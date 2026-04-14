import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids } from "@/lib/db";
import { eq, desc } from "drizzle-orm";

/**
 * GET /api/auction/bid-history?sessionId=xxx
 * Returns all resolved bids (sold/unsold) for a session, newest first.
 * Used to populate the live feed on page load with historical data.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const bids = await db
    .select({
      id: auctionBids.id,
      playerName: auctionBids.playerName,
      currentHighBid: auctionBids.currentHighBid,
      currentHighBidderId: auctionBids.currentHighBidderId,
      nominatorTeamId: auctionBids.nominatorTeamId,
      minBid: auctionBids.minBid,
      status: auctionBids.status,
      updatedAt: auctionBids.updatedAt,
    })
    .from(auctionBids)
    .where(eq(auctionBids.sessionId, sessionId))
    .orderBy(desc(auctionBids.updatedAt));

  // Filter to only resolved bids (sold/unsold), not open/cancelled
  const resolved = bids.filter((b) => b.status === "sold" || b.status === "unsold");

  return NextResponse.json({ bids: resolved });
}
