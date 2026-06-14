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
  teamPenalties,
  teams,
} from "@/lib/db/schema";
import { eq, and, asc, sql, lte, inArray } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { fetchElementInfo } from "@/lib/fpl";
import { leagues } from "@/lib/db/schema";
import { calculatePurse } from "./economy";
import { countsFromOwnership, validateAddPlayer, effectiveMaxSquadSize, MIN_QUOTA } from "./squad-rules";
import { ownerOfPlayer } from "./ownership";
import { writeAuctionCompleteSnapshot } from "@/lib/backup/snapshot";
import {
  CLUB_AUCTION_SESSION_TYPE,
  resolveClubBid,
  advanceClubNominator,
  setClubNominationDeadline,
  autoNominateClubForTeam,
} from "./club-auction";

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

  // Atomically mark bid as sold ONLY if still open AND timer genuinely expired.
  // .returning() gives us fresh column values (including counter-bid updates)
  // in the same atomic operation — no stale re-read risk from replication lag.
  const updated = await db
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

  // Remove player from every team's wishlist in the league (they're no longer available)
  await db
    .delete(auctionWishlists)
    .where(
      and(
        eq(auctionWishlists.leagueId, bid.leagueId),
        eq(auctionWishlists.fplElementId, fresh.fplElementId)
      )
    );

  // Atomically deduct from winner's purse (no read-then-write race)
  await db
    .update(teams)
    .set({
      purse: sql`${teams.purse} - ${winAmount}`,
      totalSpent: sql`${teams.totalSpent} + ${winAmount}`,
    })
    .where(eq(teams.id, winnerId));

  return true;
}

/**
 * Resolve an expired bid as "unsold": just mark the status.
 */
export async function resolveBidToUnsold(bid: BidRow): Promise<void> {
  await db
    .update(auctionBids)
    .set({ status: "unsold", updatedAt: new Date() })
    .where(eq(auctionBids.id, bid.id));
}

/**
 * Resolve an expired bid. Branches on session type:
 *   - For the **player auction**, the nominator is always the floor bidder, so the player is
 *     always sold (to the high counter-bidder, or back to the nominator at floor).
 *   - For the **club auction**, "no real bids" → unsold; ≥1 real bid → sold to high bidder.
 *
 * Returns "sold" / "unsold" / "already-resolved". "unsold" is only possible for club bids.
 */
export async function resolveExpiredBid(
  bid: BidRow
): Promise<"sold" | "unsold" | "already-resolved"> {
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
 * a fresh nomination deadline for the next team. For a **club auction** this advances the queue cursor
 * and immediately auto-nominates the next PL club (no human in the loop).
 *
 * Proactively skips squad-full teams: after incrementing the cursor, we check whether the new
 * nominator has any open slot left. If not, we keep incrementing. If every team in the order is
 * full, the session is marked `completed` — there's nothing left to auction.
 */
export async function advanceNominator(sessionId: string): Promise<void> {
  const sessionRow = await db
    .select({
      leagueId: auctionSessions.leagueId,
      type: auctionSessions.type,
      snakeOrder: auctionSessions.snakeOrder,
      currentNominatorIndex: auctionSessions.currentNominatorIndex,
      nominationTimeoutSeconds: auctionSessions.nominationTimeoutSeconds,
    })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (!sessionRow.length) return;

  if (sessionRow[0].type === CLUB_AUCTION_SESSION_TYPE) {
    await advanceClubNominator(sessionId);
    return;
  }

  const snakeOrder: string[] = JSON.parse(sessionRow[0].snakeOrder);
  if (snakeOrder.length === 0) return;

  const leagueId = sessionRow[0].leagueId;
  const startIndex = sessionRow[0].currentNominatorIndex ?? 0;

  // Walk forward up to snakeOrder.length steps to find the first eligible (squad-not-full) team.
  for (let step = 1; step <= snakeOrder.length; step++) {
    const nextIndex = (startIndex + step) % snakeOrder.length;
    const candidateTeamId = snakeOrder[nextIndex];
    if (!candidateTeamId) continue;
    const eligible = await isNominatorEligible(leagueId, candidateTeamId);
    if (eligible) {
      const nomTimeout = sessionRow[0].nominationTimeoutSeconds ?? 60;
      const deadline = new Date(Date.now() + nomTimeout * 1000);
      await db
        .update(auctionSessions)
        .set({ currentNominatorIndex: nextIndex, nominationDeadline: deadline })
        .where(eq(auctionSessions.id, sessionId));
      return;
    }
  }

  // No eligible nominators left — every team's squad is full. Complete the session so the
  // auction-completion auto-snapshot fires and the UI flips to "complete".
  console.info("[advanceNominator] no eligible nominators (all squads full) — completing session", {
    sessionId,
    leagueId,
    snakeOrderSize: snakeOrder.length,
  });

  // Composition audit: walk every team in the snake order and flag any squad below 1/3/3/1.
  // We can't force a team to fix composition once the auction has run out, but admins get a
  // single audit_logs row so the league can be addressed out-of-band. Never blocks completion.
  try {
    const allOwnership = await db
      .select({ teamId: auctionOwnership.teamId, elementType: auctionOwnership.elementType })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          inArray(auctionOwnership.teamId, snakeOrder),
          eq(auctionOwnership.status, "active"),
        ),
      );
    const byTeam = new Map<string, { elementType: number | null }[]>();
    for (const r of allOwnership) {
      const list = byTeam.get(r.teamId) ?? [];
      list.push(r);
      byTeam.set(r.teamId, list);
    }
    const offenders: Array<{ teamId: string; missing: Record<string, number> }> = [];
    for (const teamId of snakeOrder) {
      const counts = countsFromOwnership(byTeam.get(teamId) ?? []);
      const missing: Record<string, number> = {};
      for (const t of [1, 2, 3, 4] as const) {
        const need = Math.max(0, MIN_QUOTA[t] - counts[t]);
        if (need > 0) missing[`pos${t}`] = need;
      }
      if (Object.keys(missing).length > 0) {
        offenders.push({ teamId, missing });
      }
    }
    if (offenders.length > 0) {
      await db.insert(auditLogs).values({
        id: generateId(),
        type: "AUCTION_COMPLETED_COMPOSITION_WARNING",
        description: `Session ${sessionId} (league ${leagueId}) auto-completed at all-teams-full but ${offenders.length} team(s) finish below 1/3/3/1 minimum: ${JSON.stringify(offenders).slice(0, 1500)}`,
        pointsAffected: 0,
      });
      console.warn("[advanceNominator] composition warning at completion", { sessionId, leagueId, offenders });
    }
  } catch (e) {
    console.error("[advanceNominator] composition audit failed (continuing to complete session anyway):", e);
  }

  await db
    .update(auctionSessions)
    .set({ status: "completed", nominationDeadline: null })
    .where(eq(auctionSessions.id, sessionId));
  await writeAuctionCompleteSnapshot(sessionId).catch((e) => console.error("[auction snapshot]", e));
}

