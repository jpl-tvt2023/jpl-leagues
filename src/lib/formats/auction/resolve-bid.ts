/**
 * Shared auction bid resolution logic.
 *
 * Called from:
 * - SSE stream route (timer expiry during poll)
 * - Session GET route (resolveExpiredBids safety net)
 * - Nominate route (stale-bid cleanup before new nomination)
 *
 * Handles the full lifecycle: mark sold/unsold → create ownership → deduct purse → advance nominator → set next deadline.
 */

import { db } from "@/lib/db";
import {
  auctionBids,
  auctionBidLogs,
  auctionOwnership,
  auctionSessions,
  auctionWishlists,
  auditLogs,
  auctionTurnEvents,
  teamPenalties,
  teams,
} from "@/lib/db/schema";
import { eq, and, asc, sql, lte, inArray, isNull } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { fetchElementInfo } from "@/lib/fpl";
import { leagues } from "@/lib/db/schema";
import { calculatePurse } from "./economy";
import { countsFromOwnership, validateAddPlayer, effectiveMaxSquadSize, MIN_QUOTA } from "./squad-rules";
import { ownerOfPlayer } from "./ownership";
import {
  CLUB_AUCTION_SESSION_TYPE,
  resolveClubBid,
  advanceClubNominator,
  setClubNominationDeadline,
  autoNominateClubForTeam,
} from "./club-auction";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

const DEFAULT_MIN_BID = 500_000;

// ---- Types ----

interface BidRow {
  id: string;
  leagueId: string;
  sessionId: string;
  nominatorTeamId: string;
  fplElementId: number;
  playerName: string;
  currentHighBid: number;
  currentHighBidderId: string;
  minBid: number;
  status: string;
  expiresAt: Date;
}

// ---- Bid Resolution ----

/**
 * Resolve an expired bid as "sold": assign player to winner, deduct purse.
 * Returns true if resolution happened, false if already resolved by another caller.
 *
 * Uses an atomic status guard (open → sold) and re-reads the bid from DB
 * to get the freshest currentHighBid / currentHighBidderId values.
 */
