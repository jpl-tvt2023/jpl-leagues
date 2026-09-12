/**
 * One manager's gameweek score, live or settled.
 *
 * The single answer to "how many points has this FPL entry scored in GW N", shared by the
 * TVT live scorer, the cron pre-warm, the playoff bracket and `calculateTeamGameweekScore`.
 * Four copies of this used to exist; they disagreed, and one of them was wrong.
 *
 * ## Why this is not simply `entry_history.points`
 *
 * It was, between 2026-08-30 and this change, and that is what made every live fixture
 * render 0-0. `entry_history.points` is a SETTLED field: FPL populates it when it processes
 * the gameweek and returns 0 for the entire time the gameweek is in progress. Measured on
 * 2026-09-12 with GW4 live, three entries whose true running scores were 69, 61 and 51:
 *
 *   /entry/{id}/event/4/picks/  ->  entry_history.points = 0,  rank = null
 *   /entry/{id}/event/3/picks/  ->  entry_history.points = 74     (settled: correct)
 *   /leagues-classic/314/standings/  ->  event_total = 69         (live: correct)
 *   sum over /event/4/live/ of total_points x multiplier  =  69   (live: correct)
 *
 * So while a gameweek is in flight we recompute from `/event/{gw}/live/`, and once FPL has
 * settled it we go back to `entry_history.points` — which keeps the property that made the
 * August change attractive: the number shown live and the number the cron, playoff and final
 * scoring paths persist are identical by construction, auto-substitutions and all.
 *
 * ## The vice-captain handover
 *
 * The recompute this restores was removed because it handed the armband to the vice-captain
 * whenever the captain had zero minutes — which is also true of a captain whose match has not
 * kicked off. It inflated 23 of 64 managers on a live gameweek.
 *
 * The gate below is the narrow fix that bug actually needed: hand over only when the captain
 * has DEMONSTRABLY blanked, meaning zero minutes AND no fixture left for their club in this
 * gameweek. Before kickoff the club still has a fixture outstanding, so nothing moves.
 *
 * Zero minutes is load-bearing and zero points will not substitute for it: a substitute who
 * comes on and is booked scores exactly 0 (1 for the appearance, -1 for the card).
 *
 * ## What is deliberately not modelled
 *
 * Provisional bonus and auto-substitutions. FPL's API withholds both until it settles the
 * gameweek — `/event/{gw}/live/` carries `bonus: 0` until bonus is confirmed, and
 * `automatic_subs` is empty while matches are in play. Deriving either would mean asserting
 * something FPL has not, which is the class of recompute that caused the inflation above.
 * Both arrive with the settled branch, so a score can step slightly when a gameweek concludes.
 *
 * Triple Captain and Bench Boost need no handling at all: FPL bakes them into the pick
 * multipliers (x3, and all 15 picks active) before we ever see them.
 */

import type { FPLGameweekPicks } from "@/lib/fpl";

/** A single element's live figures. Mirrors `CachedElementStat` without the cache dependency. */
export interface LiveElementStat {
  points: number;
  minutes: number;
}

export interface ManagerPointsContext {
  /** True once FPL has concluded the gameweek — every PL fixture played and bonus confirmed. */
  settled: boolean;
  /** Live points and minutes per FPL element id. Empty when `settled`, which does not read it. */
  stats: Record<number, LiveElementStat>;
  /**
   * Element ids whose club has no unfinished fixture remaining in this gameweek.
   *
   * Membership is what licenses the vice-captain handover. An empty set therefore means
   * "never hand over", which is the correct way to fail when FPL's fixture list is
   * unreachable — late is recoverable, early inflates every affected manager.
   */
  concludedElements: ReadonlySet<number>;
}

/**
 * A manager's gross gameweek points — before JPL transfer hits and before the JPL captain
 * doubling, both of which are the caller's business.
 */
export function managerGameweekPoints(
  picks: FPLGameweekPicks,
  ctx: ManagerPointsContext
): number {
  if (ctx.settled) return picks.entry_history.points;

  const captainPick = picks.picks.find((p) => p.is_captain);

  // Demonstrably blanked: played no part AND has no fixture left to play it in.
  const captainBlanked =
    captainPick !== undefined &&
    (ctx.stats[captainPick.element]?.minutes ?? 0) === 0 &&
    ctx.concludedElements.has(captainPick.element);

  let total = 0;
  for (const pick of picks.picks) {
    let multiplier = pick.multiplier;
    if (captainBlanked) {
      if (pick.is_captain) {
        multiplier = 0;
      } else if (pick.is_vice_captain) {
        // Inherits the captain's own multiplier, so Triple Captain transfers as x3.
        multiplier = captainPick.multiplier;
      }
    }
    if (multiplier <= 0) continue;
    total += (ctx.stats[pick.element]?.points ?? 0) * multiplier;
  }
  return total;
}
