import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionBidLogs } from "@/lib/db";
import { eq, desc, asc, inArray } from "drizzle-orm";

/**
 * GET /api/auction/bid-history?sessionId=xxx
 * Returns all resolved bids (sold/unsold) for a session, newest first.
 * Each bid includes its event logs (nomination, bids, sold) for expand view.
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

  // Fetch event logs for all resolved bids
  const bidIds = resolved.map((b) => b.id);
  const logsByBidId: Record<string, { id: string; teamId: string; amount: number; type: string; createdAt: Date }[]> = {};

  if (bidIds.length > 0) {
    const logs = await db
      .select({
        id: auctionBidLogs.id,
        bidId: auctionBidLogs.bidId,
        teamId: auctionBidLogs.teamId,
        amount: auctionBidLogs.amount,
        type: auctionBidLogs.type,
        createdAt: auctionBidLogs.createdAt,
      })
      .from(auctionBidLogs)
      .where(inArray(auctionBidLogs.bidId, bidIds))
      .orderBy(asc(auctionBidLogs.createdAt));

    for (const log of logs) {
      if (!logsByBidId[log.bidId]) logsByBidId[log.bidId] = [];
      logsByBidId[log.bidId].push({
        id: log.id,
        teamId: log.teamId,
        amount: log.amount,
        type: log.type,
        createdAt: log.createdAt,
      });
    }
  }

  const bidsWithLogs = resolved.map((b) => ({
    ...b,
    logs: logsByBidId[b.id] ?? [],
  }));

  return NextResponse.json({ bids: bidsWithLogs });
}
