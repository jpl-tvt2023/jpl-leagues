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
 */
export interface TempCaptainPlayer {
  id: string;
  name: string;
  netScore: number;
}

export function pickTempCaptain(
  players: TempCaptainPlayer[],
  prevCaptainPlayerId?: string | null
): string | null {
  if (players.length === 0) return null;
  if (players.length === 1) return players[0].id;

  const sorted = [...players].sort((a, b) => a.netScore - b.netScore);
  const tied = sorted[0].netScore === sorted[1].netScore;

  if (tied) {
    if (prevCaptainPlayerId && players.some(p => p.id === prevCaptainPlayerId)) {
      const other = players.find(p => p.id !== prevCaptainPlayerId);
      if (other) return other.id;
    }
    return [...players].sort((a, b) => a.name.localeCompare(b.name))[0].id;
  }

  return sorted[0].id;
}
