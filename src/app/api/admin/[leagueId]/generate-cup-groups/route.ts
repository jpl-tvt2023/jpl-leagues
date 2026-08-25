/**
 * POST /api/admin/[leagueId]/generate-cup-groups
 * Continental Championship: Seed 20 teams into 4 cup groups after GW5
 *
 * Flow:
 * 1. Fetch PL standings at end of GW5 (leagueStageEnd=5)
 * 2. Snake-seed 20 teams into 4 groups (A/B/C/D) of 5 teams each
 * 3. Create 4 cup group rows with groupType="cup"
 * 4. Reassign teams to cup groups
 * 5. Create 1 Ghost team per cup group (isGhost=true, no players)
 * 6. Generate round-robin cup fixtures (5 human + 1 Ghost = 6 teams per group)
 *    - 10 matchdays on even GWs: 6,8,10,12,14,16,18,20,22,24
 *    - competitionType="cup-group"
 */

import { NextRequest, NextResponse } from "next/server";
import { db, teams, groups, fixtures, gameweeks, leagues, results, type Team } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { getGroupStandings } from "@/lib/formats/tvt/playoffs";
import { compareTiebreaker } from "@/lib/formats/tvt/tiebreaker";
import { generateCupGroupFixtures, seedCupGroups } from "@/lib/formats/continental-championship/fixtures";

