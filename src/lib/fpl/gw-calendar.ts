/**
 * FPL gameweek deadlines, cached independently of the rest of bootstrap-static.
 *
 * `getCachedBootstrap()` in fpl-cache.ts stores only `elements` (used for player names/teams),
 * so `deadline_time` is not cached anywhere in the app today. The FPL Classic format needs every
 * gameweek's deadline — to seed its own gameweek-numbering, and to bucket settled rows into
 * calendar months — without re-fetching all ~700 elements just for that.
 *
 * Own private Redis client, same pattern as fpl-live/players-left.ts: a new cache key needs no
 * edit to fpl-cache.ts, which this feature otherwise never touches.
 */

import { Redis } from "@upstash/redis";
import { fetchBootstrapData } from "@/lib/fpl";
import { CACHE_TTL } from "@/lib/fpl-cache";
import type { FplLane } from "@/lib/fpl/gateway";

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

const GW_CALENDAR_KEY = "fpl:gw-calendar:v1";

export interface GwDeadline {
  gw: number;
  /** ISO string — kept as a string across the cache boundary rather than a Date. */
  deadlineTime: string;
}

/** Every gameweek's deadline, cache-first. Background lane — this is never on the scoring path. */
export async function fetchGameweekDeadlines(lane: FplLane = "background"): Promise<GwDeadline[]> {
  const r = getRedis();
  if (r) {
    const cached = await r.get<GwDeadline[]>(GW_CALENDAR_KEY);
    if (cached && Array.isArray(cached) && cached.length > 0) return cached;
  }

  const bootstrap = (await fetchBootstrapData(lane)) as {
    events?: { id: number; deadline_time: string }[];
  };
  const deadlines: GwDeadline[] = (bootstrap.events ?? []).map((e) => ({
    gw: e.id,
    deadlineTime: e.deadline_time,
  }));

  if (r && deadlines.length > 0) {
    await r.set(GW_CALENDAR_KEY, deadlines, { ex: CACHE_TTL });
  }

  return deadlines;
}