export async function resolveBidToSold(bid: BidRow): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(Date.now() - 2000); // 2s grace period

  // Read the intermission length up front so the claim below can open the beat in its own commit.
  const cfg = await db
    .select({ intermissionSeconds: auctionSessions.intermissionSeconds })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, bid.sessionId))
    .limit(1);
  const intermissionSecs = cfg[0]?.intermissionSeconds ?? 5;

  // Atomically mark bid as sold ONLY if still open AND timer genuinely expired,
  // AND open the post-sale intermission in the SAME commit.
  //
  // .returning() gives us fresh column values (including counter-bid updates)
  // in the same atomic operation — no stale re-read risk from replication lag.
  //
  // The intermission belongs in here rather than in the caller's `beginIntermission` because
  // "lot sold" and "intermission open" must not be separately observable. Between them the session
  // row reads: no open bid, no deadline, no intermission — indistinguishable from an idle auction
  // sitting on `currentNominatorIndex`. Every connected browser polls that state every 2s, and the
  // first to see it arms a fresh nomination window for the cursor, which still points at the team
  // whose lot just sold. They nominate again, and the next team's turn is lost behind it. A
  // concurrency soak reproduces ~36 such doubles in 40 lots when these are two writes; as one
  // commit the intermediate state does not exist. `beginIntermission` is idempotent, so the
  // caller's follow-up call is a no-op on this path.
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(auctionBids)
      .set({ status: "sold", updatedAt: now })
      .where(
        and(
          eq(auctionBids.id, bid.id),
          eq(auctionBids.status, "open"),
          lte(auctionBids.expiresAt, cutoff)
        )
      )
      .returning();
    if (rows.length === 0) return rows;

    if (intermissionSecs > 0) {
      await tx
        .update(auctionSessions)
        .set({
          intermissionUntil: new Date(Date.now() + intermissionSecs * 1000),
          nominationDeadline: null,
        })
        .where(eq(auctionSessions.id, bid.sessionId));
    }
    return rows;
  });

  // If no row was returned, either already resolved or timer was extended
  if (updated.length === 0) return false;

  const fresh = updated[0];
  const winnerId = fresh.currentHighBidderId;
  const winAmount = fresh.currentHighBid;

  // Double-sell guard: if another bid for the same player already produced an active ownership
  // row (race window where two `auctionBids` rows for the same fplElementId both reached this
  // point), treat THIS bid as a duplicate. Mark its status, log the cancellation, do not insert
  // ownership, do not deduct purse, and return false so the caller does NOT advance the
  // nominator (the other winning bid is responsible for that). This was the root cause of the
  // "Wharton sold to two teams" bug.
  const existingOwner = await ownerOfPlayer(bid.leagueId, fresh.fplElementId);
  if (existingOwner) {
    await db
      .update(auctionBids)
      .set({ status: "cancelled-duplicate", updatedAt: now })
      .where(eq(auctionBids.id, bid.id));
    await db.insert(auctionBidLogs).values({
      id: generateId(),
      bidId: bid.id,
      teamId: winnerId,
      amount: winAmount,
      type: "cancelled-duplicate",
    });
    console.error("[resolveBidToSold] duplicate active ownership detected — bid cancelled, no purse deducted", {
      bidId: bid.id,
      leagueId: bid.leagueId,
      fplElementId: fresh.fplElementId,
      existingOwnerTeamId: existingOwner,
      wouldBeWinnerTeamId: winnerId,
    });
    return false;
  }

  // Look up element type from FPL cache for position quota tracking
  let elementType: number | null = null;
  try {
    const elements = await fetchElementInfo();
    const player = elements.find((e) => e.id === fresh.fplElementId);
    elementType = player?.element_type ?? null;
  } catch {
    // Non-critical — ownership still created without position type
  }

  // Create ownership record (uses fresh values from RETURNING)
  await db.insert(auctionOwnership).values({
    id: generateId(),
    leagueId: bid.leagueId,
    teamId: winnerId,
    fplElementId: fresh.fplElementId,
    playerName: fresh.playerName,
    elementType,
    purchasePrice: winAmount,
    acquiredGw: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  // Log the sold event
  await db.insert(auctionBidLogs).values({
    id: generateId(),
    bidId: bid.id,
    teamId: winnerId,
    amount: winAmount,
    type: "sold",
  });

  // Note: wishlist rows for this player are intentionally left in place — "sold" is derived
  // client/server-side from live ownership (see ownerOfPlayer below, and ownedElementIds in the
  // UI), not tracked as a stored flag here. See useWishlist.ts for why.

  // Atomically deduct from winner's purse (no read-then-write race)
  await db
    .update(teams)
    .set({
      purse: sql`${teams.purse} - ${winAmount}`,
      totalSpent: sql`${teams.totalSpent} + ${winAmount}`,
    })
    .where(eq(teams.id, winnerId));

  // Bust the standings page cache — without this, /api/standings keeps serving pre-sale
  // ownership/purse data until the cache naturally expires (mirrors club-auction.ts).
  await invalidateLeaguePageCache(bid.leagueId).catch((err) =>
    console.error("[resolve-bid] standings cache invalidation failed:", err)
  );

  return true;
}

/**
 * Resolve an expired bid. Branches on session type:
 *   - For the **player auction**, the nominator is always the floor bidder, so the player is
 *     always sold (to the high counter-bidder, or back to the nominator at floor).
 *   - For the **club auction**, the nominator is likewise always the floor bidder, so the club is
 *     always sold (to a higher counter-bid, or back to the nominator).
 *
 * Returns "sold" / "already-resolved".
 */
export async function resolveExpiredBid(
  bid: BidRow
): Promise<"sold" | "already-resolved"> {
  // Look up session type cheaply
  const sess = await db
    .select({ type: auctionSessions.type })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, bid.sessionId))
    .limit(1);
  if (sess[0]?.type === CLUB_AUCTION_SESSION_TYPE) {
    return resolveClubBid(bid);
  }
  const resolved = await resolveBidToSold(bid);
  return resolved ? "sold" : "already-resolved";
}

// ---- Nominator Advancement ----

/** Actor that drove a turn mutation — see `auction_turn_events.actor`. */
export type TurnActor = "sse" | "rest" | "nominate" | "admin";

/**
 * Append a turn-cycle event. Best-effort: the audit trail must never be able to break the auction,
 * so failures are logged and swallowed.
 *
 * This exists because turn state is a single mutable row with no history. When the 2026-08-19
 * session ate seven turns, six left no trace at all and had to be reconstructed from gaps in
 * `auction_bids.created_at` versus the snake ring.
 */
export async function logTurnEvent(entry: {
  sessionId: string;
  leagueId: string;
  teamId?: string | null;
  nominatorIndex?: number | null;
  event: string;
  actor: TurnActor;
  detail?: unknown;
}): Promise<void> {
  try {
    await db.insert(auctionTurnEvents).values({
      id: generateId(),
      sessionId: entry.sessionId,
      leagueId: entry.leagueId,
      teamId: entry.teamId ?? null,
      nominatorIndex: entry.nominatorIndex ?? null,
      event: entry.event,
      actor: entry.actor,
      detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
    });
  } catch (err) {
    console.error("[turn-event] insert failed", entry.event, err);
  }
}

