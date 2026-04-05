import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, fixtures, results, groups, leagues, teams } from "@/lib/db";
import { generateRoundRobinFixtures, generateGameweeks } from "@/lib/formats/tvt/fixtures";
import { eq, and, asc, count, inArray } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * POST /api/admin/[leagueId]/generate-fixtures
 * Generate all league-stage fixtures for the league.
 * Supports all three TVT formats:
 *   32-team: 2 groups of 16, 2 repetitions → 30 GWs, playoffStartGw=31
 *   16-team: 1 group of 16, 2 repetitions → 30 GWs, playoffStartGw=31
 *    8-team: 1 group of 8,  5 repetitions → 35 GWs, playoffStartGw=36
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Read league config
    const leagueRows = await db
      .select({
        teamSize: leagues.teamSize,
        groupCount: leagues.groupCount,
        playoffStartGw: leagues.playoffStartGw,
        format: leagues.format,
      })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);

    if (!leagueRows.length) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }

    const { teamSize, groupCount, playoffStartGw, format } = leagueRows[0];
    const isTripleCrown = format === "triple-crown";
    const teamsPerGroup = (teamSize ?? 32) / (groupCount ?? 2);
    const effectivePlayoffStart = playoffStartGw ?? 31;

    // Check if fixtures already exist for this league
    const [existingCount] = await db
      .select({ count: count() })
      .from(fixtures)
      .innerJoin(gameweeks, eq(fixtures.gameweekId, gameweeks.id))
      .where(eq(gameweeks.leagueId, leagueId));

    if ((existingCount?.count ?? 0) > 0) {
      return NextResponse.json(
        { error: "Fixtures have already been generated for this league. Delete existing fixtures first." },
        { status: 400 }
      );
    }

    // Get groups for this league
    const allGroups = await db.query.groups.findMany({
      where: eq(groups.leagueId, leagueId),
      with: {
        teams: { columns: { id: true, name: true } },
      },
    });

    // ── Triple Crown: PL fixtures span all 38 GWs, single group (or no groups), 2 reps (20 teams × 2 = 38) ──
    if (isTripleCrown) {
      let plGroup = allGroups.find((g) => g.name === "A");

      // If no groups exist, fetch all league teams directly
      if (!plGroup) {
        const allTeams = await db.query.teams.findMany({
          where: eq(teams.leagueId, leagueId),
          columns: { id: true, name: true },
        });
        if (allTeams.length < 2) {
          return NextResponse.json(
            { error: `League must have at least 2 teams for fixtures (has ${allTeams.length})` },
            { status: 400 }
          );
        }
        // Create a virtual group object (will use null groupId in fixtures)
        plGroup = { id: null, name: "League", teams: allTeams, leagueId, groupType: "pl" } as any;
      } else {
        // Groups exist, validate group A
        if (plGroup.teams.length < 2) {
          return NextResponse.json({ error: `Group A must have at least 2 teams (has ${plGroup.teams.length})` }, { status: 400 });
        }
      }

      // After if/else, plGroup is guaranteed to be defined
      if (!plGroup) throw new Error("plGroup should be defined"); // TypeScript guard

      // Ensure all 38 gameweeks exist, all isPlayoffs=false (Triple Crown has no TVT playoffs)
      const existingGws = await db.select().from(gameweeks).where(eq(gameweeks.leagueId, leagueId));
      const existingGwNums = new Set(existingGws.map((gw) => gw.number));
      for (let n = 1; n <= 38; n++) {
        if (!existingGwNums.has(n)) {
          await db.insert(gameweeks).values({
            id: generateId(),
            number: n,
            leagueId,
            isPlayoffs: false,
            deadline: new Date(),
          });
        }
      }

      const allGws = await db.select().from(gameweeks).where(eq(gameweeks.leagueId, leagueId)).orderBy(asc(gameweeks.number));
      const gameweekMap = new Map(allGws.map((gw) => [gw.number, gw.id]));

      // 20 teams × 2 reps = 38 GWs exactly
      const tcRepetitions = 2;
      const plFixtures = generateRoundRobinFixtures(plGroup.teams, tcRepetitions);

      const fixtureData = plFixtures.map((f) => ({
        id: generateId(),
        homeTeamId: f.homeTeamId,
        awayTeamId: f.awayTeamId,
        gameweekId: gameweekMap.get(f.gameweekNumber)!,
        groupId: plGroup.id || null, // null for groupless leagues
        competitionType: "pl",
      })).filter((f) => f.gameweekId != null);

      for (const fixture of fixtureData) {
        await db.insert(fixtures).values(fixture);
      }

      await invalidateLeaguePageCache(leagueId);
      return NextResponse.json({
        success: true,
        message: "PL fixtures generated successfully for Triple Crown league",
        summary: {
          format: "Triple Crown (20-team, 1 PL group)",
          repetitions: tcRepetitions,
          leagueStageGws: 38,
          totalFixtures: fixtureData.length,
          plGroup: { teams: plGroup.teams.length, fixtures: plFixtures.length },
        },
      });
    }

    // ── TVT path: handle both grouped (32-team) and groupless (8/16-team) leagues ──
    const isSingleGroupFormat = (groupCount ?? 2) === 1;

    let groupA = allGroups.find((g) => g.name === "A");
    let groupB = (groupCount ?? 2) === 2 ? allGroups.find((g) => g.name === "B") : null;

    // For single-group formats (8/16-team), fetch all league teams if groups don't exist
    if (isSingleGroupFormat) {
      if (!groupA) {
        // No groups exist, fetch all teams for the league directly
        const allTeams = await db.query.teams.findMany({
          where: eq(teams.leagueId, leagueId),
          columns: { id: true, name: true },
        });
        if (allTeams.length < 2) {
          return NextResponse.json(
            { error: `League must have at least 2 teams (has ${allTeams.length})` },
            { status: 400 }
          );
        }
        // Create a virtual group object for processing (will use null groupId in fixtures)
        groupA = { id: null, name: "League", teams: allTeams, leagueId, groupType: "pl" } as any;
      } else if (groupA.teams.length < 2) {
        return NextResponse.json(
          { error: `Group A must have at least 2 teams (has ${groupA.teams.length})` },
          { status: 400 }
        );
      }
    } else {
      // For 2-group format (32-team), require both groups
      if (!groupA) {
        return NextResponse.json(
          { error: "Group A must exist before generating fixtures" },
          { status: 400 }
        );
      }
      if (!groupB) {
        return NextResponse.json(
          { error: "Both Group A and Group B must exist before generating fixtures" },
          { status: 400 }
        );
      }
      if (groupA.teams.length < 2) {
        return NextResponse.json(
          { error: `Group A must have at least 2 teams (has ${groupA.teams.length})` },
          { status: 400 }
        );
      }
      if (groupB.teams.length < 2) {
        return NextResponse.json(
          { error: `Group B must have at least 2 teams (has ${groupB.teams.length})` },
          { status: 400 }
        );
      }
    }

    // After if/else blocks, groupA is guaranteed to be defined for both paths
    if (!groupA) throw new Error("groupA should be defined"); // TypeScript guard

    // Compute repetitions from league config
    // Formula: (playoffStartGw - 1) / (teamsPerGroup - 1)
    // 32-team: 30/15=2, 16-team: 30/15=2, 8-team: 35/7=5
    const repetitions = (effectivePlayoffStart - 1) / (teamsPerGroup - 1);

    // Ensure league-stage gameweeks exist for this league
    const existingLeagueGws = await db
      .select()
      .from(gameweeks)
      .where(and(eq(gameweeks.leagueId, leagueId), eq(gameweeks.isPlayoffs, false)));

    if (existingLeagueGws.length === 0) {
      const gwData = generateGameweeks(effectivePlayoffStart);
      for (const gw of gwData.filter((g) => !g.isPlayoffs)) {
        await db.insert(gameweeks).values({
          id: generateId(),
          number: gw.number,
          leagueId,
          isPlayoffs: false,
          deadline: new Date(),
        });
      }
    }

    // Build gameweek map for this league (non-playoff only)
    const leagueGws = await db
      .select()
      .from(gameweeks)
      .where(and(eq(gameweeks.leagueId, leagueId), eq(gameweeks.isPlayoffs, false)))
      .orderBy(asc(gameweeks.number));

    const gameweekMap = new Map(leagueGws.map((gw) => [gw.number, gw.id]));

    // Generate fixtures per group
    const groupAFixtures = generateRoundRobinFixtures(groupA.teams, repetitions);
    const groupBFixtures = groupB ? generateRoundRobinFixtures(groupB.teams, repetitions) : [];

    // Build insert payload
    const allFixtureData = [
      ...groupAFixtures.map((f) => ({
        id: generateId(),
        homeTeamId: f.homeTeamId,
        awayTeamId: f.awayTeamId,
        gameweekId: gameweekMap.get(f.gameweekNumber)!,
        groupId: groupA.id || null, // null for groupless leagues
      })),
      ...(groupB
        ? groupBFixtures.map((f) => ({
            id: generateId(),
            homeTeamId: f.homeTeamId,
            awayTeamId: f.awayTeamId,
            gameweekId: gameweekMap.get(f.gameweekNumber)!,
            groupId: groupB.id,
          }))
        : []),
    ];

    // Filter out any entries where gameweekId is undefined (safety)
    const validFixtures = allFixtureData.filter((f) => f.gameweekId != null);

    for (const fixture of validFixtures) {
      await db.insert(fixtures).values(fixture);
    }

    await invalidateLeaguePageCache(leagueId);
    return NextResponse.json({
      success: true,
      message: `Fixtures generated successfully for ${teamSize}-team league`,
      summary: {
        format: `${teamSize}-team (${groupCount === 1 ? "1 group" : "2 groups"})`,
        repetitions,
        leagueStageGws: effectivePlayoffStart - 1,
        totalFixtures: validFixtures.length,
        groupA: {
          teams: groupA.teams.length,
          fixtures: groupAFixtures.length,
        },
        ...(groupB
          ? {
              groupB: {
                teams: groupB.teams.length,
                fixtures: groupBFixtures.length,
              },
            }
          : {}),
      },
    });
  } catch (error) {
    console.error("Fixture generation error:", error);
    return NextResponse.json({ error: "Failed to generate fixtures" }, { status: 500 });
  }
}

