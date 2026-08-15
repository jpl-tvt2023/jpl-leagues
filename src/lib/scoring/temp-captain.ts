/**
 * Picks the captain when a team didn't announce one for a GW.
 *
 * Rule: lowest current/final FPL net scorer becomes captain.
 * On a tie (equal net scores), rotate — pick the player who was NOT
 * captain in the previous GW. Spreads the per-player captaincy-cap
 * usage across both team members. Falls back to alphabetical first
 * when there's no prior captain (e.g. GW1).
 *
 * Used in two places:
 *  - Live scoring (pre-GW / mid-GW): provisional "temp captain"
 *    derived on-the-fly from current live FPL scores.
 *  - Post-GW assignDefaultCaptain: persisted captain when GW closes
 *    with no announcement.
 *
 * DEF-CHIP-009 (auto-fallback bypass): when a `capContext` is supplied
 * AND the chosen player would push their cap usage past the per-player
 * League-Stage limit, the result still names that player (the lowest
 * scorer is still chosen — client decision: never clamp) but the caller
 * is told via `wouldExceedCap: true` so it can record a bypass reason
 * on the persisted gameweek_captains row.
 */
export interface TempCaptainPlayer {
  id: string;
  name: string;
  netScore: number;
  /** Current cumulative captaincy-cap usage for this player. Optional —
   *  only the persisted-captain callers need to pass it (live preview
   *  paths don't write to the cap audit). */
  captaincyChipsUsed?: number;
}

export interface TempCaptainResult {
  playerId: string;
  playerName: string;
  /** True when the persistence caller MUST record a bypass_reason because
   *  the chosen player has already used their per-player League-Stage cap
   *  and this GW would push them over. Always false when `capContext` is
   *  omitted, when the GW does not count toward the cap (playoff GWs),
   *  or when the player's usage is still below the cap. */
  wouldExceedCap: boolean;
}

export interface TempCaptainCapContext {
  /** Per-player League-Stage cap (e.g. 19 for continental-championship, 15 otherwise). */
  cap: number;
  /** False for playoff GWs (cap doesn't apply); true for League-Stage GWs. */
  gwCountsTowardCap: boolean;
}

export function pickTempCaptain(
  players: TempCaptainPlayer[],
  prevCaptainPlayerId?: string | null,
  capContext?: TempCaptainCapContext | null,
): TempCaptainResult | null {
  if (players.length === 0) return null;

  let chosen: TempCaptainPlayer | undefined;

  if (players.length === 1) {
    chosen = players[0];
  } else {
    const sorted = [...players].sort((a, b) => a.netScore - b.netScore);
    const tied = sorted[0].netScore === sorted[1].netScore;

    if (tied) {
      if (prevCaptainPlayerId && players.some(p => p.id === prevCaptainPlayerId)) {
        chosen = players.find(p => p.id !== prevCaptainPlayerId);
      }
      if (!chosen) {
        chosen = [...players].sort((a, b) => a.name.localeCompare(b.name))[0];
      }
    } else {
      chosen = sorted[0];
    }
  }

  if (!chosen) return null;

  const wouldExceedCap =
    !!capContext &&
    capContext.gwCountsTowardCap &&
    (chosen.captaincyChipsUsed ?? 0) >= capContext.cap;

  return {
    playerId: chosen.id,
    playerName: chosen.name,
    wouldExceedCap,
  };
}
