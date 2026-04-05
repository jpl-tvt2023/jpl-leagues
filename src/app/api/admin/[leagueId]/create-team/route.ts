import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * POST /api/admin/[leagueId]/create-team
 * Admin-only endpoint to create a team (team name = login ID)
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const {
      teamLoginId,
      teamName,
      abbreviation,
      password,
      player1Name,
      player1FplId,
      player2Name,
      player2FplId,
      group,
    } = body;

    // Validate required fields
    if (!teamLoginId || !teamName || !abbreviation || !password || !player1Name || !player1FplId || !player2Name || !player2FplId || !group) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 }
      );
    }

    // Validate teamLoginId format
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(teamLoginId)) {
      return NextResponse.json(
        { error: "Team ID must be 3–20 alphanumeric/underscore/hyphen characters" },
        { status: 400 }
      );
    }

    // Global uniqueness check on teamLoginId
    const existingLoginId = await db.select().from(teams).where(
      eq(teams.teamLoginId, teamLoginId)
    );
    if (existingLoginId.length > 0) {
      return NextResponse.json(
        { error: "Team ID already exists globally" },
        { status: 400 }
      );
    }

    // Validate group
    if (group !== "A" && group !== "B") {
      return NextResponse.json(
        { error: "Group must be either A or B" },
        { status: 400 }
      );
    }

    // Check if team name already exists in this league
    const existingTeam = await db.select().from(teams).where(
      and(eq(teams.name, teamName), eq(teams.leagueId, leagueId))
    );
    if (existingTeam.length > 0) {
      return NextResponse.json(
        { error: "Team name already exists in this league" },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Ensure group exists for this league
    let groupRecords = await db.select().from(groups).where(
      and(eq(groups.name, group), eq(groups.leagueId, leagueId))
    );
    let groupRecord = groupRecords[0];

    if (!groupRecord) {
      const groupId = generateId();
      await db.insert(groups).values({ id: groupId, name: group, leagueId, groupType: "pl" });
      groupRecord = { id: groupId, name: group, leagueId, groupType: "pl" };
    }

    // Create team with password
    const teamId = generateId();
    await db.insert(teams).values({
      id: teamId,
      teamLoginId,
      name: teamName,
      abbreviation: abbreviation.toUpperCase(),
      password: hashedPassword,
      mustChangePassword: true,
      groupId: groupRecord.id,
      leagueId,
    });

    // Create players
    await db.insert(players).values([
      { id: generateId(), name: player1Name, fplId: player1FplId, teamId },
      { id: generateId(), name: player2Name, fplId: player2FplId, teamId },
    ]);

    return NextResponse.json({
      success: true,
      message: "Team created successfully. Team must change password on first login.",
      team: {
        id: teamId,
        teamLoginId,
        name: teamName,
        abbreviation: abbreviation.toUpperCase(),
        group: group,
      },
    });
  } catch (error) {
    console.error("Create team error:", error);
    return NextResponse.json(
      { error: "Failed to create team" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/[leagueId]/create-team
 * Get list of all teams for this league (admin only)
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const allTeams = await db.query.teams.findMany({
      where: eq(teams.leagueId, leagueId),
      with: {
        players: true,
        group: true,
      },
    });

    return NextResponse.json({
      teams: allTeams.map(t => ({
        id: t.id,
        teamLoginId: t.teamLoginId,
        name: t.name,
        abbreviation: t.abbreviation,
        group: t.group.name,
        players: t.players.map(p => ({ name: p.name, fplId: p.fplId, id: p.id })),
        needsPasswordChange: t.mustChangePassword,
        isProfileComplete: t.isProfileComplete,
      })),
    });
  } catch (error) {
    console.error("Get teams error:", error);
    return NextResponse.json(
      { error: "Failed to fetch teams" },
      { status: 500 }
    );
  }
}