/** Parse a `makeupQueue` / `snakeOrder` JSON column defensively — a malformed value must not stall the auction. */
function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * True if `teamId` has at least one open slot in their squad given current ownership + penalty +
 * bonus slot config. Used by `advanceNominator` to proactively skip squad-full teams instead of
 * giving them a turn that always times out.
 */
async function isNominatorEligible(leagueId: string, teamId: string): Promise<boolean> {
  const [teamRow, ownership] = await Promise.all([
    db.select({ penaltySlots: teams.penaltySlots, bonusSlots: teams.bonusSlots }).from(teams).where(eq(teams.id, teamId)).limit(1),
    db
      .select({ elementType: auctionOwnership.elementType })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          eq(auctionOwnership.teamId, teamId),
          eq(auctionOwnership.status, "active"),
        ),
      ),
  ]);
  if (teamRow.length === 0) return false;
  const counts = countsFromOwnership(ownership);
  const maxSize = effectiveMaxSquadSize(teamRow[0].penaltySlots ?? 0, teamRow[0].bonusSlots ?? 0);
  return counts.total < maxSize;
}

/**
 * Advance to the next nominator. For a **player auction** this rolls the snake-order cursor and sets
 * a fresh nomination deadline for the next team. For a **club auction** this rolls the same kind of
 * turn order to the next club-less team and arms their nomination deadline — a human still nominates.
 *
 * Proactively skips squad-full teams: after incrementing the cursor, we check whether the new
 * nominator has any open slot left. If not, we keep incrementing. If every team in the order is
 * full we idle and wait for the admin to complete the session.
 *
 * **Make-up turns take priority over the ring.** If `makeupQueue` is non-empty this arms its head
 * instead of stepping the ring, parking the real ring position in `ringReturnIndex`.
 *
 * Every write is a compare-and-swap against the state the caller observed. That matters because
 * ~20 independent processes (one SSE poll loop per connected browser, plus a mutating REST poll per
 * client) all run this cycle concurrently against one row. An unguarded write here is what let two
 * callers each step the cursor and silently eat a team's turn.
 */
