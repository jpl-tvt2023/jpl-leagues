/**
 * Win / draw / loss for one side of a scored fixture, decided by the two scores.
 *
 * Never derive this from a result's `homeMatchPoints` / `awayMatchPoints`. Those columns are
 * chip-adjusted when the gameweek is processed: a Double Pointer win is stored as 4 and a
 * Win-Win loss as 2, so reading `=== 2` as a win turns the first into a loss and the second
 * into a win. The stored scores are the ones the natural result was decided from, so
 * comparing them gives the true outcome. The standings table follows the same rule
 * (lib/standings/league-stage.ts).
 */
export type MatchOutcome = "W" | "D" | "L";

export function matchOutcome(own: number, opp: number): MatchOutcome {
  if (own > opp) return "W";
  if (own === opp) return "D";
  return "L";
}
