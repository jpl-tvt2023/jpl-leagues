import { NextRequest, NextResponse } from "next/server";
import { db, fixtures, teams, gameweeks, groups, results, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getCachedFixtures, setCachedFixtures } from "@/lib/fpl-cache";

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

    // Resolve leagueId and config from slug if provided
    let leagueId: string | null = null;
    let playoffStartGw: number | null = null;
    if (leagueSlug) {
      const league = await db.select({ id: leagues.id, playoffStartGw: leagues.playoffStartGw }).from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
      if (league.length > 0) {
        leagueId = league[0].id;
        playoffStartGw = league[0].playoffStartGw ?? null;
      }
    }

    // Return cached fixtures if available — only for unfiltered league requests
    // (filtered requests by gameweek/group are less common and can hit DB directly)
    if (leagueId && !gameweekParam && !groupParam) {
      const cached = await getCachedFixtures(leagueId);
      if (cached) return NextResponse.json(cached);
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

    const responseData = {
      totalFixtures: allFixtures.length,
      fixtures: fixturesByGameweek,
      playoffStartGw,
    };

    // Write to cache for future unfiltered requests
    if (leagueId && !gameweekParam && !groupParam) {
      await setCachedFixtures(leagueId, responseData);
    }

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Error fetching fixtures:", error);
    return NextResponse.json(
      { error: "Failed to fetch fixtures" },
      { status: 500 }
    );
  }
}
