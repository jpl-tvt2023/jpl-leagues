/**
 * Which gameweek a fixtures page should open on.
 *
 * The rule the pages used to apply was derived from *results*: advance while a
 * gameweek is fully scored, stop at the first one with none. That reads "not
 * scored yet" as "not reached yet", so with GW1 scored and GW2 being played the
 * page opened on GW1 — a week behind the gameweek everybody was watching.
 *
 * Deadlines answer the question directly, and this mirrors the rule the
 * dashboard's PL Fixture card already uses server-side
 * (api/team/dashboard/pl-fixture): in flight, else upcoming, else the last one.
 *
 * Zero imports on purpose (same reasoning as formats/tvt/tiebreaker.ts) so it
 * unit-tests without a DB and can be called from client components.
 */

export interface GameweekChoice {
  /** Gameweek number. */
  gw: number;
  /** Deadline as epoch milliseconds. */
  deadline: number;
  /** True once every fixture in the gameweek has a result. */
  isFullyResolved: boolean;
}

/**
 * @param choices  every selectable gameweek. Order does not matter.
 * @param now      epoch milliseconds; injected so this stays testable.
 * @returns the gameweek to select, or null when there is nothing to select.
 */
export function pickDefaultGameweek(
  choices: GameweekChoice[],
  now: number = Date.now()
): number | null {
  if (choices.length === 0) return null;

  const byNumber = [...choices].sort((a, b) => a.gw - b.gw);

  // In flight: the latest gameweek whose deadline has passed but which is not
  // finished. Searched from the back so a double gameweek or a late-scored
  // earlier week cannot pull the selection backwards.
  for (let i = byNumber.length - 1; i >= 0; i--) {
    const c = byNumber[i];
    if (c.deadline <= now && !c.isFullyResolved) return c.gw;
  }

  // Nothing in flight — the current gameweek is done, so show what is next.
  const upcoming = byNumber.find((c) => c.deadline > now);
  if (upcoming) return upcoming.gw;

  // Every gameweek is played and scored: the season is over, stay on the last.
  return byNumber[byNumber.length - 1].gw;
}

/**
 * Which gameweek a team's dashboard fixture card shows: the one after the team's latest scored
 * league fixture. Results-driven, unlike `pickDefaultGameweek` — the card stays on a gameweek
 * until its score is processed. The Match Center opens on the same fixture from the nav, so the
 * two share this rule rather than each keeping a copy.
 */
export function teamFixtureGameweek(fixtures: { gw: number; scored: boolean }[]): number {
  let latest = 0;
  for (const f of fixtures) if (f.scored && f.gw > latest) latest = f.gw;
  return latest + 1;
}
