import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
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
      password,
      player1Name,
      player1FplId,
      player2Name,
      player2FplId,
      group,
    } = body;

    // Validate required fields (group is optional, defaults to "A")
    if (!teamLoginId || !teamName || !password || !player1Name || !player1FplId || !player2Name || !player2FplId) {
      return NextResponse.json(
        { error: "All fields except group are required" },
        { status: 400 }
      );
    }

    // Validate teamLoginId format
    if (!/^[A-Za-z0-9_-]{3,30}$/.test(teamLoginId)) {
      return NextResponse.json(
        { error: "Team ID must be 3–30 alphanumeric/underscore/hyphen characters" },
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

    // Validate group (optional; if provided, must be A or B)
    if (group && group !== "A" && group !== "B") {
      return NextResponse.json(
        { error: "Group must be either A or B" },
        { status: 400 }
      );
    }

    // Check if team name already exists in this league (case-insensitive)
    const existingTeam = await db.select().from(teams).where(
      and(sql`LOWER(REPLACE(${teams.name}, ' ', '')) = LOWER(REPLACE(${teamName}, ' ', ''))`, eq(teams.leagueId, leagueId))
    );
    if (existingTeam.length > 0) {
      return NextResponse.json(
        { error: "Team name already exists in this league" },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Resolve group (null if not provided)
    let groupId: string | null = null;
    if (group) {
      const groupRecords = await db.select().from(groups).where(
        and(eq(groups.name, group), eq(groups.leagueId, leagueId))
      );
      let groupRecord = groupRecords[0];

      if (!groupRecord) {
        groupId = generateId();
        await db.insert(groups).values({ id: groupId, name: group, leagueId, groupType: "pl" });
      } else {
        groupId = groupRecord.id;
      }
    }

    // Create team with password
    const teamId = generateId();
    await db.insert(teams).values({
      id: teamId,
      teamLoginId,
      name: teamName,
      password: hashedPassword,
      mustChangePassword: true,
      groupId,
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
        group: group || null,
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
      where: and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)),
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
        group: t.group?.name || "Unassigned",
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
