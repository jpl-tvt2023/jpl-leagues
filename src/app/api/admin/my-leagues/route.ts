import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, leagueAdmins, teams, gameweeks } from "@/lib/db/schema";
import { eq, and, max, count } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";

/**
 * GET /api/admin/my-leagues
 * Returns leagues the current admin can access, with quick stats.
 * Superadmin gets all leagues. Admin gets only their assigned leagues.
 */
export async function GET(request: NextRequest) {
  const sessionType = request.headers.get("x-session-type");
  const sessionId = request.headers.get("x-session-id");

  if (sessionType !== "admin" && sessionType !== "superadmin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Get the set of leagues this user can access
  let leagueIds: string[] | null = null; // null = all (superadmin)

  if (!isSuperAdmin(request) && sessionId) {
    const assignments = await db
      .select({ leagueId: leagueAdmins.leagueId })
      .from(leagueAdmins)
      .where(eq(leagueAdmins.userId, sessionId));
    leagueIds = assignments.map((a) => a.leagueId);
  }

  // Fetch all leagues (filtered if needed)
  const allLeagues = await db.select().from(leagues).orderBy(leagues.createdAt);
  const accessibleLeagues = leagueIds === null
    ? allLeagues
    : allLeagues.filter((l) => leagueIds!.includes(l.id));

  // For each league, fetch quick stats
  const leaguesWithStats = await Promise.all(
    accessibleLeagues.map(async (league) => {
      const [teamCountRow] = await db
        .select({ count: count() })
        .from(teams)
        .where(eq(teams.leagueId, league.id));

      const [currentGwRow] = await db
        .select({ maxGw: max(gameweeks.number) })
        .from(gameweeks)
        .where(and(eq(gameweeks.leagueId, league.id)));

      return {
        ...league,
        teamCount: teamCountRow?.count ?? 0,
        currentGameweek: currentGwRow?.maxGw ?? null,
      };
    })
  );

  return NextResponse.json({ leagues: leaguesWithStats });
}
