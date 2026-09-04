// TVT Scoring Engine
// Implements the scoring rules for TVT Fantasy Super League

import { calculateTeamGameweekScore } from "../../fpl";

export interface PlayerScore {
  fplScore: number;
  transferHits: number;
  isCaptain: boolean;
}

export interface TVTTeamScore {
  player1Score: number;
  player2Score: number;
  player1Hits: number;
  player2Hits: number;
  captainId: string;
  totalScore: number;
  doubledCaptainScore: number;
}

export interface MatchResult {
  homeScore: number;
  awayScore: number;
  homeMatchPoints: number; // 2 = win, 1 = draw, 0 = loss
  awayMatchPoints: number;
  margin: number;
  homeGotBonus: boolean;
  awayGotBonus: boolean;
}

/**
 * Calculate TVT team score from player scores (synchronous version)
 * Team Score = Combined score of both members
 * Captain's score (including their transfer hits) is doubled
 */
export function calculateTVTTeamScore(players: PlayerScore[]): number {
  let totalScore = 0;

  for (const player of players) {
    const netScore = player.fplScore - player.transferHits;
    if (player.isCaptain) {
      // Captain's net score (fplScore - transferHits) is doubled
      totalScore += netScore * 2;
    } else {
      totalScore += netScore;
    }
  }

  return totalScore;
}

/**
 * Calculate TVT team score for a gameweek (async version using FPL API)
 * Team Score = Combined score of both members minus transfer hits
 * Captain's score and hits are doubled
 */
export async function calculateTVTTeamScoreAsync(
  player1FplId: string,
  player2FplId: string,
  captainPlayerId: string, // Which player is captain (player1 or player2's ID)
  gameweek: number
): Promise<TVTTeamScore> {
  const [p1Score, p2Score] = await Promise.all([
    calculateTeamGameweekScore(player1FplId, gameweek),
    calculateTeamGameweekScore(player2FplId, gameweek),
  ]);

  const isCaptain1 = captainPlayerId === player1FplId;

  // Captain's score and hits are doubled
  const player1Final = isCaptain1
    ? (p1Score.netScore * 2)
    : p1Score.netScore;

  const player2Final = !isCaptain1
    ? (p2Score.netScore * 2)
    : p2Score.netScore;

  const totalScore = player1Final + player2Final;

  return {
    player1Score: p1Score.points,
    player2Score: p2Score.points,
    player1Hits: p1Score.transferHits,
    player2Hits: p2Score.transferHits,
    captainId: captainPlayerId,
    totalScore,
    doubledCaptainScore: isCaptain1
      ? p1Score.netScore * 2
      : p2Score.netScore * 2,
  };
}

/**
 * Determine match result between two teams
 * Win = 2 points, Draw = 1 point, Loss = 0 points
 */
export function determineMatchResult(
  homeScore: number,
  awayScore: number,
  isDoublePointerHome: boolean = false,
  isDoublePointerAway: boolean = false
): MatchResult {
  const margin = Math.abs(homeScore - awayScore);

  let homeMatchPoints: number;
  let awayMatchPoints: number;

  if (homeScore > awayScore) {
    homeMatchPoints = 2;
    awayMatchPoints = 0;
  } else if (awayScore > homeScore) {
    homeMatchPoints = 0;
    awayMatchPoints = 2;
  } else {
    homeMatchPoints = 1;
    awayMatchPoints = 1;
  }

  // Double Pointer chip doubles match points
  if (isDoublePointerHome) {
    homeMatchPoints *= 2;
  }
  if (isDoublePointerAway) {
    awayMatchPoints *= 2;
  }

  // Bonus point: earned if team wins by 75+ points
  // Note: Highest margin check should be done at group level
  const homeGotBonus = homeScore - awayScore >= 75;
  const awayGotBonus = awayScore - homeScore >= 75;

  return {
    homeScore,
    awayScore,
    homeMatchPoints,
    awayMatchPoints,
    margin,
    homeGotBonus,
    awayGotBonus,
  };
}

/**
 * Check if negative hit cap is exceeded
 * Max -12 points per player. Exceeding triggers -1 league point deduction
 */
export function checkNegativeHitCap(hits: number): {
  exceeded: boolean;
  penalty: number;
} {
  const MAX_NEGATIVE_HITS = 12;
  return {
    exceeded: hits > MAX_NEGATIVE_HITS,
    penalty: hits > MAX_NEGATIVE_HITS ? -1 : 0,
  };
}

/**
 * Calculate chip eligibility
 * - Double Pointer: Rank 1-8 use only against Top 8, Rank 9+ only against higher-ranked
 * - Chips reset between Set 1 and Set 2 (boundaries depend on playoffStartGw)
 */
export function canUseDoublePointer(
  teamRank: number,
  opponentRank: number,
  gameweek: number,
  playoffStartGw: number = 31
): boolean {
  // Playoffs have no chip restrictions
  if (gameweek >= playoffStartGw) return true;

  if (teamRank <= 8) {
    // Top 8 can only use against other Top 8 teams
    return opponentRank <= 8;
  } else {
    // Rank 9+ can only use against higher-ranked teams (lower rank number)
    return opponentRank < teamRank;
  }
}

// Defined in ./chip-set.ts so callers that must not load a database can reach it
// (this module imports the FPL gateway). Re-exported here for existing importers.
export { getChipSet } from "./chip-set";

/**
 * Check captaincy chip availability
 * Each player has 15 chips in League Stage
 * No limit in Playoffs
 */
export function canBeCaptain(
  chipsUsed: number,
  gameweek: number,
  playoffStartGw: number = 31
): boolean {
  const MAX_CAPTAINCY_CHIPS = 15;
  // No limit in playoffs
  if (gameweek >= playoffStartGw) return true;
  return chipsUsed < MAX_CAPTAINCY_CHIPS;
}

// The canonical league-stage tiebreaker lives in ./tiebreaker.ts — a module with no
// imports, so it stays unit-testable without a DB. Re-exported here because callers
// have always reached for it via this file.
export { compareTiebreaker, type TeamStanding } from "./tiebreaker";
