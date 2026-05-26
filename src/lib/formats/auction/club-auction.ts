/**
 * PL Club Auction orchestration.
 *
 * The club auction is a separate auction session (`auctionSessions.type = "club-auction"`)
 * that runs before the initial player auction. State is co-located in the existing tables:
 *
 *   - `auctionSessions.snakeOrder`  → JSON array of remaining PL team IDs queued for this round.
 *   - `auctionSessions.currentNominatorIndex` → pointer into snakeOrder for the next club to nominate.
 *   - `auctionSessions.cycleNumber` → which pass we are on (1 = first pass over all 20 clubs,
 *                                     2 = re-nomination of unsold clubs).
 *   - `auctionBids` row per club nomination:
 *       fplElementId = PL bootstrap team id (re-purposed; both are int IDs, just different namespaces)
 *       playerName   = PL team name
 *       nominatorTeamId / currentHighBidderId = SENTINEL — first fantasy team in the league (any club-less team).
 *       Real bids show up as `auctionBidLogs.type = "bid"` rows; "no bids" → unsold.
 *
 * When a club bid resolves:
 *   - SOLD  (≥1 real bid): write `auctionClubOwnership` row, deduct purse, emit `club_purchased` notification.
 *   - UNSOLD (no real bid): mark bid status; club rejoins round-2 queue (if cycle === 1).
 *
 * The whole flow is admin/system driven — there is no nomination-by-team turn.
 */

import { db } from "@/lib/db";
import {
  auctionSessions,
  auctionBids,
  auctionBidLogs,
  auctionClubOwnership,
  teams,
  leagues,
  plStandingsConfig,
} from "@/lib/db/schema";
import { eq, and, count, sql } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { fetchBootstrapData } from "@/lib/fpl";
import { getFplFixturesForGw } from "@/lib/fpl-live/players-left";
import {
  PL_STANDINGS_SEED_ID,
  PL_STANDINGS_SEED_SEASON,
  PL_STANDINGS_SEED_TOP8,
  PL_STANDINGS_SEED_MID,
  PL_STANDINGS_SEED_PROMOTED,
  resolveTier,
} from "@/lib/data/pl-standings-seed";
import type { ClubTier } from "@/lib/db/schema";
import { createNotification } from "@/lib/notifications";
import { getPlTeamFullName } from "@/lib/data/pl-team-full-names";
import { writeAuctionCompleteSnapshot } from "@/lib/backup/snapshot";

const CLUB_FLOOR_BID = 500_000; // Same floor as player auction

export const CLUB_AUCTION_SESSION_TYPE = "club-auction";

// ── Tier scoring (per-fixture bonus). Used by Phase 4 scoring; exported here so both sides agree. ──
export const CLUB_TIER_BONUS: Record<ClubTier, { win: number; draw: number }> = {
  top8:     { win: 2, draw: 1 },
  mid:      { win: 3, draw: 1 },
  promoted: { win: 4, draw: 2 },
};

export function getClubBonusForTier(tier: ClubTier, isWin: boolean, isDraw: boolean): number {
  if (!isWin && !isDraw) return 0;
  const row = CLUB_TIER_BONUS[tier];
  return isWin ? row.win : row.draw;
}

/**
 * Compute the per-fixture club-result bonus for an owned club in a given GW.
 *
 * Looks up the GW's PL fixtures, filters to those involving the owned club, and awards `tier.win`
 * for wins / `tier.draw` for draws / 0 for losses. Sums across fixtures (DGW doubles the bonus).
 *
 * Returns `null` if the FPL fixtures fetch fails. Otherwise returns `{ bonus, summary }` where the
 * summary string takes the form `"Brentford 3-0 Man Utd → +3"` (DGW joined with `; `). Caller
 * decides whether to surface a `GWn:` prefix.
 *
 * Used by both the GW scorer (process-gameweek.ts) and on-the-fly tooltip backfill in the historical
 * gw-summary path for legacy rows that pre-date the persisted `club_result_summary` column.
 */
