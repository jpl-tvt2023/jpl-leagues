// JPL Auction Gameweek Processor
// Scores all teams, ranks them, assigns payouts, updates purses

import { db, teams, auctionScores, auctionOwnership, leagues } from "../../db";
import { eq, and } from "drizzle-orm";
import { calculateAuctionTeamScore, loadAuctionGwFplData } from "./scoring";
import type { FplLane } from "../../fpl/gateway";
import { assignRanksAndPayouts, calculateRefund, calculateFMV } from "./economy";
import { createNotification } from "../../notifications";
import { isReleaseCycleBoundary, parseReleaseCycleGws } from "./cycle";
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

  // Which gameweeks finalize pending releases for THIS league. Configured per league
  // (default 10/20/30), replacing the old hardcoded `gameweekNumber % 10 === 0`, which
  // could not follow a league that starts at a gameweek other than 1.
  const leagueCfgRow = await db
    .select({ releaseCycleGws: leagues.releaseCycleGws })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  const releaseCycleGws = parseReleaseCycleGws(leagueCfgRow[0]?.releaseCycleGws);

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

  // Notification fan-out happens after the transaction commits. Track refunds
  // per team here so the post-commit loop has the data it needs.
  const refundByTeam = new Map<string, number>();
  const releaseCountByTeam = new Map<string, number>();

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

    // Finalize pending releases at the league's configured cycle boundaries
    if (isReleaseCycleBoundary(gameweekNumber, releaseCycleGws)) {
      const pendingReleases = await tx
        .select()
        .from(auctionOwnership)
        .where(
          and(
            eq(auctionOwnership.leagueId, leagueId),
            eq(auctionOwnership.status, "pending_release")
          )
        );

      // Aggregate refunds per team to avoid multiple round-trips. Use the FMV-based refund snapshotted
      // at mark-for-release time; fall back to 50% of purchase for legacy rows with no snapshot.
      for (const p of pendingReleases) {
        const refund = p.releaseRefund ?? calculateRefund(p.purchasePrice);
        await tx
          .update(auctionOwnership)
          .set({
            status: "released",
            releasedGw: gameweekNumber,
            updatedAt: new Date(),
          })
          .where(eq(auctionOwnership.id, p.id));
        refundByTeam.set(p.teamId, (refundByTeam.get(p.teamId) ?? 0) + refund);
        releaseCountByTeam.set(p.teamId, (releaseCountByTeam.get(p.teamId) ?? 0) + 1);
      }

      for (const [teamId, totalRefund] of refundByTeam) {
        const team = leagueTeams.find((t) => t.id === teamId);
        if (!team) continue;
        // Re-fetch the most recent purse (may have been updated above)
        const current = await tx.select().from(teams).where(eq(teams.id, teamId)).limit(1);
        const currentPurse = current[0]?.purse ?? team.purse;
        const currentRefunds = current[0]?.totalRefunds ?? team.totalRefunds;
        await tx
          .update(teams)
          .set({
            purse: currentPurse + totalRefund,
            totalRefunds: currentRefunds + totalRefund,
            updatedAt: new Date(),
          })
          .where(eq(teams.id, teamId));
      }
    }
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

    for (const [teamId, totalRefund] of refundByTeam) {
      const count = releaseCountByTeam.get(teamId) ?? 0;
      try {
        await createNotification({
          teamId,
          leagueId,
          type: "release_refund",
          title: "Release refund credited",
          body: `£${(totalRefund / 1_000_000).toFixed(2)}M for ${count} released player${count === 1 ? "" : "s"}`,
          link: slug ? `/${slug}/finance` : undefined,
        });
      } catch (e) {
        console.warn("[processAuctionGameweek] notify release_refund failed", { teamId, error: e });
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
 * Finalize all pending releases for a league immediately.
 * Called when a mini-auction session starts so players marked for release
 * are freed up before the new auction begins.
 *
 * @param gwNumber - Current GW number used as the release GW marker
 */
export async function finalizePendingReleasesNow(
  leagueId: string,
  gwNumber: number
): Promise<{ finalized: number }> {
  const pendingReleases = await db
    .select()
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueId),
        eq(auctionOwnership.status, "pending_release")
      )
    );

  if (pendingReleases.length === 0) return { finalized: 0 };

  // Aggregate refunds per team — use the FMV-based refund snapshotted at release; fall back to 50%
  // of purchase for legacy rows.
  const refundByTeam = new Map<string, number>();
  for (const p of pendingReleases) {
    const refund = p.releaseRefund ?? calculateRefund(p.purchasePrice);
    await db
      .update(auctionOwnership)
      .set({ status: "released", releasedGw: gwNumber, updatedAt: new Date() })
      .where(eq(auctionOwnership.id, p.id));
    refundByTeam.set(p.teamId, (refundByTeam.get(p.teamId) ?? 0) + refund);
  }

  // Credit refunds to each team's purse
  for (const [teamId, totalRefund] of refundByTeam) {
    const current = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    if (current.length === 0) continue;
    await db
      .update(teams)
      .set({
        purse: current[0].purse + totalRefund,
        totalRefunds: current[0].totalRefunds + totalRefund,
        updatedAt: new Date(),
      })
      .where(eq(teams.id, teamId));
  }

  return { finalized: pendingReleases.length };
}
