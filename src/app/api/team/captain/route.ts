import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, players, gameweekCaptains, auditLogs, teams, settings, leagues } from "@/lib/db";
import { canBeCaptain } from "@/lib/formats/tvt/scoring";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { computeCaptainCap, computeCaptainCheckLimit } from "@/lib/captains";

/**
 * POST /api/team/captain
 * Announce captain for a gameweek (team-authenticated)
 */
export async function POST(request: NextRequest) {
  try {
    // Check if team is logged in
    const teamId = request.headers.get("x-session-id");
    if (!teamId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { playerId, gameweek } = body;

    // Validate required fields
    if (!playerId || !gameweek) {
      return NextResponse.json(
        { error: "playerId and gameweek are required" },
        { status: 400 }
      );
    }

    const gameweekNumber = parseInt(gameweek);
    if (isNaN(gameweekNumber) || gameweekNumber < 1 || gameweekNumber > 38) {
      return NextResponse.json(
        { error: "Invalid gameweek number (must be 1-38)" },
        { status: 400 }
      );
    }

    // Get the team and its players first to get leagueId
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { players: true },
    });

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    // Determine captain cap based on league format (TC: 19, others: 15).
    // captainCheckLimit is the upper GW boundary of the League Stage — anything
    // beyond it is playoffs and exempts the per-player chip count. Derive it
    // from the league's actual playoffStartGw so TVT-8 (playoffStartGw=36 →
    // league stage GW1-35) doesn't get its final 5 league-stage GWs silently
    // treated as playoffs by a hardcoded 30.
    const leagueRow = await db.select({ format: leagues.format, playoffStartGw: leagues.playoffStartGw })
      .from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    const leagueFormat = leagueRow[0]?.format ?? "tvt";
    // Auction format has no captaincy/chip mechanics — guard at the route boundary
    // so a team that knows the endpoint URL can't create captaincy rows for an
    // auction league (where players don't even exist in the players table).
    if (leagueFormat === "auction") {
      return NextResponse.json(
        { error: "Captain announcements are not available in auction-format leagues" },
        { status: 400 }
      );
    }
    const playoffStartGw = leagueRow[0]?.playoffStartGw ?? 31;
    const CAPTAIN_CAP = computeCaptainCap(leagueFormat, playoffStartGw);
    const captainCheckLimit = computeCaptainCheckLimit(leagueFormat, playoffStartGw);

    // Check if captain announcements are enabled for this league
    const captainSetting = await db.select().from(settings)
      .where(and(eq(settings.key, "captainAnnouncementEnabled"), eq(settings.leagueId, team.leagueId)))
      .limit(1);
    if (captainSetting.length > 0 && captainSetting[0].value === "false") {
      return NextResponse.json(
        { error: "Captain announcements are currently disabled by the admin" },
        { status: 403 }
      );
    }

    // Verify the player belongs to this team
    const player = team.players.find(p => p.id === playerId);
    if (!player) {
      return NextResponse.json(
        { error: "Player does not belong to your team" },
        { status: 400 }
      );
    }

    // Get the gameweek scoped to this league
    const gw = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, gameweekNumber), eq(gameweeks.leagueId, team.leagueId)),
    });

    if (!gw) {
      return NextResponse.json(
        { error: "Gameweek not found" },
        { status: 404 }
      );
    }

    // Check if captain already announced for this gameweek by this team
    const existingCaptains = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.gameweekId, gw.id),
      with: { player: true },
    });

    const existingCaptain = existingCaptains.find(c => c.player.teamId === teamId);
    const isSwitching = !!existingCaptain;
    const switchingToSamePlayer = existingCaptain?.playerId === playerId;

    if (switchingToSamePlayer) {
      return NextResponse.json(
        { error: "This player is already your captain for this gameweek" },
        { status: 400 }
      );
    }

    // Check captaincy chip availability (format-aware cap per player)
    // Only the final selection counts toward the limit
    if (gameweekNumber <= captainCheckLimit) {
      const playerCaptainHistory = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.playerId, playerId),
        with: { gameweek: true },
      });
      // Exclude the current GW if this player was already captain for it (switching back)
      const leagueStageCount = playerCaptainHistory.filter(
        c => c.gameweek.number <= captainCheckLimit && c.gameweek.id !== gw.id
      ).length;

      if (leagueStageCount >= CAPTAIN_CAP) {
        return NextResponse.json(
          { error: `${player.name} has used all ${CAPTAIN_CAP} captaincy chips for the League Stage` },
          { status: 400 }
        );
      }
    }

    // Check deadline (must be announced before FPL deadline)
    const now = new Date();
    const deadline = new Date(gw.deadline);
    const isLate = now >= deadline;

    if (isSwitching) {
      // Update existing captain record to the new player
      await db.update(gameweekCaptains)
        .set({
          playerId: player.id,
          announcedAt: now,
          isValid: !isLate,
          updatedAt: new Date(),
        })
        .where(eq(gameweekCaptains.id, existingCaptain.id));
    } else {
      // Create new captain announcement
      const captainId = generateId();
      await db.insert(gameweekCaptains).values({
        id: captainId,
        gameweekId: gw.id,
        playerId: player.id,
        announcedAt: now,
        isValid: !isLate,
      });
    }

    // Log late announcement as penalty
    if (isLate) {
      await db.insert(auditLogs).values({
        id: generateId(),
        type: "PENALTY",
        description: `Late captain ${isSwitching ? "switch" : "announcement"} for GW${gameweekNumber}`,
        teamId: teamId,
        gameweekId: gw.id,
        pointsAffected: 0,
      });
    }

    // Calculate remaining chips for the selected player
    const updatedHistory = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.playerId, playerId),
      with: { gameweek: true },
    });
    const finalLeagueCount = updatedHistory.filter(c => c.gameweek.number <= captainCheckLimit).length;
    const chipsRemaining = gameweekNumber <= captainCheckLimit
      ? CAPTAIN_CAP - finalLeagueCount
      : "unlimited";

    return NextResponse.json({
      success: true,
      message: isLate
        ? `Captain ${isSwitching ? "switched" : "announced"} but marked as late (after deadline)`
        : `Captain ${isSwitching ? "switched" : "announced"} successfully`,
      captain: {
        playerName: player.name,
        teamName: team.name,
        gameweek: gameweekNumber,
        announcedAt: now.toISOString(),
        isValid: !isLate,
        captaincyChipsRemaining: chipsRemaining,
        wasSwitched: isSwitching,
      },
    });
  } catch (error) {
    console.error("Captain announcement error:", error);
    return NextResponse.json(
      { error: "Failed to announce captain" },
      { status: 500 }
    );
  }
}