export async function computeClubResultBonus(
  plTeamId: number,
  tier: ClubTier,
  gw: number
): Promise<{ bonus: number; summary: string } | null> {
  const fixtures = await getFplFixturesForGw(gw);
  if (fixtures == null) return null;

  const myFixtures = fixtures.filter((f) => f.team_h === plTeamId || f.team_a === plTeamId);
  if (myFixtures.length === 0) {
    return { bonus: 0, summary: "Blank GW — no fixture, no bonus" };
  }

  // PL team-name lookup for the scoreline summary ("BRE 3-0 MUN → +3"). The 3-letter `short_name`
  // is used here because the scoreline is rendered inside cramped tooltip rows next to the bonus
  // number; the full club name appears separately in the tooltip's header.
  // Best-effort: on FPL outage we fall back to "team#<id>".
  const plShortById = new Map<number, string>();
  try {
    const bootstrap = await fetchBootstrapData();
    for (const t of (bootstrap.teams ?? []) as Array<{ id: number; short_name: string; name: string }>) {
      plShortById.set(t.id, t.short_name ?? t.name);
    }
  } catch { /* leave map empty; nameFor() falls back to "team#<id>" */ }
  const nameFor = (id: number): string => plShortById.get(id) ?? `team#${id}`;

  let total = 0;
  const lines: string[] = [];
  for (const f of myFixtures) {
    const homeName = nameFor(f.team_h);
    const awayName = nameFor(f.team_a);
    if (!f.finished && !f.finished_provisional) {
      lines.push(`${homeName} vs ${awayName} (in progress) → +0`);
      continue;
    }
    const homeScore = f.team_h_score ?? 0;
    const awayScore = f.team_a_score ?? 0;
    const isHome = f.team_h === plTeamId;
    const myScore = isHome ? homeScore : awayScore;
    const oppScore = isHome ? awayScore : homeScore;
    const isWin = myScore > oppScore;
    const isDraw = myScore === oppScore;
    const bonus = getClubBonusForTier(tier, isWin, isDraw);
    total += bonus;
    lines.push(`${homeName} ${homeScore}-${awayScore} ${awayName} → +${bonus}`);
  }
  return { bonus: total, summary: lines.join("; ") };
}

// ── Standings config loader (auto-seeds on first read) ──

interface StandingsConfigRow {
  top8: number[];
  mid: number[];
  promoted: number[];
  season: string;
}

function parseIdList(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export async function loadStandingsConfig(): Promise<StandingsConfigRow> {
  const existing = await db.query.plStandingsConfig.findFirst({
    where: eq(plStandingsConfig.id, PL_STANDINGS_SEED_ID),
  });
  if (existing) {
    return {
      season: existing.season,
      top8: parseIdList(existing.top8),
      mid: parseIdList(existing.mid),
      promoted: parseIdList(existing.promoted),
    };
  }

  // Auto-seed on first read so we always have a usable mapping.
  await db.insert(plStandingsConfig).values({
    id: PL_STANDINGS_SEED_ID,
    season: PL_STANDINGS_SEED_SEASON,
    top8: JSON.stringify(PL_STANDINGS_SEED_TOP8),
    mid: JSON.stringify(PL_STANDINGS_SEED_MID),
    promoted: JSON.stringify(PL_STANDINGS_SEED_PROMOTED),
    updatedAt: new Date(),
  });
  return {
    season: PL_STANDINGS_SEED_SEASON,
    top8: [...PL_STANDINGS_SEED_TOP8],
    mid: [...PL_STANDINGS_SEED_MID],
    promoted: [...PL_STANDINGS_SEED_PROMOTED],
  };
}

// ── Initial club queue (called when admin creates the club-auction session) ──

export interface PLClubInfo {
  id: number;
  name: string;
  short: string;
  tier: ClubTier | null;
}

/**
 * Fetch all 20 PL clubs from the FPL bootstrap, resolving each to a tier via the standings config.
 * Throws if the bootstrap fetch fails — caller surfaces the error to the admin UI.
 */
export async function fetchAllPLClubsWithTiers(): Promise<PLClubInfo[]> {
  const [bootstrap, config] = await Promise.all([fetchBootstrapData(), loadStandingsConfig()]);
  const raw = (bootstrap.teams ?? []) as Array<{ id: number; name: string; short_name: string }>;
  return raw.map((t) => ({
    id: t.id,
    name: t.name,
    short: t.short_name,
    tier: resolveTier(t.id, config),
  }));
}

function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build the initial randomised queue for a brand new club auction session.
 * Returns the PL team IDs (as numbers) in nomination order.
 */
export function buildInitialClubQueue(plClubIds: number[]): number[] {
  return shuffleInPlace([...plClubIds]);
}

// ── Eligibility / state helpers ──

/**
 * Returns IDs of fantasy teams in the league that do NOT yet own a PL club.
 * Only these teams are allowed to bid in the club auction.
 */
export async function getClubLessTeamIds(leagueId: string): Promise<string[]> {
  const [allTeams, owners] = await Promise.all([
    db.select({ id: teams.id, isGhost: teams.isGhost })
      .from(teams)
      .where(eq(teams.leagueId, leagueId)),
    db.select({ teamId: auctionClubOwnership.teamId })
      .from(auctionClubOwnership)
      .where(eq(auctionClubOwnership.leagueId, leagueId)),
  ]);
  const ownerSet = new Set(owners.map((o) => o.teamId));
  return allTeams.filter((t) => !t.isGhost && !ownerSet.has(t.id)).map((t) => t.id);
}

/**
 * Returns the PL team IDs that are unsold this cycle — i.e. that don't yet have a
 * `auctionClubOwnership` row for this league. Used to rebuild the round-2 queue.
 */
export async function getUnsoldClubIds(leagueId: string, allClubIds: number[]): Promise<number[]> {
  const owned = await db
    .select({ plTeamId: auctionClubOwnership.plTeamId })
    .from(auctionClubOwnership)
    .where(eq(auctionClubOwnership.leagueId, leagueId));
  const ownedSet = new Set(owned.map((r) => r.plTeamId));
  return allClubIds.filter((id) => !ownedSet.has(id));
}

/**
 * Pick a sentinel team to populate `auctionBids.nominatorTeamId` / `currentHighBidderId`
 * during a club nomination. Any non-ghost team in the league works — the bid resolver
 * doesn't trust this value; it inspects `auctionBidLogs.type = "bid"` to decide sold/unsold.
 */
async function pickSentinelTeam(leagueId: string): Promise<string | null> {
  const row = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)))
    .limit(1);
  return row[0]?.id ?? null;
}

