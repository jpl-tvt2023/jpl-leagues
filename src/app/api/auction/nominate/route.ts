import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionSessions, auctionOwnership } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import {
  resolveExpiredBid,
  advanceNominator,
  clearNominationDeadline,
} from "@/lib/formats/auction/resolve-bid";

const BID_TIMER_SECONDS = 30;
const DEFAULT_MIN_BID = 500_000; // 500K minimum starting bid

/**
 * POST /api/auction/nominate
 * Nominate a PL player for auction. Only the current nominator or admin can do this.
 *
 * Body: { sessionId, fplElementId, playerName, minBid? }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { sessionId, fplElementId, playerName, minBid } = body;

  if (!sessionId || !fplElementId || !playerName) {
    return NextResponse.json(
      { error: "sessionId, fplElementId, and playerName are required" },
      { status: 400 }
    );
  }

  // Get the auction session
  const sessionRow = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);

  if (sessionRow.length === 0 || sessionRow[0].status !== "active") {
    console.error("[nominate] 400: session not active", { sessionId, status: sessionRow[0]?.status });
    return NextResponse.json({ error: "Auction session is not active" }, { status: 400 });
  }

  const leagueId = sessionRow[0].leagueId;

  // Verify initial nominator authorization before running the safety-net
  const snakeOrderInitial: string[] = JSON.parse(sessionRow[0].snakeOrder);
  const initialNominatorId = snakeOrderInitial[sessionRow[0].currentNominatorIndex];

  if (!isAdmin && session?.id !== initialNominatorId) {
    console.error("[nominate] 403: not your turn", { sessionId, teamId: session?.id, currentNominator: initialNominatorId });
    return NextResponse.json({ error: "Not your turn to nominate" }, { status: 403 });
  }

  // Auto-resolve any expired open bids (safety net if SSE wasn't running)
  const staleOpenBids = await db
    .select()
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")));

  const now = new Date();
  for (const stale of staleOpenBids) {
    if (now > stale.expiresAt) {
      try {
        await resolveExpiredBid(stale);
        await advanceNominator(sessionId);
      } catch (err) {
        // SSE may have already resolved this bid — log and continue
        console.error("[nominate] Safety-net resolution failed for bid", stale.id, err);
      }
    }
  }

  // Re-fetch session after safety-net (nominatorIndex may have advanced)
  const refreshedSession = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);

  if (refreshedSession.length === 0 || refreshedSession[0].status !== "active") {
    console.error("[nominate] 400: session became inactive after safety-net", { sessionId });
    return NextResponse.json({ error: "Auction session is not active" }, { status: 400 });
  }

  const auctionSession = refreshedSession[0];
  const snakeOrder: string[] = JSON.parse(auctionSession.snakeOrder);
  const currentNominatorId = snakeOrder[auctionSession.currentNominatorIndex];

  // Re-check nominator auth — safety-net may have advanced past the submitter
  if (!isAdmin && session?.id !== currentNominatorId) {
    console.error("[nominate] 403: no longer nominator after safety-net advance", { sessionId, teamId: session?.id, currentNominator: currentNominatorId });
    return NextResponse.json({ error: "Not your turn to nominate" }, { status: 403 });
  }

  // Check no other item is currently open (after cleanup)
  const openBids = await db
    .select()
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")))
    .limit(1);

  if (openBids.length > 0) {
    console.error("[nominate] 400: open bid still exists after safety-net", { sessionId, bidId: openBids[0].id });
    return NextResponse.json({ error: "Another item is still open for bidding" }, { status: 400 });
  }

  // Check player isn't already owned in this league
  const existingOwner = await db
    .select()
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueId),
        eq(auctionOwnership.fplElementId, fplElementId),
        eq(auctionOwnership.status, "active")
      )
    )
    .limit(1);

  if (existingOwner.length > 0) {
    console.error("[nominate] 400: player already owned", { sessionId, fplElementId });
    return NextResponse.json({ error: "Player is already owned" }, { status: 400 });
  }

  // Create the auction bid item
  const startingBid = minBid ?? DEFAULT_MIN_BID;
  const expiresAt = new Date(Date.now() + BID_TIMER_SECONDS * 1000);

  const bidId = generateId();
  await db.insert(auctionBids).values({
    id: bidId,
    leagueId,
    sessionId,
    nominatorTeamId: currentNominatorId,
    fplElementId,
    playerName,
    currentHighBid: startingBid,
    currentHighBidderId: currentNominatorId, // nominator starts as default bidder
    minBid: startingBid,
    status: "open",
    expiresAt,
  });

  // Clear nomination deadline — the 30s bid timer takes over
  await clearNominationDeadline(sessionId);

  return NextResponse.json({
    success: true,
    bidId,
    fplElementId,
    playerName,
    startingBid,
    expiresAt: expiresAt.toISOString(),
    nominatorTeamId: currentNominatorId,
  });
}
