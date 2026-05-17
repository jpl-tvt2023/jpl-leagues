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
import { countPlayersLeftToPlay } from "@/lib/fpl-live/players-left";

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
          // A processed GW has no PL fixtures left by definition. Explicit 0
          // keeps the UI from rendering "—" (which would mean "FPL outage").
          playersLeftHome: 0 as number | null,
          playersLeftAway: 0 as number | null,
        }));
      return NextResponse.json({ isLive: false, fixtures: storedFixtures, reason: "already_processed", cachedAt: new Date().toISOString() });
    }

    // Check live cache first — reject entries that predate the players-left
    // fields OR whose cached values are null (FPL outage at cache-write time).
    // Forcing a recompute on null lets the cache self-heal within seconds of
    // FPL recovering, rather than staying poisoned for the full 10-min TTL.
    const cached = await getLiveCachedScores(gwNumber, leagueId);
    const firstFixture = cached?.fixtures?.[0] as
      | { playersLeftHome?: number | null }
      | undefined;
    const cacheHasValidPlayersLeft =
      firstFixture != null
      && "playersLeftHome" in firstFixture
      && firstFixture.playersLeftHome !== null;
    if (cached && cached.fixtures && cached.fixtures.length > 0 && cacheHasValidPlayersLeft) {
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
      // Get all captain picks for this GW
      const captainPicks = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.gameweekId, gw.id),
        with: { player: true },
      });

      // Build lookup: teamId → captainPlayerId (the player row ID, not fplId)
      const captainByTeam = new Map<string, string>();
      // Track which captain picks were auto-assigned post-deadline (isValid === false)
      // so we can flag them as temp captains in the breakdown.
      const autoAssignedByTeam = new Map<string, boolean>();
      for (const pick of captainPicks) {
        captainByTeam.set(pick.player.teamId, pick.player.id);
        autoAssignedByTeam.set(pick.player.teamId, pick.isValid === false);
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
            gwNumber,
            autoAssignedByTeam.get(fixture.homeTeamId) ?? false,
          );
          const awayScore = await calculateLiveTeamScore(
            fixture.awayTeam.players,
            captainByTeam.get(fixture.awayTeamId),
            prevCaptainByTeam.get(fixture.awayTeamId) ?? null,
            gwNumber,
            autoAssignedByTeam.get(fixture.awayTeamId) ?? false,
          );

          // Players-left per side: starting-XI element IDs across managers,
          // looked up against PL fixtures' kickoff times. Helper returns null
          // on FPL outage — surface null so UI can show "—" rather than 0.
          let playersLeftHome: number | null = null;
          let playersLeftAway: number | null = null;
          try {
            const [pHome, pAway] = await Promise.all([
              countPlayersLeftToPlay(homeScore.starterElementIds, gwNumber),
              countPlayersLeftToPlay(awayScore.starterElementIds, gwNumber),
            ]);
            playersLeftHome = pHome?.leftToPlay ?? null;
            playersLeftAway = pAway?.leftToPlay ?? null;
          } catch {
            // best-effort — keep nulls
          }

          liveFixtures.push({
            fixtureId: fixture.id,
            gameweek: gwNumber,
            homeTeamName: fixture.homeTeam.name,
            awayTeamName: fixture.awayTeam.name,
            homeTeamId: fixture.homeTeamId,
            awayTeamId: fixture.awayTeamId,
            homeScore: homeScore.total,
            awayScore: awayScore.total,
            homePlayers: homeScore.players,
            awayPlayers: awayScore.players,
            playersLeftHome,
            playersLeftAway,
          });
        } catch (err) {
          console.error(`Live score error for fixture ${fixture.id}:`, err);
          // Return partial data with null scores for failed fixtures
          liveFixtures.push({
            fixtureId: fixture.id,
            gameweek: gwNumber,
            homeTeamName: fixture.homeTeam.name,
            awayTeamName: fixture.awayTeam.name,
            homeTeamId: fixture.homeTeamId,
            awayTeamId: fixture.awayTeamId,
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

        // Cache for 10 minutes normally, but shorten to 60s when any fixture
        // has null players-left (FPL outage at write time) so the entry
        // self-heals quickly once FPL recovers — rather than poisoning the
        // cache for the full 10 minutes.
        const anyNullPlayersLeft = liveFixtures.some(
          (f) => f.playersLeftHome === null || f.playersLeftAway === null,
        );
        await setLiveCachedScores(
          gwNumber,
          liveData,
          leagueId,
          anyNullPlayersLeft ? 60 : undefined,
        );

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

/**
 * Calculate live score for a TVT team (2 FPL players + captaincy doubling).
 * Also returns the starting-XI FPL element IDs across both managers so the
 * caller can compute "players left to play" for this side of the fixture.
 */
async function calculateLiveTeamScore(
  teamPlayers: { id: string; name: string; fplId: string }[],
  captainPlayerId: string | undefined,
  prevCaptainPlayerId: string | null,
  gameweek: number,
  captainWasAutoAssigned: boolean = false,
): Promise<{
  total: number;
  players: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
  /** FPL element IDs of the starting XI across all managers (positions 1-11, no dedupe). */
  starterElementIds: number[];
}> {
  const rawScores: { id: string; name: string; fplId: string; fplScore: number; transferHits: number; netScore: number }[] = [];
  const starterElementIds: number[] = [];
  for (const player of teamPlayers) {
    try {
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek);
      const fplScore = picks.entry_history.points;
      const transferHits = picks.entry_history.event_transfers_cost;
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore, transferHits, netScore: fplScore - transferHits });
      // Starters are picks.position 1-11. Collect their element IDs for the
      // players-left indicator. No dedupe: each roster slot counts independently.
      for (const pk of picks.picks ?? []) {
        if (pk.position >= 1 && pk.position <= 11) starterElementIds.push(pk.element);
      }
    } catch {
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore: 0, transferHits: 0, netScore: 0 });
    }
  }

  let resolvedCaptainId: string | null = captainPlayerId ?? null;
  // Treat the captain as a temp captain when either: (a) no captain row existed at all
  // (we ran pickTempCaptain just now), or (b) the existing row was auto-assigned
  // post-deadline by autoAssignDefaultCaptain (isValid === false).
  let isTemp = captainWasAutoAssigned;
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

  return { total, players, starterElementIds };
}
