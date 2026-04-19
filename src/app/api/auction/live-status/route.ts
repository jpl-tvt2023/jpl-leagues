import { NextRequest, NextResponse } from "next/server";
import { db, leagues, auctionSessions } from "@/lib/db";
import { eq, and, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * GET /api/auction/live-status?leagueSlug=...  OR  ?leagueId=...
 * Public read: returns whether the league has an active or paused auction session.
 */
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("leagueSlug");
  const idParam = request.nextUrl.searchParams.get("leagueId");

  if (!slug && !idParam) {
    return NextResponse.json({ error: "leagueSlug or leagueId is required" }, { status: 400 });
  }

  const leagueRow = await db
    .select({ id: leagues.id, format: leagues.format })
    .from(leagues)
    .where(slug ? eq(leagues.slug, slug) : eq(leagues.id, idParam!))
    .limit(1);

  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ live: false, leagueId: null });
  }

  const leagueId = leagueRow[0].id;
  const sessions = await db
    .select({ id: auctionSessions.id, status: auctionSessions.status })
    .from(auctionSessions)
    .where(
      and(
        eq(auctionSessions.leagueId, leagueId),
        or(eq(auctionSessions.status, "active"), eq(auctionSessions.status, "paused"))
      )
    )
    .limit(1);

  return NextResponse.json({
    live: sessions.length > 0,
    leagueId,
    sessionId: sessions[0]?.id ?? null,
    status: sessions[0]?.status ?? null,
  });
}
