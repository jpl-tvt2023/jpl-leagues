/**
 * Returns the set of gameweek numbers for which `advance-playoffs` is meaningful
 * for a given league. Used by the cron auto-advance loop to skip leagues whose
 * playoff window doesn't include the just-scored GW.
 *
 * Format/teamSize → playoff window:
 *  - Auction:        no knockout playoffs → empty set.
 *  - Triple Crown:   non-contiguous   [27, 29, 33, 35, 38]
 *  - TVT 8-team:     [playoffStartGw, +1, +2]            (3 GWs)
 *  - TVT 16-team:    [playoffStartGw … +7]               (8 GWs)
 *  - TVT 32-team:    [31..38]                            (8 GWs)
 */
export function getPlayoffAdvanceGws(
  format: string,
  teamSize: number,
  playoffStartGw: number,
): Set<number> {
  if (format === "auction") return new Set();
  if (format === "triple-crown") return new Set([27, 29, 33, 35, 38]);
  if (teamSize === 8) return new Set([playoffStartGw, playoffStartGw + 1, playoffStartGw + 2]);
  if (teamSize === 16) return new Set(Array.from({ length: 8 }, (_, i) => playoffStartGw + i));
  if (teamSize === 32) return new Set([31, 32, 33, 34, 35, 36, 37, 38]);
  return new Set();
}