export async function advanceNominator(
  sessionId: string,
  opts: { claimIntermission?: Date | null; expectIndex?: number; actor?: TurnActor } = {},
): Promise<void> {
  const sessionRow = await db
    .select({
      leagueId: auctionSessions.leagueId,
      type: auctionSessions.type,
      snakeOrder: auctionSessions.snakeOrder,
      currentNominatorIndex: auctionSessions.currentNominatorIndex,
      nominationTimeoutSeconds: auctionSessions.nominationTimeoutSeconds,
      makeupQueue: auctionSessions.makeupQueue,
      ringReturnIndex: auctionSessions.ringReturnIndex,
    })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (!sessionRow.length) return;

  const actor: TurnActor = opts.actor ?? "sse";

  // When advancing out of a post-sale intermission, the claim on `intermissionUntil` and the cursor
  // move must be ONE write. Claiming separately meant a request torn down between the two — routine
  // for SSE on serverless — consumed the intermission without moving the cursor.
  //
  // The claim matches the caller's OBSERVED `intermissionUntil`, not merely "some intermission
  // exists": the caller read its value in an earlier snapshot, and a newer intermission may have
  // been written since. Matching exactly means a stale caller affects 0 rows instead of spending a
  // token that belongs to a later lot (which advanced the cursor twice and skipped a team).
  //
  // `expectIndex` extends the same discipline to callers that hold no intermission token — the
  // penalty and squad-full paths. Without it those writes were unguarded, so a concurrent advance
  // could double-step the cursor on exactly the code path that runs when someone misses a turn.
  const claiming = opts.claimIntermission != null;
  const rawQueue = sessionRow[0].makeupQueue ?? "[]";
  const guards = [eq(auctionSessions.id, sessionId)];
  if (claiming) guards.push(eq(auctionSessions.intermissionUntil, opts.claimIntermission as Date));
  if (opts.expectIndex != null) guards.push(eq(auctionSessions.currentNominatorIndex, opts.expectIndex));
  // Pin the queue too: a concurrent admin grant must not be silently swallowed by this write.
  guards.push(eq(auctionSessions.makeupQueue, rawQueue));
  const claimWhere = and(...guards);
  const claimSet = claiming ? { intermissionUntil: null } : {};

  if (sessionRow[0].type === CLUB_AUCTION_SESSION_TYPE) {
    await advanceClubNominator(sessionId, opts);
    return;
  }

  const snakeOrder: string[] = parseIdList(sessionRow[0].snakeOrder);
  if (snakeOrder.length === 0) return;

  const leagueId = sessionRow[0].leagueId;
  const nomTimeout = sessionRow[0].nominationTimeoutSeconds ?? 60;
  const cursor = sessionRow[0].currentNominatorIndex ?? 0;

  // ---- Make-up turns first ----
  //
  // A make-up turn is an INSERTION, not a cursor move: once the queue drains the ring must resume
  // exactly where it stopped, or rectifying one turn re-skews everyone after it. We still move
  // `currentNominatorIndex` onto the make-up team, because every downstream consumer (the SSE
  // payloads, the auction room UI, and the nominate route's "is it your turn" check) derives the
  // active nominator from it. The real ring position is parked in `ringReturnIndex` instead.
  const queue = parseIdList(rawQueue);
  if (queue.length > 0) {
    for (let k = 0; k < queue.length; k++) {
      const teamId = queue[k];
      const armIndex = snakeOrder.indexOf(teamId);
      // Drop entries not in this session's order, or whose squad has since filled up — arming them
      // would just burn the window and hand out a penalty for a turn we owed them.
      if (armIndex < 0) continue;
      if (!(await isNominatorEligible(leagueId, teamId))) continue;

      const remaining = queue.slice(k + 1);
      const ringReturn = sessionRow[0].ringReturnIndex ?? cursor;
      const updated = await db
        .update(auctionSessions)
        .set({
          ...claimSet,
          currentNominatorIndex: armIndex,
          ringReturnIndex: ringReturn,
          makeupQueue: JSON.stringify(remaining),
          nominationDeadline: new Date(Date.now() + nomTimeout * 1000),
        })
        .where(claimWhere);
      if (updated.rowsAffected > 0) {
        await logTurnEvent({
          sessionId,
          leagueId,
          teamId,
          nominatorIndex: armIndex,
          event: "makeup-armed",
          actor,
          detail: { remaining, ringReturnIndex: ringReturn },
        });
      }
      return;
    }
    // Every queued entry was stale or ineligible — fall through to the ring, clearing the queue in
    // the same write below so it cannot be retried forever.
  }

  // ---- Normal ring walk ----
  //
  // Resume from `ringReturnIndex` when coming off a make-up turn, so the inserted turn costs nobody
  // their place in the order.
  const startIndex = sessionRow[0].ringReturnIndex ?? cursor;

  // Walk forward up to snakeOrder.length steps to find the first eligible (squad-not-full) team.
  for (let step = 1; step <= snakeOrder.length; step++) {
    const nextIndex = (startIndex + step) % snakeOrder.length;
    const candidateTeamId = snakeOrder[nextIndex];
    if (!candidateTeamId) continue;
    const eligible = await isNominatorEligible(leagueId, candidateTeamId);
    if (eligible) {
      const updated = await db
        .update(auctionSessions)
        .set({
          ...claimSet,
          currentNominatorIndex: nextIndex,
          nominationDeadline: new Date(Date.now() + nomTimeout * 1000),
          ringReturnIndex: null,
          makeupQueue: "[]",
        })
        .where(claimWhere);
      if (updated.rowsAffected > 0) {
        await logTurnEvent({
          sessionId,
          leagueId,
          teamId: candidateTeamId,
          nominatorIndex: nextIndex,
          event: "advanced",
          actor,
          detail: { from: startIndex },
        });
      }
      return;
    }
  }

  // No eligible nominators left — every team's squad is full. Per spec, do NOT auto-complete the
  // session: leave it active and idle (deadline cleared) and wait for the admin to mark it complete.
  console.info("[advanceNominator] no eligible nominators (all squads full) — idling, awaiting admin completion", {
    sessionId,
    leagueId,
    snakeOrderSize: snakeOrder.length,
  });
  await db
    .update(auctionSessions)
    .set({ ...claimSet, nominationDeadline: null, ringReturnIndex: null, makeupQueue: "[]" })
    .where(claimWhere);
}

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

export interface CompositionOffender {
  teamId: string;
  teamName: string;
  /** e.g. { pos1: 1, pos2: 2 } — how many more of each position are still required. */
  missing: Record<string, number>;
  /** Human-readable summary, e.g. "1 GKP, 2 DEF". */
  summary: string;
}

/**
 * Find the teams in a player auction's snake order that currently sit below the 1/3/3/1 positional
 * minimum. No-op (empty array) for club auctions. Used both for the non-blocking audit log and as
 * the hard gate that blocks an admin from completing the auction (a team that released players must
 * rebuild to 1/3/3/1 before the next auction concludes).
 */
