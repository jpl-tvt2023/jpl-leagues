/**
 * FPL chip status for many managers at once, keyed by FPL entry id.
 *
 * Two callers with deliberately different appetites for cost:
 *
 *  - The **scorer** decides whether a TVT chip is wasted, so a missing history changes a team's
 *    league points. It runs on the `"critical"` lane — the one lane entitled to fetch during a
 *    scoring run — and tops up what the cache does not hold.
 *  - **Public read paths** only decorate a page. They pass `topUp: 0` and take whatever is
 *    cached, so an unauthenticated page can never fan out to FPL. Managers with no cached
 *    history are simply absent from the map.
 *
 * Absence from the returned map means "not known", never "played nothing" — see
 * formats/tvt/fpl-chip-clash.ts, which refuses to declare a chip wasted on that basis.
 */

import { getCachedEntryHistories, setCachedEntryHistory, CACHE_TTL } from "@/lib/fpl-cache";
import { fetchTeamHistory } from "@/lib/fpl";
import { withFplBudget, FplUnavailableError, type FplLane } from "@/lib/fpl/gateway";
import { mapWithConcurrency } from "@/lib/concurrency";
import { buildFplChipStatus, type FplChipStatus } from "./chips";

export async function resolveFplChipStatuses(
  fplIds: string[],
  opts: {
    lane: FplLane;
    /** Max histories to fetch for cache misses. 0 (the default) never touches FPL. */
    topUp?: number;
    /** Shows up in gateway budget logs. */
    label: string;
  },
): Promise<Map<string, FplChipStatus>> {
  const ids = [...new Set(fplIds.filter(Boolean))];
  const out = new Map<string, FplChipStatus>();
  if (ids.length === 0) return out;

  const histories = await getCachedEntryHistories(ids);

  const topUp = opts.topUp ?? 0;
  if (topUp > 0) {
    const missing = ids.filter((id) => !histories.has(id)).slice(0, topUp);
    if (missing.length > 0) {
      try {
        await withFplBudget(
          { lane: opts.lane, label: opts.label, max: missing.length },
          () =>
            mapWithConcurrency(missing, 4, async (fplId) => {
              try {
                const history = await fetchTeamHistory(fplId, opts.lane);
                await setCachedEntryHistory(fplId, history, CACHE_TTL);
                histories.set(fplId, { ...history, cachedAt: new Date().toISOString() });
              } catch {
                // One unreadable manager must not fail the batch. They stay absent from the map,
                // which every caller already treats as "not known".
              }
            }),
        );
      } catch (err) {
        // Breaker open, budget exhausted, or a scoring run holding the lock. Serve what is cached.
        if (!(err instanceof FplUnavailableError)) throw err;
      }
    }
  }

  for (const [fplId, history] of histories) {
    out.set(fplId, buildFplChipStatus(history.chips));
  }
  return out;
}
