import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { fetchClubOwnershipMap } from "@/lib/teams/rename-rows";

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

    // Enforce the same minimum password length as bulk-upload-teams so the
    // single-team-create and bulk-import paths cannot diverge in security stance.
    if (String(password).length < 4) {
      return NextResponse.json(
        { error: "Password must be at least 4 characters" },
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

    // Normalise to lowercase for case-insensitive storage + comparison
    const normalizedLoginId = String(teamLoginId).toLowerCase();

    // Global uniqueness check on teamLoginId (case-insensitive)
    const existingLoginId = await db.select().from(teams).where(
      sql`LOWER(${teams.teamLoginId}) = ${normalizedLoginId}`
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
      const groupRecord = groupRecords[0];

      if (!groupRecord) {
        groupId = generateId();
        await db.insert(groups).values({ id: groupId, name: group, leagueId, groupType: "pl" });
      } else {
        groupId = groupRecord.id;
      }
    }

    // Create team with password. Match bulk-upload-teams by setting
    // isProfileComplete=true — the admin already supplied team name + both
    // players, so the team-side setup wizard has nothing to add. Without this,
    // single-team-create and bulk-upload land teams in different onboarding
    // states despite the same input shape.
    const teamId = generateId();
    await db.insert(teams).values({
      id: teamId,
      teamLoginId: normalizedLoginId,
      name: teamName,
      password: hashedPassword,
      mustChangePassword: true,
      isProfileComplete: true,
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
        teamLoginId: normalizedLoginId,
        name: teamName,
        group: group || null,
      },
    });
  } catch (error) {
    console.error("Create team error:", error);
    // Inspect the underlying error chain for SQLite/libsql UNIQUE constraint failures
    // — the pre-INSERT uniqueness check is racy, so two concurrent calls with the same
    // teamLoginId can both pass and the second INSERT then trips this. Return a
    // user-friendly 400 instead of an opaque 500.
    const parts: string[] = [];
    let cur: unknown = error;
    while (cur && parts.length < 5) {
      if (cur instanceof Error) { parts.push(cur.message); cur = (cur as { cause?: unknown }).cause; } else { parts.push(String(cur)); break; }
    }
    const msg = parts.join(" | ");
    if (/UNIQUE constraint failed:\s*teams\.team_login_id/i.test(msg) || /teams_login_id_global_unique/i.test(msg)) {
      return NextResponse.json(
        { error: "Team ID already exists globally" },
        { status: 400 }
      );
    }
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

    const [allTeams, clubByTeamId] = await Promise.all([
      db.query.teams.findMany({
        where: and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)),
        with: { players: true, group: true },
      }),
      fetchClubOwnershipMap(leagueId),
    ]);

    return NextResponse.json({
      teams: allTeams.map(t => {
        const ownedClub = clubByTeamId.get(t.id) ?? null;
        return {
          id: t.id,
          teamLoginId: t.teamLoginId,
          // PL Club Auction rename — a team that owns Liverpool displays as "Liverpool" everywhere.
          name: ownedClub?.plTeamName ?? t.name,
          rawName: t.name,
          group: t.group?.name || "Unassigned",
          players: t.players.map(p => ({ name: p.name, fplId: p.fplId, id: p.id })),
          needsPasswordChange: t.mustChangePassword,
          isProfileComplete: t.isProfileComplete,
          ownedClub,
        };
      }),
    });
  } catch (error) {
    console.error("Get teams error:", error);
    return NextResponse.json(
      { error: "Failed to fetch teams" },
      { status: 500 }
    );
  }
}
