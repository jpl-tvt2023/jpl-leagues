// JPL Auction Standings
// Pure total-points competition — no W/D/L, no groups

import type { AuctionScore, Team } from "../../db/schema";

export interface AuctionGwHistory {
  gw: number;
  points: number;          // back-compat alias for totalPoints (kept for older UI consumers)
  totalPoints: number;
  rawPoints: number;
  synergyBonus: number;
  clubResultBonus: number;
  rank: number;
  payout: number;
}

export interface AuctionStanding {
  teamId: string;
  teamName: string;
  totalPoints: number;          // cumulative total = raw + synergy + clubResult
  rawPoints: number;
  synergyBonus: number;
  clubResultBonus: number;
  purse: number;
  squadValue: number;           // sum of FMV of all owned players (FMV uses RAW points only)
  gwHistory: AuctionGwHistory[];
  rank: number;
  previousRank: number | null;
  rankDelta: number | null;
}

/**
 * Compute auction league standings from accumulated scores.
 * Teams are ranked by cumulative total points (descending).
 */
export function computeAuctionStandings(
  teams: Pick<Team, "id" | "name" | "purse">[],
  scores: Pick<AuctionScore, "teamId" | "gameweekId" | "totalPoints" | "rawPoints" | "synergyBonus" | "clubResultBonus" | "rank" | "payout">[],
  gwNumbers: Map<string, number>, // gameweekId -> gwNumber
  squadValues: Map<string, number> // teamId -> total FMV
): AuctionStanding[] {
  const standings: AuctionStanding[] = teams.map((team) => {
    const teamScores = scores
      .filter((s) => s.teamId === team.id)
      .sort((a, b) => (gwNumbers.get(a.gameweekId) ?? 0) - (gwNumbers.get(b.gameweekId) ?? 0));

    const totalPoints = teamScores.reduce((sum, s) => sum + s.totalPoints, 0);
    const rawPoints = teamScores.reduce((sum, s) => sum + (s.rawPoints ?? 0), 0);
    const synergyBonus = teamScores.reduce((sum, s) => sum + (s.synergyBonus ?? 0), 0);
    const clubResultBonus = teamScores.reduce((sum, s) => sum + (s.clubResultBonus ?? 0), 0);

    const gwHistory: AuctionGwHistory[] = teamScores.map((s) => ({
      gw: gwNumbers.get(s.gameweekId) ?? 0,
      points: s.totalPoints,
      totalPoints: s.totalPoints,
      rawPoints: s.rawPoints ?? 0,
      synergyBonus: s.synergyBonus ?? 0,
      clubResultBonus: s.clubResultBonus ?? 0,
      rank: s.rank ?? 0,
      payout: s.payout,
    }));

    return {
      teamId: team.id,
      teamName: team.name,
      totalPoints,
      rawPoints,
      synergyBonus,
      clubResultBonus,
      purse: team.purse,
      squadValue: squadValues.get(team.id) ?? 0,
      gwHistory,
      rank: 0, // will be assigned below
      previousRank: null,
      rankDelta: null,
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

  // Compute previous-GW ranking — cumulative totalPoints through (maxGw - 1).
  // Ties broken using the same secondary keys (squadValue asc, purse desc) as
  // the current sort, so the delta math is consistent. Skip when no prior GW.
  const playedGws = standings
    .flatMap((s) => s.gwHistory.map((h) => h.gw))
    .filter((n) => n > 0);
  if (playedGws.length > 0) {
    const maxGw = Math.max(...playedGws);
    if (maxGw > 1) {
      const previousGw = maxGw - 1;
      const previousStandings = standings.map((s) => {
        const pointsThroughPrev = s.gwHistory
          .filter((h) => h.gw <= previousGw)
          .reduce((sum, h) => sum + h.points, 0);
        return { teamId: s.teamId, totalPoints: pointsThroughPrev, squadValue: s.squadValue, purse: s.purse };
      });
      previousStandings.sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
        if (a.squadValue !== b.squadValue) return a.squadValue - b.squadValue;
        return b.purse - a.purse;
      });
      const previousRankByTeam = new Map<string, number>();
      previousStandings.forEach((row, idx) => previousRankByTeam.set(row.teamId, idx + 1));
      // Only treat a team as having a "previous rank" if it actually played the
      // earlier GW. A team with zero history at previousGw shouldn't show a delta.
      for (const s of standings) {
        const hasPrevGw = s.gwHistory.some((h) => h.gw <= previousGw);
        if (!hasPrevGw) continue;
        const prev = previousRankByTeam.get(s.teamId);
        if (prev == null) continue;
        s.previousRank = prev;
        s.rankDelta = prev - s.rank;
      }
    }
  }

  return standings;
}
