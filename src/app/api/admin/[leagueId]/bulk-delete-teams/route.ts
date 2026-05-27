import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, fixtures, results, gameweekCaptains, auditLogs } from "@/lib/db";
import { eq, or, and, inArray } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

/**
 * POST /api/admin/[leagueId]/bulk-delete-teams
 *
 * Admin-only endpoint that deletes N teams + all their dependent rows in ONE
 * transaction. Replaces the previous admin-dashboard pattern of firing N
 * independent /api/admin/[leagueId]/delete-team requests in a loop — that
 * loop had no cross-team rollback, so a network blip mid-loop left half the
 * teams deleted and half intact.
 *
 * Body: { teamIds: string[] }
 *
 * Returns: { success, deleted: string[], skipped: { id, reason }[] }
 * - `deleted` lists team rows that were removed.
 * - `skipped` lists rows the route refused (not in league, ghost team).
 * If the transaction throws, NO team is deleted — caller can safely retry.
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const teamIds: unknown = body?.teamIds;

    if (!Array.isArray(teamIds) || teamIds.length === 0 || !teamIds.every(id => typeof id === "string")) {
      return NextResponse.json(
        { error: "teamIds must be a non-empty array of strings" },
        { status: 400 }
      );
    }
    if (teamIds.length > 200) {
      return NextResponse.json(
        { error: "Bulk delete is capped at 200 teams per call" },
        { status: 400 }
      );
    }

    // Pre-validate: load every requested team, partition into deletable vs skipped.
    const requested = await db
      .select()
      .from(teams)
      .where(and(inArray(teams.id, teamIds as string[]), eq(teams.leagueId, leagueId)));

    const requestedById = new Map(requested.map(r => [r.id, r]));
    const skipped: { id: string; reason: string }[] = [];
    const deletable: string[] = [];

    for (const id of teamIds as string[]) {
      const row = requestedById.get(id);
      if (!row) {
        skipped.push({ id, reason: "Team not found in this league" });
        continue;
      }
      if (row.isGhost === true) {
        skipped.push({ id, reason: "Cannot delete a ghost team (Triple Crown bye placeholder)" });
        continue;
      }
      deletable.push(id);
    }

    if (deletable.length === 0) {
      return NextResponse.json({ success: true, deleted: [], skipped });
    }

    // Collect player IDs across all deletable teams up-front so the transaction
    // body uses one inArray delete per dependent table instead of N round-trips.
    const teamPlayers = await db
      .select({ id: players.id })
      .from(players)
      .where(inArray(players.teamId, deletable));
    const playerIds = teamPlayers.map(p => p.id);

    await db.transaction(async (tx) => {
      // 1. gameweek_captains for players of any deletable team
      if (playerIds.length > 0) {
        await tx.delete(gameweekCaptains).where(inArray(gameweekCaptains.playerId, playerIds));
      }
      // 2. audit logs for any deletable team
      await tx.delete(auditLogs).where(inArray(auditLogs.teamId, deletable));
      // 3. results where the team participated
      await tx.delete(results).where(inArray(results.teamId, deletable));
      // 4. fixtures where the team is home or away
      await tx.delete(fixtures).where(
        or(
          inArray(fixtures.homeTeamId, deletable),
          inArray(fixtures.awayTeamId, deletable)
        )
      );
      // 5. players belonging to any deletable team
      await tx.delete(players).where(inArray(players.teamId, deletable));
      // 6. teams themselves
      await tx.delete(teams).where(inArray(teams.id, deletable));
    });

    await invalidateLeaguePageCache(leagueId);
    return NextResponse.json({
      success: true,
      deleted: deletable,
      skipped,
      message: `Deleted ${deletable.length} team(s). ${skipped.length > 0 ? `Skipped ${skipped.length}.` : ""}`.trim(),
    });
  } catch (error) {
    console.error("Bulk delete teams error:", error);
    return NextResponse.json(
      { error: "Failed to delete teams (transaction rolled back — no team was deleted)" },
      { status: 500 }
    );
  }
}
