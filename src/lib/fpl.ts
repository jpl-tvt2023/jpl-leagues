// FPL API Service
// Official Fantasy Premier League API endpoints

import { fplRequest, FPL_BASE_URL, type FplLane } from "@/lib/fpl/gateway";

export { FPL_BASE_URL };

/**
 * All FPL traffic is funnelled through the gateway, which enforces the global
 * concurrency cap, the circuit breaker and the critical/background lanes.
 *
 * The default lane is "background" deliberately: user-facing code vastly
 * outnumbers the scoring pipeline, and defaulting to "critical" would let a
 * new page silently bypass every protection. The scoring pipeline opts in to
 * "critical" explicitly at its call sites.
 */
function fplFetch(url: string, lane: FplLane = "background"): Promise<Response> {
  return fplRequest(url, { lane });
}

export interface FPLPlayer {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  now_cost: number;
  total_points: number;
}

export interface FPLTeamEntry {
  id: number;
  player_first_name: string;
  player_last_name: string;
  name: string;
  summary_overall_points: number;
  summary_overall_rank: number;
}

export interface FPLGameweekPicks {
  active_chip: string | null;
  automatic_subs: unknown[];
  entry_history: {
    event: number;
    points: number;
    total_points: number;
    rank: number;
    event_transfers: number;
    event_transfers_cost: number;
  };
  picks: {
    element: number;
    position: number;
    multiplier: number;
    is_captain: boolean;
    is_vice_captain: boolean;
  }[];
}

export interface FPLLiveData {
  elements: {
    id: number;
    stats: {
      total_points: number;
      minutes: number;
      goals_scored: number;
      assists: number;
      clean_sheets: number;
      bonus: number;
    };
  }[];
}

/**
 * In-flight bootstrap requests, keyed by lane.
 *
 * bootstrap-static is the single most duplicated call in the app: twenty call
 * sites, and several ask for it twice at once — `Promise.all([fetchElementInfo(),
 * fetchBootstrapData()])` in the auction routes is two identical requests every
 * time the cache is cold, because neither has written it yet when the other
 * starts. Overlapping callers now share one request.
 *
 * Keyed by lane, never shared across lanes, and that matters for correctness
 * rather than tidiness. The two lanes have different permissions: background
 * calls are refused while a scoring run holds the lock, critical calls are
 * always attempted. Letting a background caller await a critical request would
 * smuggle it past a refusal it was supposed to receive; the reverse would
 * subject scoring to a refusal it is meant to be exempt from.
 */
const inFlightBootstrap = new Map<FplLane, Promise<unknown>>();

/**
 * Fetch general bootstrap data (all players, teams, gameweeks)
 */
export async function fetchBootstrapData(lane: FplLane = "background") {
  const existing = inFlightBootstrap.get(lane);
  if (existing) return existing;

  const pending = (async () => {
    const res = await fplFetch(`${FPL_BASE_URL}/bootstrap-static/`, lane);
    if (!res.ok) throw new Error("Failed to fetch FPL bootstrap data");
    return res.json();
  })();

  inFlightBootstrap.set(lane, pending);
  // Dropped as soon as it settles, so the next caller re-checks the caches
  // upstream instead of being pinned to one snapshot for the whole process.
  // A rejection is cleared the same way — it must not be replayed to everyone.
  void pending.catch(() => undefined).finally(() => {
    if (inFlightBootstrap.get(lane) === pending) inFlightBootstrap.delete(lane);
  });

  return pending;
}

/**
 * Fetch a specific FPL team entry by ID
 */
export async function fetchTeamEntry(
  teamId: string,
  lane: FplLane = "background"
): Promise<FPLTeamEntry> {
  const res = await fplFetch(`${FPL_BASE_URL}/entry/${teamId}/`, lane);
  if (!res.ok) throw new Error(`Failed to fetch FPL team ${teamId}`);
  return res.json();
}

/**
 * Fetch a team's picks for a specific gameweek
 */
export async function fetchTeamGameweekPicks(
  teamId: string,
  gameweek: number,
  lane: FplLane = "background"
): Promise<FPLGameweekPicks> {
  const res = await fplFetch(`${FPL_BASE_URL}/entry/${teamId}/event/${gameweek}/picks/`, lane);
  if (!res.ok) throw new Error(`Failed to fetch picks for team ${teamId} GW${gameweek}`);
  return res.json();
}

