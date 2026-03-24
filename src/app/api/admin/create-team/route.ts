import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups } from "@/lib/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateId } from "@/lib/id";

/**
 * POST /api/admin/create-team
 * Admin-only endpoint to create a team (team name = login ID)
 */
export async function POST(request: NextRequest) {
  try {
    // Admin verified by middleware; defense-in-depth check
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const {
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
    if (!teamName || !abbreviation || !password || !player1Name || !player1FplId || !player2Name || !player2FplId || !group) {
      return NextResponse.json(
        { error: "All fields are required" },
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

    // Check if team name already exists
    const existingTeam = await db.select().from(teams).where(eq(teams.name, teamName));
    if (existingTeam.length > 0) {
      return NextResponse.json(
        { error: "Team name already exists" },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Ensure group exists
    let groupRecords = await db.select().from(groups).where(eq(groups.name, group));
    let groupRecord = groupRecords[0];
    
    if (!groupRecord) {
      const groupId = generateId();
      await db.insert(groups).values({ id: groupId, name: group });
      groupRecord = { id: groupId, name: group };
    }

    // Create team with password
    const teamId = generateId();
    await db.insert(teams).values({
      id: teamId,
      name: teamName,
      abbreviation: abbreviation.toUpperCase(),
      password: hashedPassword,
      mustChangePassword: true,
      groupId: groupRecord.id,
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
 * GET /api/admin/create-team
 * Get list of all teams (admin only)
 */
export async function GET(request: NextRequest) {
  try {
    // Admin verified by middleware; defense-in-depth check
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const allTeams = await db.query.teams.findMany({
      with: {
        players: true,
        group: true,
      },
    });

    return NextResponse.json({
      teams: allTeams.map(t => ({
        id: t.id,
        name: t.name,
        abbreviation: t.abbreviation,
        group: t.group.name,
        players: t.players.map(p => ({ name: p.name, fplId: p.fplId })),
        needsPasswordChange: t.mustChangePassword,
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