export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Fetch league config
    const leagueRow = await db.select({
      format: leagues.format,
      teamSize: leagues.teamSize,
    }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);

    if (!leagueRow.length) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }

    if (leagueRow[0].format !== "continental-championship") {
      return NextResponse.json({
        error: "Cup group seeding only available for Continental Championship format",
      }, { status: 400 });
    }

    if (leagueRow[0].teamSize !== 20) {
      return NextResponse.json({
        error: "Continental Championship must have exactly 20 teams",
      }, { status: 400 });
    }

    // Check if cup groups already exist
    const existingCupGroups = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "cup"))
    );

    if (existingCupGroups.length > 0) {
      return NextResponse.json({
        error: "Cup groups already exist for this league. Delete them first to reseed.",
      }, { status: 400 });
    }

    // Fetch PL standings at end of GW5 (leagueStageEnd = 5)
    const standings = await getGroupStandings(leagueId, 5);
    if (!standings) {
      return NextResponse.json({
        error: "Failed to compute PL standings at GW5",
      }, { status: 500 });
    }

    // Combine and rank all 20 teams
    const allTeams = [...standings.groupA, ...standings.groupB];
    if (allTeams.length < 20) {
      return NextResponse.json({
        error: `Expected 20 teams, found ${allTeams.length}. Ensure all teams are ranked.`,
      }, { status: 400 });
    }

    // Merge the two group tables into one 20-team order using the SAME rule that ranked
    // them. The previous `b.leaguePoints - a.leaguePoints` re-sort threw the tiebreaker
    // away immediately after getGroupStandings had applied it, making snake seeding
    // non-deterministic on ties — and this decides cup groups for the whole season.
    allTeams.sort(compareTiebreaker);

    // Seed into 4 cup groups using snake distribution
    const seededGroups = seedCupGroups(
      allTeams.map(t => ({ id: t.teamId, name: t.name }))
    );

    const cupGroupMappings: Record<string, { id: string; name: string; displayName: string }> = {
      groupA: { id: "", name: "Cup-A", displayName: "A" },
      groupB: { id: "", name: "Cup-B", displayName: "B" },
      groupC: { id: "", name: "Cup-C", displayName: "C" },
      groupD: { id: "", name: "Cup-D", displayName: "D" },
    };

    // Create cup group rows and Ghost teams
    const ghostTeamIds: Record<string, string> = {};
    const cupTeamCounts: Record<string, number> = {};

    for (const [groupKey, groupName] of Object.entries(cupGroupMappings)) {
      const groupId = generateId();
      cupGroupMappings[groupKey].id = groupId;
      cupTeamCounts[groupKey] = 0;

      // Create cup group
      await db.insert(groups).values({
        id: groupId,
        name: groupName.name,
        leagueId,
        groupType: "cup",
      });

      // Create Ghost team for this group
      const ghostTeamId = generateId();
      ghostTeamIds[groupKey] = ghostTeamId;

      await db.insert(teams).values({
        id: ghostTeamId,
        name: `The Ghost (${groupName.displayName})`,
        password: "", // Ghost teams don't login
        mustChangePassword: false,
        leagueId,
        groupId,
        isGhost: true,
        leaguePoints: 0,
        bonusPoints: 0,
        cupGroupPoints: 0,
      });
    }

    // Assign human teams to cup groups and generate fixtures
    const generatedFixtures: string[] = [];

    for (const [groupKey, teamList] of Object.entries(seededGroups)) {
      const cupGroupId = cupGroupMappings[groupKey].id;
      const ghostTeamId = ghostTeamIds[groupKey];

      // Assign human teams to this cup group
      const humanTeamIds: string[] = [];
      for (const teamInfo of teamList) {
        const teamRecord = await db.select().from(teams).where(eq(teams.id, teamInfo.id));
        if (teamRecord[0]) {
          // Update team's groupId to new cup group
          await db.update(teams)
            .set({ groupId: cupGroupId })
            .where(eq(teams.id, teamInfo.id));
          humanTeamIds.push(teamInfo.id);
        }
      }

      // Generate cup group fixtures (5 human + 1 Ghost = 6 teams)
      const cupTeams = [
        ...teamList.map(t => ({ id: t.id, name: t.name })),
        { id: ghostTeamId, name: `The Ghost (${cupGroupMappings[groupKey].displayName})` },
      ];

      const cupFixtures = generateCupGroupFixtures(cupTeams, ghostTeamId);

      // Insert cup group fixtures
      for (const fixture of cupFixtures) {
        const fixtureId = generateId();
        const gwRecord = await db.query.gameweeks.findFirst({
          where: and(
            eq(gameweeks.number, fixture.gameweekNumber),
            eq(gameweeks.leagueId, leagueId)
          ),
        });

        if (!gwRecord) {
          // Create the gameweek with a deadline anchored to the league's
          // earliest existing gameweek (treated as GW1), not to today. If
          // the admin seeds cup groups mid-season, today+7*N would land all
          // synthetic deadlines in the wrong week. Falling back to today only
          // when no other gameweeks exist for this league.
          const earliestGw = await db.query.gameweeks.findFirst({
            where: eq(gameweeks.leagueId, leagueId),
            orderBy: (gw, { asc }) => [asc(gw.number)],
          });
          const anchorDate = earliestGw ? new Date(earliestGw.deadline) : new Date();
          const anchorNumber = earliestGw ? earliestGw.number : 1;
          const deadline = new Date(anchorDate);
          deadline.setDate(deadline.getDate() + 7 * (fixture.gameweekNumber - anchorNumber));
          deadline.setHours(11, 0, 0, 0);
          const gwId = generateId();

          await db.insert(gameweeks).values({
            id: gwId,
            number: fixture.gameweekNumber,
            leagueId,
            deadline,
            isPlayoffs: false,
          });

          await db.insert(fixtures).values({
            id: fixtureId,
            gameweekId: gwId,
            homeTeamId: fixture.homeTeamId,
            awayTeamId: fixture.awayTeamId,
            groupId: cupGroupId,
            isChallenge: false,
            isPlayoff: false,
            competitionType: "cup-group",
          });
        } else {
          await db.insert(fixtures).values({
            id: fixtureId,
            gameweekId: gwRecord.id,
            homeTeamId: fixture.homeTeamId,
            awayTeamId: fixture.awayTeamId,
            groupId: cupGroupId,
            isChallenge: false,
            isPlayoff: false,
            competitionType: "cup-group",
          });
        }

        generatedFixtures.push(fixtureId);
      }
    }

    await invalidateLeaguePageCache(leagueId);

    return NextResponse.json({
      success: true,
      message: `Seeded 20 teams into 4 cup groups with ${generatedFixtures.length} fixtures`,
      summary: {
        cupGroups: 4,
        teamsPerGroup: 5,
        ghostTeams: 4,
        cupFixtures: generatedFixtures.length,
        matchdaysPerGroup: 10,
        cupGWs: [6, 8, 10, 12, 14, 16, 18, 20, 22, 24],
      },
    });
  } catch (error) {
    console.error("Error seeding cup groups:", error);
    return NextResponse.json(
      { error: "Failed to seed cup groups" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/[leagueId]/generate-cup-groups
 * Check cup group seeding status
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const cupGroups = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "cup"))
    );

    const plGroup = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "jpl"))
    );

    const cupFixtureCount = cupGroups.length > 0
      ? (await db.select().from(fixtures).where(
          and(
            eq(fixtures.competitionType, "cup-group"),
            ...cupGroups.map(g => eq(fixtures.groupId, g.id))
          )
        )).length
      : 0;

    return NextResponse.json({
      cupGroupsSeeded: cupGroups.length > 0,
      cupGroupCount: cupGroups.length,
      cupFixtures: cupFixtureCount,
      plGroupExists: plGroup.length > 0,
    });
  } catch (error) {
    console.error("Error checking cup group status:", error);
    return NextResponse.json(
      { error: "Failed to check cup group status" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/[leagueId]/generate-cup-groups
 * Delete all cup groups and fixtures for re-seeding
 */
export async function DELETE(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Find all cup groups for this league
    const cupGroups = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "cup"))
    );

    if (cupGroups.length === 0) {
      return NextResponse.json({ error: "No cup groups to delete" }, { status: 400 });
    }

    const cupGroupIds = cupGroups.map((g) => g.id);

    // Find all cup-group fixtures (reads can run outside the transaction —
    // we only need a consistent snapshot when the writes start). PL group
    // lookup is also a read.
    const cupFixtures = await db.select().from(fixtures).where(
      eq(fixtures.competitionType, "cup-group")
    );
    const leagueCupFixtures = cupFixtures.filter((f) => cupGroupIds.includes(f.groupId || ""));
    const fixtureIds = leagueCupFixtures.map((f) => f.id);

    const plGroup = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "jpl"))
    );
    const plGroupId = plGroup.length > 0 ? plGroup[0].id : null;

    // All destructive writes run inside one transaction so a partial failure
    // (cup fixtures wiped but ghost teams left behind, etc.) rolls back to a
    // consistent pre-DELETE state. Previously each delete/update was
    // independent and could orphan rows on mid-flow failure.
    await db.transaction(async (tx) => {
      // Delete results for cup fixtures
      for (const fixtureId of fixtureIds) {
        await tx.delete(results).where(eq(results.fixtureId, fixtureId));
      }

      // Delete cup fixtures
      for (const fixtureId of fixtureIds) {
        await tx.delete(fixtures).where(eq(fixtures.id, fixtureId));
      }

      // Delete ghost teams (isGhost = true for this league)
      await tx.delete(teams).where(
        and(eq(teams.leagueId, leagueId), eq(teams.isGhost, true))
      );

      // Reassign human teams back to PL group (or null if no PL group exists)
      for (const cupGroupId of cupGroupIds) {
        const cupTeams = await tx.select().from(teams).where(
          and(eq(teams.groupId, cupGroupId), eq(teams.isGhost, false))
        );
        for (const team of cupTeams) {
          await tx.update(teams)
            .set({ groupId: plGroupId })
            .where(eq(teams.id, team.id));
        }
      }

      // Delete cup groups
      for (const cupGroupId of cupGroupIds) {
        await tx.delete(groups).where(eq(groups.id, cupGroupId));
      }
    });

    await invalidateLeaguePageCache(leagueId);

    return NextResponse.json({ success: true, message: "Cup groups deleted successfully" });
  } catch (error) {
    console.error("Error deleting cup groups:", error);
    return NextResponse.json({ error: "Failed to delete cup groups" }, { status: 500 });
  }
}
