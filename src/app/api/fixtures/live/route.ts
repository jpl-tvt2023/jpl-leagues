import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, gameweeks, leagues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  getLiveCachedScores,
  isLiveCacheFresh,
  setLiveCachedScores,
  type LiveFixtureScore,
  type LiveGameweekData,
} from "@/lib/fpl-cache";
import { computeLiveFixtureScores } from "@/lib/fpl-live/tvt-live-scores";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";

// Vercel Hobby ceiling — a full gameweek sweep needs room.
export const maxDuration = 60;

/**
 * GET /api/fixtures/live?gameweek=N
 * Returns live scores for all fixtures in a gameweek.
 * Uses 10-minute Redis cache to avoid FPL API rate limits.
 * Only returns live data for GWs whose deadline has passed but have no results yet.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const gwParam = searchParams.get("gameweek");

    if (!gwParam) {
      return NextResponse.json({ error: "gameweek parameter required" }, { status: 400 });
    }

    const gwNumber = parseInt(gwParam);
    if (isNaN(gwNumber) || gwNumber < 1 || gwNumber > 38) {
      return NextResponse.json({ error: "Invalid gameweek" }, { status: 400 });
    }

    // Resolve leagueId from leagueSlug if provided
    const leagueSlug = searchParams.get("leagueSlug");
    let leagueId: string | null = null;
    if (leagueSlug) {
      const leagueRow = await db.select({ id: leagues.id }).from(leagues)
        .where(eq(leagues.slug, leagueSlug)).limit(1);
      if (leagueRow.length > 0) leagueId = leagueRow[0].id;
    }

    // Find the gameweek record (scoped to league if provided)
    const gwRecords = await db.select().from(gameweeks).where(
      leagueId
        ? and(eq(gameweeks.number, gwNumber), eq(gameweeks.leagueId, leagueId))
        : eq(gameweeks.number, gwNumber)
    );
    if (gwRecords.length === 0) {
      return NextResponse.json({ isLive: false, fixtures: [] });
    }
    const gw = gwRecords[0];

    // Check if deadline has passed
    const now = new Date();
    if (gw.deadline > now) {
      return NextResponse.json({ isLive: false, fixtures: [], reason: "deadline_not_passed" });
    }

    // Check if results already exist for this GW (i.e. scores already processed)
    const gwFixtures = await db.query.fixtures.findMany({
      where: eq(fixtures.gameweekId, gw.id),
      with: {
        homeTeam: { with: { players: true, group: true } },
        awayTeam: { with: { players: true, group: true } },
        result: true,
      },
    });

    if (gwFixtures.length === 0) {
      return NextResponse.json({ isLive: false, fixtures: [] });
    }

    // If ALL fixtures have results, this GW is done — return stored data with player breakdowns
    const allHaveResults = gwFixtures.every((f) => f.result !== null);
    if (allHaveResults) {
      const storedFixtures = gwFixtures
        .filter(f => f.result)
        .map(f => ({
          fixtureId: f.id,
          gameweek: gwNumber,
          homeTeamName: f.homeTeam.name,
          awayTeamName: f.awayTeam.name,
          homeTeamId: f.homeTeamId,
          awayTeamId: f.awayTeamId,
          homeScore: f.result!.homeScore,
          awayScore: f.result!.awayScore,
          homePlayers: normalizeStoredPlayerScores(f.result!.homePlayerScores),
          awayPlayers: normalizeStoredPlayerScores(f.result!.awayPlayerScores),
        }));
      return NextResponse.json({ isLive: false, fixtures: storedFixtures, reason: "already_processed", cachedAt: new Date().toISOString() });
    }

    // Serve whatever is cached, fresh or stale.
    //
    // A stale copy goes back immediately rather than being recomputed. A whole
    // gameweek is ~64 FPL calls, which the gateway's rate cap stretches to about
    // ten seconds; making whichever reader happens to arrive after the fresh
    // window lapses pay that for everyone — while the page showed "Upcoming" —
    // is precisely the problem. The client refreshes behind the numbers instead.
    const cached = await getLiveCachedScores(gwNumber, leagueId);
    if (cached && cached.fixtures && cached.fixtures.length > 0) {
      return NextResponse.json({
        isLive: true,
        ...cached,
        stale: !isLiveCacheFresh(cached),
      });
    }

    // Cache miss - check if we have DB results (fallback when Redis is empty)
    const dbFixtures: LiveFixtureScore[] = [];
    for (const fixture of gwFixtures) {
      if (fixture.result) {
        dbFixtures.push({
          fixtureId: fixture.id,
          gameweek: gwNumber,
          homeTeamName: fixture.homeTeam.name,
          awayTeamName: fixture.awayTeam.name,
          homeTeamId: fixture.homeTeamId,
          awayTeamId: fixture.awayTeamId,
          homeScore: fixture.result.homeScore,
          awayScore: fixture.result.awayScore,
          homePlayers: [],
          awayPlayers: [],
        });
      }
    }

    // If we have DB results, return those (fallback when Redis is empty)
    if (dbFixtures.length > 0) {
      return NextResponse.json({
        isLive: false,
        gameweek: gwNumber,
        fixtures: dbFixtures,
        source: "database",
        cachedAt: new Date().toISOString(),
      });
    }

    // Try to fetch fresh from FPL API
    try {
      // Shared with /api/fixtures/live/refresh so the cached number and the
      // refreshed number can never disagree — these used to be two separate
      // implementations with different captain handling.
      const liveFixtures = await withFplBudget(
        { lane: "background", label: `live gw${gwNumber}`, max: 80 },
        () => computeLiveFixtureScores({ leagueId, gwNumber })
      );

      if (liveFixtures.length > 0) {
        const liveData: LiveGameweekData = {
          gameweek: gwNumber,
          fixtures: liveFixtures,
          cachedAt: new Date().toISOString(),
        };

        // Cache for 10 minutes
        await setLiveCachedScores(gwNumber, liveData, leagueId);

        return NextResponse.json({ isLive: true, ...liveData });
      }
    } catch (error) {
      if (error instanceof FplUnavailableError) {
        // Breaker open, or a scoring run holds the lock. Expected — fall
        // through to the empty response rather than logging a fault.
        console.warn(`[live] FPL unavailable for GW${gwNumber} (${error.reason})`);
      } else {
        console.error(`Error fetching live scores for GW${gwNumber}:`, error);
      }
      // Fallback already handled above with DB results
    }

    // Ultimate fallback - return empty
    return NextResponse.json({
      isLive: false,
      gameweek: gwNumber,
      fixtures: [],
      cachedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Live fixtures error:", error);
    return NextResponse.json(
      { error: "Failed to fetch live scores" },
      { status: 500 }
    );
  }
}

/**
 * Parse stored homePlayerScores/awayPlayerScores JSON and normalize legacy field names.
 * Older rows stored `isAutoAssigned: true` for auto-picked captains; the renderer expects
 * `isTempCaptain: true`. Map one to the other so old data renders the C* badge.
 */
function normalizeStoredPlayerScores(raw: string | null | undefined): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<Record<string, unknown>>;
    return arr.map(p => p.isAutoAssigned && !p.isTempCaptain ? { ...p, isTempCaptain: true } : p);
  } catch { return []; }
}