// ── Auto-nominate the next club in the queue ──

/**
 * Create the next club nomination if the session has one queued and no open bid.
 * Returns the bid id on success, or null if the queue is exhausted / a bid is already open.
 *
 * If the queue is exhausted on cycle 1, this rebuilds it from unsold clubs for cycle 2.
 * If exhausted on cycle 2 (or if every team already has a club), this marks the session "completed".
 */
export async function autoNominateNextClub(sessionId: string): Promise<string | null> {
  const sessionRow = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (sessionRow.length === 0 || sessionRow[0].type !== CLUB_AUCTION_SESSION_TYPE) return null;
  if (sessionRow[0].status !== "active") return null;

  // Don't nominate if a bid is already open
  const openBids = await db
    .select({ id: auctionBids.id })
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")))
    .limit(1);
  if (openBids.length > 0) return null;

  const leagueId = sessionRow[0].leagueId;
  const cycleNumber = sessionRow[0].cycleNumber ?? 1;
  let queue: number[] = [];
  try {
    const parsed = JSON.parse(sessionRow[0].snakeOrder);
    if (Array.isArray(parsed)) queue = parsed.filter((n): n is number => typeof n === "number");
  } catch { /* fall through to empty */ }
  let cursor = sessionRow[0].currentNominatorIndex ?? 0;

  // Skip past already-owned clubs (defence against stale queue)
  const clubLess = await getClubLessTeamIds(leagueId);
  if (clubLess.length === 0) {
    await db.update(auctionSessions).set({ status: "completed" }).where(eq(auctionSessions.id, sessionId));
    await writeAuctionCompleteSnapshot(sessionId).catch((e) => console.error("[auction snapshot]", e));
    return null;
  }

  const ownedNow = new Set<number>(
    (await db
      .select({ plTeamId: auctionClubOwnership.plTeamId })
      .from(auctionClubOwnership)
      .where(eq(auctionClubOwnership.leagueId, leagueId))
    ).map((r) => r.plTeamId)
  );

  while (cursor < queue.length && ownedNow.has(queue[cursor])) {
    cursor++;
  }

  // Queue exhausted — try to rebuild for round 2, or complete the session.
  if (cursor >= queue.length) {
    if (cycleNumber >= 2) {
      await db.update(auctionSessions).set({ status: "completed" }).where(eq(auctionSessions.id, sessionId));
      await writeAuctionCompleteSnapshot(sessionId).catch((e) => console.error("[auction snapshot]", e));
      return null;
    }
    const bootstrap = await fetchBootstrapData();
    const allIds = ((bootstrap.teams ?? []) as Array<{ id: number }>).map((t) => t.id);
    const unsold = await getUnsoldClubIds(leagueId, allIds);
    if (unsold.length === 0) {
      await db.update(auctionSessions).set({ status: "completed" }).where(eq(auctionSessions.id, sessionId));
      await writeAuctionCompleteSnapshot(sessionId).catch((e) => console.error("[auction snapshot]", e));
      return null;
    }
    const newQueue = shuffleInPlace(unsold);
    await db
      .update(auctionSessions)
      .set({
        snakeOrder: JSON.stringify(newQueue),
        currentNominatorIndex: 0,
        cycleNumber: 2,
      })
      .where(eq(auctionSessions.id, sessionId));
    queue = newQueue;
    cursor = 0;
  }

  const nextPlTeamId = queue[cursor];

  // Resolve club name from FPL bootstrap (also gives us the short_name)
  const bootstrap = await fetchBootstrapData();
  const club = ((bootstrap.teams ?? []) as Array<{ id: number; name: string; short_name: string }>)
    .find((t) => t.id === nextPlTeamId);
  if (!club) {
    // Stale ID — skip and try again
    await db
      .update(auctionSessions)
      .set({ currentNominatorIndex: cursor + 1 })
      .where(eq(auctionSessions.id, sessionId));
    return autoNominateNextClub(sessionId);
  }

  const sentinelTeamId = await pickSentinelTeam(leagueId);
  if (!sentinelTeamId) return null;

  const bidTimerSeconds = sessionRow[0].bidTimerSeconds ?? 20;
  const bidId = generateId();
  const expiresAt = new Date(Date.now() + bidTimerSeconds * 1000);

  await db.insert(auctionBids).values({
    id: bidId,
    leagueId,
    sessionId,
    nominatorTeamId: sentinelTeamId,
    fplElementId: nextPlTeamId,
    playerName: club.name,
    currentHighBid: CLUB_FLOOR_BID,
    currentHighBidderId: sentinelTeamId,
    minBid: CLUB_FLOOR_BID,
    status: "open",
    expiresAt,
  });

  await db.insert(auctionBidLogs).values({
    id: generateId(),
    bidId,
    teamId: sentinelTeamId,
    amount: CLUB_FLOOR_BID,
    type: "nomination",
  });

  // Persist the advanced cursor; on resolve we will increment further past the now-resolved club.
  await db
    .update(auctionSessions)
    .set({ currentNominatorIndex: cursor, nominationDeadline: null })
    .where(eq(auctionSessions.id, sessionId));

  return bidId;
}

