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
  if (format === "continental-championship") return new Set([27, 29, 33, 35, 37, 38]);
  if (teamSize === 8) return new Set([playoffStartGw, playoffStartGw + 1, playoffStartGw + 2]);
  if (teamSize === 16) return new Set(Array.from({ length: 8 }, (_, i) => playoffStartGw + i));
  if (teamSize === 32) return new Set([31, 32, 33, 34, 35, 36, 37, 38]);
  return new Set();
}

/**
 * Returns the gameweek number that, once it ends (deadline passed → cron scores it
 * the same run), should trigger initial playoff bracket generation for this league
 * — and the relative endpoint to call.
 *
 * Trigger GW = the LAST regular-season GW (one before playoffs start):
 *  - TVT 8-team   (playoffStartGw = 36): trigger GW35 → /generate-playoffs (creates SF ties).
 *  - TVT 16-team  (playoffStartGw = 31): trigger GW30 → /generate-playoffs (creates Group Stage GW31-33).
 *  - TVT 32-team  (playoffStartGw = 31): trigger GW30 → /generate-playoffs (creates RO16 + C-31).
 *  - Triple Crown                       : trigger GW24 → /generate-brackets   (seeds UCL/UEL QFs).
 *  - Auction                            : no knockout playoffs.
 *
 * Returns null when the format has no auto-generation step, or when the GW
 * doesn't match the trigger.
 */
export function getPlayoffGenerateAction(
  format: string,
  teamSize: number,
  playoffStartGw: number,
  gw: number,
): { endpoint: "generate-playoffs" | "generate-brackets" } | null {
  if (format === "auction") return null;
  if (format === "continental-championship") {
    return gw === 24 ? { endpoint: "generate-brackets" } : null;
  }
  // TVT — covers 8/16/32. Trigger when the regular-season-end GW (playoffStartGw - 1)
  // has just ended. Idempotency: the endpoint returns 400 if ties already exist, so
  // later cron runs naturally skip this league.
  void teamSize; // teamSize doesn't change the trigger GW for TVT — only the endpoint's branching does
  return gw === playoffStartGw - 1 ? { endpoint: "generate-playoffs" } : null;
}
