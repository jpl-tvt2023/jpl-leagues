// JPL Auction Gameweek Processor
// Scores all teams, ranks them, assigns payouts, updates purses

import { db, teams, auctionScores, auctionOwnership, auctionSessions, leagues } from "../../db";
import { eq, and, lte, sql } from "drizzle-orm";
import { calculateAuctionTeamScore, loadAuctionGwFplData } from "./scoring";
import type { FplLane } from "../../fpl/gateway";
import { assignRanksAndPayouts, creditedRefund, calculateFMV } from "./economy";
import { formatMoney } from "./release-refund";
import { createNotification } from "../../notifications";
import { RELEASE_DEADLINE_HOURS, isReleaseWindowClosed } from "./release-deadline";
import { getNextMiniAuction } from "./live-session";
import { getStartedGameweekNumber } from "../../gameweeks/current-gw";
import { randomUUID } from "crypto";

export interface AuctionProcessResult {
  success: boolean;
  teamsProcessed: number;
  scores: { teamId: string; teamName: string; totalPoints: number; rank: number; payout: number }[];
  error?: string;
}

/**
 * Process a gameweek for an auction league:
 * 1. Calculate each team's squad score (sum of owned elements' GW points)
 * 2. Rank teams by GW score
 * 3. Assign income payouts based on rank
 * 4. Update teams.purse and teams.totalIncome
 * 5. Store results in auctionScores table
 */