// ── Resolve a club-auction bid (sold or unsold) ──

interface BidRow {
  id: string;
  leagueId: string;
  sessionId: string;
  nominatorTeamId: string;
  fplElementId: number;
  playerName: string;
  currentHighBid: number;
  currentHighBidderId: string;
  status: string;
}

/**
 * Resolve an expired club-auction bid.
 *   - At least one real bid (auctionBidLogs.type='bid') → SOLD to currentHighBidderId.
 *   - No real bids → UNSOLD.
 *
 * Idempotent: only proceeds if the bid is still "open".
 */
export async function resolveClubBid(bid: BidRow): Promise<"sold" | "unsold" | "already-resolved"> {
  // Idempotent claim: only one caller flips status from open.
  const realBids = await db
    .select({ c: count() })
    .from(auctionBidLogs)
    .where(and(eq(auctionBidLogs.bidId, bid.id), eq(auctionBidLogs.type, "bid")));
  const hadBids = (realBids[0]?.c ?? 0) > 0;

  if (hadBids) {
    const updated = await db
      .update(auctionBids)
      .set({ status: "sold", updatedAt: new Date() })
      .where(and(eq(auctionBids.id, bid.id), eq(auctionBids.status, "open")))
      .returning();
    if (updated.length === 0) return "already-resolved";
    const fresh = updated[0];

    // Look up tier. resolveTier returns null only when the PL team id is in
    // none of {top8, mid, promoted} — i.e., the standings config is
    // misconfigured (promoted teams not yet refreshed, or a bootstrap drift).
    // Refuse to write an ownership row with a silently-fallback tier; flag the
    // bid as needing operator attention by leaving its status as "sold" but
    // marking it as already-resolved so the caller doesn't try to re-process.
    // The bid log entry below records the failure for the audit trail.
    const config = await loadStandingsConfig();
    const resolvedTier = resolveTier(fresh.fplElementId, config);
    if (resolvedTier === null) {
      console.error(
        `[club-auction] Tier resolution failed for plTeamId=${fresh.fplElementId} (league=${bid.leagueId}). ` +
          `Standings config likely misconfigured; refusing to write auctionClubOwnership row. ` +
          `Bid row was updated to 'sold' but the ownership is unallocated — superadmin must repair the standings ` +
          `config and re-run via auction-corrections.`
      );
      // The bid row was already moved to 'sold' above (lines 430-435). We do
      // NOT write the auctionClubOwnership row — leaving the bid sold but
      // unallocated. The caller's "already-resolved" return signals "do not
      // retry"; the audit-log entry below records the failure for triage.
      await db.insert(auctionBidLogs).values({
        id: generateId(),
        bidId: bid.id,
        teamId: fresh.currentHighBidderId,
        amount: fresh.currentHighBid,
        type: "sold",
      });
      return "already-resolved";
    }
    const tier = resolvedTier;

    // Look up club short name
    let plTeamShort = "";
    try {
      const bootstrap = await fetchBootstrapData();
      const club = ((bootstrap.teams ?? []) as Array<{ id: number; short_name: string }>)
        .find((t) => t.id === fresh.fplElementId);
      plTeamShort = club?.short_name ?? "";
    } catch { /* fall through with empty short */ }

    const now = new Date();
    await db.insert(auctionClubOwnership).values({
      id: generateId(),
      leagueId: bid.leagueId,
      teamId: fresh.currentHighBidderId,
      plTeamId: fresh.fplElementId,
      plTeamName: getPlTeamFullName(fresh.fplElementId, fresh.playerName),
      plTeamShort,
      tier,
      purchasePrice: fresh.currentHighBid,
      acquiredAt: now,
      createdAt: now,
    });

    await db.insert(auctionBidLogs).values({
      id: generateId(),
      bidId: bid.id,
      teamId: fresh.currentHighBidderId,
      amount: fresh.currentHighBid,
      type: "sold",
    });

    // Deduct purse atomically
    await db
      .update(teams)
      .set({
        purse: sql`${teams.purse} - ${fresh.currentHighBid}`,
        totalSpent: sql`${teams.totalSpent} + ${fresh.currentHighBid}`,
      })
      .where(eq(teams.id, fresh.currentHighBidderId));

    // Notify the winner
    try {
      await createNotification({
        teamId: fresh.currentHighBidderId,
        leagueId: bid.leagueId,
        type: "club_purchased",
        title: `You bought ${fresh.playerName}`,
        body: `Purchased for ${(fresh.currentHighBid / 1_000_000).toFixed(1)}M — tier ${tier}. Your team will display as "${fresh.playerName}" all season.`,
      });
    } catch (err) {
      console.error("[club-auction] notification failed:", err);
    }

    return "sold";
  }

  // No real bids → unsold
  const updated = await db
    .update(auctionBids)
    .set({ status: "unsold", updatedAt: new Date() })
    .where(and(eq(auctionBids.id, bid.id), eq(auctionBids.status, "open")))
    .returning();
  if (updated.length === 0) return "already-resolved";

  await db.insert(auctionBidLogs).values({
    id: generateId(),
    bidId: bid.id,
    teamId: bid.nominatorTeamId,
    amount: 0,
    type: "unsold",
  });

  return "unsold";
}