export async function findCompositionOffenders(sessionId: string): Promise<CompositionOffender[]> {
  const sessionRow = await db
    .select({ leagueId: auctionSessions.leagueId, type: auctionSessions.type, snakeOrder: auctionSessions.snakeOrder })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (!sessionRow.length || sessionRow[0].type === CLUB_AUCTION_SESSION_TYPE) return [];
  const leagueId = sessionRow[0].leagueId;
  let snakeOrder: string[] = [];
  try { snakeOrder = JSON.parse(sessionRow[0].snakeOrder); } catch { return []; }
  if (!Array.isArray(snakeOrder) || snakeOrder.length === 0) return [];

  const [allOwnership, teamRows] = await Promise.all([
    db
      .select({ teamId: auctionOwnership.teamId, elementType: auctionOwnership.elementType })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          inArray(auctionOwnership.teamId, snakeOrder),
          eq(auctionOwnership.status, "active"),
        ),
      ),
    db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, snakeOrder)),
  ]);
  const nameByTeam = new Map(teamRows.map((t) => [t.id, t.name]));
  const byTeam = new Map<string, { elementType: number | null }[]>();
  for (const r of allOwnership) {
    const list = byTeam.get(r.teamId) ?? [];
    list.push(r);
    byTeam.set(r.teamId, list);
  }
  const offenders: CompositionOffender[] = [];
  for (const teamId of snakeOrder) {
    const counts = countsFromOwnership(byTeam.get(teamId) ?? []);
    const missing: Record<string, number> = {};
    const parts: string[] = [];
    for (const t of [1, 2, 3, 4] as const) {
      const need = Math.max(0, MIN_QUOTA[t] - counts[t]);
      if (need > 0) {
        missing[`pos${t}`] = need;
        parts.push(`${need} ${POSITION_LABELS[t]}`);
      }
    }
    if (parts.length > 0) {
      offenders.push({ teamId, teamName: nameByTeam.get(teamId) ?? teamId, missing, summary: parts.join(", ") });
    }
  }
  return offenders;
}

/**
 * One-time squad-composition audit, run when an admin completes a player auction: flags any team
 * finishing below the 1/3/3/1 minimum into `audit_logs` (non-blocking). No-op for club auctions.
 * Moved out of `advanceNominator` now that auctions no longer auto-complete.
 */
export async function auditAuctionComposition(sessionId: string): Promise<void> {
  try {
    const offenders = await findCompositionOffenders(sessionId);
    if (offenders.length > 0) {
      await db.insert(auditLogs).values({
        id: generateId(),
        type: "AUCTION_COMPLETED_COMPOSITION_WARNING",
        description: `Session ${sessionId} completed but ${offenders.length} team(s) finish below 1/3/3/1 minimum: ${JSON.stringify(offenders).slice(0, 1500)}`,
        pointsAffected: 0,
      });
      console.warn("[auditAuctionComposition] composition warning at completion", { sessionId, offenders });
    }
  } catch (e) {
    console.error("[auditAuctionComposition] failed (non-blocking):", e);
  }
}

/**
 * True when every team in `teamIds` has filled its squad to the effective cap (no open slots) — i.e.
 * no team can still nominate. This is the player-auction analogue of "all clubs allocated": it marks
 * the point where a live auction has effectively run its course and only awaits admin completion.
 */
export async function allSquadsFull(leagueId: string, teamIds: string[]): Promise<boolean> {
  if (teamIds.length === 0) return false;
  const [teamRows, ownership] = await Promise.all([
    db
      .select({ id: teams.id, penaltySlots: teams.penaltySlots, bonusSlots: teams.bonusSlots })
      .from(teams)
      .where(inArray(teams.id, teamIds)),
    db
      .select({ teamId: auctionOwnership.teamId, elementType: auctionOwnership.elementType })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          inArray(auctionOwnership.teamId, teamIds),
          eq(auctionOwnership.status, "active"),
        ),
      ),
  ]);
  const byTeam = new Map<string, { elementType: number | null }[]>();
  for (const r of ownership) {
    const list = byTeam.get(r.teamId) ?? [];
    list.push(r);
    byTeam.set(r.teamId, list);
  }
  for (const t of teamRows) {
    const counts = countsFromOwnership(byTeam.get(t.id) ?? []);
    const maxSize = effectiveMaxSquadSize(t.penaltySlots ?? 0, t.bonusSlots ?? 0);
    if (counts.total < maxSize) return false; // this team still has an open slot → can nominate
  }
  return true;
}

/**
 * Set the nomination deadline for the current nominator (e.g. on session start, or whenever the SSE
 * stream notices no deadline). For a **club auction** this arms the current club-less team's
 * nomination deadline the same way — each team gets its own turn to nominate a club.
 *
 * If the current nominator is already squad-full (mini-auction starting where someone hit cap last
 * cycle, or initial auction starting after a prior session left squad state), delegate to
 * `advanceNominator` which will proactively walk to the next eligible team.
 */
