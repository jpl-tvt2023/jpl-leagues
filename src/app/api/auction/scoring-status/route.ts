import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, gameweeks, auctionScores, teams } from "@/lib/db/schema";
import { eq, and, count } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * GET /api/auction/scoring-status?leagueId=...
 * Returns gameweek scoring status for auction leagues (replaces fixture-based status).
 * Each GW shows how many managers have been scored vs total managers.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  if (!session || (session.type !== "admin" && session.type !== "superadmin")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const leagueId = request.nextUrl.searchParams.get("leagueId");
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  // Verify it's an auction league
  const leagueRow = await db.select({ format: leagues.format }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (!leagueRow.length || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  // Get total managers in this league
  const [teamCountRow] = await db.select({ count: count() }).from(teams).where(eq(teams.leagueId, leagueId));
  const totalManagers = teamCountRow?.count ?? 0;

  // Get all gameweeks for this league
  const gws = await db.select().from(gameweeks).where(eq(gameweeks.leagueId, leagueId)).orderBy(gameweeks.number);

  // For each gameweek, count how many auctionScores exist
  const statuses = await Promise.all(
    gws.map(async (gw) => {
      const [scoreCountRow] = await db
        .select({ count: count() })
        .from(auctionScores)
        .where(and(eq(auctionScores.leagueId, leagueId), eq(auctionScores.gameweekId, gw.id)));
      const scored = scoreCountRow?.count ?? 0;
      return {
        number: gw.number,
        gameweekId: gw.id,
        totalManagers,
        scored,
        isPending: scored < totalManagers,
      };
    })
  );

  return NextResponse.json({ statuses });
}