/**
 * After a club bid resolves, advance the queue cursor and (if appropriate) auto-nominate the next club.
 * Mirrors `advanceNominator` for player auctions.
 */
export async function advanceClubQueue(sessionId: string): Promise<void> {
  const sess = await db
    .select({ currentNominatorIndex: auctionSessions.currentNominatorIndex })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (!sess.length) return;

  await db
    .update(auctionSessions)
    .set({ currentNominatorIndex: (sess[0].currentNominatorIndex ?? 0) + 1 })
    .where(eq(auctionSessions.id, sessionId));

  // Try to nominate the next club. If the queue is exhausted, this marks the session completed.
  await autoNominateNextClub(sessionId);
}

// ── Public introspection ──

/** Check whether a session is a club auction. Used as a branch guard in shared endpoints. */
export async function isClubAuctionSession(sessionId: string): Promise<boolean> {
  const row = await db
    .select({ type: auctionSessions.type })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  return row[0]?.type === CLUB_AUCTION_SESSION_TYPE;
}

/** Owner mapping for a league. Returns {teamId → ownership} so the UI / scoring can look up cheaply. */
export async function getClubOwnershipsByTeam(
  leagueId: string
): Promise<Record<string, { plTeamId: number; plTeamName: string; plTeamShort: string; tier: ClubTier }>> {
  const rows = await db
    .select()
    .from(auctionClubOwnership)
    .where(eq(auctionClubOwnership.leagueId, leagueId));
  const result: Record<string, { plTeamId: number; plTeamName: string; plTeamShort: string; tier: ClubTier }> = {};
  for (const r of rows) {
    result[r.teamId] = {
      plTeamId: r.plTeamId,
      // Normalise legacy rows (stored as FPL short form) to the full PL name. New writes are already
      // full names, but this read-side override means we don't need a one-off backfill.
      plTeamName: getPlTeamFullName(r.plTeamId, r.plTeamName),
      plTeamShort: r.plTeamShort,
      tier: r.tier as ClubTier,
    };
  }
  return result;
}