/**
 * Set the nomination deadline for the current nominator (e.g. on session start, or whenever the SSE
 * stream notices no deadline). For a **club auction** this triggers auto-nomination of the next club
 * instead — there is no per-team nomination turn in club auctions.
 *
 * If the current nominator is already squad-full (mini-auction starting where someone hit cap last
 * cycle, or initial auction starting after a prior session left squad state), delegate to
 * `advanceNominator` which will proactively walk to the next eligible team.
 */
export async function setNominationDeadline(sessionId: string): Promise<void> {
  const sessionRow = await db
    .select({
      leagueId: auctionSessions.leagueId,
      type: auctionSessions.type,
      snakeOrder: auctionSessions.snakeOrder,
      currentNominatorIndex: auctionSessions.currentNominatorIndex,
      nominationTimeoutSeconds: auctionSessions.nominationTimeoutSeconds,
    })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (sessionRow[0]?.type === CLUB_AUCTION_SESSION_TYPE) {
    await setClubNominationDeadline(sessionId);
    return;
  }
  if (!sessionRow.length) return;
  const snakeOrder: string[] = JSON.parse(sessionRow[0].snakeOrder);
  const currentIdx = sessionRow[0].currentNominatorIndex ?? 0;
  const currentTeamId = snakeOrder[currentIdx];
  if (currentTeamId) {
    const eligible = await isNominatorEligible(sessionRow[0].leagueId, currentTeamId);
    if (!eligible) {
      // Walk forward to find someone who can actually nominate.
      await advanceNominator(sessionId);
      return;
    }
  }
  const nomTimeout = sessionRow[0]?.nominationTimeoutSeconds ?? 60;
  const deadline = new Date(Date.now() + nomTimeout * 1000);
  await db
    .update(auctionSessions)
    .set({ nominationDeadline: deadline })
    .where(eq(auctionSessions.id, sessionId));
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
    .select({ intermissionSeconds: auctionSessions.intermissionSeconds })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  const secs = row[0]?.intermissionSeconds ?? 5;
  if (secs <= 0) {
    await advanceNominator(sessionId);
    return;
  }
  await db
    .update(auctionSessions)
    .set({ intermissionUntil: new Date(Date.now() + secs * 1000), nominationDeadline: null })
    .where(eq(auctionSessions.id, sessionId));
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
    .select({ type: auctionSessions.type })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (sessTypeRow[0]?.type === CLUB_AUCTION_SESSION_TYPE) {
    const outcome = await autoNominateClubForTeam(sessionId, nominatorTeamId);
    return outcome === "auto-nominated" ? "auto-nominated" : "skipped-full";
  }

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
      await advanceNominator(sessionId);
      return "skipped-full";
    }
  }

  const autoNominated = await autoNominateFromWishlist(
    sessionId,
    nominatorTeamId,
    leagueId
  );

  if (autoNominated) {
    return "auto-nominated";
  }

  // Wishlist empty/exhausted — penalise and skip
  await applyNominationPenalty(nominatorTeamId, sessionId, leagueId);
  await advanceNominator(sessionId);
  return "penalised";
}
