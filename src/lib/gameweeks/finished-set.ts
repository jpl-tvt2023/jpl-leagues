import { fetchBootstrapEventFlags } from "@/lib/fpl";
import { getMatchesFinishedGwNumbers } from "@/lib/fpl/event-status";

/**
 * The set of gameweek numbers whose PL matches have all been played.
 *
 * Gates on "last whistle" alone, deliberately NOT on bonus-point confirmation.
 * Bonus lags one to two days behind the final match, but the published scores are
 * stable as soon as the matches end. Holding the submission window shut for that
 * extra day or two every week would be worse than the problem it solves.
 *
 * Do NOT substitute `isGameweekConcluded` from fpl/event-status.ts — that one also
 * requires bonus confirmed, because it gates *scoring*, where points that still
 * move would be written into league tables. Different question, stricter answer.
 *
 * Primary source is FPL's /fixtures/ list (60s cache, single-flighted) rather than
 * bootstrap-static's `events[].finished` (~800KB behind a CDN, cached 10 minutes) —
 * same signal, minutes sooner. Bootstrap remains the fallback.
 *
 * Returns null on any failure. Callers must treat null as "unknown" and fail
 * open; see resolveSubmissionWindow.
 */
export async function getFinishedGwNumbers(): Promise<Set<number> | null> {
  // One retry. Falling open is the right behaviour for a real FPL outage, but
  // it opens the gate for every team in the league — too consequential to
  // trigger on a single transient blip. This is one cheap call (Redis-cached
  // upstream), not a fan-out, so retrying costs almost nothing.
  for (let attempt = 0; attempt < 2; attempt++) {
    const fromFixtures = await getMatchesFinishedGwNumbers();
    if (fromFixtures) return fromFixtures;

    try {
      const events = await fetchBootstrapEventFlags();
      return new Set(events.filter((e) => e.finished).map((e) => e.id));
    } catch (error) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      console.warn("[gameweeks] FPL event status unavailable; submission gate falls open", error);
    }
  }
  return null;
}
