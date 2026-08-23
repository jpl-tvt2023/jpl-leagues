import { fetchEventStatus } from "@/lib/fpl";

/**
 * The set of gameweek numbers FPL reports as finished.
 *
 * Gates on `finished` alone, deliberately NOT `data_checked`. This mirrors
 * `isGwFinalized` in src/lib/cron/process-all.ts, whose comment documents the
 * reasoning: `data_checked` (bonus points confirmed) lags one to two days
 * behind the last match, but the published scores are stable as soon as
 * `finished` flips. Holding the submission window shut for an extra two days
 * every week would be worse than the problem it solves.
 *
 * Do NOT substitute `isGameweekFinal` from fpl.ts — that one requires both
 * flags because it decides a 24-hour cache TTL, which is a different question.
 *
 * Returns null on any failure. Callers must treat null as "unknown" and fail
 * open; see resolveSubmissionWindow.
 */
export async function getFinishedGwNumbers(): Promise<Set<number> | null> {
  // One retry. Falling open is the right behaviour for a real FPL outage, but
  // it opens the gate for every team in the league — too consequential to
  // trigger on a single transient blip. This is one cheap call (Redis-cached
  // for 10 minutes upstream), not a fan-out, so retrying costs almost nothing.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const events = await fetchEventStatus();
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
