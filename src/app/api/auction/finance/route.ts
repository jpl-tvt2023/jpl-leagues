import { NextRequest, NextResponse } from "next/server";
import { db, teams } from "@/lib/db";
import { eq } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { buildTeamLedger, buildAllTeamsSummary } from "@/lib/formats/auction/finance";
import { fetchClubOwnershipMap } from "@/lib/teams/rename-rows";

/**
 * GET /api/auction/finance
 *
 *   ?teamId=xxx                       → single team ledger (team owner or admin)
 *   ?leagueId=xxx&allTeams=true       → all teams' summaries (admin only)
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const admin = isSuperAdmin(request);

  if (!session && !admin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const teamId = request.nextUrl.searchParams.get("teamId");
  const leagueIdParam = request.nextUrl.searchParams.get("leagueId");
  const allTeams = request.nextUrl.searchParams.get("allTeams") === "true";

  if (allTeams) {
    if (!admin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    if (!leagueIdParam) {
      return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
    }
    const summaries = await buildAllTeamsSummary(leagueIdParam);
    // PL Club Auction rename + ownedClub for tier-chip rendering.
    const clubByTeamId = await fetchClubOwnershipMap(leagueIdParam);
    const renamed = summaries.map((s) => {
      const ownedClub = clubByTeamId.get(s.teamId) ?? null;
      return { ...s, teamName: ownedClub?.plTeamName ?? s.teamName, ownedClub };
    });
    return NextResponse.json({ leagueId: leagueIdParam, teams: renamed });
  }

  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }

  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  // Team can only view their own ledger; admin or other teams in same league can view too
  if (!admin && session?.type === "team") {
    const sameLeague = teamRow[0].leagueId;
    const sessionTeam = await db.select().from(teams).where(eq(teams.id, session.id)).limit(1);
    if (sessionTeam.length === 0 || sessionTeam[0].leagueId !== sameLeague) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const ledger = await buildTeamLedger(teamRow[0].leagueId, teamId);
  if (!ledger) {
    return NextResponse.json({ error: "Ledger unavailable" }, { status: 404 });
  }

  // Override `teamName` with the owned-club name if this team bought one.
  const clubByTeamId = await fetchClubOwnershipMap(teamRow[0].leagueId);
  const ownedClub = clubByTeamId.get(teamId) ?? null;
  const renamedLedger = ownedClub
    ? { ...ledger, teamName: ownedClub.plTeamName, ownedClub }
    : { ...ledger, ownedClub: null };

  return NextResponse.json(renamedLedger);
}
