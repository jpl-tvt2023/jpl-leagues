import { NextRequest, NextResponse } from "next/server";
import { db, fixtures, gameweeks, groups, teams, users, type Group, type Team, type Gameweek } from "@/lib/db";
import { generateRoundRobinFixtures, generateGameweeks } from "@/lib/formats/tvt/fixtures";
import { eq, asc } from "drizzle-orm";
import { generateId } from "@/lib/id";

type GroupWithTeams = Group & { teams: Pick<Team, "id" | "name">[] };

/**
 * POST /api/fixtures/generate
 * Generate all league stage fixtures for both groups (admin-only)
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin (defense-in-depth — middleware also checks)
    const adminId = request.headers.get("x-session-id");
    const sessionType = request.headers.get("x-session-type");
    if (!adminId || sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    // Check if fixtures already exist
    const existingFixtures = await db.select().from(fixtures);
    if (existingFixtures.length > 0) {
      return NextResponse.json(
        { error: "Fixtures have already been generated. Delete existing fixtures first." },
        { status: 400 }
      );
    }

    // Get all groups with teams
    const allGroups = await db.query.groups.findMany({
      with: {
        teams: {
          columns: { id: true, name: true },
        },
      },
    });

    // Validate we have both groups with enough teams
    const groupA = allGroups.find((g) => g.name === "A");
    const groupB = allGroups.find((g) => g.name === "B");

    if (!groupA || !groupB) {
      return NextResponse.json(
        { error: "Both groups must exist before generating fixtures" },
        { status: 400 }
      );
    }

    if (groupA.teams.length < 2 || groupB.teams.length < 2) {
      return NextResponse.json(
        { 
          error: "Each group must have at least 2 teams",
          groupA: groupA.teams.length,
          groupB: groupB.teams.length,
        },
        { status: 400 }
      );
    }

    // Generate gameweeks if they don't exist
    const existingGameweeks = await db.select().from(gameweeks);
    if (existingGameweeks.length === 0) {
      const gameweekData = generateGameweeks();
      for (const gw of gameweekData) {
        await db.insert(gameweeks).values({
          id: generateId(),
          number: gw.number,
          leagueId: groupA.leagueId,
          isPlayoffs: gw.isPlayoffs,
          deadline: new Date(), // Will be updated with actual FPL deadlines
        });
      }
    }

    // Get all gameweeks for fixture creation
    const allGameweeks = await db.select()
      .from(gameweeks)
      .where(eq(gameweeks.isPlayoffs, false))
      .orderBy(asc(gameweeks.number));

    const gameweekMap = new Map(allGameweeks.map((gw) => [gw.number, gw.id]));

    // Generate fixtures for Group A
    const groupAFixtures = generateRoundRobinFixtures(groupA.teams);
    
    // Generate fixtures for Group B
    const groupBFixtures = generateRoundRobinFixtures(groupB.teams);

    // Create all fixtures in database
    const allFixtureData = [
      ...groupAFixtures.map((f) => ({
        id: generateId(),
        homeTeamId: f.homeTeamId,
        awayTeamId: f.awayTeamId,
        gameweekId: gameweekMap.get(f.gameweekNumber)!,
        groupId: groupA.id,
      })),
      ...groupBFixtures.map((f) => ({
        id: generateId(),
        homeTeamId: f.homeTeamId,
        awayTeamId: f.awayTeamId,
        gameweekId: gameweekMap.get(f.gameweekNumber)!,
        groupId: groupB.id,
      })),
    ];

    // Insert fixtures in batches
    for (const fixture of allFixtureData) {
      await db.insert(fixtures).values(fixture);
    }

    return NextResponse.json({
      success: true,
      message: "Fixtures generated successfully",
      summary: {
        totalFixtures: allFixtureData.length,
        groupA: {
          teams: groupA.teams.length,
          fixtures: groupAFixtures.length,
        },
        groupB: {
          teams: groupB.teams.length,
          fixtures: groupBFixtures.length,
        },
        gameweeks: allGameweeks.length,
      },
    });
  } catch (error) {
    console.error("Fixture generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate fixtures" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/fixtures/generate
 * Check status of fixture generation
 */
export async function GET() {
  try {
    const [fixtureList, gameweekList, allGroups] = await Promise.all([
      db.select().from(fixtures),
      db.select().from(gameweeks),
      db.query.groups.findMany({
        with: {
          teams: {
            columns: { id: true },
          },
        },
      }),
    ]);

    const groupA = allGroups.find((g) => g.name === "A");
    const groupB = allGroups.find((g) => g.name === "B");

    return NextResponse.json({
      fixturesGenerated: fixtureList.length > 0,
      totalFixtures: fixtureList.length,
      totalGameweeks: gameweekList.length,
      groups: {
        A: groupA?.teams.length ?? 0,
        B: groupB?.teams.length ?? 0,
      },
      readyToGenerate: (groupA?.teams.length ?? 0) >= 2 && (groupB?.teams.length ?? 0) >= 2,
    });
  } catch (error) {
    console.error("Error checking fixture status:", error);
    return NextResponse.json(
      { error: "Failed to check fixture status" },
      { status: 500 }
    );
  }
}
