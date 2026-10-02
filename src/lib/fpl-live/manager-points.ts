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
 * One pick with the multiplier FPL will actually apply to it, given what is known right now.
 *
 * `managerGameweekPoints` is a sum over these, and the Match Center draws them row by row — one
 * resolver for both, so a per-player breakdown can never disagree with the total beside it.
 */
export interface ResolvedPick {
  element: number;
  /** 1–11 starting XI, 12–15 bench in order. */
  position: number;
  /** As FPL published it: 2 captain, 3 Triple Captain, 0 bench (1 under Bench Boost). */
  pickMultiplier: number;
  /** What the score uses, after the vice-captain handover and any FPL auto-substitution. */
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  /** This vice-captain inherited the armband because the captain demonstrably blanked. */
  armbandInherited?: boolean;
  /** FPL auto-substituted this player on (settled gameweeks only). */
  autoSubIn?: boolean;
  /** FPL auto-substituted this player off (settled gameweeks only). */
  autoSubOut?: boolean;
}

/**
 * Per-pick multipliers for an in-flight gameweek.
 *
 * Applies only the vice-captain handover, under the gate described at the top of this file.
 * Auto-substitutions are deliberately NOT applied — FPL has not made them yet.
 */
export function resolveLiveMultipliers(
  picks: FPLGameweekPicks,
  ctx: Pick<ManagerPointsContext, "stats" | "concludedElements">
): ResolvedPick[] {
  const captainPick = picks.picks.find((p) => p.is_captain);

  // Demonstrably blanked: played no part AND has no fixture left to play it in.
  // `multiplier > 1` guards a payload in which FPL has already moved the armband itself
  // (a settled week): handing over a captain multiplier of 0 would zero the vice-captain.
  const captainBlanked =
    captainPick !== undefined &&
    captainPick.multiplier > 1 &&
    (ctx.stats[captainPick.element]?.minutes ?? 0) === 0 &&
    ctx.concludedElements.has(captainPick.element);

  return picks.picks.map((pick) => {
    let multiplier = pick.multiplier;
    let armbandInherited = false;
    if (captainBlanked) {
      if (pick.is_captain) {
        multiplier = 0;
      } else if (pick.is_vice_captain) {
        // Inherits the captain's own multiplier, so Triple Captain transfers as x3.
        multiplier = captainPick.multiplier;
        armbandInherited = true;
      }
    }
    return {
      element: pick.element,
      position: pick.position,
      pickMultiplier: pick.multiplier,
      multiplier,
      is_captain: pick.is_captain,
      is_vice_captain: pick.is_vice_captain,
      ...(armbandInherited ? { armbandInherited: true } : {}),
    };
  });
}

/** One entry of FPL's `automatic_subs`, as the picks payload carries it once a week settles. */
interface FplAutoSub {
  element_in: number;
  element_out: number;
}

function isAutoSub(x: unknown): x is FplAutoSub {
  return (
    typeof x === "object" && x !== null &&
    typeof (x as FplAutoSub).element_in === "number" &&
    typeof (x as FplAutoSub).element_out === "number"
  );
}

/**
 * Per-pick multipliers for a SETTLED gameweek, for display.
 *
 * The settled score itself is `entry_history.points` and does not come from here. This exists
 * so the Match Center can show which players those points came from: FPL's `automatic_subs`
 * are applied (when the payload has not already swapped the multipliers itself), and the
 * armband handover is re-derived from final minutes. Any remaining gap between the sum of
 * these and `entry_history.points` is FPL's to explain, and the caller shows it as such.
 */
export function resolveSettledMultipliers(
  picks: FPLGameweekPicks,
  stats: Record<number, LiveElementStat>
): ResolvedPick[] {
  const byElement = new Map(picks.picks.map((p) => [p.element, { ...p }]));
  const subbedIn = new Set<number>();
  const subbedOut = new Set<number>();
  for (const sub of (picks.automatic_subs ?? []).filter(isAutoSub)) {
    const out = byElement.get(sub.element_out);
    const into = byElement.get(sub.element_in);
    if (!out || !into) continue;
    subbedIn.add(into.element);
    subbedOut.add(out.element);
    // Only swap if FPL has not already reflected the substitution in the multipliers.
    if (into.multiplier === 0 && out.multiplier > 0) {
      into.multiplier = 1;
      // A captain subbed off keeps the multiplier here so the handover below still sees it.
      if (!out.is_captain) out.multiplier = 0;
    }
  }

  // Every club has finished by the time a week settles, so every element is "concluded".
  const concludedElements = new Set(picks.picks.map((p) => p.element));
  const resolved = resolveLiveMultipliers(
    { ...picks, picks: [...byElement.values()] },
    { stats, concludedElements }
  );
  return resolved.map((r) => ({
    ...r,
    pickMultiplier: picks.picks.find((p) => p.element === r.element)?.multiplier ?? r.pickMultiplier,
    ...(subbedIn.has(r.element) ? { autoSubIn: true } : {}),
    ...(subbedOut.has(r.element) ? { autoSubOut: true } : {}),
  }));
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

  let total = 0;
  for (const pick of resolveLiveMultipliers(picks, ctx)) {
    if (pick.multiplier <= 0) continue;
    total += (ctx.stats[pick.element]?.points ?? 0) * pick.multiplier;
  }
  return total;
}
