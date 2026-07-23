/**
 * TVT Chip Validation Engine
 *
 * Validates TVT chips (Win-Win, Double Pointer, Challenge) according to league rules:
 *
 * GENERAL RULES:
 * - TVT chips cannot be combined with FPL chips (WC, BB, FH, TC)
 * - Once announced and deadline passed, chip cannot be revoked
 * - Each chip can be used once per set (Set 1: GW1-15, Set 2: GW16-30)
 *
 * WIN-WIN (W):
 * - Awards 2 points regardless of match result
 * - If negative hits taken, chip is wasted (counted as used, no points)
 *
 * DOUBLE POINTER (D):
 * - Doubles TVT League points for that gameweek
 *
 * CHALLENGE CHIP (C):
 * - Challenge any top-2 team from opposite group
 * - Win additional 2 points if they beat them
 */

import { db, teams, fixtures, gameweekChips, gameweeks, groups } from "../../db";
import { eq, and, lt } from "drizzle-orm";
import { getChipSet } from "./scoring";

export interface ChipValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * The full set of chip codes a TVT league may enable at creation/edit time.
 */
export const VALID_TVT_CHIP_CODES = ["W", "D", "C", "SL", "CB", "UD"] as const;

/**
 * Validate the shape of a TVT `enabledChips` array: must be an array of exactly
 * 3 unique entries drawn from VALID_TVT_CHIP_CODES. Used by both POST and PATCH
 * on /api/superadmin/leagues so the same rule is enforced at create and edit time.
 *
 * Returns `{ ok: true, chips }` on success; `{ ok: false, error }` otherwise.
 */
export function validateEnabledChipsArray(
  value: unknown
): { ok: true; chips: string[] } | { ok: false; error: string } {
  const errorMsg =
    "TVT enabledChips must be an array of exactly 3 unique valid chip codes (W, D, C, SL, CB, UD)";
  if (!Array.isArray(value)) {
    return { ok: false, error: errorMsg };
  }
  if (value.length !== 3) {
    return { ok: false, error: errorMsg };
  }
  if (!value.every((c): c is string => typeof c === "string" && (VALID_TVT_CHIP_CODES as readonly string[]).includes(c))) {
    return { ok: false, error: errorMsg };
  }
  if (new Set(value).size !== 3) {
    return { ok: false, error: errorMsg };
  }
  return { ok: true, chips: value as string[] };
}

/**
 * Double Pointer and Challenge Chip are both rank-based (see
 * getDoublePointerEligibility / the Challenge Chip opposite-group-top-2
 * rule). In GW1 there are no prior results, so getGroupRankingsBeforeGW
 * ties every team at 0 points — the resulting "rank" is arbitrary, not a
 * real league position. Shared here so the dashboard eligibility display
 * and the POST rejection can never say different things.
 */
export const CHIP_GW1_POSITION_REASON =
  "Both Double Pointer and Challenge Chip depend on your league position, which isn't established yet — unavailable in GW1.";

export interface TeamRanking {
  teamId: string;
  groupId: string;
  groupName: string;
  rank: number;
  leaguePoints: number;
  bonusPoints: number;
}

/**
 * Get chip set based on gameweek (re-exported from scoring.ts for convenience)
 */
export { getChipSet };

/**
 * Check if a chip type has already been used in the current set
 */
export async function isChipUsedInSet(
  teamId: string,
  chipType: "W" | "D" | "C",
  gameweekNumber: number,
  playoffStartGw: number = 31
): Promise<boolean> {
  const chipSet = getChipSet(gameweekNumber, playoffStartGw);
  if (chipSet === "playoffs") return false; // No chip restrictions in playoffs

  const midpoint = Math.ceil((playoffStartGw - 1) / 2);
  const setStart = chipSet === 1 ? 1 : midpoint + 1;
  const setEnd = chipSet === 1 ? midpoint : playoffStartGw - 1;

  // Query chips used by this team of this type in this set's gameweeks
  const usedChips = await db.query.gameweekChips.findMany({
    where: eq(gameweekChips.teamId, teamId),
    with: {
      gameweek: true,
    },
  });

  return usedChips.some(chip => {
    const gwNum = chip.gameweek?.number;
    return chip.chipType === chipType &&
           gwNum !== undefined &&
           gwNum >= setStart &&
           gwNum <= setEnd;
  });
}

/**
 * Get team rankings for a group before a specific gameweek
 * Rankings are calculated by summing results from GW1 to GW(n-1)
 */
export async function getGroupRankingsBeforeGW(
  groupId: string,
  gameweekNumber: number
): Promise<TeamRanking[]> {
  // Get all teams in the group
  const teamsInGroup = await db.query.teams.findMany({
    where: eq(teams.groupId, groupId),
    with: {
      group: true,
    },
  });

  // Calculate historical points for each team
  const teamPoints = await calculateHistoricalPoints(teamsInGroup.map(t => t.id), gameweekNumber);

  // Build rankings with historical points
  const teamsWithPoints = teamsInGroup.map(team => ({
    ...team,
    historicalLeaguePoints: teamPoints.get(team.id)?.leaguePoints || 0,
    historicalBonusPoints: teamPoints.get(team.id)?.bonusPoints || 0,
  }));

  // Sort by league points (desc), then bonus points (desc)
  const sorted = teamsWithPoints.sort((a, b) => {
    if (a.historicalLeaguePoints !== b.historicalLeaguePoints) {
      return b.historicalLeaguePoints - a.historicalLeaguePoints;
    }
    return b.historicalBonusPoints - a.historicalBonusPoints;
  });

  return sorted.map((team, index) => ({
    teamId: team.id,
    groupId: team.groupId!,
    groupName: team.group?.name || "",
    rank: index + 1,
    leaguePoints: team.historicalLeaguePoints,
    bonusPoints: team.historicalBonusPoints,
  }));
}

