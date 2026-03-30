import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, gameweeks, gameweekCaptains, auditLogs } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * POST /api/admin/[leagueId]/override-captain
 * Admin-only endpoint to override/set a captain for a team's gameweek
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { teamId, playerId, gameweekNumber, reason } = body;

    // Validate required fields
    if (!teamId || !playerId || !gameweekNumber) {
      return NextResponse.json(
        { error: "teamId, playerId, and gameweekNumber are required" },
        { status: 400 }
      );
    }

    const gwNumber = parseInt(gameweekNumber);
    if (isNaN(gwNumber) || gwNumber < 1 || gwNumber > 38) {
      return NextResponse.json(
        { error: "Invalid gameweek number (must be 1-38)" },
        { status: 400 }
      );
    }

    // Get the gameweek, creating it if it doesn't exist yet (e.g. playoff GWs)
    const gwList = await db.select().from(gameweeks).where(and(eq(gameweeks.number, gwNumber), eq(gameweeks.leagueId, leagueId)));
    let gw = gwList[0];

    if (!gw) {
      const leagueRecord = await db.select({ playoffStartGw: leagues.playoffStartGw }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
      const playoffStartGw = leagueRecord[0]?.playoffStartGw ?? 31;
      const gwId = generateId();
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + 7 * gwNumber);
      deadline.setHours(11, 0, 0, 0);
      await db.insert(gameweeks).values({ id: gwId, number: gwNumber, deadline, isPlayoffs: gwNumber >= playoffStartGw, leagueId });
      gw = { id: gwId, number: gwNumber, deadline, isPlayoffs: gwNumber >= playoffStartGw, leagueId, createdAt: new Date(), updatedAt: new Date() };
    }

    // Get the team and verify it exists
    const teamList = await db.select().from(teams).where(eq(teams.id, teamId));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json(
        { error: "Team not found" },
        { status: 404 }
      );
    }

    // Get the player and verify they belong to the team
    const playerList = await db.query.players.findMany({
      where: eq(players.id, playerId),
      with: { team: true },
    });
    const player = playerList[0];

    if (!player) {
      return NextResponse.json(
        { error: "Player not found" },
        { status: 404 }
      );
    }

    if (player.teamId !== teamId) {
      return NextResponse.json(
        { error: "Player does not belong to this team" },
        { status: 400 }
      );
    }

    // Check if captain already exists for this team/gameweek
    const existingCaptains = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.gameweekId, gw.id),
      with: { player: true },
    });

    const existingCaptain = existingCaptains.find(c => c.player.teamId === teamId);

    if (existingCaptain) {
      // Update existing captain pick
      await db.update(gameweekCaptains)
        .set({
          playerId: player.id,
          isValid: true, // Admin override makes it valid
          updatedAt: new Date(),
        })
        .where(eq(gameweekCaptains.id, existingCaptain.id));

      // Log the override
      await db.insert(auditLogs).values({
        id: generateId(),
        type: "ADMIN_OVERRIDE",
        description: `Admin override: Changed captain from ${existingCaptain.player.name} to ${player.name} for GW${gwNumber}. Reason: ${reason || "Not specified"}`,
        teamId: teamId,
        gameweekId: gw.id,
        pointsAffected: 0,
      });

      await invalidateLeaguePageCache(leagueId);
      return NextResponse.json({
        success: true,
        message: `Captain changed from ${existingCaptain.player.name} to ${player.name}`,
        override: {
          teamName: team.name,
          previousCaptain: existingCaptain.player.name,
          newCaptain: player.name,
          gameweek: gwNumber,
        },
      });
    } else {
      // Create new captain pick
      const captainId = generateId();
      await db.insert(gameweekCaptains).values({
        id: captainId,
        gameweekId: gw.id,
        playerId: player.id,
        announcedAt: new Date(),
        isValid: true, // Admin-created always valid
      });

      // Log the override
      await db.insert(auditLogs).values({
        id: generateId(),
        type: "ADMIN_OVERRIDE",
        description: `Admin override: Set captain to ${player.name} for GW${gwNumber}. Reason: ${reason || "Not specified"}`,
        teamId: teamId,
        gameweekId: gw.id,
        pointsAffected: 0,
      });

      await invalidateLeaguePageCache(leagueId);
      return NextResponse.json({
        success: true,
        message: `Captain set to ${player.name}`,
        override: {
          teamName: team.name,
          previousCaptain: null,
          newCaptain: player.name,
          gameweek: gwNumber,
        },
      });
    }
  } catch (error) {
    console.error("Admin captain override error:", error);
    return NextResponse.json(
      { error: "Failed to override captain" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/[leagueId]/override-captain
 * Get all teams and players for admin captain override
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Get all teams with their players
    const teamsWithPlayers = await db.query.teams.findMany({
      where: eq(teams.leagueId, leagueId),
      with: {
        players: true,
        group: true,
      },
    });

    // Get all gameweeks
    const allGameweeks = await db.select().from(gameweeks).where(eq(gameweeks.leagueId, leagueId));

    // Get all captain announcements for this league's gameweeks only
    const gwIds = allGameweeks.map(gw => gw.id);
    const allCaptains = gwIds.length > 0
      ? await db.query.gameweekCaptains.findMany({
          where: inArray(gameweekCaptains.gameweekId, gwIds),
          with: {
            player: { with: { team: true } },
            gameweek: true,
          },
        })
      : [];

    return NextResponse.json({
      teams: teamsWithPlayers.map(t => ({
        id: t.id,
        name: t.name,
        group: t.group.name,
        players: t.players.map(p => ({
          id: p.id,
          name: p.name,
          fplId: p.fplId,
          captaincyChipsUsed: p.captaincyChipsUsed,
        })),
      })),
      gameweeks: allGameweeks.map(gw => ({
        id: gw.id,
        number: gw.number,
        deadline: gw.deadline,
      })),
      currentCaptains: allCaptains.map(c => ({
        teamId: c.player.teamId,
        teamName: c.player.team.name,
        gameweek: c.gameweek.number,
        playerName: c.player.name,
        playerId: c.playerId,
        isValid: c.isValid,
        announcedAt: c.announcedAt,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch override data:", error);
    return NextResponse.json(
      { error: "Failed to fetch data" },
      { status: 500 }
    );
  }
}
