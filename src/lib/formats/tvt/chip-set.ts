/**
 * Which chip set a gameweek belongs to.
 *
 * Set boundaries are derived from the league's own playoffStartGw, never hardcoded:
 *   Set 1: GW1 to midpoint (ceil((playoffStartGw-1)/2))
 *   Set 2: GW(midpoint+1) to playoffStartGw-1
 * Examples:
 *   32/16-team (playoffStartGw=31): Set1 GW1-15, Set2 GW16-30
 *   8-team     (playoffStartGw=36): Set1 GW1-17, Set2 GW18-35
 *
 * Its own module, and import-free, because ./scoring.ts pulls in the FPL gateway (and so the
 * database) — which put this pure three-line rule out of reach of anything that must not load
 * a database, including unit tests. Same leaf-module shape as ./chip-labels.ts. scoring.ts
 * re-exports it, so existing importers are unaffected.
 */
export function getChipSet(gameweek: number, playoffStartGw: number = 31): 1 | 2 | "playoffs" {
  if (gameweek >= playoffStartGw) return "playoffs";
  const midpoint = Math.ceil((playoffStartGw - 1) / 2);
  return gameweek <= midpoint ? 1 : 2;
}
