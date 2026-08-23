/**
 * Deadline-driven submission window for captain/chip announcements.
 *
 * This is deliberately decoupled from *our* "results processing" (the
 * latestCompletedGW/nextGameweek concept used for fixture/results display
 * elsewhere in the dashboard). Admin result-entry can lag days behind a
 * gameweek, and teams should not have to wait on it.
 *
 * It is NOT decoupled from whether the gameweek actually finished. Double
 * Pointer's rank rule and Challenge Chip's top-2 target are both league-table
 * position dependent, so the window for GW(n+1) stays shut until FPL flags
 * GW(n) as finished — see the "awaiting-results" state below. GW1 is exempt
 * (nothing precedes it), an FPL outage fails open, and FORCE_OPEN_WITHIN_MS
 * is a safety valve for congested schedules.
 *
 * A single shared resolver is used by the dashboard GET (to tell the client
 * what to show/disable) and both POST routes (to validate what a submission
 * is actually allowed to target), so the two can never drift apart.
 */

export type SubmissionState = "open" | "locked" | "awaiting-results" | "closed";

export interface SubmissionWindow {
  /** "open": this GW's deadline hasn't passed yet — submittable.
   *  "locked": this GW's deadline passed less than LOCK_MS ago — nothing
   *  submittable, waiting for the lock to lift.
   *  "awaiting-results": the preceding gameweek has not been marked finished
   *  by FPL yet, so the league table is still moving. Double Pointer's rank
   *  rule and Challenge Chip's top-2 target are both table-position
   *  dependent, so nothing may be declared against a table that is still
   *  settling.
   *  "closed": no gameweek currently satisfies any of the above (e.g. season
   *  over, or no gameweeks exist at all). */
  state: SubmissionState;
  /** The gameweek the state above refers to. Null only when state is "closed". */
  gw: { id: string; number: number; deadline: Date } | null;
  /** ISO timestamp of when the window next opens. Only set when state is "locked". */
  opensAt: string | null;
  /** The gameweek we are waiting on FPL to finish. Only set when state is
   *  "awaiting-results". */
  awaitingGw: number | null;
  /** True when the FPL finished-set was unavailable and we fell open rather
   *  than locking the whole league out. */
  degraded: boolean;
}

/** How long submissions stay locked after a deadline passes, before the
 *  next gameweek's window opens. */
export const SUBMISSION_LOCK_MS = 30 * 60 * 1000;

/**
 * Safety valve for the awaiting-results gate.
 *
 * If we are within this long of the target gameweek's own deadline, the
 * window opens regardless of whether FPL has flagged the previous gameweek
 * finished. This covers congested schedules — a midweek gameweek can arrive
 * before FPL flips the previous week's `finished` flag, and without the valve
 * every team would be locked out of declaring entirely.
 */
export const FORCE_OPEN_WITHIN_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the current submission window for a league.
 *
 * `gameweeksAsc` must be every gameweek for the league, sorted ascending by
 * `number` (callers already have this list on hand — no DB access here).
 */
export function resolveSubmissionWindow(
  gameweeksAsc: { id: string; number: number; deadline: Date }[],
  now: Date,
  /**
   * GW numbers FPL reports as finished, or null when FPL state could not be
   * fetched. Required, not optional: making callers pass it explicitly is what
   * stops the dashboard GET and the two POST routes from drifting apart.
   */
  finishedGwNumbers: ReadonlySet<number> | null,
  opts?: {
    forceOpenWithinMs?: number;
    /**
     * Whether the previous gameweek must be FPL-finished before this one opens.
     * Only formats with league-position-dependent chips (TVT: Double Pointer's
     * rank rule, Challenge Chip's top-2 target) need this. Continental
     * Championship announces captains only, so gating it would delay teams for
     * no benefit. Defaults to true — the safe direction.
     */
    requirePreviousFinished?: boolean;
  }
): SubmissionWindow {
  const forceOpenWithinMs = opts?.forceOpenWithinMs ?? FORCE_OPEN_WITHIN_MS;
  const requirePreviousFinished = opts?.requirePreviousFinished ?? true;

  for (let i = 0; i < gameweeksAsc.length; i++) {
    const gw = gameweeksAsc[i];
    if (!gw.deadline) continue;
    const deadlineMs = gw.deadline.getTime();
    const nowMs = now.getTime();

    if (nowMs < deadlineMs) {
      // Candidate found. Before opening, check the preceding gameweek has
      // actually finished — chip eligibility depends on the settled table.
      //
      // Deliberately the array-previous gameweek, not `gw.number - 1`: a
      // league's gameweek list can be non-contiguous (playoff phases), and
      // what matters is the gameweek that precedes this one *in this league*.
      const prev = gameweeksAsc[i - 1];

      const open = (degraded: boolean): SubmissionWindow => ({
        state: "open",
        gw,
        opensAt: null,
        awaitingGw: null,
        degraded,
      });

      // Format does not have position-dependent chips — no table to wait for.
      if (!requirePreviousFinished) return open(false);

      // Nothing precedes this gameweek — there is no table to wait for.
      if (!prev) return open(false);

      // Within the safety valve of this GW's own deadline: open regardless.
      if (deadlineMs - nowMs <= forceOpenWithinMs) return open(false);

      // FPL unreachable. Fail OPEN and say so. Locking every team out of
      // declaring because of a transient FPL blip is unrecoverable; opening
      // early merely degrades to the old 30-minute behaviour, and the real
      // eligibility rules are re-validated server-side at submit time anyway.
      if (finishedGwNumbers == null) return open(true);

      if (finishedGwNumbers.has(prev.number)) return open(false);

      return {
        state: "awaiting-results",
        gw,
        opensAt: null,
        awaitingGw: prev.number,
        degraded: false,
      };
    }

    if (nowMs < deadlineMs + SUBMISSION_LOCK_MS) {
      return {
        state: "locked",
        gw,
        opensAt: new Date(deadlineMs + SUBMISSION_LOCK_MS).toISOString(),
        awaitingGw: null,
        degraded: false,
      };
    }
    // This GW's lock has fully elapsed — move on and check the next one.
  }

  return { state: "closed", gw: null, opensAt: null, awaitingGw: null, degraded: false };
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
