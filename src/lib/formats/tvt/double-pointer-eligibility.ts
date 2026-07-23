/**
 * Wires up the Double Pointer rank-based eligibility rule.
 *
 * `canUseDoublePointer` (scoring.ts) has existed for a while but was never
 * actually called anywhere — this module is the single place that resolves
 * the ranks it needs and turns the boolean into a plain-language reason, so
 * both the dashboard GET (to grey out the option in the UI) and the chips
 * POST route (to actually reject an ineligible submission) stay in sync.
 */

import { canUseDoublePointer } from "./scoring";
import { getGroupRankingsBeforeGW } from "./chip-validation";

export interface DoublePointerEligibility {
  eligible: boolean;
  teamRank: number | null;
  opponentRank: number | null;
  reason: string | null;
}

export async function getDoublePointerEligibility(
  teamId: string,
  groupId: string,
  opponentTeamId: string | null,
  gameweekNumber: number,
  playoffStartGw: number
): Promise<DoublePointerEligibility> {
  // Playoffs have no rank restriction — matches canUseDoublePointer's own
  // bypass, no need to touch the DB for rankings.
  if (gameweekNumber >= playoffStartGw) {
    return { eligible: true, teamRank: null, opponentRank: null, reason: null };
  }

  const rankings = await getGroupRankingsBeforeGW(groupId, gameweekNumber);
  const teamRanking = rankings.find(r => r.teamId === teamId);
  const teamRank = teamRanking?.rank ?? null;

  if (!opponentTeamId) {
    return {
      eligible: false,
      teamRank,
      opponentRank: null,
      reason: `No opponent fixture found for GW${gameweekNumber} — Double Pointer needs a head-to-head opponent`,
    };
  }

  const opponentRanking = rankings.find(r => r.teamId === opponentTeamId);
  const opponentRank = opponentRanking?.rank ?? null;

  if (teamRank === null || opponentRank === null) {
    return {
      eligible: false,
      teamRank,
      opponentRank,
      reason: "Unable to determine group ranking for this fixture",
    };
  }

  const eligible = canUseDoublePointer(teamRank, opponentRank, gameweekNumber, playoffStartGw);
  if (eligible) {
    return { eligible: true, teamRank, opponentRank, reason: null };
  }

  const reason = teamRank <= 8
    ? `Your team (rank ${teamRank}) can only Double-Point a Top-8 opponent — GW${gameweekNumber}'s opponent is ranked ${opponentRank}`
    : `Your team (rank ${teamRank}) can only Double-Point a higher-ranked opponent — GW${gameweekNumber}'s opponent is ranked ${opponentRank}`;

  return { eligible: false, teamRank, opponentRank, reason };
}
