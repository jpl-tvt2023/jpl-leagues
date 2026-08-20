import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionBidLogs, teamPenalties } from "@/lib/db";
import { eq, desc, asc, inArray } from "drizzle-orm";

/**
 * GET /api/auction/bid-history?sessionId=xxx
 * Returns all resolved bids (sold/unsold) for a session, newest first.
 * Each bid includes its event logs (nomination, bids, sold) for expand view.
 * Also returns the session's missed-nomination penalties so the live-feed rebuild can keep those
 * entries (they live in `teamPenalties`, not in the bid logs).
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const bids = await db
    .select({
      id: auctionBids.id,
      // Needed so both rooms can resolve position / PL club / tier for a historical row. Without it
      // the participant feed lost its [GKP·ARS] tags on every resync (the live SSE path had the id,
      // the rebuilt-from-history path did not), and the admin feed could not show them at all.
      fplElementId: auctionBids.fplElementId,
      playerName: auctionBids.playerName,
      currentHighBid: auctionBids.currentHighBid,
      currentHighBidderId: auctionBids.currentHighBidderId,
      nominatorTeamId: auctionBids.nominatorTeamId,
      minBid: auctionBids.minBid,
      status: auctionBids.status,
      updatedAt: auctionBids.updatedAt,
      createdAt: auctionBids.createdAt,
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

  // Lot numbers count SOLD players only, in the order they were put on the block. Assigned here so
  // every consumer agrees; `resolved` is newest-first, so number the chronological order instead.
  const lotNumberByBidId = new Map<string, number>();
  const soldChronological = resolved
    .filter((b) => b.status === "sold")
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  soldChronological.forEach((b, i) => lotNumberByBidId.set(b.id, i + 1));

  const bidsWithLogs = resolved.map((b) => ({
    ...b,
    lotNumber: lotNumberByBidId.get(b.id) ?? null,
    logs: logsByBidId[b.id] ?? [],
  }));

  // Missed-nomination penalties for this session — feed source for the "penalised" lines.
  const penalties = await db
    .select({
      id: teamPenalties.id,
      teamId: teamPenalties.teamId,
      createdAt: teamPenalties.createdAt,
    })
    .from(teamPenalties)
    .where(eq(teamPenalties.sessionId, sessionId))
    .orderBy(asc(teamPenalties.createdAt));

  return NextResponse.json({ bids: bidsWithLogs, penalties });
}