export async function setNominationDeadline(
  sessionId: string,
  opts: { expectIndex?: number; actor?: TurnActor } = {},
): Promise<void> {
  const sessionRow = await db
    .select({
      leagueId: auctionSessions.leagueId,
      type: auctionSessions.type,
      snakeOrder: auctionSessions.snakeOrder,
      currentNominatorIndex: auctionSessions.currentNominatorIndex,
      nominationTimeoutSeconds: auctionSessions.nominationTimeoutSeconds,
      makeupQueue: auctionSessions.makeupQueue,
      intermissionUntil: auctionSessions.intermissionUntil,
    })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (sessionRow[0]?.type === CLUB_AUCTION_SESSION_TYPE) {
    await setClubNominationDeadline(sessionId, opts);
    return;
  }
  if (!sessionRow.length) return;

  // Nothing to arm while a post-sale beat is running — the advance that ends it will arm the next
  // team itself. Bailing here (rather than relying only on the write guard below) also keeps the
  // make-up delegation from arming a team while leaving the intermission behind for a later,
  // spurious second claim.
  if (sessionRow[0].intermissionUntil) return;

  const actor: TurnActor = opts.actor ?? "sse";
  const leagueId = sessionRow[0].leagueId;
  const snakeOrder: string[] = parseIdList(sessionRow[0].snakeOrder);
  const currentIdx = sessionRow[0].currentNominatorIndex ?? 0;

  // A make-up turn is owed — arm its head rather than the ring cursor. `advanceNominator` owns that
  // logic (and leaves the ring position parked in `ringReturnIndex`), so delegate rather than
  // duplicate it here.
  if (parseIdList(sessionRow[0].makeupQueue).length > 0) {
    await advanceNominator(sessionId, { expectIndex: opts.expectIndex ?? currentIdx, actor });
    return;
  }

  const currentTeamId = snakeOrder[currentIdx];
  if (currentTeamId) {
    const eligible = await isNominatorEligible(leagueId, currentTeamId);
    if (!eligible) {
      // Walk forward to find someone who can actually nominate.
      await advanceNominator(sessionId, { expectIndex: currentIdx, actor });
      return;
    }
  }

  // Never arm a window while a lot is on the block. The caller decided there was none from a
  // snapshot taken at the top of its poll; a nomination landing since then means the turn is already
  // spent, and arming here would hand the same team a second one.
  const liveBid = await db
    .select({ id: auctionBids.id })
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")))
    .limit(1);
  if (liveBid.length > 0) return;

  const nomTimeout = sessionRow[0]?.nominationTimeoutSeconds ?? 60;
  const deadline = new Date(Date.now() + nomTimeout * 1000);

  // Compare-and-swap, NOT a bare write by session id. This is the fallback that arms a window when
  // nothing is armed, and every connected browser runs it on its own 2s poll off a snapshot taken
  // at the top of the tick.
  //
  // Selling a lot takes two writes — mark the bid sold, then open the intermission. A tick landing
  // between them sees no open bid, no intermission and no deadline, and used to arm a fresh full
  // window for `currentNominatorIndex`, which still pointed at the team that had just sold. That
  // handed the same team a second consecutive nomination and, once a stale poll consumed the
  // window, cost the next team its turn outright.
  //
  // Requiring both fields to still be NULL at write time means such a tick affects 0 rows: by then
  // `beginIntermission` has landed. `expectIndex` additionally pins the cursor the caller observed.
  const guards = [
    eq(auctionSessions.id, sessionId),
    isNull(auctionSessions.nominationDeadline),
    isNull(auctionSessions.intermissionUntil),
  ];
  if (opts.expectIndex != null) guards.push(eq(auctionSessions.currentNominatorIndex, opts.expectIndex));

  const updated = await db
    .update(auctionSessions)
    .set({ nominationDeadline: deadline })
    .where(and(...guards));

  if (updated.rowsAffected > 0) {
    await logTurnEvent({
      sessionId,
      leagueId,
      teamId: currentTeamId ?? null,
      nominatorIndex: currentIdx,
      event: "armed",
      actor,
    });
  }
}

/**
 * Start a post-sale intermission: a short cooldown after a lot sells, during which all clients
 * re-sync to authoritative state and see a "next nomination in N" countdown before the next
 * nominator is armed. Sets `intermissionUntil` and clears any nomination deadline; the SSE stream
 * advances the nominator once the window elapses. If the session's `intermissionSeconds` is 0 the
 * intermission is disabled and we advance immediately (preserving the old instant-advance behaviour).
 */
