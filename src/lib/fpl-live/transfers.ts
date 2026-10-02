/**
 * Which players each manager brought in and sold for one gameweek, cached.
 *
 * FPL only lists transfers per entry (`entry/{id}/transfers/`, the whole season in one call), so
 * a league's "most transferred in" costs one call per manager. That is paid once per gameweek:
 * a list fetched after gameweek N's deadline is complete for N and every earlier gameweek, so it
 * is reused until a LATER deadline makes it potentially short.
 */

import { fetchEntryTransfers } from "@/lib/fpl";
import {
  getCachedTransfersMany,
  setCachedTransfers,
  type CachedTransfer,
} from "@/lib/fpl-cache";
import { FplUnavailableError, withFplBudget, type FplLane } from "@/lib/fpl/gateway";
import { mapWithConcurrency } from "@/lib/concurrency";

export interface GwTransfers {
  in: number[];
  out: number[];
}

/**
 * Transfers made for `gameweek`, per manager. A manager missing from the result could not be
 * read (cold cache past `maxFetch`, or FPL refused) — callers must treat that as unknown, not
 * as "made no transfers".
 */
export async function getTransfersForGameweek(
  fplIds: string[],
  gameweek: number,
  deadline: Date,
  opts: { lane: FplLane; maxFetch: number; label: string },
): Promise<Map<string, GwTransfers>> {
  const out = new Map<string, GwTransfers>();
  const pick = (all: CachedTransfer[]): GwTransfers => {
    const these = all.filter((t) => t.event === gameweek);
    return { in: these.map((t) => t.element_in), out: these.map((t) => t.element_out) };
  };

  let cached = new Map<string, { fetchedAt: string; transfers: CachedTransfer[] }>();
  try {
    cached = await getCachedTransfersMany(fplIds);
  } catch {
    // Treat a cache read failure as a cold cache.
  }

  const stale: string[] = [];
  for (const id of fplIds) {
    const hit = cached.get(id);
    if (hit && Date.parse(hit.fetchedAt) > deadline.getTime()) out.set(id, pick(hit.transfers));
    else stale.push(id);
  }

  const toFetch = stale.slice(0, Math.max(0, opts.maxFetch));
  if (toFetch.length === 0) return out;

  try {
    await withFplBudget({ lane: opts.lane, label: opts.label, max: toFetch.length }, () =>
      mapWithConcurrency(toFetch, 4, async (id) => {
        try {
          const transfers = await fetchEntryTransfers(id, opts.lane);
          await setCachedTransfers(id, { fetchedAt: new Date().toISOString(), transfers });
          out.set(id, pick(transfers));
        } catch (err) {
          // One unreadable entry must not sink the rest; a gateway refusal must stop the batch.
          if (err instanceof FplUnavailableError) throw err;
        }
      }),
    );
  } catch (err) {
    if (!(err instanceof FplUnavailableError)) throw err;
  }
  return out;
}
