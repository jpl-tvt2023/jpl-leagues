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
  auctionOwnership,
  auctionSessions,
  auctionWishlists,
  teams,
} from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { generateId } from "@/lib/id";

const NOMINATION_TIMEOUT_SECONDS = 60;
const DEFAULT_MIN_BID = 500_000;
const BID_TIMER_SECONDS = 30;

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
 */
export async function resolveBidToSold(bid: BidRow): Promise<void> {
  const now = new Date();

  // Mark bid as sold
  await db
    .update(auctionBids)
    .set({ status: "sold", updatedAt: now })
    .where(eq(auctionBids.id, bid.id));

  // Create ownership record
  await db.insert(auctionOwnership).values({
    id: generateId(),
    leagueId: bid.leagueId,
    teamId: bid.currentHighBidderId,
    fplElementId: bid.fplElementId,
    playerName: bid.playerName,
    purchasePrice: bid.currentHighBid,
    acquiredGw: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  // Deduct from winner's purse
  const teamRow = await db
    .select({ purse: teams.purse, totalSpent: teams.totalSpent })
    .from(teams)
    .where(eq(teams.id, bid.currentHighBidderId))
    .limit(1);
  if (teamRow.length) {
    await db
      .update(teams)
      .set({
        purse: teamRow[0].purse - bid.currentHighBid,
        totalSpent: teamRow[0].totalSpent + bid.currentHighBid,
      })
      .where(eq(teams.id, bid.currentHighBidderId));
  }
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
 */
export async function resolveExpiredBid(bid: BidRow): Promise<"sold"> {
  await resolveBidToSold(bid);
  return "sold";
}

// ---- Nominator Advancement ----

/**
 * Advance to the next nominator in the snake order and set a 60s nomination deadline.
 */
export async function advanceNominator(sessionId: string): Promise<void> {
  const sessionRow = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (!sessionRow.length) return;

  const snakeOrder: string[] = JSON.parse(sessionRow[0].snakeOrder);
  if (snakeOrder.length === 0) return;

  const nextIndex =
    (sessionRow[0].currentNominatorIndex + 1) % snakeOrder.length;
  const deadline = new Date(Date.now() + NOMINATION_TIMEOUT_SECONDS * 1000);

  await db
    .update(auctionSessions)
    .set({
      currentNominatorIndex: nextIndex,
      nominationDeadline: deadline,
    })
    .where(eq(auctionSessions.id, sessionId));
}

/**
 * Set the nomination deadline for the current nominator (e.g. on session start).
 */
export async function setNominationDeadline(sessionId: string): Promise<void> {
  const deadline = new Date(Date.now() + NOMINATION_TIMEOUT_SECONDS * 1000);
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
  const bidId = generateId();
  const expiresAt = new Date(Date.now() + BID_TIMER_SECONDS * 1000);

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
  const wishlist = await db
    .select()
    .from(auctionWishlists)
    .where(
      and(
        eq(auctionWishlists.leagueId, leagueId),
        eq(auctionWishlists.teamId, teamId)
      )
    )
    .orderBy(asc(auctionWishlists.priority));

  for (const entry of wishlist) {
    // Check if this player is still unowned
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

    if (owned.length > 0) continue; // Already owned, try next

    await createNomination(
      sessionId,
      teamId,
      leagueId,
      entry.fplElementId,
      entry.playerName
    );
    return true;
  }

  return false; // All wishlist entries already owned or wishlist empty
}

/**
 * Apply a penalty for missed nomination (empty wishlist + timeout).
 * Increments penaltySlots on the team.
 */
export async function applyNominationPenalty(teamId: string): Promise<void> {
  const teamRow = await db
    .select({ penaltySlots: teams.penaltySlots })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  if (!teamRow.length) return;

  await db
    .update(teams)
    .set({ penaltySlots: teamRow[0].penaltySlots + 1 })
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
): Promise<"auto-nominated" | "penalised"> {
  const autoNominated = await autoNominateFromWishlist(
    sessionId,
    nominatorTeamId,
    leagueId
  );

  if (autoNominated) {
    return "auto-nominated";
  }

  // Wishlist empty/exhausted — penalise and skip
  await applyNominationPenalty(nominatorTeamId);
  await advanceNominator(sessionId);
  return "penalised";
}
