import { NextRequest, NextResponse } from "next/server";
import { db, users, teams, players, fixtures, results, gameweekCaptains, auditLogs } from "@/lib/db";
import { eq, or } from "drizzle-orm";

/**
 * DELETE /api/admin/delete-team
 * Admin-only endpoint to delete a team and all related data
 */
export async function DELETE(request: NextRequest) {
  try {
    // Admin verified by middleware; defense-in-depth check
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { teamId } = body;

    if (!teamId) {
      return NextResponse.json(
        { error: "Team ID is required" },
        { status: 400 }
      );
    }

    // Check if team exists
    const existingTeam = await db.select().from(teams).where(eq(teams.id, teamId));
    if (existingTeam.length === 0) {
      return NextResponse.json(
        { error: "Team not found" },
        { status: 404 }
      );
    }

    const teamName = existingTeam[0].name;

    // Get all players for this team
    const teamPlayers = await db.select().from(players).where(eq(players.teamId, teamId));
    const playerIds = teamPlayers.map(p => p.id);

    // Delete related data in proper order within a transaction
    await db.transaction(async (tx) => {
      // 1. Delete gameweek captains for this team's players
      for (const playerId of playerIds) {
        await tx.delete(gameweekCaptains).where(eq(gameweekCaptains.playerId, playerId));
      }

      // 2. Delete audit logs related to this team
      await tx.delete(auditLogs).where(eq(auditLogs.teamId, teamId));

      // 3. Delete results where this team is involved
      await tx.delete(results).where(eq(results.teamId, teamId));

      // 4. Delete fixtures where this team is home or away
      await tx.delete(fixtures).where(
        or(
          eq(fixtures.homeTeamId, teamId),
          eq(fixtures.awayTeamId, teamId)
        )
      );

      // 5. Delete players belonging to this team
      await tx.delete(players).where(eq(players.teamId, teamId));

      // 6. Finally delete the team
      await tx.delete(teams).where(eq(teams.id, teamId));
    });

    return NextResponse.json({
      success: true,
      message: `Team "${teamName}" and all related data deleted successfully`,
    });
  } catch (error) {
    console.error("Delete team error:", error);
    return NextResponse.json(
      { error: "Failed to delete team" },
      { status: 500 }
    );
  }
}
