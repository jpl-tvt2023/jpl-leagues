/**
 * Which of a JPL team's managers is captain for a gameweek, as the live views see it.
 *
 * Announced captain first. With no announcement, the provisional "temp captain" — the lowest
 * current net scorer, rotating on a tie (pickTempCaptain). A row the processor auto-assigned
 * after the deadline (`isValid === false`) is also shown as temp, so it keeps its C* marker.
 *
 * Extracted from the TVT live scorer so the Match Center resolves the captain the same way the
 * fixture scores did — a page that doubled a different manager than the scoreline beside it
 * would be worse than no page.
 *
 * Import-free apart from pickTempCaptain, so the unit lane can exercise it directly.
 */

import { pickTempCaptain } from "@/lib/scoring/temp-captain";

export interface JplCaptainCandidate {
  id: string;
  name: string;
  netScore: number;
}

export function resolveJplCaptain(
  candidates: JplCaptainCandidate[],
  announcedCaptainId: string | null | undefined,
  captainWasAutoAssigned: boolean,
  prevCaptainPlayerId: string | null,
): { captainId: string | null; isTemp: boolean } {
  if (announcedCaptainId) {
    return { captainId: announcedCaptainId, isTemp: captainWasAutoAssigned };
  }
  // Live preview only — no capContext, so wouldExceedCap is irrelevant here.
  const picked = pickTempCaptain(candidates, prevCaptainPlayerId);
  const captainId = picked?.playerId ?? null;
  return { captainId, isTemp: !!captainId };
}