// Ensure league row check (used by callers that take a leagueId from request).
export async function leagueHasClubAuctionEnabled(leagueId: string): Promise<boolean> {
  const row = await db
    .select({ enabled: leagues.clubAuctionEnabled })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  return Boolean(row[0]?.enabled);
}

// ── Simulation ────────────────────────────────────────────────────────────
// For leagues with `isSimulated=true`, the session route short-circuits the live auction and
// auto-allocates everything. This is the club-auction equivalent of `simulateAuction` in
// simulate.ts. Algorithm: random pairing of fantasy teams to PL clubs, floor price (500K) per
// allocation, bulk-insert ownership rows, deduct purse, mark session completed.

export async function simulateClubAuction(
  leagueId: string,
  sessionId: string
): Promise<{ allocated: number }> {
  // Fetch the session — must exist and be a club-auction
  const sessionRow = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (sessionRow.length === 0) throw new Error("Session not found");
  if (sessionRow[0].type !== CLUB_AUCTION_SESSION_TYPE) {
    throw new Error("simulateClubAuction called on a non-club-auction session");
  }

  // Fetch fantasy teams (non-ghost) and PL clubs (with tier)
  const [leagueTeams, clubs] = await Promise.all([
    db.select().from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false))),
    fetchAllPLClubsWithTiers(),
  ]);

  if (leagueTeams.length === 0) throw new Error("No teams in league to allocate clubs to");
  if (clubs.length === 0) throw new Error("FPL bootstrap returned no PL clubs");

  // Random pairing: shuffle both, pair index-by-index. Auction leagues cap at ≤14 teams, so we
  // never run out of clubs.
  const shuffledTeams = shuffleInPlace([...leagueTeams]);
  const shuffledClubs = shuffleInPlace([...clubs]);
  const pairCount = Math.min(shuffledTeams.length, shuffledClubs.length);

  const now = new Date();
  const price = CLUB_FLOOR_BID;
  const ownershipRecords: (typeof auctionClubOwnership.$inferInsert)[] = [];

  for (let i = 0; i < pairCount; i++) {
    const team = shuffledTeams[i];
    const club = shuffledClubs[i];
    if (!club.tier) {
      // Shouldn't happen — every PL club resolves to a tier via the standings config. If a tier
      // genuinely can't be resolved (FPL added a 21st club, say), skip this pairing rather than
      // writing a tier-less row that scoring can't price.
      console.warn(`[simulateClubAuction] skipping team ${team.id} — club ${club.id} has no tier`);
      continue;
    }
    ownershipRecords.push({
      id: generateId(),
      leagueId,
      teamId: team.id,
      plTeamId: club.id,
      plTeamName: getPlTeamFullName(club.id, club.name),
      plTeamShort: club.short,
      tier: club.tier,
      purchasePrice: price,
      acquiredAt: now,
      createdAt: now,
    });
  }

  if (ownershipRecords.length > 0) {
    await db.insert(auctionClubOwnership).values(ownershipRecords);
  }

  // Deduct purse from each allocated team — one UPDATE per team (mirrors simulate.ts pattern)
  for (const record of ownershipRecords) {
    await db
      .update(teams)
      .set({
        purse: sql`${teams.purse} - ${price}`,
        totalSpent: sql`${teams.totalSpent} + ${price}`,
        updatedAt: now,
      })
      .where(eq(teams.id, record.teamId));
  }

  // Mark the session completed
  await db
    .update(auctionSessions)
    .set({ status: "completed" })
    .where(eq(auctionSessions.id, sessionId));

  await writeAuctionCompleteSnapshot(sessionId).catch((e) => console.error("[auction snapshot]", e));

  return { allocated: ownershipRecords.length };
}