export async function beginIntermission(sessionId: string): Promise<void> {
  const row = await db
    .select({
      intermissionSeconds: auctionSessions.intermissionSeconds,
      currentNominatorIndex: auctionSessions.currentNominatorIndex,
    })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  const secs = row[0]?.intermissionSeconds ?? 5;
  if (secs <= 0) {
    // No intermission to claim, so pin the cursor we observed instead — otherwise this is a bare
    // write that a concurrent advance can double-step.
    await advanceNominator(sessionId, { expectIndex: row[0]?.currentNominatorIndex ?? undefined });
    return;
  }
  // Idempotent: only opens a beat when one is not already running. `resolveBidToSold` now opens the
  // post-sale intermission inside the same commit that marks the lot sold, so the callers that still
  // invoke this after a sale land here as a no-op. Without the guard they would push the beat out by
  // another full interval each time, and N pollers resolving concurrently would stretch it further.
  await db
    .update(auctionSessions)
    .set({ intermissionUntil: new Date(Date.now() + secs * 1000), nominationDeadline: null })
    .where(and(eq(auctionSessions.id, sessionId), isNull(auctionSessions.intermissionUntil)));
}

/**
 * Clear the nomination deadline (called when a manual nomination is made).
 */
export async function clearNominationDeadline(
  sessionId: string
): Promise<void> {
  await db
    .update(auctionSessions)
    .set({ nominationDeadline: null })
    .where(eq(auctionSessions.id, sessionId));
}

// ---- Auto-Nomination ----

/**
 * Create a nomination bid for a player (used by auto-nomination).
 */
async function createNomination(
  sessionId: string,
  nominatorTeamId: string,
  leagueId: string,
  fplElementId: number,
  playerName: string
): Promise<string> {
  const sessionRow = await db
    .select({ bidTimerSeconds: auctionSessions.bidTimerSeconds })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  const bidTimer = sessionRow[0]?.bidTimerSeconds ?? 20;
  const bidId = generateId();
  const expiresAt = new Date(Date.now() + bidTimer * 1000);

  await db.insert(auctionBids).values({
    id: bidId,
    leagueId,
    sessionId,
    nominatorTeamId,
    fplElementId,
    playerName,
    currentHighBid: DEFAULT_MIN_BID,
    currentHighBidderId: nominatorTeamId,
    minBid: DEFAULT_MIN_BID,
    status: "open",
    expiresAt,
  });

  // Log the nomination event
  await db.insert(auctionBidLogs).values({
    id: generateId(),
    bidId,
    teamId: nominatorTeamId,
    amount: DEFAULT_MIN_BID,
    type: "nomination",
  });

  // Clear the nomination deadline — the bid timer now takes over
  await clearNominationDeadline(sessionId);

  return bidId;
}

/**
 * Attempt to auto-nominate from a team's wishlist.
 * Picks the highest-priority unowned player and creates a nomination.
 * Returns true if a nomination was created, false if wishlist exhausted.
 */
export async function autoNominateFromWishlist(
  sessionId: string,
  teamId: string,
  leagueId: string
): Promise<boolean> {
  const [wishlist, teamRow, leagueRow, ownership, elements] = await Promise.all([
    db
      .select()
      .from(auctionWishlists)
      .where(
        and(
          eq(auctionWishlists.leagueId, leagueId),
          eq(auctionWishlists.teamId, teamId)
        )
      )
      .orderBy(asc(auctionWishlists.priority)),
    db.select().from(teams).where(eq(teams.id, teamId)).limit(1),
    db.select({ initialBudget: leagues.initialBudget }).from(leagues).where(eq(leagues.id, leagueId)).limit(1),
    db
      .select({ elementType: auctionOwnership.elementType, fplElementId: auctionOwnership.fplElementId })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          eq(auctionOwnership.teamId, teamId),
          eq(auctionOwnership.status, "active")
        )
      ),
    fetchElementInfo(),
  ]);

  if (teamRow.length === 0 || leagueRow.length === 0) return false;

  const counts = countsFromOwnership(ownership);
  const penaltySlots = teamRow[0].penaltySlots ?? 0;
  const bonusSlots = teamRow[0].bonusSlots ?? 0;
  // If the squad is already full, don't even try.
  if (counts.total >= effectiveMaxSquadSize(penaltySlots, bonusSlots)) return false;

  const availablePurse = calculatePurse(
    leagueRow[0].initialBudget,
    teamRow[0].totalIncome,
    teamRow[0].totalSpent,
    teamRow[0].totalRefunds
  );

  const elementById = new Map(elements.map((e) => [e.id, e]));

  for (const entry of wishlist) {
    // Skip if player is already owned (or pending_release) by any team — single source of truth
    // via `ownerOfPlayer`, which keeps this auto-nominate path consistent with the nominate route
    // and `resolveBidToSold`'s pre-INSERT check.
    if (await ownerOfPlayer(leagueId, entry.fplElementId)) continue;

    // Skip if we can't afford even the minimum bid
    if (availablePurse < DEFAULT_MIN_BID) return false;

    // Skip if adding this player would break squad rules / position feasibility
    const el = elementById.get(entry.fplElementId);
    if (!el) continue;
    const check = validateAddPlayer(counts, penaltySlots, el.element_type, bonusSlots);
    if (!check.ok) continue;

    await createNomination(
      sessionId,
      teamId,
      leagueId,
      entry.fplElementId,
      entry.playerName
    );
    return true;
  }

  return false; // All wishlist entries already owned, unaffordable, or infeasible
}

