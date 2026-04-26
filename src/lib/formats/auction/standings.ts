// JPL Auction Standings
// Pure total-points competition — no W/D/L, no groups

import type { AuctionScore, Team } from "../../db/schema";

export interface AuctionGwHistory {
  gw: number;
  points: number;
  rank: number;
  payout: number;
}

export interface AuctionStanding {
  teamId: string;
  teamName: string;
  totalPoints: number;
  purse: number;
  squadValue: number; // sum of FMV of all owned players
  gwHistory: AuctionGwHistory[];
  rank: number;
}

/**
 * Compute auction league standings from accumulated scores.
 * Teams are ranked by cumulative total points (descending).
 */
export function computeAuctionStandings(
  teams: Pick<Team, "id" | "name" | "purse">[],
  scores: Pick<AuctionScore, "teamId" | "gameweekId" | "totalPoints" | "rank" | "payout">[],
  gwNumbers: Map<string, number>, // gameweekId -> gwNumber
  squadValues: Map<string, number> // teamId -> total FMV
): AuctionStanding[] {
  const standings: AuctionStanding[] = teams.map((team) => {
    const teamScores = scores
      .filter((s) => s.teamId === team.id)
      .sort((a, b) => (gwNumbers.get(a.gameweekId) ?? 0) - (gwNumbers.get(b.gameweekId) ?? 0));

    const totalPoints = teamScores.reduce((sum, s) => sum + s.totalPoints, 0);

    const gwHistory: AuctionGwHistory[] = teamScores.map((s) => ({
      gw: gwNumbers.get(s.gameweekId) ?? 0,
      points: s.totalPoints,
      rank: s.rank ?? 0,
      payout: s.payout,
    }));

    return {
      teamId: team.id,
      teamName: team.name,
      totalPoints,
      purse: team.purse,
      squadValue: squadValues.get(team.id) ?? 0,
      gwHistory,
      rank: 0, // will be assigned below
    };
  });

  // Sort by total points desc, then squad value asc (lower = better),
  // then purse desc (higher = better).
  standings.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (a.squadValue !== b.squadValue) return a.squadValue - b.squadValue;
    return b.purse - a.purse;
  });

  // Assign ranks
  for (let i = 0; i < standings.length; i++) {
    standings[i].rank = i + 1;
  }

  return standings;
}
