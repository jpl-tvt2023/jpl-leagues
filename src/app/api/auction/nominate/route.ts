import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionSessions, auctionOwnership, teams, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";

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
    return NextResponse.json({ error: "Auction session is not active" }, { status: 400 });
  }

  const auctionSession = sessionRow[0];
  const leagueId = auctionSession.leagueId;
  const snakeOrder: string[] = JSON.parse(auctionSession.snakeOrder);
  const currentNominatorId = snakeOrder[auctionSession.currentNominatorIndex];

  // Verify nominator authorization (current nominator or admin)
  if (!isAdmin && session?.id !== currentNominatorId) {
    return NextResponse.json({ error: "Not your turn to nominate" }, { status: 403 });
  }

  // Check no other item is currently open
  const openBids = await db
    .select()
    .from(auctionBids)
    .where(
      and(
        eq(auctionBids.sessionId, sessionId),
        eq(auctionBids.status, "open")
      )
    )
    .limit(1);

  if (openBids.length > 0) {
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