/**
 * GET /api/admin/[leagueId]/generate-fixtures
 * Check fixture generation status for this league.
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const leagueRows = await db
      .select({
        teamSize: leagues.teamSize,
        groupCount: leagues.groupCount,
        playoffStartGw: leagues.playoffStartGw,
      })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);

    const leagueConfig = leagueRows[0];

    const [fixtureCountRow] = await db
      .select({ count: count() })
      .from(fixtures)
      .innerJoin(gameweeks, eq(fixtures.gameweekId, gameweeks.id))
      .where(eq(gameweeks.leagueId, leagueId));

    const allGroups = await db.query.groups.findMany({
      where: eq(groups.leagueId, leagueId),
      with: { teams: { columns: { id: true } } },
    });

    const groupA = allGroups.find((g) => g.name === "A");
    const groupB = allGroups.find((g) => g.name === "B");
    const groupCount = leagueConfig?.groupCount ?? 2;

    const readyToGenerate =
      (groupA?.teams.length ?? 0) >= 2 &&
      (groupCount === 1 || (groupB?.teams.length ?? 0) >= 2);

    return NextResponse.json({
      fixturesGenerated: (fixtureCountRow?.count ?? 0) > 0,
      totalFixtures: fixtureCountRow?.count ?? 0,
      leagueConfig: leagueConfig ?? null,
      groups: {
        A: groupA?.teams.length ?? 0,
        B: groupB?.teams.length ?? 0,
      },
      readyToGenerate,
    });
  } catch (error) {
    console.error("Error checking fixture status:", error);
    return NextResponse.json({ error: "Failed to check fixture status" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/[leagueId]/generate-fixtures
 * Delete all league-stage fixtures and gameweeks for this league to allow re-generation.
 * Preserves playoff fixtures if they exist.
 */
