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

const FPL_FIXTURES_TTL_SECONDS = 60;
const FPL_FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/";

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
 * Fetch all PL fixtures for a given GW from FPL (with 60s Redis cache).
 *
 * Returns:
 *   - FplFixture[] on success (may be empty for blank GWs).
 *   - null on actual FPL outage (fetch error, non-2xx, or non-array response).
 *
 * Cache discipline: only populate Redis with non-empty arrays. A transient
 * empty response shouldn't poison the cache for 60s.
 */
export async function getFplFixturesForGw(gw: number): Promise<FplFixture[] | null> {
  const r = getRedis();
  const key = `fpl:fixtures:gw${gw}`;

  if (r) {
    const cached = await r.get<FplFixture[]>(key);
    // Only trust cache entries that have at least one fixture — defensive
    // against any historical empty-array poisoning.
    if (Array.isArray(cached) && cached.length > 0) return cached;
  }

  try {
    const res = await fetch(`${FPL_FIXTURES_URL}?event=${gw}`, {
      // Bypass Next.js fetch cache — Redis handles caching for us
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as FplFixture[];
    if (!Array.isArray(data)) return null;
    // Only cache non-empty results. Empty arrays (blank GWs or transient
    // FPL responses) are returned to the caller but never cached.
    if (r && data.length > 0) await r.set(key, data, { ex: FPL_FIXTURES_TTL_SECONDS });
    return data;
  } catch {
    return null;
  }
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
 * Returns null on FPL outage (so callers can show "—" rather than misleading 0).
 */
export async function countPlayersLeftToPlay(
  fplElementIds: number[],
  gw: number,
): Promise<PlayersLeftResult | null> {
  if (!Number.isFinite(gw) || gw < 1 || gw > 38) return null;
  if (fplElementIds.length === 0) {
    return { leftToPlay: 0, total: 0, isLive: false };
  }

  const fixtures = await getFplFixturesForGw(gw);
  // null → FPL fetch failed entirely (network/non-2xx); show "—".
  // [] → FPL returned a successful but empty payload. For a normal GW that's
  // pathological — we don't want to lie with "0" or "—" either. Log a warning
  // so this is visible, and surface as null. Cache hygiene above prevents the
  // empty from sticking, so a subsequent call has a chance to recover.
  if (fixtures == null) return null;
  if (fixtures.length === 0) {
    console.warn("[players-left] FPL returned empty fixtures for GW", gw);
    return null;
  }

  let elements: Awaited<ReturnType<typeof fetchElementInfo>>;
  try {
    elements = await fetchElementInfo();
  } catch {
    return null;
  }

  const now = Date.now();

  // PL team → count of unstarted fixtures in this GW
  const unstartedByTeam = new Map<number, number>();
  // PL team → "currently has a fixture in progress" (kicked off, not finished)
  let anyLiveFixture = false;
  for (const f of fixtures) {
    if (!f.kickoff_time) {
      // Fixture not yet scheduled — treat as unstarted for both teams.
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

  // Map element id → PL team
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
