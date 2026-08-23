/**
 * Single source of truth for TVT live fixture scores.
 *
 * This replaces two separate `calculateLiveTeamScore` implementations that had
 * drifted apart:
 *   - api/fixtures/live/route.ts used `picks.entry_history.points`
 *   - api/fixtures/live/refresh/route.ts recomputed from /event/{gw}/live/
 *     with a vice-captain fallback
 * so the cached number and the refreshed number could legitimately disagree —
 * visible to users as a score that jumps when they hit Refresh, and (once the
 * dashboard renders its own breakdown) as the dashboard and the fixtures page
 * disagreeing about the same fixture.
 *
 * The recomputed version is the correct one: it applies the vice-captain
 * fallback when a captain does not play, which `entry_history.points` cannot
 * express mid-gameweek. Both routes now use it.
 *
 * Cost: the old refresh path called fetchLiveGameweek() once per *team side*,
 * so a 16-fixture TVT-32 gameweek was ~32 live fetches plus 64 picks fetches.
 * Here the live element map is fetched exactly once per request.
 */

import { db } from "@/lib/db";
import { fixtures, gameweeks, gameweekCaptains } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { fetchTeamGameweekPicks, fetchLiveGameweek } from "@/lib/fpl";
import type { LiveFixtureScore } from "@/lib/fpl-cache";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";
import { countPlayersLeftToPlay } from "@/lib/fpl-live/players-left";
import { FplUnavailableError } from "@/lib/fpl/gateway";

export interface TvtLiveOptions {
  leagueId: string | null;
  gwNumber: number;
  /** Restrict to these fixtures. Null/undefined computes the whole gameweek. */
  fixtureIds?: string[] | null;
}

interface LiveElement {
  total_points: number;
  minutes: number;
}

type TeamPlayer = { id: string; name: string; fplId: string };

interface SideResult {
  total: number;
  players: LiveFixtureScore["homePlayers"];
  /** FPL element ids of every pick with multiplier > 0, across both managers. */
  activeElements: number[];
}

/**
 * Compute live scores for a gameweek (or a subset of its fixtures).
 *
 * Throws only on a hard failure to resolve the gameweek. Individual fixture
 * scoring failures degrade to a zeroed entry rather than failing the request,
 * matching the previous behaviour of both routes.
 */
export async function computeLiveFixtureScores(
  opts: TvtLiveOptions
): Promise<LiveFixtureScore[]> {
  const { leagueId, gwNumber, fixtureIds } = opts;

  const gwRecords = await db
    .select()
    .from(gameweeks)
    .where(
      leagueId
        ? and(eq(gameweeks.number, gwNumber), eq(gameweeks.leagueId, leagueId))
        : eq(gameweeks.number, gwNumber)
    );
  if (gwRecords.length === 0) return [];
  const gw = gwRecords[0];

  const gwFixtures = await db.query.fixtures.findMany({
    where:
      fixtureIds && fixtureIds.length > 0
        ? and(eq(fixtures.gameweekId, gw.id), inArray(fixtures.id, fixtureIds))
        : eq(fixtures.gameweekId, gw.id),
    with: {
      homeTeam: { with: { players: true } },
      awayTeam: { with: { players: true } },
    },
  });
  if (gwFixtures.length === 0) return [];

  // Announced captains, plus whether each was auto-assigned post-deadline
  // (isValid === false) — those render with the C* temp marker.
  const captainPicks = await db.query.gameweekCaptains.findMany({
    where: eq(gameweekCaptains.gameweekId, gw.id),
    with: { player: true },
  });
  const captainByTeam = new Map<string, string>();
  const autoAssignedByTeam = new Map<string, boolean>();
  for (const pick of captainPicks) {
    captainByTeam.set(pick.player.teamId, pick.player.id);
    autoAssignedByTeam.set(pick.player.teamId, pick.isValid === false);
  }

  // Previous-GW captains, used by pickTempCaptain to rotate on a tie.
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

  // ── The one live fetch for the whole request ──────────────────────────
  let liveElements: Map<number, LiveElement>;
  try {
    const liveData = await fetchLiveGameweek(gwNumber);
    liveElements = new Map(liveData.elements.map((e) => [e.id, e.stats]));
  } catch (err) {
    if (err instanceof FplUnavailableError) {
      // Breaker open or a scoring run holds the lock. Callers fall back to
      // whatever they have cached rather than showing zeros.
      throw err;
    }
    console.error(`[tvt-live] live data unavailable for GW${gwNumber}:`, err);
    throw err;
  }

  const results: LiveFixtureScore[] = [];

  for (const fixture of gwFixtures) {
    const base = {
      fixtureId: fixture.id,
      gameweek: gwNumber,
      homeTeamName: fixture.homeTeam.name,
      awayTeamName: fixture.awayTeam.name,
      homeTeamId: fixture.homeTeamId,
      awayTeamId: fixture.awayTeamId,
    };

    try {
      const home = await scoreSide(
        fixture.homeTeam.players,
        captainByTeam.get(fixture.homeTeamId),
        prevCaptainByTeam.get(fixture.homeTeamId) ?? null,
        gwNumber,
        autoAssignedByTeam.get(fixture.homeTeamId) ?? false,
        liveElements
      );
      const away = await scoreSide(
        fixture.awayTeam.players,
        captainByTeam.get(fixture.awayTeamId),
        prevCaptainByTeam.get(fixture.awayTeamId) ?? null,
        gwNumber,
        autoAssignedByTeam.get(fixture.awayTeamId) ?? false,
        liveElements
      );

      const [homePlayersLeft, awayPlayersLeft] = await Promise.all([
        playersLeftFor(home.activeElements, gwNumber),
        playersLeftFor(away.activeElements, gwNumber),
      ]);

      results.push({
        ...base,
        homeScore: home.total,
        awayScore: away.total,
        homePlayers: home.players,
        awayPlayers: away.players,
        homePlayersLeft,
        awayPlayersLeft,
      });
    } catch (err) {
      // FPL being unavailable is not a per-fixture failure and must not be
      // absorbed here. The breaker can open, or a scoring run can take the
      // lock, *part way through* a sweep — the first fetches succeed and a
      // later one is refused. Swallowing that would push a 0-0 fixture, which
      // the caller then writes into the live cache and serves to everyone for
      // the next ten minutes. Showing a real fixture as 0-0 during a live
      // gameweek is far worse than briefly showing nothing, which is exactly
      // what the two sibling handlers (the live-elements fetch above and the
      // per-entry picks fetch below) already say by re-throwing.
      if (err instanceof FplUnavailableError) throw err;

      // Anything else genuinely is per-fixture — a bad entry id, malformed
      // picks — so degrade just this one and carry on with the rest.
      console.error(`[tvt-live] score error for fixture ${fixture.id}:`, err);
      results.push({
        ...base,
        homeScore: 0,
        awayScore: 0,
        homePlayers: [],
        awayPlayers: [],
        homePlayersLeft: null,
        awayPlayersLeft: null,
      });
    }
  }

  return results;
}