export async function DELETE(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Get all league-stage gameweeks (isPlayoffs = false)
    const leagueGws = await db
      .select({ id: gameweeks.id })
      .from(gameweeks)
      .where(and(eq(gameweeks.leagueId, leagueId), eq(gameweeks.isPlayoffs, false)));

    if (leagueGws.length === 0) {
      return NextResponse.json({ success: true, message: "No league-stage fixtures to delete" });
    }

    const leagueGwIds = leagueGws.map((gw) => gw.id);

    // Delete results for these fixtures
    const fixtureIds = await db
      .select({ id: fixtures.id })
      .from(fixtures)
      .where(inArray(fixtures.gameweekId, leagueGwIds));

    if (fixtureIds.length > 0) {
      await db.delete(results).where(inArray(results.fixtureId, fixtureIds.map((f) => f.id)));
    }

    // Delete fixtures for league-stage gameweeks
    const deletedFixturesCount = await db
      .delete(fixtures)
      .where(inArray(fixtures.gameweekId, leagueGwIds));

    // Delete league-stage gameweeks
    const deletedGwsCount = await db
      .delete(gameweeks)
      .where(inArray(gameweeks.id, leagueGwIds));

    await invalidateLeaguePageCache(leagueId);
    return NextResponse.json({
      success: true,
      message: "League-stage fixtures and gameweeks deleted successfully",
      deletedGameweeks: leagueGws.length,
      deletedFixtures: fixtureIds.length,
    });
  } catch (error) {
    console.error("Error deleting fixtures:", error);
    return NextResponse.json({ error: "Failed to delete fixtures" }, { status: 500 });
  }
}
