import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, fixtures, groups, leagues } from "@/lib/db";
import { generateRoundRobinFixtures, generateGameweeks } from "@/lib/fixtures";
import { eq, and, asc, count } from "drizzle-orm";
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
      })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);

    if (!leagueRows.length) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }

    const { teamSize, groupCount, playoffStartGw } = leagueRows[0];
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

    const groupA = allGroups.find((g) => g.name === "A");
    const groupB = (groupCount ?? 2) === 2 ? allGroups.find((g) => g.name === "B") : null;

    if (!groupA) {
      return NextResponse.json(
        { error: "Group A must exist before generating fixtures" },
        { status: 400 }
      );
    }
    if ((groupCount ?? 2) === 2 && !groupB) {
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
    if (groupB && groupB.teams.length < 2) {
      return NextResponse.json(
        { error: `Group B must have at least 2 teams (has ${groupB.teams.length})` },
        { status: 400 }
      );
    }

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
        groupId: groupA.id,
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