/**
 * Fixtures-left-to-play across a side's active picks.
 *
 * Cheap: countPlayersLeftToPlay reads FPL's fixtures list (60s Redis cache)
 * and element info (24h cache), both shared across every side in the same
 * request once warm. Null on any failure so the UI can render "—".
 */
async function playersLeftFor(
  activeElements: number[],
  gwNumber: number
): Promise<{ leftToPlay: number; total: number } | null> {
  if (activeElements.length === 0) return null;
  try {
    const res = await countPlayersLeftToPlay(activeElements, gwNumber);
    return res ? { leftToPlay: res.leftToPlay, total: res.total } : null;
  } catch {
    return null;
  }
}

/**
 * Score one TVT team side: two FPL managers, with the captain's *net* score
 * (points minus transfer hits) doubled.
 */
async function scoreSide(
  teamPlayers: TeamPlayer[],
  captainPlayerId: string | undefined,
  prevCaptainPlayerId: string | null,
  gameweek: number,
  captainWasAutoAssigned: boolean,
  liveElements: Map<number, LiveElement>
): Promise<SideResult> {
  const rawScores: {
    id: string;
    name: string;
    fplId: string;
    fplScore: number;
    transferHits: number;
    netScore: number;
  }[] = [];
  const activeElements: number[] = [];

  for (const player of teamPlayers) {
    try {
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek);
      const transferHits = picks.entry_history.event_transfers_cost;

      // Collect the active XI from the RAW picks, before any vice-captain
      // rewriting below. multiplier > 0 (not position <= 11) so Bench Boost
      // correctly counts all 15.
      for (const pick of picks.picks) {
        if (pick.multiplier > 0) activeElements.push(pick.element);
      }

      const captainPick = picks.picks.find((p) => p.is_captain);
      const captainLive = captainPick ? liveElements.get(captainPick.element) : null;
      const captainPlayed = captainLive ? captainLive.minutes > 0 : false;

      let teamScore = 0;
      for (const pick of picks.picks) {
        const liveElement = liveElements.get(pick.element);
        if (!liveElement) continue;

        let multiplier = pick.multiplier;
        if (!captainPlayed) {
          if (pick.is_captain) {
            multiplier = 0;
          } else if (pick.is_vice_captain) {
            multiplier = captainPick?.multiplier ?? 2;
          }
        }
        if (multiplier > 0) {
          teamScore += liveElement.total_points * multiplier;
        }
      }

      rawScores.push({
        id: player.id,
        name: player.name,
        fplId: player.fplId,
        fplScore: teamScore,
        transferHits,
        netScore: teamScore - transferHits,
      });
    } catch (err) {
      if (err instanceof FplUnavailableError) throw err;
      console.error(`[tvt-live] picks failed for entry ${player.fplId} GW${gameweek}:`, err);
      rawScores.push({
        id: player.id,
        name: player.name,
        fplId: player.fplId,
        fplScore: 0,
        transferHits: 0,
        netScore: 0,
      });
    }
  }

  // Resolve captain: announced > temp (lowest net, rotate on tie). Treated as
  // temp if no announcement existed, or the row was auto-assigned post-deadline.
  let resolvedCaptainId: string | null = captainPlayerId ?? null;
  let isTemp = captainWasAutoAssigned;
  if (!resolvedCaptainId) {
    // Live preview only — no capContext, so wouldExceedCap is irrelevant here.
    const picked = pickTempCaptain(rawScores, prevCaptainPlayerId);
    resolvedCaptainId = picked?.playerId ?? null;
    isTemp = !!resolvedCaptainId;
  }

  let total = 0;
  const players = rawScores.map((r) => {
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

  return { total, players, activeElements };
}
