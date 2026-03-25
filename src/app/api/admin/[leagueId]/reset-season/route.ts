import { NextRequest, NextResponse } from "next/server";
import { db, users, teams, players, gameweeks, fixtures, results, gameweekCaptains, gameweekChips, auditLogs } from "@/lib/db";
import { eq, inArray, or } from "drizzle-orm";
import { playoffTies, challengerSurvivalEntries } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * POST /api/admin/[leagueId]/reset-season
 * Reset all season data for this league — requires admin password confirmation
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const sessionId = request.headers.get("x-session-id");
    if (!sessionId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Look up admin user for password verification
    const admin = await db.query.users.findFirst({ where: eq(users.id, sessionId) });
    if (admin?.role !== "admin" && admin?.role !== "superadmin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { password } = body;

    if (!password) {
      return NextResponse.json({ error: "Password is required" }, { status: 400 });
    }

    const isValid = await bcrypt.compare(password, admin.password);
    if (!isValid) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 403 });
    }

    // Get all team IDs for this league
    const leagueTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, leagueId));
    const teamIds = leagueTeams.map(t => t.id);

    // Get all gameweek IDs for this league
    const leagueGameweeks = await db.select({ id: gameweeks.id }).from(gameweeks).where(eq(gameweeks.leagueId, leagueId));
    const gameweekIds = leagueGameweeks.map(gw => gw.id);

    // Get all player IDs for this league's teams
    const leaguePlayers = teamIds.length > 0
      ? await db.select({ id: players.id }).from(players).where(inArray(players.teamId, teamIds))
      : [];
    const playerIds = leaguePlayers.map(p => p.id);

    // Get all fixture IDs for this league's gameweeks
    const leagueFixtures = gameweekIds.length > 0
      ? await db.select({ id: fixtures.id }).from(fixtures).where(inArray(fixtures.gameweekId, gameweekIds))
      : [];
    const fixtureIds = leagueFixtures.map(f => f.id);

    await db.transaction(async (tx) => {
      // Delete challenger survival entries for this league's gameweeks
      if (gameweekIds.length > 0) {
        await tx.delete(challengerSurvivalEntries).where(inArray(challengerSurvivalEntries.gameweekId, gameweekIds));
      }

      // Delete audit logs for this league's teams
      if (teamIds.length > 0) {
        await tx.delete(auditLogs).where(inArray(auditLogs.teamId, teamIds));
      }

      // Delete gameweek chips for this league's teams
      if (teamIds.length > 0) {
        await tx.delete(gameweekChips).where(inArray(gameweekChips.teamId, teamIds));
      }

      // Delete gameweek captains for this league's players
      if (playerIds.length > 0) {
        await tx.delete(gameweekCaptains).where(inArray(gameweekCaptains.playerId, playerIds));
      }

      // Delete results for this league's fixtures
      if (fixtureIds.length > 0) {
        await tx.delete(results).where(inArray(results.fixtureId, fixtureIds));
      }

      // Delete playoff ties for this league's teams
      if (teamIds.length > 0) {
        await tx.delete(playoffTies).where(
          or(inArray(playoffTies.homeTeamId, teamIds), inArray(playoffTies.awayTeamId, teamIds))
        );
      }

      // Delete fixtures for this league's gameweeks
      if (gameweekIds.length > 0) {
        await tx.delete(fixtures).where(inArray(fixtures.gameweekId, gameweekIds));
      }

      // Delete players for this league's teams
      if (teamIds.length > 0) {
        await tx.delete(players).where(inArray(players.teamId, teamIds));
      }

      // Delete teams for this league
      await tx.delete(teams).where(eq(teams.leagueId, leagueId));

      // Delete gameweeks for this league
      await tx.delete(gameweeks).where(eq(gameweeks.leagueId, leagueId));
    });

    return NextResponse.json({
      success: true,
      message: "Season data has been reset for this league. Admin accounts, groups, and settings are preserved.",
      deleted: [
        "teams", "players", "gameweeks", "fixtures", "results",
        "gameweek_captains", "gameweek_chips", "playoff_ties",
        "challenger_survival_entries", "audit_logs"
      ],
      preserved: ["users", "groups", "settings"]
    });
  } catch (error) {
    console.error("Error resetting season:", error);
    return NextResponse.json({ error: "Failed to reset season" }, { status: 500 });
  }
}
