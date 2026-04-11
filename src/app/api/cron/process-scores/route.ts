import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, fixtures, results, teams, gameweekCaptains, players, leagues } from "@/lib/db";
import { eq, asc, and } from "drizzle-orm";
import { clearLiveCache, setLiveCachedScores } from "@/lib/fpl-cache";
import { detectLiveGameweek, fetchTeamGameweekPicks } from "@/lib/fpl";
import { processAuctionGameweek } from "@/lib/formats/auction/process-gameweek";

/**
 * GET /api/cron/process-scores
 * Vercel Cron Job — reprocesses scores for the current gameweek.
 * Authenticated via CRON_SECRET (checked in middleware).
 */
export async function GET(request: NextRequest) {
  try {
    // Find gameweeks that have fixtures but incomplete results (need processing)
    const allGameweeks = await db
      .select()
      .from(gameweeks)
      .orderBy(asc(gameweeks.number));

    // Find the latest gameweek whose deadline has passed and has pending fixtures
    const now = new Date();
    let targetGW: number | null = null;

    for (const gw of allGameweeks) {
      if (gw.deadline > now) continue; // deadline hasn't passed yet

      // Check if this GW has unprocessed fixtures
      const gwFixtures = await db
        .select({ id: fixtures.id, resultId: results.id })
        .from(fixtures)
        .leftJoin(results, eq(results.fixtureId, fixtures.id))
        .where(eq(fixtures.gameweekId, gw.id));

      if (gwFixtures.length === 0) continue; // no fixtures

      const unprocessed = gwFixtures.filter((f) => f.resultId === null).length;
      const processed = gwFixtures.length - unprocessed;

      // Target this GW if it has any fixtures (reprocess with force)
      // Prefer the latest GW with a passed deadline
      if (gwFixtures.length > 0) {
        targetGW = gw.number;
      }
    }

    if (!targetGW) {
      return NextResponse.json({
        success: true,
        message: "No gameweek needs processing",
      });
    }

    // Before clearing/processing, fetch and cache fresh live scores for in-progress GW
    try {
      const { liveGw, gwStatus } = await detectLiveGameweek();
      
      if (liveGw && liveGw >= 31 && liveGw <= 38) {
        console.log(`Cron: Detected GW${liveGw} as in-progress, fetching live scores...`);
        await fetchAndCacheLiveScores(liveGw);
        console.log(`Cron: Successfully cached live scores for GW${liveGw}`);
      }
    } catch (error) {
      console.error("Cron: Failed to fetch/cache live scores:", error);
      // Continue with processing even if live cache fails
    }

    // Clear live cache for this gameweek before processing final scores
    try {
      await clearLiveCache(targetGW);
      console.log(`Cron: Cleared live cache for GW${targetGW}`);
    } catch (e) {
      console.error(`Cron: Failed to clear live cache for GW${targetGW}:`, e);
    }

    // Call the existing gameweek processing endpoint internally
    const baseUrl = request.nextUrl.origin;
    const processUrl = `${baseUrl}/api/gameweeks/${targetGW}?force=true`;

    const response = await fetch(processUrl, {
      method: "POST",
      headers: {
        // Pass through the cron authorization so middleware injects admin headers
        Authorization: request.headers.get("Authorization") || "",
      },
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(`Cron: Failed to process GW${targetGW}:`, result);
      return NextResponse.json(
        {
          success: false,
          gameweek: targetGW,
          error: result.error || "Processing failed",
        },
        { status: 500 }
      );
    }

    console.log(`Cron: Successfully processed GW${targetGW}`, {
      processed: result.processed,
      failed: result.failed,
    });

    // Process auction leagues separately (they don't use fixtures/results)
    try {
      const auctionLeagues = await db
        .select()
        .from(leagues)
        .where(and(eq(leagues.isActive, true), eq(leagues.format, "auction")));

      for (const league of auctionLeagues) {
        if (targetGW) {
          // Find the gameweek record for this league
          const gwRow = await db
            .select()
            .from(gameweeks)
            .where(and(eq(gameweeks.leagueId, league.id), eq(gameweeks.number, targetGW)))
            .limit(1);

          if (gwRow.length > 0) {
            try {
              const auctionResult = await processAuctionGameweek(
                gwRow[0].id,
                targetGW,
                league.id,
                true // force reprocess
              );
              console.log(`Cron: Processed auction league "${league.slug}" GW${targetGW}:`, {
                teamsProcessed: auctionResult.teamsProcessed,
              });
            } catch (e) {
              console.error(`Cron: Failed to process auction league "${league.slug}" GW${targetGW}:`, e);
            }
          }
        }
      }
    } catch (e) {
      console.error("Cron: Failed to process auction leagues:", e);
    }

    // Pre-warm page caches for all active leagues so users get instant loads
    try {
      const activeLeagues = await db
        .select({ slug: leagues.slug })
        .from(leagues)
        .where(eq(leagues.isActive, true));

      const authHeader = request.headers.get("Authorization") || "";

      for (const league of activeLeagues) {
        const slug = league.slug;
        try {
          await Promise.all([
            fetch(`${baseUrl}/api/standings?leagueSlug=${encodeURIComponent(slug)}`, { headers: { Authorization: authHeader } }),
            fetch(`${baseUrl}/api/fixtures?leagueSlug=${encodeURIComponent(slug)}`, { headers: { Authorization: authHeader } }),
            fetch(`${baseUrl}/api/playoffs/bracket?leagueSlug=${encodeURIComponent(slug)}`, { headers: { Authorization: authHeader } }),
          ]);
          console.log(`Cron: Pre-warmed page cache for league "${slug}"`);
        } catch (e) {
          console.error(`Cron: Failed to pre-warm cache for league "${slug}":`, e);
        }
      }
    } catch (e) {
      console.error("Cron: Failed to pre-warm page caches:", e);
    }

    return NextResponse.json({
      success: true,
      gameweek: targetGW,
      processed: result.processed,
      failed: result.failed,
    });
  } catch (error) {
    console.error("Cron process-scores error:", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 }
    );
  }
}

