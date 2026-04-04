import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, leagues } from "@/lib/db";
import { eq } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

/**
 * GET /api/team/setup
 * Returns current team setup info (for prefilling) or checks team name uniqueness
 */
export async function GET(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const session = token ? await verifySession(token) : null;

    if (!session || session.type !== "team") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if this is a name uniqueness check
    const checkName = request.nextUrl.searchParams.get("checkName");

    if (checkName) {
      // Uniqueness check: query all leagues for this team name
      const existing = await db.select().from(teams).where(eq(teams.name, checkName)).limit(1);
      return NextResponse.json({ available: existing.length === 0 });
    }

    // Regular GET: return current team info
    const teamList = await db.select().from(teams).where(eq(teams.id, session.id));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    return NextResponse.json({
      teamId: team.id,
      currentName: team.name,
      currentAbbreviation: team.abbreviation,
    });
  } catch (error) {
    console.error("Setup GET error:", error);
    return NextResponse.json({ error: "Failed to fetch setup info" }, { status: 500 });
  }
}

/**
 * POST /api/team/setup
 * Completes team profile setup: updates team name/abbreviation, creates 2 players
 */
export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const session = token ? await verifySession(token) : null;

    if (!session || session.type !== "team") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      teamName,
      abbreviation,
      player1Name,
      player1FplId,
      player2Name,
      player2FplId,
    } = body;

    // ============= Validations =============

    // Team name: non-empty, globally unique across all leagues
    if (!teamName || typeof teamName !== "string" || !teamName.trim()) {
      return NextResponse.json(
        { error: "Team name is required" },
        { status: 400 }
      );
    }

    const trimmedTeamName = teamName.trim();

    // Check global uniqueness (across all leagues)
    const existing = await db
      .select()
      .from(teams)
      .where(eq(teams.name, trimmedTeamName))
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "Team name is already taken" },
        { status: 400 }
      );
    }

    // Abbreviation: 2-4 uppercase letters only
    if (!abbreviation || typeof abbreviation !== "string") {
      return NextResponse.json(
        { error: "Abbreviation is required" },
        { status: 400 }
      );
    }

    if (!/^[A-Z]{2,4}$/.test(abbreviation)) {
      return NextResponse.json(
        { error: "Abbreviation must be 2-4 uppercase letters" },
        { status: 400 }
      );
    }

    // Player 1: name and FPL ID
    if (!player1Name || typeof player1Name !== "string" || !player1Name.trim()) {
      return NextResponse.json(
        { error: "Player 1 name is required" },
        { status: 400 }
      );
    }

    if (!player1FplId || typeof player1FplId !== "string" || !player1FplId.trim()) {
      return NextResponse.json(
        { error: "Player 1 FPL ID is required" },
        { status: 400 }
      );
    }

    if (!/^\d+$/.test(player1FplId.trim())) {
      return NextResponse.json(
        { error: "Player 1 FPL ID must be numeric" },
        { status: 400 }
      );
    }

    // Player 2: name and FPL ID
    if (!player2Name || typeof player2Name !== "string" || !player2Name.trim()) {
      return NextResponse.json(
        { error: "Player 2 name is required" },
        { status: 400 }
      );
    }

    if (!player2FplId || typeof player2FplId !== "string" || !player2FplId.trim()) {
      return NextResponse.json(
        { error: "Player 2 FPL ID is required" },
        { status: 400 }
      );
    }

    if (!/^\d+$/.test(player2FplId.trim())) {
      return NextResponse.json(
        { error: "Player 2 FPL ID must be numeric" },
        { status: 400 }
      );
    }

    // ============= Update Team =============

    const teamList = await db.select().from(teams).where(eq(teams.id, session.id));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const leagueId = team.leagueId;

    // Update team: name, abbreviation, isProfileComplete = true
    await db
      .update(teams)
      .set({
        name: trimmedTeamName,
        abbreviation,
        isProfileComplete: true,
        updatedAt: new Date(),
      })
      .where(eq(teams.id, session.id));

    // ============= Create/Update Players =============

    // Check if players already exist for this team
    const existingPlayers = await db
      .select()
      .from(players)
      .where(eq(players.teamId, session.id));

    if (existingPlayers.length >= 2) {
      // Update existing players
      await Promise.all([
        db
          .update(players)
          .set({
            name: player1Name.trim(),
            fplId: player1FplId.trim(),
            updatedAt: new Date(),
          })
          .where(eq(players.id, existingPlayers[0].id)),
        db
          .update(players)
          .set({
            name: player2Name.trim(),
            fplId: player2FplId.trim(),
            updatedAt: new Date(),
          })
          .where(eq(players.id, existingPlayers[1].id)),
      ]);
    } else {
      // Create new players
      await db.insert(players).values([
        {
          id: generateId(),
          name: player1Name.trim(),
          fplId: player1FplId.trim(),
          teamId: session.id,
        },
        {
          id: generateId(),
          name: player2Name.trim(),
          fplId: player2FplId.trim(),
          teamId: session.id,
        },
      ]);
    }

    // Invalidate cache for this league
    await invalidateLeaguePageCache(leagueId);

    return NextResponse.json({
      success: true,
      message: "Profile setup completed",
    });
  } catch (error) {
    console.error("Setup POST error:", error);
    return NextResponse.json(
      { error: "Failed to complete setup" },
      { status: 500 }
    );
  }
}
