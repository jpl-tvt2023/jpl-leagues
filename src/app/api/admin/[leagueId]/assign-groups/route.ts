import { NextRequest, NextResponse } from "next/server";
import { db, teams, groups, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

/**
 * POST /api/admin/[leagueId]/assign-groups
 * Bulk-assign teams to groups. Body: { assignments: { teamId: string, group: "A" | "B" }[] }
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { assignments } = body as { assignments: { teamId: string; group: string }[] };

    if (!Array.isArray(assignments) || assignments.length === 0) {
      return NextResponse.json({ error: "assignments array is required" }, { status: 400 });
    }

    // Validate all group values
    for (const a of assignments) {
      if (a.group !== "A" && a.group !== "B") {
        return NextResponse.json(
          { error: `Invalid group "${a.group}" for team ${a.teamId}. Must be A or B.` },
          { status: 400 }
        );
      }
    }

    // Ensure groups A and B exist for this league
    for (const groupName of ["A", "B"]) {
      const existing = await db
        .select()
        .from(groups)
        .where(and(eq(groups.name, groupName), eq(groups.leagueId, leagueId)));
      if (existing.length === 0) {
        await db.insert(groups).values({ id: generateId(), name: groupName, leagueId, groupType: "jpl" });
      }
    }

    // Fetch group records
    const groupRecords = await db
      .select()
      .from(groups)
      .where(eq(groups.leagueId, leagueId));
    const groupMap = new Map(groupRecords.map(g => [g.name, g.id]));

    let updated = 0;
    const errors: string[] = [];

    for (const { teamId, group } of assignments) {
      const groupId = groupMap.get(group);
      if (!groupId) {
        errors.push(`Group ${group} not found`);
        continue;
      }

      // Verify team belongs to this league
      const teamRecord = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)));

      if (teamRecord.length === 0) {
        errors.push(`Team ${teamId} not found in this league`);
        continue;
      }

      await db
        .update(teams)
        .set({ groupId, updatedAt: new Date() })
        .where(eq(teams.id, teamId));

      updated++;
    }

    await invalidateLeaguePageCache(leagueId);

    return NextResponse.json({
      success: true,
      updated,
      errors,
      message: `${updated} team(s) assigned to groups`,
    });
  } catch (error) {
    console.error("Assign groups error:", error);
    return NextResponse.json({ error: "Failed to assign groups" }, { status: 500 });
  }
}

/**
 * GET /api/admin/[leagueId]/assign-groups
 * Returns current group assignments for all teams in the league
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const allTeams = await db.query.teams.findMany({
      where: eq(teams.leagueId, leagueId),
      with: { group: true },
      columns: { id: true, name: true, groupId: true },
    });

    return NextResponse.json({
      teams: allTeams
        .filter(t => !("isGhost" in t) || !t.isGhost)
        .map(t => ({
          id: t.id,
          name: t.name,
          group: (t as { group: { name: string } }).group.name,
        })),
    });
  } catch (error) {
    console.error("Get group assignments error:", error);
    return NextResponse.json({ error: "Failed to fetch group assignments" }, { status: 500 });
  }
}
