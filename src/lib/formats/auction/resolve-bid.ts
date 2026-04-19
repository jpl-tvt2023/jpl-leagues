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
  teamPenalties,
  teams,
} from "@/lib/db/schema";
import { eq, and, asc, sql, lte } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { fetchElementInfo } from "@/lib/fpl";
import { leagues } from "@/lib/db/schema";
import { calculatePurse } from "./economy";
import { countsFromOwnership, validateAddPlayer, effectiveMaxSquadSize } from "./squad-rules";

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
 * Resolve an expired bid. The nominator is always the floor bidder, so the
 * player is always sold — either to the highest counter-bidder or, if no one
 * counter-bid, to the nominator at the base price.
 *
 * Returns "sold" if this call resolved the bid, or "already-resolved" if
 * another caller (SSE / safety-net) already handled it.
 */
export async function resolveExpiredBid(
  bid: BidRow
): Promise<"sold" | "already-resolved"> {
  const resolved = await resolveBidToSold(bid);
  return resolved ? "sold" : "already-resolved";
}

// ---- Nominator Advancement ----

/**
 * Advance to the next nominator in the snake order and set a 60s nomination deadline.
 */
export async function advanceNominator(sessionId: string): Promise<void> {
  const sessionRow = await db
    .select({ snakeOrder: auctionSessions.snakeOrder, nominationTimeoutSeconds: auctionSessions.nominationTimeoutSeconds })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (!sessionRow.length) return;

  const snakeOrder: string[] = JSON.parse(sessionRow[0].snakeOrder);
  if (snakeOrder.length === 0) return;

  const nomTimeout = sessionRow[0].nominationTimeoutSeconds ?? 60;
  const deadline = new Date(Date.now() + nomTimeout * 1000);

  // Atomic increment — prevents concurrent callers from computing the same nextIndex
  await db
    .update(auctionSessions)
    .set({
      currentNominatorIndex: sql`(${auctionSessions.currentNominatorIndex} + 1) % ${snakeOrder.length}`,
      nominationDeadline: deadline,
    })
    .where(eq(auctionSessions.id, sessionId));
}

/**
 * Set the nomination deadline for the current nominator (e.g. on session start).
 */
export async function setNominationDeadline(sessionId: string): Promise<void> {
  const sessionRow = await db
    .select({ nominationTimeoutSeconds: auctionSessions.nominationTimeoutSeconds })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  const nomTimeout = sessionRow[0]?.nominationTimeoutSeconds ?? 60;
  const deadline = new Date(Date.now() + nomTimeout * 1000);
  await db
    .update(auctionSessions)
    .set({ nominationDeadline: deadline })
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
  // If the squad is already full, don't even try.
  if (counts.total >= effectiveMaxSquadSize(penaltySlots)) return false;

  const availablePurse = calculatePurse(
    leagueRow[0].initialBudget,
    teamRow[0].totalIncome,
    teamRow[0].totalSpent,
    teamRow[0].totalRefunds
  );

  const elementById = new Map(elements.map((e) => [e.id, e]));

  for (const entry of wishlist) {
    // Skip if player is already owned by anyone
    const owned = await db
      .select({ id: auctionOwnership.id })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          eq(auctionOwnership.fplElementId, entry.fplElementId),
          eq(auctionOwnership.status, "active")
        )
      )
      .limit(1);
    if (owned.length > 0) continue;

    // Skip if we can't afford even the minimum bid
    if (availablePurse < DEFAULT_MIN_BID) return false;

    // Skip if adding this player would break squad rules / position feasibility
    const el = elementById.get(entry.fplElementId);
    if (!el) continue;
    const check = validateAddPlayer(counts, penaltySlots, el.element_type);
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
    const maxSize = effectiveMaxSquadSize(teamRow[0].penaltySlots ?? 0);
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