export async function processAuctionGameweek(
  gameweekId: string,
  gameweekNumber: number,
  leagueId: string,
  forceReprocess: boolean,
  /**
   * FPL request lane. Defaults to "critical" because every caller of this function is
   * a scoring path: the background lane is refused outright while a scoring run holds
   * the FPL lock, which made auction scoring fail exactly when cron was running.
   */
  lane: FplLane = "critical"
): Promise<AuctionProcessResult> {
  // Check if already processed
  if (!forceReprocess) {
    const existing = await db
      .select()
      .from(auctionScores)
      .where(
        and(
          eq(auctionScores.leagueId, leagueId),
          eq(auctionScores.gameweekId, gameweekId)
        )
      );
    if (existing.length > 0) {
      return {
        success: true,
        teamsProcessed: existing.length,
        scores: existing.map((s) => ({
          teamId: s.teamId,
          teamName: "",
          totalPoints: s.totalPoints,
          rank: s.rank ?? 0,
          payout: s.payout,
        })),
      };
    }
  }

  // Get all non-ghost teams in this league
  const leagueTeams = await db
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));

  if (leagueTeams.length === 0) {
    return { success: false, teamsProcessed: 0, scores: [], error: "No teams found" };
  }

  // Reprocess-preservation: build a per-team map of {elementId → {plTeamId, synergyBonus}} from
  // the prior breakdown JSON. Two reasons we need this:
  //   1. Synergy retroactivity: if a player transferred PL clubs after the GW was originally scored,
  //      reprocess must NOT re-route synergy to the new club. The historical plTeamId drives the
  //      synergy decision for this GW.
  //   2. PL exits: if a player has left the PL entirely (missing from bootstrap), the last-known
  //      synergy bonus is used as a fallback.
  // Only applies on forceReprocess.
  const preservedDataByTeam = new Map<string, Map<number, { plTeamId: number | null; synergyBonus: number }>>();
  if (forceReprocess) {
    const prior = await db
      .select({ teamId: auctionScores.teamId, breakdown: auctionScores.playerBreakdown })
      .from(auctionScores)
      .where(
        and(
          eq(auctionScores.leagueId, leagueId),
          eq(auctionScores.gameweekId, gameweekId)
        )
      );
    for (const row of prior) {
      try {
        const parsed = JSON.parse(row.breakdown) as Array<{
          elementId: number;
          plTeamId?: number | null;
          synergyBonus?: number;
        }>;
        const map = new Map<number, { plTeamId: number | null; synergyBonus: number }>();
        for (const p of parsed) {
          // Only preserve entries that carry at least one of the snapshot fields (legacy rows
          // pre-club-auction had neither and produce nothing useful).
          if (typeof p.synergyBonus === "number" || p.plTeamId != null) {
            map.set(p.elementId, {
              plTeamId: p.plTeamId ?? null,
              synergyBonus: typeof p.synergyBonus === "number" ? p.synergyBonus : 0,
            });
          }
        }
        if (map.size > 0) preservedDataByTeam.set(row.teamId, map);
      } catch { /* legacy breakdown rows that don't parse → nothing to preserve */ }
    }
  }

  // Fetch the league-wide FPL data ONCE, before fanning out. Every team needs the same
  // /event/{gw}/live/ payload and the same bootstrap element metadata; letting each of
  // them fetch it independently is what used to push this call past the 60s function
  // ceiling and drop the connection.
  const fplData = await loadAuctionGwFplData(gameweekNumber, lane);

  // Calculate scores for all teams
  const teamScores = await Promise.all(
    leagueTeams.map(async (team) => {
      const score = await calculateAuctionTeamScore(
        leagueId,
        team.id,
        gameweekNumber,
        preservedDataByTeam.get(team.id),
        fplData
      );
      return { ...score, teamName: team.name };
    })
  );

  // Build per-team squadValue snapshot at this GW (FMV of currently-owned players,
  // FMV uses purchasePrice + (player's accumulated GW points × 50K from this score's
  // breakdown — for tie-breaking purposes a snapshot derived from the just-computed
  // GW breakdown is a fair approximation).
  const allOwnership = await db
    .select()
    .from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "active")));

  const squadValueByTeam = new Map<string, number>();
  for (const owned of allOwnership) {
    const score = teamScores.find((s) => s.teamId === owned.teamId);
    // FMV uses RAW points only (per locked spec — synergy never compounds into FMV/squad value/trades).
    const playerPts = score?.playerBreakdown.find((p) => p.elementId === owned.fplElementId)?.rawPoints ?? 0;
    const fmv = calculateFMV(owned.purchasePrice, playerPts);
    squadValueByTeam.set(owned.teamId, (squadValueByTeam.get(owned.teamId) ?? 0) + fmv);
  }
  const purseByTeam = new Map(leagueTeams.map((t) => [t.id, t.purse]));

  // Order: GW points desc → squad value asc (lower wins) → purse desc (higher wins).
  // The squad-value/purse keys no longer decide money — teams level on points share a rank and
  // split the pot (see assignRanksAndPayouts) — but they still give a deterministic row order
  // within a tied block.
  teamScores.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    const aSv = squadValueByTeam.get(a.teamId) ?? 0;
    const bSv = squadValueByTeam.get(b.teamId) ?? 0;
    if (aSv !== bSv) return aSv - bSv;
    return (purseByTeam.get(b.teamId) ?? 0) - (purseByTeam.get(a.teamId) ?? 0);
  });

  // Assign ranks and payouts. Applies to every auction tier — Primary earns GW payouts too
  // (its purse sink is the mini-auction).
  const rankedScores = assignRanksAndPayouts(teamScores, (s) => s.totalPoints).map(
    ({ item, rank, payout }) => ({ ...item, rank, payout })
  );

  // Payout already credited for this GW by an earlier run, per team. Populated only on
  // forceReprocess (stays empty on a first pass). Purses are then moved by the delta rather
  // than the raw payout, so reprocessing the same GW twice is a no-op instead of paying twice.
  const priorPayoutByTeam = new Map<string, number>();

  // Atomically write scores and update purses.
  // Race-safety: re-check duplicate scores INSIDE the transaction. If a concurrent caller wrote
  // them between our outer check and our transaction start, we abort and return their persisted
  // state. Closes the window where two callers both run INSERTs — one succeeds, the loser
  // throws a UNIQUE constraint violation.
  type RaceLossScore = { teamId: string; teamName: string; totalPoints: number; rank: number; payout: number };
  let raceLossDetected: RaceLossScore[] | null = null;

  await db.transaction(async (tx) => {
    // Re-check inside the transaction: closes the race window from the outer check above.
    if (!forceReprocess) {
      const existingInTx = await tx
        .select()
        .from(auctionScores)
        .where(
          and(
            eq(auctionScores.leagueId, leagueId),
            eq(auctionScores.gameweekId, gameweekId),
          ),
        );
      if (existingInTx.length > 0) {
        // The caller only reads teamId/teamName/totalPoints/rank/payout from the response shape.
        raceLossDetected = existingInTx.map((s) => {
          const team = leagueTeams.find((t) => t.id === s.teamId);
          return {
            teamId: s.teamId,
            teamName: team?.name ?? "",
            totalPoints: s.totalPoints,
            rank: s.rank ?? 0,
            payout: s.payout,
          };
        });
        return; // skip the rest of the transaction body
      }
    }

    // Delete existing scores for this GW if reprocessing
    if (forceReprocess) {
      // Delete one by one since Drizzle SQLite doesn't support compound where on delete easily
      const existingScores = await tx
        .select({ id: auctionScores.id, teamId: auctionScores.teamId, payout: auctionScores.payout })
        .from(auctionScores)
        .where(
          and(
            eq(auctionScores.leagueId, leagueId),
            eq(auctionScores.gameweekId, gameweekId)
          )
        );
      for (const existing of existingScores) {
        // Record what the previous run paid before the row goes away — the purse update below
        // needs it to reverse the old credit.
        priorPayoutByTeam.set(
          existing.teamId,
          (priorPayoutByTeam.get(existing.teamId) ?? 0) + existing.payout
        );
        await tx.delete(auctionScores).where(eq(auctionScores.id, existing.id));
      }
    }

    for (const score of rankedScores) {
      // Insert auction score (with PL Club Auction breakdown columns)
      await tx.insert(auctionScores).values({
        id: randomUUID(),
        leagueId,
        teamId: score.teamId,
        gameweekId,
        totalPoints: score.totalPoints,
        rawPoints: score.rawPoints,
        synergyBonus: score.synergyBonus,
        clubResultBonus: score.clubResultBonus,
        // Persist the human-readable per-fixture summary so tooltips on standings + GW Results can
        // show "Brentford 3-0 Man Utd → +3" without re-fetching PL fixtures.
        clubResultSummary: score.clubResultSummary,
        playerBreakdown: JSON.stringify(score.playerBreakdown),
        rank: score.rank,
        payout: score.payout,
      });

      // Update team purse and income by the DELTA against whatever a previous run of this GW
      // already credited (0 on a first pass). `team.purse` is the pre-transaction snapshot and
      // already includes the prior payout, so snapshot + new − prior lands on the right number.
      const team = leagueTeams.find((t) => t.id === score.teamId);
      if (team) {
        const delta = score.payout - (priorPayoutByTeam.get(score.teamId) ?? 0);
        if (delta !== 0) {
          await tx
            .update(teams)
            .set({
              purse: team.purse + delta,
              totalIncome: team.totalIncome + delta,
              updatedAt: new Date(),
            })
            .where(eq(teams.id, score.teamId));
        }
      }
    }

    // Any team that was paid for this GW previously but has no score row now (e.g. removed from
    // the league between runs) would otherwise keep a stale credit — reverse it.
    for (const [teamId, priorPayout] of priorPayoutByTeam) {
      if (priorPayout === 0) continue;
      if (rankedScores.some((s) => s.teamId === teamId)) continue;
      const team = leagueTeams.find((t) => t.id === teamId);
      if (!team) continue;
      await tx
        .update(teams)
        .set({
          purse: team.purse - priorPayout,
          totalIncome: team.totalIncome - priorPayout,
          updatedAt: new Date(),
        })
        .where(eq(teams.id, teamId));
    }

    // Pending releases are not confirmed here: they confirm at the mini-auction's release deadline
    // (confirmDueReleases below), a fixed time teams can see coming.
  });

  // Race-loss path: another concurrent caller scored this GW between our outer check and the
  // transaction. Return their persisted state instead of running notifications a second time.
  // Cast through `unknown` because TS can't narrow the closure-mutated variable.
  const raceLoss = raceLossDetected as unknown as RaceLossScore[] | null;
  if (raceLoss) {
    return {
      success: true,
      teamsProcessed: raceLoss.length,
      scores: raceLoss,
    };
  }

  // Post-commit notification fan-out. Failures must never bubble up — scoring
  // already succeeded. Best-effort: a logged warning per team is enough.
  try {
    const [leagueRow] = await db
      .select({ slug: leagues.slug })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    const slug = leagueRow?.slug ?? "";

    for (const score of rankedScores) {
      try {
        await createNotification({
          teamId: score.teamId,
          leagueId,
          type: "gw_processed",
          title: `GW${gameweekNumber} scored`,
          body: `Ranked #${score.rank} · ${score.totalPoints} pts · Payout £${(score.payout / 1_000_000).toFixed(2)}M`,
          link: slug ? `/${slug}/gw-results?gw=${gameweekNumber}` : undefined,
        });
      } catch (e) {
        console.warn("[processAuctionGameweek] notify gw_processed failed", { teamId: score.teamId, error: e });
      }
    }
  } catch (e) {
    console.warn("[processAuctionGameweek] notification fan-out skipped", e);
  }

  return {
    success: true,
    teamsProcessed: rankedScores.length,
    scores: rankedScores.map((s) => ({
      teamId: s.teamId,
      teamName: s.teamName,
      totalPoints: s.totalPoints,
      rank: s.rank,
      payout: s.payout,
    })),
  };
}