/**
 * Fetch live gameweek data (real-time scores)
 */
export async function fetchLiveGameweek(
  gameweek: number,
  lane: FplLane = "background"
): Promise<FPLLiveData> {
  const res = await fplFetch(`${FPL_BASE_URL}/event/${gameweek}/live/`, lane);
  if (!res.ok) throw new Error(`Failed to fetch live data for GW${gameweek}`);
  return res.json();
}

/** One row of an entry's current-season history, as FPL returns it. */
export interface FplEntryHistoryCurrent {
  event: number;
  points: number;
  total_points: number;
  rank: number | null;
  overall_rank: number | null;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
  value: number;
  bank: number;
}

/** An FPL chip play. `name` is FPL's raw code: wildcard | bboost | 3xc | freehit | manager. */
export interface FplEntryChip {
  name: string;
  time: string;
  event: number;
}

export interface FplEntryHistory {
  current: FplEntryHistoryCurrent[];
  past: { season_name: string; total_points: number; rank: number }[];
  chips: FplEntryChip[];
}

/**
 * Fetch team history (past seasons + current season gameweeks + chips played).
 *
 * One call yields everything the FPL League page needs for an entry: per-GW
 * points and the official season total from `current`, plus `chips`. Callers
 * should go through `getEntryHistory` in fpl-history.ts, which adds caching —
 * this is the raw, uncached fetch.
 */
export async function fetchTeamHistory(
  teamId: string,
  lane: FplLane = "background"
): Promise<FplEntryHistory> {
  const res = await fplFetch(`${FPL_BASE_URL}/entry/${teamId}/history/`, lane);
  if (!res.ok) throw new Error(`Failed to fetch history for team ${teamId}`);
  const raw = (await res.json()) as Partial<FplEntryHistory>;
  return {
    current: Array.isArray(raw.current) ? raw.current : [],
    past: Array.isArray(raw.past) ? raw.past : [],
    chips: Array.isArray(raw.chips) ? raw.chips : [],
  };
}

import {
  getCachedScore, setCachedScore,
  getCachedElementPoints, setCachedElementPoints,
  getCachedBootstrap, setCachedBootstrap,
  getCachedEventStatus, setCachedEventStatus,
  CACHE_TTL, LIVE_CACHE_TTL,
  type CachedElementInfo,
  type FplEventStatus,
} from "./fpl-cache";
import { db, gameweeks, fixtures, results } from "./db";
import { eq, and, isNull, asc, inArray } from "drizzle-orm";

/**
 * Calculate total gameweek score for an FPL team
 * Returns the points minus transfer hits
 * Uses cache to avoid hitting FPL API rate limits
 */
export async function calculateTeamGameweekScore(
  teamId: string,
  gameweek: number,
  leagueId?: string | null
): Promise<{ points: number; transferHits: number; netScore: number }> {
  // Check cache first
  const cached = await getCachedScore(teamId, gameweek, leagueId);
  if (cached) {
    return {
      points: cached.points,
      transferHits: cached.transferHits,
      netScore: cached.netScore,
    };
  }

  // Fetch from FPL API
  const picks = await fetchTeamGameweekPicks(teamId, gameweek);

  const score = {
    points: picks.entry_history.points,
    transferHits: picks.entry_history.event_transfers_cost,
    netScore: picks.entry_history.points - picks.entry_history.event_transfers_cost,
  };

  // Cache the result
  await setCachedScore(teamId, gameweek, score, leagueId);

  return score;
}

/**
 * Get captain info for a team in a specific gameweek
 */
