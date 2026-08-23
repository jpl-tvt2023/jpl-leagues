import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, gameweekCaptains, teams, settings, leagues, auditLogs } from "@/lib/db";
import { eq, and, asc } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { computeCaptainCap, computeCaptainCheckLimit } from "@/lib/captains";
import { resolveSubmissionWindow, formatLateness } from "@/lib/gameweek-window";
import { getFinishedGwNumbers } from "@/lib/gameweeks/finished-set";

/**
 * POST /api/team/captain
 * Announce captain for a gameweek (team-authenticated).
 * The requested GW must be the currently open submission window (deadline
 * not yet passed, and past its own 30-minute post-deadline lock) — anything
 * else is hard-rejected with a message proving how late/mistimed the
 * request was, and recorded in the audit log.
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

    // The requested GW must be exactly the currently open submission window.
    // Anything else (deadline already passed, still in its post-deadline
    // lock, or not yet the open GW) is rejected with proof of timing.
    const allLeagueGws = await db.query.gameweeks.findMany({
      where: eq(gameweeks.leagueId, team.leagueId),
      orderBy: asc(gameweeks.number),
    });
    const now = new Date();
    const finishedGws = await getFinishedGwNumbers();
    const window = resolveSubmissionWindow(allLeagueGws, now, finishedGws, {
      requirePreviousFinished: leagueFormat === "tvt",
    });

    if (window.state !== "open" || window.gw?.number !== gameweekNumber) {
      const deadline = new Date(gw.deadline);
      const isLate = deadline <= now;
      const message = isLate
        ? `GW${gameweekNumber}'s deadline (${deadline.toISOString()}) passed ${formatLateness(now.getTime() - deadline.getTime())} before your submission arrived at ${now.toISOString()} — rejected.`
        : window.state === "awaiting-results"
        ? `GW${gameweekNumber} is not open yet: FPL has not marked GW${window.awaitingGw} finished. Double Pointer and Challenge Chip depend on the final league table, so declarations open once GW${window.awaitingGw} is settled.`
        : `GW${gameweekNumber} is not currently open for submissions.`;

      await db.insert(auditLogs).values({
        id: generateId(),
        type: "LATE_ATTEMPT",
        description: `Team ${team.name} attempted a captain submission for GW${gameweekNumber} at ${now.toISOString()} (deadline was ${deadline.toISOString()}).`,
        teamId: team.id,
        gameweekId: gw.id,
        pointsAffected: 0,
      });

      return NextResponse.json({ error: message }, { status: 400 });
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
      // Exclude this GW if the player was already captain for it (switching back)
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

    // The window check above already proved this GW's deadline is still
    // open, so manual announcements are always valid here. isValid: false
    // is reserved for auto-assigned captains (see temp-captain.ts).
    if (isSwitching) {
      // Update existing captain record to the new player
      await db.update(gameweekCaptains)
        .set({
          playerId: player.id,
          announcedAt: now,
          isValid: true,
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
        isValid: true,
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
      message: `${player.name} ${isSwitching ? "switched to" : "submitted as"} captain for GW${gameweekNumber}`,
      captain: {
        playerName: player.name,
        teamName: team.name,
        gameweek: gameweekNumber,
        announcedAt: now.toISOString(),
        isValid: true,
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