/**
 * Confirm every pending release in a league immediately. Called when a mini-auction session starts,
 * so players marked for release are freed up before bidding opens — this covers an auction started
 * before its release deadline, one with no scheduled time, and any release the deadline sweep
 * hasn't reached yet.
 */
export async function finalizePendingReleasesNow(leagueId: string): Promise<{ finalized: number }> {
  return { finalized: await confirmReleases(leagueId, "as the mini-auction started") };
}

/**
 * Confirm a league's pending releases once its next mini-auction's release deadline (24 hours
 * before the scheduled start, see release-deadline.ts) has passed.
 *
 * Nothing schedules this. The routes that read or change releases, purses and the player pool call
 * it, and so does the daily tick, so the first of them after the deadline does the work. Safe to
 * call often and concurrently: before the deadline it costs one query, and after it each release
 * is paid exactly once. Teams can't mark releases once the deadline has passed, so everything still
 * pending then was marked before it.
 */
export async function confirmDueReleases(leagueId: string, now: Date = new Date()): Promise<{ confirmed: number }> {
  const nextMini = await getNextMiniAuction(leagueId);
  if (!nextMini || !isReleaseWindowClosed(nextMini, now)) return { confirmed: 0 };
  const confirmed = await confirmReleases(
    leagueId,
    `${RELEASE_DEADLINE_HOURS} hours before Mini-Auction #${nextMini.cycleNumber}`
  );
  return { confirmed };
}