export async function getCaptainInfo(teamId: string, gameweek: number) {
  const [picks, liveData, bootstrap] = await Promise.all([
    fetchTeamGameweekPicks(teamId, gameweek),
    fetchLiveGameweek(gameweek),
    fetchBootstrapData(),
  ]);

  const captain = picks.picks.find((p) => p.is_captain);
  const viceCaptain = picks.picks.find((p) => p.is_vice_captain);

  if (!captain) throw new Error("No captain found");

  const captainLive = liveData.elements.find((e) => e.id === captain.element);
  const viceCaptainLive = viceCaptain
    ? liveData.elements.find((e) => e.id === viceCaptain.element)
    : null;

  const playerData = bootstrap.elements as FPLPlayer[];
  const captainPlayer = playerData.find((p) => p.id === captain.element);
  const viceCaptainPlayer = viceCaptain
    ? playerData.find((p) => p.id === viceCaptain.element)
    : null;

  return {
    captain: {
      id: captain.element,
      name: captainPlayer?.web_name || "Unknown",
      points: captainLive?.stats.total_points || 0,
    },
    viceCaptain: viceCaptain
      ? {
          id: viceCaptain.element,
          name: viceCaptainPlayer?.web_name || "Unknown",
          points: viceCaptainLive?.stats.total_points || 0,
        }
      : null,
  };
}

/**
 * Detect which gameweek is currently live (playoff GW31-38)
 * Returns status map: {[gw]: "notStarted"|"inProgress"|"finished"}
 * 
 * Live GW criteria: deadline passed AND not all playoff fixtures have results
 * This is used by bracket API to fetch from correct source:
 * - live GW: fetch from Redis cache (populated by cron every 10 min)
 * - finished GW: fetch from DB results table (locked by cron)
 * - upcoming GW: return empty (scores = 0)
 */
export async function detectLiveGameweek(): Promise<{
  liveGw: number | null;
  gwStatus: Record<number, "notStarted" | "inProgress" | "finished">;
}> {
  const gwStatus: Record<number, "notStarted" | "inProgress" | "finished"> = {};
  let liveGw: number | null = null;
  const now = new Date();

  try {
    for (let gwNumber = 31; gwNumber <= 38; gwNumber++) {
      const gwRecord = await db.query.gameweeks.findFirst({
        where: eq(gameweeks.number, gwNumber),
      });

      if (!gwRecord) {
        gwStatus[gwNumber] = "notStarted";
        continue;
      }

      // Check if deadline has passed
      if (gwRecord.deadline > now) {
        gwStatus[gwNumber] = "notStarted";
        continue;
      }

      // Deadline passed - check if all playoff fixtures have results
      const playoffFixtures = await db.query.fixtures.findMany({
        where: and(
          eq(fixtures.gameweekId, gwRecord.id),
          eq(fixtures.isPlayoff, true)
        ),
      });

      if (playoffFixtures.length === 0) {
        gwStatus[gwNumber] = "notStarted";
        continue;
      }

      // Check which fixtures have results

      const fixturesWithResults = await db
        .select({ fixtureId: results.fixtureId })
        .from(results)
        .where(inArray(results.fixtureId, playoffFixtures.map((f) => f.id)));

      const allHaveResults = playoffFixtures.length === fixturesWithResults.length;

      if (allHaveResults) {
        gwStatus[gwNumber] = "finished";
      } else {
        gwStatus[gwNumber] = "inProgress";
        liveGw = gwNumber; // Only one should be in-progress at a time
      }
    }
  } catch (error) {
    console.error("Error detecting live gameweek:", error);
  }

  return { liveGw, gwStatus };
}

// ============================================
// JPL Auction: Element-Level Data
// ============================================

/**
 * Fetch all PL player GW points in a single API call.
 * Returns a map of elementId -> total_points for the gameweek.
 * Uses cache (24hr TTL) to avoid rate limits.
 */
/**
 * In-flight dedupe, keyed by gameweek + lane.
 *
 * Without this, N concurrent callers all miss the Redis cache (none has written it
 * yet) and each pulls the multi-MB /event/{gw}/live/ payload independently. That is
 * the natural shape of auction scoring, which fans out over every team at once: a
 * 14-team league made 14 identical requests, the gateway serialized them 4 at a time
 * at 120ms apart with 10s timeouts, and the whole call blew past the 60s function
 * ceiling — surfacing in the browser as a bare "Failed to fetch".
 *
 * Lane is part of the key for the same reason it is on `inFlightBootstrap`: a
 * background caller must not ride along on a critical request it would have been
 * refused, nor vice versa.
 */
const inFlightElementPoints = new Map<string, Promise<Record<number, number>>>();

