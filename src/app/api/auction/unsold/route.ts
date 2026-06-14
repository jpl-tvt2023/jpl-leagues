import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionSessions, auctionOwnership } from "@/lib/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";

/**
 * GET /api/auction/unsold?leagueId=xxx
 *
 * Returns players available to shortlist before/in the next mini-auction: the most-recent session's
 * unsold bids PLUS players that teams have RELEASED (and aren't currently re-owned). Used by the
 * Auction page's "Unsold" tab.
 *
 * Response: { unsold: [{ bidId, fplElementId, playerName, nominatedAt, sessionType, cycleNumber, released? }] }
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const leagueId = request.nextUrl.searchParams.get("leagueId");
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  // Find the most-recent session (active, paused, or recently completed) so the Unsold tab is
  // meaningful even when the auction has paused or just wrapped. Ordered by createdAt desc.
  const [recentSession] = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.leagueId, leagueId))
    .orderBy(desc(auctionSessions.createdAt))
    .limit(1);

  if (!recentSession) {
    return NextResponse.json({ unsold: [] });
  }

  const rows = await db
    .select({
      bidId: auctionBids.id,
      fplElementId: auctionBids.fplElementId,
      playerName: auctionBids.playerName,
      createdAt: auctionBids.createdAt,
    })
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, recentSession.id), eq(auctionBids.status, "unsold")))
    .orderBy(desc(auctionBids.createdAt));

  // Released players that aren't currently owned again — surfaced here as available to shortlist.
  const [releasedRows, currentlyOwned] = await Promise.all([
    db
      .select({ fplElementId: auctionOwnership.fplElementId, playerName: auctionOwnership.playerName, releasedGw: auctionOwnership.releasedGw })
      .from(auctionOwnership)
      .where(and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "released"))),
    db
      .select({ fplElementId: auctionOwnership.fplElementId })
      .from(auctionOwnership)
      .where(and(eq(auctionOwnership.leagueId, leagueId), inArray(auctionOwnership.status, ["active", "pending_release"]))),
  ]);
  const ownedSet = new Set(currentlyOwned.map((o) => o.fplElementId));
  const unsoldSet = new Set(rows.map((r) => r.fplElementId));

  const seen = new Set<number>();
  const releasedEntries = [];
  for (const r of releasedRows) {
    if (ownedSet.has(r.fplElementId) || unsoldSet.has(r.fplElementId) || seen.has(r.fplElementId)) continue;
    seen.add(r.fplElementId);
    releasedEntries.push({
      bidId: `released-${r.fplElementId}`,
      fplElementId: r.fplElementId,
      playerName: r.playerName,
      nominatedAt: null as string | null,
      sessionType: recentSession.type,
      cycleNumber: recentSession.cycleNumber ?? 0,
      released: true,
    });
  }

  return NextResponse.json({
    unsold: [
      ...rows.map((r) => ({
        bidId: r.bidId,
        fplElementId: r.fplElementId,
        playerName: r.playerName,
        nominatedAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        sessionType: recentSession.type,
        cycleNumber: recentSession.cycleNumber ?? 0,
        released: false,
      })),
      ...releasedEntries,
    ],
  });
}
