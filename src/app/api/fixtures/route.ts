import { NextRequest, NextResponse } from "next/server";
import { db, fixtures, teams, gameweeks, groups, results, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";

/**
 * GET /api/fixtures
 * Get all fixtures, optionally filtered by gameweek
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const gameweekParam = searchParams.get("gameweek");
    const groupParam = searchParams.get("group");
    const leagueSlug = searchParams.get("leagueSlug");

    // Resolve leagueId from slug if provided
    let leagueId: string | null = null;
    if (leagueSlug) {
      const league = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
      if (league.length > 0) leagueId = league[0].id;
    }

    // Use relational queries for cleaner joins
    let allFixtures = await db.query.fixtures.findMany({
      with: {
        homeTeam: true,
        awayTeam: true,
        gameweek: true,
        group: true,
        result: true,
      },
    });

    // Filter by league if leagueSlug provided
    if (leagueId) {
      allFixtures = allFixtures.filter(f => f.gameweek.leagueId === leagueId);
    }

    // Filter by gameweek if provided
    if (gameweekParam) {
      const gwNumber = parseInt(gameweekParam);
      allFixtures = allFixtures.filter(f => f.gameweek.number === gwNumber);
    }

    // Filter by group if provided
    if (groupParam && (groupParam === "A" || groupParam === "B")) {
      allFixtures = allFixtures.filter(f => f.group.name === groupParam);
    }

    // Sort by gameweek number, then group name
    allFixtures.sort((a, b) => {
      if (a.gameweek.number !== b.gameweek.number) {
        return a.gameweek.number - b.gameweek.number;
      }
      return a.group.name.localeCompare(b.group.name);
    });

    // Group fixtures by gameweek
    const fixturesByGameweek: Record<number, typeof allFixtures> = {};
    for (const fixture of allFixtures) {
      const gw = fixture.gameweek.number;
      if (!fixturesByGameweek[gw]) {
        fixturesByGameweek[gw] = [];
      }
      fixturesByGameweek[gw].push(fixture);
    }

    return NextResponse.json({
      totalFixtures: allFixtures.length,
      fixtures: fixturesByGameweek,
    });
  } catch (error) {
    console.error("Error fetching fixtures:", error);
    return NextResponse.json(
      { error: "Failed to fetch fixtures" },
      { status: 500 }
    );
  }
}