/**
 * Apply a penalty for missed nomination (empty wishlist + timeout).
 * Increments penaltySlots on the team and records a per-row penalty ledger
 * entry so redemption pricing can know which cycle issued it.
 */
export async function applyNominationPenalty(
  teamId: string,
  sessionId: string,
  leagueId: string
): Promise<void> {
  const sessionRow = await db
    .select({ cycleNumber: auctionSessions.cycleNumber })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  const cycleNumber = sessionRow[0]?.cycleNumber ?? 0;

  await db.insert(teamPenalties).values({
    id: generateId(),
    leagueId,
    teamId,
    sessionId,
    incurredCycle: cycleNumber,
  });

  await db
    .update(teams)
    .set({ penaltySlots: sql`${teams.penaltySlots} + 1` })
    .where(eq(teams.id, teamId));
}

/**
 * Handle nomination timeout: auto-nominate from wishlist or penalise.
 * Called by the SSE stream when nominationDeadline expires with no open bid.
 * Returns: "auto-nominated" | "penalised"
 */
export async function handleNominationTimeout(
  sessionId: string,
  nominatorTeamId: string,
  leagueId: string
): Promise<"auto-nominated" | "penalised" | "skipped-full"> {
  // Club auction: no wishlist / penalty model — auto-pick a random available club for the team so
  // the snake keeps moving. A "completed"/"noop" outcome (e.g. clubs exhausted) maps to skipped-full.
  const sessTypeRow = await db
    .select({ type: auctionSessions.type, currentNominatorIndex: auctionSessions.currentNominatorIndex })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  const nominatorIndex = sessTypeRow[0]?.currentNominatorIndex ?? null;
  if (sessTypeRow[0]?.type === CLUB_AUCTION_SESSION_TYPE) {
    const outcome = await autoNominateClubForTeam(sessionId, nominatorTeamId);
    return outcome === "auto-nominated" ? "auto-nominated" : "skipped-full";
  }

  // Both terminal branches below end the turn via `beginIntermission`, NOT a direct
  // `advanceNominator`. Two reasons:
  //
  //  1. It matches the intended cycle — nominate (or auto-nominate, or penalise) → 5s intermission
  //     → next in queue. Previously a missed turn skipped the beat entirely and armed the next team
  //     instantly, so whoever followed a penalty got no sync pause and a countdown that had already
  //     started before their client heard about it.
  //  2. Advancing here meant a bare, unguarded cursor write on exactly the path that runs when
  //     someone misses a turn, letting a concurrent advance double-step the cursor and eat a second
  //     team's turn. Routing through the intermission means the single CAS-guarded advance in
  //     `advanceNominator` is the only thing that ever moves the cursor.

  // If the team's squad is already full (or full minus penalty slots), skip
  // them without penalty — they have nothing left to bid on.
  const [teamRow, ownership] = await Promise.all([
    db.select().from(teams).where(eq(teams.id, nominatorTeamId)).limit(1),
    db
      .select({ elementType: auctionOwnership.elementType })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          eq(auctionOwnership.teamId, nominatorTeamId),
          eq(auctionOwnership.status, "active")
        )
      ),
  ]);
  if (teamRow.length > 0) {
    const counts = countsFromOwnership(ownership);
    const maxSize = effectiveMaxSquadSize(teamRow[0].penaltySlots ?? 0, teamRow[0].bonusSlots ?? 0);
    if (counts.total >= maxSize) {
      await logTurnEvent({
        sessionId,
        leagueId,
        teamId: nominatorTeamId,
        nominatorIndex,
        event: "skipped-full",
        actor: "sse",
        detail: { squadSize: counts.total, maxSize },
      });
      await beginIntermission(sessionId);
      return "skipped-full";
    }
  }

  const autoNominated = await autoNominateFromWishlist(
    sessionId,
    nominatorTeamId,
    leagueId
  );

  if (autoNominated) {
    await logTurnEvent({
      sessionId,
      leagueId,
      teamId: nominatorTeamId,
      nominatorIndex,
      event: "auto-nominated",
      actor: "sse",
    });
    return "auto-nominated";
  }

  // Wishlist empty/exhausted — penalise and skip
  await applyNominationPenalty(nominatorTeamId, sessionId, leagueId);
  await logTurnEvent({
    sessionId,
    leagueId,
    teamId: nominatorTeamId,
    nominatorIndex,
    event: "penalised",
    actor: "sse",
  });
  await beginIntermission(sessionId);
  return "penalised";
}