export async function fetchElementGameweekPoints(
  gameweek: number,
  lane: FplLane = "background"
): Promise<Record<number, number>> {
  // Check cache first
  const cached = await getCachedElementPoints(gameweek);
  if (cached) return cached;

  const key = `${lane}:${gameweek}`;
  const existing = inFlightElementPoints.get(key);
  if (existing) return existing;

  const pending = (async () => {
    // Fetch from FPL API — one call returns all ~700 players
    const liveData = await fetchLiveGameweek(gameweek, lane);
    const pointsMap: Record<number, number> = {};
    for (const element of liveData.elements) {
      pointsMap[element.id] = element.stats.total_points;
    }

    // Cache the result. A finished GW's points never move, so it keeps the long TTL; an in-flight
    // GW gets the short one so live scores actually refresh during matches.
    const final = await isGameweekFinal(gameweek);
    await setCachedElementPoints(gameweek, pointsMap, final ? CACHE_TTL : LIVE_CACHE_TTL);
    return pointsMap;
  })();

  inFlightElementPoints.set(key, pending);
  void pending.catch(() => undefined).finally(() => {
    if (inFlightElementPoints.get(key) === pending) inFlightElementPoints.delete(key);
  });

  return pending;
}

/**
 * Fetch the per-gameweek `finished` / `data_checked` flags out of bootstrap-static.
 *
 * NOT to be confused with FPL's own /event-status/ endpoint — this reads
 * `bootstrap.events`, which is the same information arriving considerably later.
 * It was called `fetchEventStatus` for a long time, which is exactly the confusion
 * the rename removes; `src/lib/fpl/event-status.ts` owns the honest name and
 * treats this as its fallback source.
 *
 * Uses its own 10-minute cache — these flags flip mid-weekend.
 */
export async function fetchBootstrapEventFlags(): Promise<FplEventStatus[]> {
  const cached = await getCachedEventStatus();
  if (cached) return cached;

  const bootstrap = await fetchBootstrapData();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawEvents = (bootstrap.events ?? []) as any[];
  const events: FplEventStatus[] = rawEvents.map((e) => ({
    id: e.id as number,
    finished: (e.finished as boolean) ?? false,
    data_checked: (e.data_checked as boolean) ?? false,
  }));

  await setCachedEventStatus(events);
  return events;
}

/**
 * True only once a gameweek's points are settled.
 *
 * Delegates to `isGameweekConcluded`, which requires every PL fixture finished AND FPL to have
 * confirmed bonus points. Points still move between "last whistle" and "bonus confirmed", so both
 * are required before we cache a GW's points for a full day. That used to be read as
 * `finished && data_checked` off bootstrap-static; the event-status endpoint carries the same
 * signal and publishes it sooner.
 *
 * Any failure resolves to `false`, which selects the SHORT cache TTL. Erring toward re-fetching
 * too often is always recoverable; erring toward a 24h freeze is what this whole change exists
 * to prevent.
 */
export async function isGameweekFinal(gameweek: number): Promise<boolean> {
  try {
    // Imported lazily: fpl/event-status.ts imports this module for its bootstrap
    // fallback, and a static import here would close that cycle.
    const { isGameweekConcluded } = await import("./fpl/event-status");
    return await isGameweekConcluded(gameweek);
  } catch (error) {
    console.warn(`[fpl] event status lookup failed for GW${gameweek}; treating as not final`, error);
    return false;
  }
}

/**
 * Fetch PL player metadata (name, team, position, status, cost, minutes).
 * Uses cache (24hr TTL) since bootstrap updates once daily.
 */
export async function fetchElementInfo(lane: FplLane = "background"): Promise<CachedElementInfo[]> {
  // Check cache first
  const cached = await getCachedBootstrap();
  if (cached) return cached;

  // Fetch from FPL API. `fetchBootstrapData` already dedupes in flight, so
  // concurrent callers here collapse onto one request.
  const bootstrap = await fetchBootstrapData(lane);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawElements = bootstrap.elements as any[];
  const elements: CachedElementInfo[] = rawElements.map((p) => ({
    id: p.id as number,
    web_name: p.web_name as string,
    team: p.team as number,
    element_type: p.element_type as number,
    now_cost: p.now_cost as number,
    total_points: p.total_points as number,
    status: (p.status as string) ?? "a",
    minutes: (p.minutes as number) ?? 0,
  }));

  // Cache the result
  await setCachedBootstrap(elements);
  return elements;
}
