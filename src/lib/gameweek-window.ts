/**
 * Deadline-driven submission window for captain/chip announcements.
 *
 * This is deliberately decoupled from "results processing" (the
 * latestCompletedGW/nextGameweek concept used for fixture/results display
 * elsewhere in the dashboard). Match results for a gameweek can lag days
 * behind that gameweek's deadline, but a team should be able to lock in
 * next week's captain/chip the moment this week's deadline (plus a short
 * lock window) has passed — not wait for last week's scores to be entered.
 *
 * A single shared resolver is used by the dashboard GET (to tell the client
 * what to show/disable) and both POST routes (to validate what a submission
 * is actually allowed to target), so the two can never drift apart.
 */

export type SubmissionState = "open" | "locked" | "closed";

export interface SubmissionWindow {
  /** "open": this GW's deadline hasn't passed yet — submittable.
   *  "locked": this GW's deadline passed less than LOCK_MS ago — nothing
   *  submittable, waiting for the lock to lift.
   *  "closed": no gameweek currently satisfies either state (e.g. season
   *  over, or no gameweeks exist at all). */
  state: SubmissionState;
  /** The gameweek the state above refers to. Null only when state is "closed". */
  gw: { id: string; number: number; deadline: Date } | null;
  /** ISO timestamp of when the window next opens. Only set when state is "locked". */
  opensAt: string | null;
}

/** How long submissions stay locked after a deadline passes, before the
 *  next gameweek's window opens. */
export const SUBMISSION_LOCK_MS = 30 * 60 * 1000;

/**
 * Resolve the current submission window for a league.
 *
 * `gameweeksAsc` must be every gameweek for the league, sorted ascending by
 * `number` (callers already have this list on hand — no DB access here).
 */
export function resolveSubmissionWindow(
  gameweeksAsc: { id: string; number: number; deadline: Date }[],
  now: Date
): SubmissionWindow {
  for (const gw of gameweeksAsc) {
    if (!gw.deadline) continue;
    const deadlineMs = gw.deadline.getTime();
    const nowMs = now.getTime();

    if (nowMs < deadlineMs) {
      return { state: "open", gw, opensAt: null };
    }
    if (nowMs < deadlineMs + SUBMISSION_LOCK_MS) {
      return {
        state: "locked",
        gw,
        opensAt: new Date(deadlineMs + SUBMISSION_LOCK_MS).toISOString(),
      };
    }
    // This GW's lock has fully elapsed — move on and check the next one.
  }

  return { state: "closed", gw: null, opensAt: null };
}

/**
 * Format a millisecond duration as a short human-readable string, e.g.
 * "2h 14m" or "45s". Used in lateness-rejection messages so a team can see
 * exactly how late their submission was.
 */
export function formatLateness(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