/**
 * Fetch live scores from FPL API and cache in Redis for the given gameweek
 * This runs every 10 minutes via cron during the in-progress GW
 */
async function fetchAndCacheLiveScores(gameweek: number): Promise<void> {
  try {
    const gwRecord = await db.query.gameweeks.findFirst({
      where: eq(gameweeks.number, gameweek),
    });

    if (!gwRecord) {
      console.warn(`Cron: Gameweek ${gameweek} not found in DB`);
      return;
    }

    // Get all playoff fixtures for this GW
    const gwFixtures = await db.query.fixtures.findMany({
      where: and(
        eq(fixtures.gameweekId, gwRecord.id),
        eq(fixtures.isPlayoff, true)
      ),
      with: {
        homeTeam: { with: { players: true } },
        awayTeam: { with: { players: true } },
      },
    });

    if (gwFixtures.length === 0) {
      console.log(`Cron: No playoff fixtures found for GW${gameweek}`);
      return;
    }

    // Get captain picks for this GW
    const captainPicks = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.gameweekId, gwRecord.id),
      with: { player: true },
    });

    const captainByTeamId = new Map<string, string>();
    for (const pick of captainPicks) {
      captainByTeamId.set(pick.player.teamId, pick.player.id);
    }

    // Calculate live scores for each fixture from FPL API
    const gwLiveScores = [];
    for (const fixture of gwFixtures) {
      try {
        const homeScore = await calculateLiveTeamScore(
          fixture.homeTeam.players,
          captainByTeamId.get(fixture.homeTeamId),
          gameweek
        );
        const awayScore = await calculateLiveTeamScore(
          fixture.awayTeam.players,
          captainByTeamId.get(fixture.awayTeamId),
          gameweek
        );

        gwLiveScores.push({
          fixtureId: fixture.id,
          gameweek: gameweek,  // Track which GW this score is from
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
        console.error(`Cron: Live score error for fixture ${fixture.id}:`, err);
        // Silently skip this fixture, don't include it in cache
      }
    }

    if (gwLiveScores.length > 0) {
      // Store in Redis with 10-minute TTL
      await setLiveCachedScores(gameweek, {
        gameweek,
        fixtures: gwLiveScores,
        cachedAt: new Date().toISOString(),
      });
      console.log(`Cron: Cached ${gwLiveScores.length} live fixture scores for GW${gameweek}`);
    }
  } catch (error) {
    console.error(`Cron: Error fetching live scores for GW${gameweek}:`, error);
    throw error;
  }
}

/**
 * Calculate live score for a TVT team (2 FPL players + captaincy doubling)
 * Fetches always from FPL API (never cached), applies captain doubling
 */
async function calculateLiveTeamScore(
  teamPlayers: { id: string; name: string; fplId: string }[],
  captainPlayerId: string | undefined,
  gameweek: number
): Promise<{
  total: number;
  players: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
}> {
  const playerScores = [];
  let total = 0;

  for (const player of teamPlayers) {
    try {
      // Fetch from FPL API - always fresh data
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek);
      const fplScore = picks.entry_history.points;
      const transferHits = picks.entry_history.event_transfers_cost;
      const netScore = fplScore - transferHits;
      const isCaptain = captainPlayerId === player.id;
      const finalScore = isCaptain ? netScore * 2 : netScore;

      playerScores.push({
        name: player.name,
        fplId: player.fplId,
        fplScore,
        transferHits,
        isCaptain,
        finalScore,
      });

      total += finalScore;
    } catch (err) {
      console.error(`Cron: Failed to fetch FPL data for player ${player.fplId} in GW${gameweek}:`, err);
      // Use 0 for this player
      playerScores.push({
        name: player.name,
        fplId: player.fplId,
        fplScore: 0,
        transferHits: 0,
        isCaptain: false,
        finalScore: 0,
      });
    }
  }

  return { total, players: playerScores };
}
