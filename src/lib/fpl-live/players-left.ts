// FPL "players left to play" helper.
//
// Counts fixtures-left-to-play across a list of FPL element IDs for a given GW:
//   - A player whose PL team has N unstarted fixtures in the GW contributes N.
//   - A fixture is "unstarted" iff its kickoff_time is strictly in the future.
//   - DGW players naturally contribute 1 or 2; BGW players contribute 0.
//
// Used by:
//   - GET /api/fpl/players-left (generic endpoint)
//   - GET /api/fixtures/live (enriched response — TVT live)
//   - GET /api/auction/gw-summary (live mode)

import { Redis } from "@upstash/redis";
import { fetchElementInfo } from "../fpl";

let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

const ALL_FIXTURES_CACHE_KEY = "fpl:fixtures:all";
const ALL_FIXTURES_TTL_SECONDS = 60;
const FPL_FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/";
// Some shared User-Agent — FPL is friendlier to clients that identify themselves.
const FPL_USER_AGENT = "Mozilla/5.0 (compatible; jpl-leagues/1.0; +https://jpl-leagues.vercel.app)";

interface FplFixture {
  id: number;
  event: number | null;            // PL GW number; null for fixtures not yet scheduled
  kickoff_time: string | null;     // ISO; null if not yet scheduled
  team_h: number;                  // PL team ID
  team_a: number;                  // PL team ID
  started: boolean | null;
  finished: boolean;
  finished_provisional: boolean;
}

/**
 * Fetch the full season fixtures list from FPL (with 60s Redis cache).
 *
 * Returns:
 *   - FplFixture[] on success — non-empty for a real season.
 *   - null on actual FPL outage (fetch error, non-2xx, non-array body, OR
 *     empty body — which shouldn't happen for a live season, so we treat it
 *     as a flag-worthy hiccup).
 *
 * Cache discipline: only populate Redis with non-empty arrays. A transient
 * empty / failed response shouldn't poison the cache for 60s.
 *
 * Logs to console.warn on suspicious responses (non-2xx, non-array, empty)
 * so Vercel logs surface what's happening when the UI shows "—".
 */
async function getAllFplFixtures(): Promise<FplFixture[] | null> {
  const r = getRedis();

  if (r) {
    const cached = await r.get<FplFixture[]>(ALL_FIXTURES_CACHE_KEY);
    if (Array.isArray(cached) && cached.length > 0) return cached;
  }

  try {
    const res = await fetch(FPL_FIXTURES_URL, {
      // Bypass Next.js fetch cache — Redis handles caching for us.
      cache: "no-store",
      headers: { "User-Agent": FPL_USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[players-left] FPL /fixtures/ status=${res.status}`);
      return null;
    }
    const data = (await res.json()) as FplFixture[];
    if (!Array.isArray(data)) {
      console.warn(`[players-left] FPL /fixtures/ unexpected body type=${typeof data}`);
      return null;
    }
    if (data.length === 0) {
      console.warn("[players-left] FPL /fixtures/ returned 0 fixtures");
      return null;
    }
    if (r) await r.set(ALL_FIXTURES_CACHE_KEY, data, { ex: ALL_FIXTURES_TTL_SECONDS });
    return data;
  } catch (e) {
    console.warn("[players-left] FPL /fixtures/ fetch error", e);
    return null;
  }
}

/**
 * Fetch all PL fixtures for a given GW (filtered from the cached full list).
 *
 * Returns:
 *   - FplFixture[] on success (may be empty for a legitimately blank GW).
 *   - null when the underlying full-season fetch failed.
 */
export async function getFplFixturesForGw(gw: number): Promise<FplFixture[] | null> {
  const all = await getAllFplFixtures();
  if (all == null) return null;
  return all.filter((f) => f.event === gw);
}

export interface PlayersLeftResult {
  /** Total fixtures-left-to-play, summed across the input element IDs. */
  leftToPlay: number;
  /** Length of the input element ID list. */
  total: number;
  /** True if at least one GW fixture has kicked off but isn't finished yet. */
  isLive: boolean;
}

/**
 * Count fixtures-left-to-play across a list of FPL element IDs for a GW.
 *
 * Three result modes:
 *   - Returns null when the FPL /fixtures/ fetch fails entirely (UI shows "—").
 *   - Returns { leftToPlay: 0 } when the full-season list IS available but
 *     the requested GW has no fixtures (legitimate blank GW).
 *   - Returns the computed count otherwise.
 */
export async function countPlayersLeftToPlay(
  fplElementIds: number[],
  gw: number,
): Promise<PlayersLeftResult | null> {
  if (!Number.isFinite(gw) || gw < 1 || gw > 38) return null;
  if (fplElementIds.length === 0) {
    return { leftToPlay: 0, total: 0, isLive: false };
  }

  // Use the full-season fetch so we can distinguish "outage" (parent null)
  // from "blank GW" (parent non-empty, filtered slice empty).
  const allFixtures = await getAllFplFixtures();
  if (allFixtures == null) return null;

  const gwFixtures = allFixtures.filter((f) => f.event === gw);
  if (gwFixtures.length === 0) {
    // Legitimate blank GW — every input contributes 0.
    return { leftToPlay: 0, total: fplElementIds.length, isLive: false };
  }

  let elements: Awaited<ReturnType<typeof fetchElementInfo>>;
  try {
    elements = await fetchElementInfo();
  } catch {
    return null;
  }

  const now = Date.now();

  // PL team → count of unstarted fixtures in this GW.
  const unstartedByTeam = new Map<number, number>();
  let anyLiveFixture = false;
  for (const f of gwFixtures) {
    if (!f.kickoff_time) {
      // Not yet scheduled — treat as unstarted for both PL teams.
      unstartedByTeam.set(f.team_h, (unstartedByTeam.get(f.team_h) ?? 0) + 1);
      unstartedByTeam.set(f.team_a, (unstartedByTeam.get(f.team_a) ?? 0) + 1);
      continue;
    }
    const kickoff = Date.parse(f.kickoff_time);
    if (Number.isFinite(kickoff) && kickoff > now) {
      unstartedByTeam.set(f.team_h, (unstartedByTeam.get(f.team_h) ?? 0) + 1);
      unstartedByTeam.set(f.team_a, (unstartedByTeam.get(f.team_a) ?? 0) + 1);
    } else if (!f.finished && !f.finished_provisional) {
      anyLiveFixture = true;
    }
  }

  const teamByElement = new Map<number, number>();
  for (const el of elements) teamByElement.set(el.id, el.team);

  let leftToPlay = 0;
  for (const elementId of fplElementIds) {
    const plTeam = teamByElement.get(elementId);
    if (plTeam == null) continue;
    leftToPlay += unstartedByTeam.get(plTeam) ?? 0;
  }

  return { leftToPlay, total: fplElementIds.length, isLive: anyLiveFixture };
}
