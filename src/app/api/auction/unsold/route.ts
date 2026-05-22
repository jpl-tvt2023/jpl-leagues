import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionSessions } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";

/**
 * GET /api/auction/unsold?leagueId=xxx
 *
 * Returns all auctionBids rows with status="unsold" for the league's most-recent session.
 * Used by the Auction page's "Unsold" tab — managers see who went without a bid in the active
 * mini-auction so they can add them to their wishlist before the next cycle.
 *
 * Response: { unsold: [{ bidId, fplElementId, playerName, nominatedAt, sessionType, cycleNumber }] }
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

  return NextResponse.json({
    unsold: rows.map((r) => ({
      bidId: r.bidId,
      fplElementId: r.fplElementId,
      playerName: r.playerName,
      nominatedAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      sessionType: recentSession.type,
      cycleNumber: recentSession.cycleNumber ?? 0,
    })),
  });
}