/**
 * confirmDueReleases for every league whose next mini-auction is within its release deadline — the
 * daily tick's catch-all, so a deadline is honoured even with no traffic on that league's pages.
 */
export async function confirmAllDueReleases(now: Date = new Date()): Promise<void> {
  const soon = await db
    .selectDistinct({ leagueId: auctionSessions.leagueId })
    .from(auctionSessions)
    .where(
      and(
        eq(auctionSessions.type, "mini-auction"),
        eq(auctionSessions.status, "pending"),
        lte(auctionSessions.scheduledAt, new Date(now.getTime() + RELEASE_DEADLINE_HOURS * 60 * 60 * 1000))
      )
    );
  for (const { leagueId } of soon) await confirmDueReleases(leagueId, now);
}

interface ConfirmedRelease {
  playerName: string;
  refund: number;
}

/**
 * Confirm every pending release in a league: credit each team its refunds (the amount snapshotted
 * when marked; legacy rows fall back to 50% of purchase, as creditedRefund does), mark them
 * released, and tell each team.
 *
 * Many callers reach this at once right after a deadline, and a team may be cancelling at the same
 * moment. So it is one atomic batch rather than read-then-write: the credit is summed in SQL from
 * the rows still pending, and the next statement releases exactly those rows. A caller that runs
 * second finds nothing pending and pays nothing; a cancel lands either before (unpaid) or after
 * (refused). An interactive transaction here failed under concurrency in the release soak: every one
 * of 22 simultaneous callers got SQLITE_BUSY, and the local driver was then left unable to commit.
 *
 * `releasedGw` is the league's current gameweek (the latest whose deadline has passed), so the
 * player scores for his old team up to and including it and never after — rescoring an earlier
 * gameweek still counts him.
 */
