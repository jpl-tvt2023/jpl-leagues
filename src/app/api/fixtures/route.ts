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

    // leagueSlug is required
    if (!leagueSlug) {
      return NextResponse.json(
        { error: "leagueSlug parameter is required" },
        { status: 400 }
      );
    }

    // Resolve leagueId and config from slug
    const league = await db.select({ id: leagues.id, playoffStartGw: leagues.playoffStartGw, format: leagues.format }).from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
    if (league.length === 0) {
      return NextResponse.json(
        { error: "League not found" },
        { status: 404 }
      );
    }

    const leagueId = league[0].id;
    const playoffStartGw = league[0].playoffStartGw ?? null;
    const format = league[0].format ?? "tvt";

    // Return cached fixtures if available — only for unfiltered league requests
    if (leagueId && !gameweekParam && !groupParam) {
      try {
        const cached = await getCachedFixtures(leagueId);
        if (cached) return NextResponse.json(cached);
      } catch {
        // Cache miss or Redis error — fall through to DB computation
      }
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

    // Filter by league (now always present)
    allFixtures = allFixtures.filter(f => f.gameweek.leagueId === leagueId);

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
      format,
    };

    // Fire-and-forget cache write
    if (leagueId && !gameweekParam && !groupParam) {
      setCachedFixtures(leagueId, responseData).catch(() => {});
    }

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Error fetching fixtures:", error);
    // Return empty fixtures instead of error — likely no fixtures generated yet
    return NextResponse.json({
      fixtures: {},
      playoffStartGw: 31,
    });
  }
}