/**
 * Calculate historical points for teams based on results before a gameweek
 * Returns a map of teamId -> { leaguePoints, bonusPoints }
 */
async function calculateHistoricalPoints(
  teamIds: string[],
  beforeGameweekNumber: number
): Promise<Map<string, { leaguePoints: number; bonusPoints: number }>> {
  const pointsMap = new Map<string, { leaguePoints: number; bonusPoints: number }>();

  // Initialize all teams with 0 points
  for (const teamId of teamIds) {
    pointsMap.set(teamId, { leaguePoints: 0, bonusPoints: 0 });
  }

  // If gameweek 1, everyone starts with 0
  if (beforeGameweekNumber <= 1) {
    return pointsMap;
  }

  // Get all fixtures from previous gameweeks
  const previousFixtures = await db.query.fixtures.findMany({
    with: {
      result: true,
      gameweek: true,
    },
  });

  // Filter to only fixtures from previous gameweeks that have results
  const relevantFixtures = previousFixtures.filter(
    f => f.gameweek && f.gameweek.number < beforeGameweekNumber && f.result
  );

  // Sum up points from each result
  for (const fixture of relevantFixtures) {
    if (!fixture.result) continue;

    // Home team points
    if (pointsMap.has(fixture.homeTeamId)) {
      const current = pointsMap.get(fixture.homeTeamId)!;
      pointsMap.set(fixture.homeTeamId, {
        leaguePoints: current.leaguePoints + fixture.result.homeMatchPoints,
        bonusPoints: current.bonusPoints + (fixture.result.homeGotBonus ? 1 : 0),
      });
    }

    // Away team points
    if (pointsMap.has(fixture.awayTeamId)) {
      const current = pointsMap.get(fixture.awayTeamId)!;
      pointsMap.set(fixture.awayTeamId, {
        leaguePoints: current.leaguePoints + fixture.result.awayMatchPoints,
        bonusPoints: current.bonusPoints + (fixture.result.awayGotBonus ? 1 : 0),
      });
    }
  }

  return pointsMap;
}

/**
 * Get top 2 teams from a group (for Challenge Chip - used at processing time)
 * Uses historical rankings at the start of the specified gameweek
 */
export async function getTop2FromGroup(
  groupId: string,
  gameweekNumber: number
): Promise<TeamRanking[]> {
  const rankings = await getGroupRankingsBeforeGW(groupId, gameweekNumber);
  return rankings.slice(0, 2);
}

/**
 * Validate Win-Win chip usage
 *
 * Rules:
 * - Cannot combine with FPL chips
 * - If negative hits taken, chip is wasted (but still valid to import)
 */
export async function validateWinWin(
  teamId: string,
  gameweekNumber: number,
  playoffStartGw: number = 31
): Promise<ChipValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if chip already used in this set
  const alreadyUsed = await isChipUsedInSet(teamId, "W", gameweekNumber, playoffStartGw);
  if (alreadyUsed) {
    errors.push(`Win-Win chip already used in Set ${getChipSet(gameweekNumber, playoffStartGw)}`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate Double Pointer chip usage
 *
 * Rules:
 * - Doubles TVT League points for the gameweek
 */
export async function validateDoublePointer(
  teamId: string,
  gameweekNumber: number,
  _gameweekId?: string,
  playoffStartGw: number = 31
): Promise<ChipValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if chip already used in this set
  const alreadyUsed = await isChipUsedInSet(teamId, "D", gameweekNumber, playoffStartGw);
  if (alreadyUsed) {
    errors.push(`Double Pointer chip already used in Set ${getChipSet(gameweekNumber, playoffStartGw)}`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate Challenge Chip usage
 *
 * Rules:
 * - Challenge any top-2 team from opposite group
 * - Win additional 2 points if they beat them
 */
export async function validateChallengeChip(
  teamId: string,
  gameweekNumber: number,
  _challengedTeamId?: string,
  playoffStartGw: number = 31
): Promise<ChipValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if chip already used in this set
  const alreadyUsed = await isChipUsedInSet(teamId, "C", gameweekNumber, playoffStartGw);
  if (alreadyUsed) {
    errors.push(`Challenge Chip already used in Set ${getChipSet(gameweekNumber, playoffStartGw)}`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate any chip type
 */
export async function validateChip(
  teamId: string,
  chipType: "W" | "D" | "C",
  gameweekNumber: number,
  gameweekId?: string,
  challengedTeamId?: string,
  playoffStartGw: number = 31
): Promise<ChipValidationResult> {
  switch (chipType) {
    case "W":
      return validateWinWin(teamId, gameweekNumber, playoffStartGw);
    case "D":
      return validateDoublePointer(teamId, gameweekNumber, gameweekId, playoffStartGw);
    case "C":
      return validateChallengeChip(teamId, gameweekNumber, challengedTeamId, playoffStartGw);
    default:
      return {
        isValid: false,
        errors: [`Unknown chip type: ${chipType}`],
        warnings: [],
      };
  }
}

/**
 * Get all chips used by a team in a gameweek
 */
export async function getChipsForTeamInGW(
  teamId: string,
  gameweekId: string
): Promise<{ chipType: "W" | "D" | "C"; isValid: boolean }[]> {
  const chips = await db.select()
    .from(gameweekChips)
    .where(and(
      eq(gameweekChips.teamId, teamId),
      eq(gameweekChips.gameweekId, gameweekId)
    ));

  return chips.map(c => ({
    chipType: c.chipType as "W" | "D" | "C",
    isValid: c.isValid,
  }));
}