async function confirmReleases(leagueId: string, confirmedWhen: string): Promise<number> {
  const pendingInLeague = and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "pending_release"));
  const [anyPending] = await db.select({ id: auctionOwnership.id }).from(auctionOwnership).where(pendingInLeague).limit(1);
  if (!anyPending) return 0;

  // Same rule as a mini-auction buy's acquiredGw, so old and new owner never share a gameweek.
  const releasedGw = await getStartedGameweekNumber(leagueId);

  // Raw SQL with an alias so the correlation to the outer `teams` row can't be mis-rendered.
  const pendingForTeam = sql`FROM auction_ownership ao WHERE ao.team_id = teams.id AND ao.league_id = ${leagueId} AND ao.status = 'pending_release'`;
  const refundDue = sql`(SELECT COALESCE(SUM(COALESCE(ao.release_refund, ao.purchase_price / 2)), 0) ${pendingForTeam})`;

  let released: { teamId: string; playerName: string; purchasePrice: number; releaseRefund: number | null }[];
  try {
    [, released] = await db.batch([
      db
        .update(teams)
        .set({
          purse: sql`${teams.purse} + ${refundDue}`,
          totalRefunds: sql`${teams.totalRefunds} + ${refundDue}`,
          updatedAt: new Date(),
        })
        .where(and(eq(teams.leagueId, leagueId), sql`EXISTS (SELECT 1 ${pendingForTeam})`)),
      db
        .update(auctionOwnership)
        .set({ status: "released", releasedGw, updatedAt: new Date() })
        .where(pendingInLeague)
        .returning({
          teamId: auctionOwnership.teamId,
          playerName: auctionOwnership.playerName,
          purchasePrice: auctionOwnership.purchasePrice,
          releaseRefund: auctionOwnership.releaseRefund,
        }),
    ]);
  } catch (err) {
    // Another caller holds the write lock and is confirming these very rows.
    if (isBusy(err)) return 0;
    throw err;
  }

  const releasedByTeam = new Map<string, ConfirmedRelease[]>();
  for (const p of released) {
    releasedByTeam.set(p.teamId, [...(releasedByTeam.get(p.teamId) ?? []), { playerName: p.playerName, refund: creditedRefund(p) }]);
  }
  await notifyReleasesConfirmed(leagueId, releasedByTeam, confirmedWhen);
  return released.length;
}

/** SQLITE_BUSY anywhere in the error or its causes (Drizzle wraps the libSQL error). */
function isBusy(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (code === "SQLITE_BUSY" || (e instanceof Error && e.message.includes("SQLITE_BUSY"))) return true;
  }
  return false;
}

/**
 * Tell each team its releases were confirmed, naming every player and amount, and which of the
 * two confirmation points did it. Shared by GW scoring and mini-auction start so a team hears the
 * same thing either way. Best-effort: the purse has already moved, so failures are only logged.
 */
async function notifyReleasesConfirmed(
  leagueId: string,
  releasedByTeam: Map<string, ConfirmedRelease[]>,
  confirmedWhen: string
): Promise<void> {
  if (releasedByTeam.size === 0) return;
  try {
    const [leagueRow] = await db
      .select({ slug: leagues.slug })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    const slug = leagueRow?.slug ?? "";

    for (const [teamId, released] of releasedByTeam) {
      const total = released.reduce((s, r) => s + r.refund, 0);
      try {
        await createNotification({
          teamId,
          leagueId,
          type: "release_refund",
          title: `Release refund credited: ${formatMoney(total)}`,
          body:
            `${released.map((r) => `${formatMoney(r.refund)} for ${r.playerName}`).join("; ")} — ` +
            `confirmed ${confirmedWhen}. See Finance for each breakdown.`,
          link: slug ? `/${slug}/finance` : undefined,
        });
      } catch (e) {
        console.warn("[releases] notify release_refund failed", { teamId, error: e });
      }
    }
  } catch (e) {
    console.warn("[releases] release notification fan-out skipped", e);
  }
}
