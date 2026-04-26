import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, leagues } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

/** Check if a league uses the auction format (no FPL player IDs needed at setup) */
async function isAuctionLeague(leagueId: string): Promise<boolean> {
  const row = await db.select({ format: leagues.format }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  return row.length > 0 && row[0].format === "auction";
}

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

    // Get current team to know leagueId for per-league checks
    const teamList = await db.select().from(teams).where(eq(teams.id, session.id));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    // Check if this is a teamLoginId or team name uniqueness check
    const checkLoginId = request.nextUrl.searchParams.get("checkLoginId");
    const checkName = request.nextUrl.searchParams.get("checkName");

    if (checkLoginId) {
      // Global uniqueness check on teamLoginId
      const existing = await db.select().from(teams).where(eq(teams.teamLoginId, checkLoginId)).limit(1);
      // Available if: no team with this loginId, OR this is the current team's loginId
      return NextResponse.json({
        available: existing.length === 0 || existing[0].id === session.id,
      });
    }

    if (checkName) {
      // Per-league uniqueness check: query teams in this league for this name (case-insensitive)
      const existing = await db.select().from(teams).where(
        and(eq(teams.leagueId, team.leagueId), sql`LOWER(REPLACE(${teams.name}, ' ', '')) = LOWER(REPLACE(${checkName}, ' ', ''))`)
      ).limit(1);
      // Available if: no team with this name in league, OR this is the current team's name
      return NextResponse.json({
        available: existing.length === 0 || existing[0].id === session.id,
      });
    }

    return NextResponse.json({
      teamId: team.id,
      currentLoginId: team.teamLoginId,
      currentName: team.name,
    });
  } catch (error) {
    console.error("Setup GET error:", error);
    return NextResponse.json({ error: "Failed to fetch setup info" }, { status: 500 });
  }
}

/**
 * POST /api/team/setup
 * Completes team profile setup: updates team name, creates 2 players
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
      teamLoginId,
      teamName,
      player1Name,
      player1FplId,
      player2Name,
      player2FplId,
    } = body;

    // ============= Validations =============

    // Team Login ID: non-empty, format validation, globally unique
    if (!teamLoginId || typeof teamLoginId !== "string" || !teamLoginId.trim()) {
      return NextResponse.json(
        { error: "Team ID is required" },
        { status: 400 }
      );
    }

    const trimmedLoginId = teamLoginId.trim();

    // Validate format
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(trimmedLoginId)) {
      return NextResponse.json(
        { error: "Team ID must be 3–20 alphanumeric/underscore/hyphen characters" },
        { status: 400 }
      );
    }

    // Check global uniqueness (across all leagues, unless it's the current team's ID)
    const existingLoginId = await db
      .select()
      .from(teams)
      .where(eq(teams.teamLoginId, trimmedLoginId))
      .limit(1);
    if (existingLoginId.length > 0 && existingLoginId[0].id !== session.id) {
      return NextResponse.json(
        { error: "Team ID is already taken" },
        { status: 400 }
      );
    }

    // Team name: non-empty, unique within league
    if (!teamName || typeof teamName !== "string" || !teamName.trim()) {
      return NextResponse.json(
        { error: "Team name is required" },
        { status: 400 }
      );
    }

    const trimmedTeamName = teamName.trim();

    // Get current team to check league
    const teamList = await db.select().from(teams).where(eq(teams.id, session.id));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const leagueId = team.leagueId;
    const isAuction = await isAuctionLeague(leagueId);

    // Check per-league uniqueness (name must be unique within the league, unless it's the current team's name) - case-insensitive
    const existingName = await db
      .select()
      .from(teams)
      .where(and(eq(teams.leagueId, leagueId), sql`LOWER(REPLACE(${teams.name}, ' ', '')) = LOWER(REPLACE(${trimmedTeamName}, ' ', ''))`));
    if (existingName.length > 0 && existingName[0].id !== session.id) {
      return NextResponse.json(
        { error: "Team name is already taken in this league" },
        { status: 400 }
      );
    }

    // Auction format: only needs team name (players acquired via auction)
    if (isAuction) {
      // Update team: teamLoginId, name, isProfileComplete = true
      // Also initialize purse from league's initial budget
      const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      const initialBudget = leagueRow[0]?.initialBudget ?? 100_000_000;

      await db
        .update(teams)
        .set({
          teamLoginId: trimmedLoginId,
          name: trimmedTeamName,
          isProfileComplete: true,
          purse: initialBudget,
          updatedAt: new Date(),
        })
        .where(eq(teams.id, session.id));

      await invalidateLeaguePageCache(leagueId);

      return NextResponse.json({
        success: true,
        message: "Profile setup completed (auction format — players acquired via auction)",
      });
    }

    // TVT / Triple Crown: require 2 FPL player IDs

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

    // Update team: teamLoginId, name, isProfileComplete = true
    await db
      .update(teams)
      .set({
        teamLoginId: trimmedLoginId,
        name: trimmedTeamName,
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
