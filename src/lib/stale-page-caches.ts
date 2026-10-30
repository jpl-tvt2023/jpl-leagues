/**
 * Leagues whose page-cache invalidation Upstash refused, kept until a sweep gets through.
 *
 * An admin save commits first and invalidates second. While Upstash is down the second step
 * cannot happen, and the standings/fixtures/playoffs cached before the save would be served again
 * once it recovers, for up to their 25h TTL. Redis cannot remember that it owes a sweep while it
 * is the thing that is down, so the debt is written to the database, and repairStalePageCaches
 * (fpl-cache.ts) pays it from whichever instance next reads a page.
 *
 * Stored in `settings` under one key rather than in a table of its own: that table is already a
 * per-league key/value store, its admin API only reads and writes the three keys it knows, and a
 * row goes with its league on delete.
 */

import { and, eq } from "drizzle-orm";
import { db, settings } from "@/lib/db";

const STALE_KEY = "pageCacheStale";

export interface StalePageCache {
  leagueId: string;
  /** When the refused invalidation was recorded (ISO) — identifies this marking for the clear. */
  markedAt: string;
}

export async function markPageCacheStale(leagueId: string): Promise<void> {
  const markedAt = new Date().toISOString();
  await db
    .insert(settings)
    .values({ key: STALE_KEY, leagueId, value: markedAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [settings.key, settings.leagueId],
      set: { value: markedAt, updatedAt: new Date() },
    });
}

export async function listStalePageCaches(): Promise<StalePageCache[]> {
  return db
    .select({ leagueId: settings.leagueId, markedAt: settings.value })
    .from(settings)
    .where(eq(settings.key, STALE_KEY));
}

/**
 * Clear one marking, and only if it is still the one that was swept: a league marked again while
 * the sweep ran was saved again through the outage, and keeps its row for the next pass.
 */
export async function clearPageCacheStale(leagueId: string, markedAt: string): Promise<void> {
  await db
    .delete(settings)
    .where(and(eq(settings.key, STALE_KEY), eq(settings.leagueId, leagueId), eq(settings.value, markedAt)));
}
