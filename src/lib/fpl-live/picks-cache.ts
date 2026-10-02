/**
 * A manager's picks for a gameweek, read through a Redis cache.
 *
 * Raw picks used to be fetched and thrown away: the live sweep pulled all fifteen of every
 * manager's players to add them up, kept the total, and discarded the rest. The Match Center
 * and the fixtures-page stats need exactly that discarded detail, so the sweep now writes it
 * here and they read it back instead of re-fetching 64 entries.
 *
 * ## Why caching picks is safe
 *
 * Everything a pick says is fixed at the deadline: the elements, their order, the armband,
 * the chip, the transfer cost. Two fields move afterwards, both when FPL SETTLES the week —
 * `entry_history.points` and `automatic_subs`. Neither is read while a gameweek is live (live
 * points are recomputed from `/event/{gw}/live/`, see manager-points.ts), so a copy taken mid-
 * gameweek is good for the rest of it. A settled reader that finds an unsettled copy refetches
 * once and stores the settled one for much longer.
 *
 * A pre-deadline request 404s at FPL and throws, so nothing is ever cached before the
 * deadline — there is no stale "empty team" to serve.
 */

import { fetchTeamGameweekPicks, type FPLGameweekPicks } from "@/lib/fpl";
import { getCachedPicks, setCachedPicks, CACHE_TTL } from "@/lib/fpl-cache";
import type { FplLane } from "@/lib/fpl/gateway";

/** A copy taken while the gameweek is live. Only `points`/`automatic_subs` can still change. */
export const PICKS_LIVE_TTL = CACHE_TTL;
/** A settled gameweek's picks never change again. */
export const PICKS_SETTLED_TTL = CACHE_TTL * 14;

const inFlight = new Map<string, Promise<FPLGameweekPicks>>();

export async function getManagerPicks(
  fplId: string,
  gameweek: number,
  opts: {
    lane: FplLane;
    /**
     * Whether the caller is working from a settled gameweek (`ManagerPointsContext.settled`).
     * A settled caller will not accept a copy cached mid-gameweek, because it reads
     * `entry_history.points`, which was 0 when that copy was taken.
     */
    settled: boolean;
  },
): Promise<FPLGameweekPicks> {
  try {
    const cached = await getCachedPicks(fplId, gameweek);
    if (cached && (cached.settled || !opts.settled)) return cached.picks;
  } catch {
    // A cache read failing must not fail scoring — fall through to FPL.
  }

  // Keyed by lane for the same reason the gateway's in-flight maps are: a background caller
  // must not ride along on a critical request it would have been refused.
  const key = `${opts.lane}:${fplId}:${gameweek}:${opts.settled ? "s" : "l"}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const picks = await fetchTeamGameweekPicks(fplId, gameweek, opts.lane);
    await setCachedPicks(
      fplId,
      gameweek,
      { picks, settled: opts.settled, cachedAt: new Date().toISOString() },
      opts.settled ? PICKS_SETTLED_TTL : PICKS_LIVE_TTL,
    );
    return picks;
  })();

  inFlight.set(key, pending);
  void pending.catch(() => undefined).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  return pending;
}
