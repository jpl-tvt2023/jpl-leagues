/**
 * One call to hang the daily run off an ordinary request.
 *
 * Called from `after()` in a couple of high-traffic GET routes, so the work happens once the
 * response has been sent and never delays a page. Everything here is best-effort by design: the
 * automation must never be able to break a page that was otherwise fine.
 */

import { maybeStartDailyRun, advanceDailyRun } from "@/lib/cron/daily-trigger";

/**
 * Start today's run if it has not started, then take one item off its queue.
 *
 * Both halves are cheap no-ops once the day is done — a couple of Redis reads — which is what
 * makes it safe to attach to every request rather than guessing which one should own it.
 */
export async function dailyTick(baseUrl: string): Promise<void> {
  // Never inside a test run. The Playwright suite has a real Redis and a real database, so an
  // unguarded tick would claim a day mid-suite and start scoring leagues underneath specs that
  // are asserting on those very scores — a source of failures with no visible cause.
  //
  // Keyed on TEST_FPL_STUB rather than NODE_ENV for the reason the FPL gateway documents at its
  // own guard: `next dev` forces NODE_ENV=development, which silently disarms anything keyed on
  // it. The stub flag is set explicitly by the test env and by nothing else.
  if (process.env.TEST_FPL_STUB === "1") return;

  try {
    await maybeStartDailyRun();
    await advanceDailyRun(baseUrl);
  } catch (e) {
    console.error("[daily-run] tick failed", e);
  }
}
