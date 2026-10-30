/**
 * FPL gameweek deadlines, cached independently of the rest of bootstrap-static.
 *
 * `getCachedBootstrap()` in fpl-cache.ts stores only `elements` (used for player names/teams),
 * so `deadline_time` is not cached anywhere in the app today. The FPL Classic format needs every
 * gameweek's deadline — to seed its own gameweek-numbering, and to bucket settled rows into
 * calendar months — without re-fetching all ~700 elements just for that.
 *
 * Its own key, outside fpl-cache.ts, same pattern as fpl-live/players-left.ts: a new cache key
 * needs no edit to fpl-cache.ts, which this feature otherwise never touches. The client and its
 * failure handling are shared (lib/redis.ts).
 */

import { fetchBootstrapData } from "@/lib/fpl";
import { CACHE_TTL } from "@/lib/fpl-cache";
import type { FplLane } from "@/lib/fpl/gateway";
import { cachedGet, cachedSet } from "@/lib/redis";

const GW_CALENDAR_KEY = "fpl:gw-calendar:v1";
/** Per-instance read-through (lib/redis.ts). Deadlines move a few times a season at most. */
const GW_CALENDAR_L1_SECONDS = 300;

export interface GwDeadline {
  gw: number;
  /** ISO string — kept as a string across the cache boundary rather than a Date. */
  deadlineTime: string;
}

/** Every gameweek's deadline, cache-first. Background lane — this is never on the scoring path. */
export async function fetchGameweekDeadlines(lane: FplLane = "background"): Promise<GwDeadline[]> {
  const cached = await cachedGet<GwDeadline[]>(GW_CALENDAR_KEY, { l1Seconds: GW_CALENDAR_L1_SECONDS });
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const bootstrap = (await fetchBootstrapData(lane)) as {
    events?: { id: number; deadline_time: string }[];
  };
  const deadlines: GwDeadline[] = (bootstrap.events ?? []).map((e) => ({
    gw: e.id,
    deadlineTime: e.deadline_time,
  }));

  if (deadlines.length > 0) {
    await cachedSet(GW_CALENDAR_KEY, deadlines, CACHE_TTL, { l1Seconds: GW_CALENDAR_L1_SECONDS });
  }

  return deadlines;
}
