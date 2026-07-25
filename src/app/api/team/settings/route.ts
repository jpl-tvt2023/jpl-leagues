import { NextRequest, NextResponse } from "next/server";
import { db, teams, players } from "@/lib/db";
import { eq, and, sql, asc } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * GET /api/team/settings
 * Returns the logged-in team's login id, name, and read-only player info.
 */
export async function GET(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const session = token ? await verifySession(token) : null;

    if (!session || session.type !== "team") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const teamList = await db.select().from(teams).where(eq(teams.id, session.id));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const teamPlayers = await db
      .select({ name: players.name, fplId: players.fplId })
      .from(players)
      .where(eq(players.teamId, session.id))
      .orderBy(asc(players.createdAt), asc(players.id));

    return NextResponse.json({
      teamLoginId: team.teamLoginId,
      teamName: team.name,
      players: teamPlayers,
    });
  } catch (error) {
    console.error("Team settings GET error:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

/**
 * PATCH /api/team/settings
 * Self-service update of the logged-in team's login id and/or name.
 * Both fields are optional — whatever's provided gets validated and updated,
 * whatever's omitted/blank is left untouched. Never touches players, password,
 * or isProfileComplete (those are out of scope for this route by design).
 */
export async function PATCH(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const session = token ? await verifySession(token) : null;

    if (!session || session.type !== "team") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { teamLoginId, teamName } = body;

    const teamLoginIdProvided = typeof teamLoginId === "string" && teamLoginId.trim() !== "";
    const teamNameProvided = typeof teamName === "string" && teamName.trim() !== "";

    if (!teamLoginIdProvided && !teamNameProvided) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const teamList = await db.select().from(teams).where(eq(teams.id, session.id));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};

    if (teamLoginIdProvided) {
      const trimmedLoginId = teamLoginId.trim();

      if (!/^[A-Za-z0-9_-]{3,20}$/.test(trimmedLoginId)) {
        return NextResponse.json(
          { error: "Team ID must be 3–20 alphanumeric/underscore/hyphen characters" },
          { status: 400 }
        );
      }

      const normalizedLoginId = trimmedLoginId.toLowerCase();
      const existingLoginId = await db
        .select()
        .from(teams)
        .where(sql`LOWER(${teams.teamLoginId}) = ${normalizedLoginId}`)
        .limit(1);
      if (existingLoginId.length > 0 && existingLoginId[0].id !== session.id) {
        return NextResponse.json({ error: "Team ID is already taken" }, { status: 400 });
      }

      updateData.teamLoginId = trimmedLoginId;
    }

    if (teamNameProvided) {
      const trimmedTeamName = teamName.trim();

      const existingName = await db
        .select()
        .from(teams)
        .where(
          and(eq(teams.leagueId, team.leagueId), sql`LOWER(REPLACE(${teams.name}, ' ', '')) = LOWER(REPLACE(${trimmedTeamName}, ' ', ''))`)
        );
      if (existingName.length > 0 && existingName[0].id !== session.id) {
        return NextResponse.json({ error: "Team name is already taken in this league" }, { status: 400 });
      }

      updateData.name = trimmedTeamName;
    }

    updateData.updatedAt = new Date();

    await db.update(teams).set(updateData).where(eq(teams.id, session.id));

    return NextResponse.json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    console.error("Team settings PATCH error:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
