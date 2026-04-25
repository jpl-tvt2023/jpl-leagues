import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, results, gameweeks, gameweekCaptains, players, teams, leagues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { fetchTeamGameweekPicks } from "@/lib/fpl";
import {
  getLiveCachedScores,
  setLiveCachedScores,
  type LiveFixtureScore,
  type LiveGameweekData,
} from "@/lib/fpl-cache";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";

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
          homeTeamAbbr: f.homeTeam.abbreviation,
          awayTeamAbbr: f.awayTeam.abbreviation,
          homeScore: f.result!.homeScore,
          awayScore: f.result!.awayScore,
          homePlayers: f.result!.homePlayerScores ? JSON.parse(f.result!.homePlayerScores) : [],
          awayPlayers: f.result!.awayPlayerScores ? JSON.parse(f.result!.awayPlayerScores) : [],
        }));
      return NextResponse.json({ isLive: false, fixtures: storedFixtures, reason: "already_processed", cachedAt: new Date().toISOString() });
    }

    // Check live cache first
    const cached = await getLiveCachedScores(gwNumber, leagueId);
    if (cached && cached.fixtures && cached.fixtures.length > 0) {
      return NextResponse.json({ isLive: true, ...cached });
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
          homeTeamAbbr: fixture.homeTeam.abbreviation,
          awayTeamAbbr: fixture.awayTeam.abbreviation,
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
      // Get all captain picks for this GW
      const captainPicks = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.gameweekId, gw.id),
        with: { player: true },
      });

      // Build lookup: teamId → captainPlayerId (the player row ID, not fplId)
      const captainByTeam = new Map<string, string>();
      for (const pick of captainPicks) {
        captainByTeam.set(pick.player.teamId, pick.player.id);
      }

      // Previous-GW captains for temp-cap tiebreak rotation
      const prevCaptainByTeam = new Map<string, string>();
      if (gwNumber > 1) {
        const prevGw = await db.query.gameweeks.findFirst({
          where: leagueId
            ? and(eq(gameweeks.number, gwNumber - 1), eq(gameweeks.leagueId, leagueId))
            : eq(gameweeks.number, gwNumber - 1),
        });
        if (prevGw) {
          const prevPicks = await db.query.gameweekCaptains.findMany({
            where: eq(gameweekCaptains.gameweekId, prevGw.id),
            with: { player: true },
          });
          for (const p of prevPicks) prevCaptainByTeam.set(p.player.teamId, p.player.id);
        }
      }

      // Calculate live scores for each fixture
      const liveFixtures: LiveFixtureScore[] = [];

      for (const fixture of gwFixtures) {
        try {
          const homeScore = await calculateLiveTeamScore(
            fixture.homeTeam.players,
            captainByTeam.get(fixture.homeTeamId),
            prevCaptainByTeam.get(fixture.homeTeamId) ?? null,
            gwNumber
          );
          const awayScore = await calculateLiveTeamScore(
            fixture.awayTeam.players,
            captainByTeam.get(fixture.awayTeamId),
            prevCaptainByTeam.get(fixture.awayTeamId) ?? null,
            gwNumber
          );

          liveFixtures.push({
            fixtureId: fixture.id,
            gameweek: gwNumber,
            homeTeamName: fixture.homeTeam.name,
            awayTeamName: fixture.awayTeam.name,
            homeTeamAbbr: fixture.homeTeam.abbreviation,
            awayTeamAbbr: fixture.awayTeam.abbreviation,
            homeScore: homeScore.total,
            awayScore: awayScore.total,
            homePlayers: homeScore.players,
            awayPlayers: awayScore.players,
          });
        } catch (err) {
          console.error(`Live score error for fixture ${fixture.id}:`, err);
          // Return partial data with null scores for failed fixtures
          liveFixtures.push({
            fixtureId: fixture.id,
            gameweek: gwNumber,
            homeTeamName: fixture.homeTeam.name,
            awayTeamName: fixture.awayTeam.name,
            homeTeamAbbr: fixture.homeTeam.abbreviation,
            awayTeamAbbr: fixture.awayTeam.abbreviation,
            homeScore: 0,
            awayScore: 0,
            homePlayers: [],
            awayPlayers: [],
          });
        }
      }

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
      console.error(`Error fetching live scores for GW${gwNumber}:`, error);
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
 * Calculate live score for a TVT team (2 FPL players + captaincy doubling)
 */
async function calculateLiveTeamScore(
  teamPlayers: { id: string; name: string; fplId: string }[],
  captainPlayerId: string | undefined,
  prevCaptainPlayerId: string | null,
  gameweek: number
): Promise<{
  total: number;
  players: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
}> {
  const rawScores: { id: string; name: string; fplId: string; fplScore: number; transferHits: number; netScore: number }[] = [];
  for (const player of teamPlayers) {
    try {
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek);
      const fplScore = picks.entry_history.points;
      const transferHits = picks.entry_history.event_transfers_cost;
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore, transferHits, netScore: fplScore - transferHits });
    } catch {
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore: 0, transferHits: 0, netScore: 0 });
    }
  }

  let resolvedCaptainId: string | null = captainPlayerId ?? null;
  let isTemp = false;
  if (!resolvedCaptainId) {
    resolvedCaptainId = pickTempCaptain(rawScores, prevCaptainPlayerId);
    isTemp = !!resolvedCaptainId;
  }

  let total = 0;
  const players = rawScores.map(r => {
    const isCaptain = resolvedCaptainId === r.id;
    const finalScore = isCaptain ? r.netScore * 2 : r.netScore;
    total += finalScore;
    return {
      name: r.name,
      fplId: r.fplId,
      fplScore: r.fplScore,
      transferHits: r.transferHits,
      isCaptain,
      ...(isCaptain && isTemp ? { isTempCaptain: true } : {}),
      finalScore,
    };
  });

  return { total, players };
}
