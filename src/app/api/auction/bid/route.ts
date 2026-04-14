import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionBidLogs, auctionSessions, auctionOwnership, teams, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { calculatePurse } from "@/lib/formats/auction/economy";

const BID_COUNTER_EXTENSION_MS = 5_000; // +5s per counter-bid
const BID_MAX_TIMER_MS = 20_000; // cap at 20s from now
const MIN_BID_INCREMENT = 100_000; // 100K minimum raise

/**
 * POST /api/auction/bid
 * Place a bid on the current open auction item.
 *
 * Body: { sessionId, bidAmount }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ error: "Team authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { sessionId, bidAmount } = body;

  if (!sessionId || typeof bidAmount !== "number") {
    return NextResponse.json({ error: "sessionId and bidAmount are required" }, { status: 400 });
  }

  // Verify session is active
  const sessionRow = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);

  if (sessionRow.length === 0 || sessionRow[0].status !== "active") {
    return NextResponse.json({ error: "Auction session is not active" }, { status: 400 });
  }

  const leagueId = sessionRow[0].leagueId;

  // Get team and verify they belong to this league
  const teamRow = await db.select().from(teams).where(eq(teams.id, session.id)).limit(1);
  if (teamRow.length === 0 || teamRow[0].leagueId !== leagueId) {
    return NextResponse.json({ error: "Team not in this league" }, { status: 403 });
  }

  // Atomically place the bid
  const result = await db.transaction(async (tx) => {
    // Get the current open bid
    const openBids = await tx
      .select()
      .from(auctionBids)
      .where(
        and(
          eq(auctionBids.sessionId, sessionId),
          eq(auctionBids.status, "open")
        )
      )
      .limit(1);

    if (openBids.length === 0) {
      return { error: "No open auction item", status: 400 };
    }

    const currentBid = openBids[0];

    // Check timer hasn't expired (2s grace for in-flight requests)
    if (Date.now() > currentBid.expiresAt.getTime() + 2000) {
      return { error: "Auction timer has expired", status: 400 };
    }

    // Validate bid amount
    if (bidAmount < currentBid.currentHighBid + MIN_BID_INCREMENT) {
      return {
        error: `Minimum bid is ${(currentBid.currentHighBid + MIN_BID_INCREMENT).toLocaleString()}`,
        status: 400,
      };
    }

    // Compute available purse (initialBudget + income + refunds - spent)
    const leagueRow = await tx.select({ initialBudget: leagues.initialBudget }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    const availablePurse = calculatePurse(
      leagueRow[0]?.initialBudget ?? 0,
      teamRow[0].totalIncome,
      teamRow[0].totalSpent,
      teamRow[0].totalRefunds
    );
    if (bidAmount > availablePurse) {
      return { error: "Insufficient purse", status: 400 };
    }

    // Check bidder doesn't already have 14 active players
    const activeOwned = await tx
      .select()
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          eq(auctionOwnership.teamId, session.id),
          eq(auctionOwnership.status, "active")
        )
      );

    const maxSquadSize = 14 - (teamRow[0].penaltySlots ?? 0);
    if (activeOwned.length >= maxSquadSize) {
      return { error: `Squad is full (${maxSquadSize} players)`, status: 400 };
    }

    // Place the bid — extend timer by +5s, capped at 20s from now
    const extended = currentBid.expiresAt.getTime() + BID_COUNTER_EXTENSION_MS;
    const maxFromNow = Date.now() + BID_MAX_TIMER_MS;
    const newExpiry = new Date(Math.min(extended, maxFromNow));
    await tx
      .update(auctionBids)
      .set({
        currentHighBid: bidAmount,
        currentHighBidderId: session.id,
        expiresAt: newExpiry,
        updatedAt: new Date(),
      })
      .where(eq(auctionBids.id, currentBid.id));

    // Log the bid event
    await tx.insert(auctionBidLogs).values({
      id: generateId(),
      bidId: currentBid.id,
      teamId: session.id,
      amount: bidAmount,
      type: "bid",
    });

    return {
      success: true,
      bidId: currentBid.id,
      bidAmount,
      bidderId: session.id,
      expiresAt: newExpiry.toISOString(),
    };
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result);
}
