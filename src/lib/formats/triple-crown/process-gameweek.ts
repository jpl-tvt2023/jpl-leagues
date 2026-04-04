/**
 * Triple Crown Format: Gameweek Processing
 * Two-pass processing: Pass 1 = PL H2H, Pass 2 = Cup group stage (Ghost opponent)
 *
 * Pass 1 (PL): Process all league-phase fixtures, update leaguePoints, award bonuses (75+ margin)
 * Pass 2 (Cup): Only on Double Header GWs (6,8,10,12,14,16,18,20,22,24,27,29,33,35,38)
 *   - Compute Ghost score from 4 human team scores in each cup group
 *   - Update cupGroupPoints (W=+2, L=0, no draws possible)
 */

import { db, fixtures, gameweeks, groups, results, teams, players, auditLogs, type Fixture, type Team, type Player, type Group, type Result } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { calculateTeamGameweekScore } from "@/lib/fpl";
import { getAllCachedScores } from "@/lib/fpl-cache";
import { calculateGhostScore, determineGhostMatchResult, calculateCupGroupPoints } from "./scoring";
import { generateId } from "@/lib/id";

const DOUBLE_HEADER_GWS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 27, 29, 33, 35, 38];

interface ProcessResult {
  success: boolean;
  message: string;
  processed: number;
  errors?: Array<{ fixtureId: string; error: string }>;
  bonusAwards?: Array<{ teamId: string; margin: number; group: string }>;
}

type FixtureWithRelations = Fixture & {
  homeTeam: Team & { players: Player[] };
  awayTeam: Team & { players: Player[] };
  group: Group;
  result: Result | null;
};

/**
 * Main entry point for Triple Crown GW processing
 */
export async function processTripleCrownGameweek(
  gameweekId: string,
  gameweekNumber: number,
  leagueId: string,
  forceReprocess: boolean
): Promise<ProcessResult> {
  try {
    // Fetch gameweek with relations
    const gwList = await db.query.gameweeks.findMany({
      where: eq(gameweeks.id, gameweekId),
      with: {
        fixtures: {
          with: {
            homeTeam: { with: { players: true } },
            awayTeam: { with: { players: true } },
            group: true,
            result: true,
          },
        },
      },
    });

    const gameweek = gwList[0];
    if (!gameweek) {
      return { success: false, message: "Gameweek not found", processed: 0 };
    }

    // Force reprocess: delete existing results and revert points
    if (forceReprocess) {
      for (const fixture of gameweek.fixtures) {
        if (fixture.result) {
          // Revert PL points
          if (fixture.competitionType === "pl") {
            const homeTeam = await db.select().from(teams).where(eq(teams.id, fixture.homeTeamId));
            const awayTeam = await db.select().from(teams).where(eq(teams.id, fixture.awayTeamId));
            if (homeTeam[0]) {
              await db.update(teams)
                .set({
                  leaguePoints: Math.max(0, homeTeam[0].leaguePoints - fixture.result.homeMatchPoints),
                  bonusPoints: Math.max(0, homeTeam[0].bonusPoints - (fixture.result.homeGotBonus ? 1 : 0)),
                })
                .where(eq(teams.id, fixture.homeTeamId));
            }
            if (awayTeam[0]) {
              await db.update(teams)
                .set({
                  leaguePoints: Math.max(0, awayTeam[0].leaguePoints - fixture.result.awayMatchPoints),
                  bonusPoints: Math.max(0, awayTeam[0].bonusPoints - (fixture.result.awayGotBonus ? 1 : 0)),
                })
                .where(eq(teams.id, fixture.awayTeamId));
            }
          }
          // Revert cup points
          else if (fixture.competitionType === "cup-group") {
            const homeTeam = await db.select().from(teams).where(eq(teams.id, fixture.homeTeamId));
            const awayTeam = await db.select().from(teams).where(eq(teams.id, fixture.awayTeamId));
            if (homeTeam[0] && !homeTeam[0].isGhost) {
              await db.update(teams)
                .set({ cupGroupPoints: Math.max(0, homeTeam[0].cupGroupPoints - fixture.result.homeMatchPoints) })
                .where(eq(teams.id, fixture.homeTeamId));
            }
            if (awayTeam[0] && !awayTeam[0].isGhost) {
              await db.update(teams)
                .set({ cupGroupPoints: Math.max(0, awayTeam[0].cupGroupPoints - fixture.result.awayMatchPoints) })
                .where(eq(teams.id, fixture.awayTeamId));
            }
          }
          await db.delete(results).where(eq(results.id, fixture.result.id));
        }
      }
      // Re-fetch gameweek
      const updatedGwList = await db.query.gameweeks.findMany({
        where: eq(gameweeks.id, gameweekId),
        with: {
          fixtures: {
            with: {
              homeTeam: { with: { players: true } },
              awayTeam: { with: { players: true } },
              group: true,
              result: true,
            },
          },
        },
      });
      if (updatedGwList[0]) {
        gameweek.fixtures = updatedGwList[0].fixtures;
      }
    }

    // ============================================
    // PASS 1: PL FIXTURES
    // ============================================
    const processedResults: string[] = [];
    const errors: Array<{ fixtureId: string; error: string }> = [];
    const teamScoreCache = new Map<string, number>(); // teamId → effectiveScore
    const bonusAwards: Array<{ teamId: string; margin: number; group: string }> = [];

    const plFixtures = gameweek.fixtures.filter(
      f => f.competitionType === "pl" && !f.result
    ) as FixtureWithRelations[];

    if (plFixtures.length === 0 && !DOUBLE_HEADER_GWS.includes(gameweekNumber)) {
      return { success: true, message: "No PL fixtures to process", processed: 0 };
    }

    // Build carry-forward hit map from previous GW
    const carryForwardMap = new Map<string, number>();
    if (gameweekNumber > 1) {
      const prevGwCache = await getAllCachedScores(gameweekNumber - 1, leagueId);
      const prevGwSuffix = `_gw${gameweekNumber - 1}`;
      for (const [key, data] of Object.entries(prevGwCache)) {
        if (key.endsWith(prevGwSuffix) && data.transferHits > 12) {
          const fplId = key.slice(0, -prevGwSuffix.length);
          carryForwardMap.set(fplId, data.transferHits);
        }
      }
    }

    // Track margins per PL group for bonus calculation
    const plMargins: Map<string, { teamId: string; margin: number; resultId: string }[]> = new Map();

    // Process each PL fixture
    for (const fixture of plFixtures) {
      try {
        // Fetch FPL scores for both teams
        const homeScores = await Promise.all(
          fixture.homeTeam.players.map(async (p: Player) => {
            const score = await calculateTeamGameweekScore(p.fplId, gameweekNumber, leagueId);
            return { ...score };
          })
        );

        const awayScores = await Promise.all(
          fixture.awayTeam.players.map(async (p: Player) => {
            const score = await calculateTeamGameweekScore(p.fplId, gameweekNumber, leagueId);
            return { ...score };
          })
        );

        // Calculate team scores (no captain doubling, just sum of net scores)
        const homeTeamScore = homeScores.reduce((sum, s) => sum + (s.points - s.transferHits), 0);
        const awayTeamScore = awayScores.reduce((sum, s) => sum + (s.points - s.transferHits), 0);

        // Apply carry-forward deductions
        const homeCarryForward = fixture.homeTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );
        const awayCarryForward = fixture.awayTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );

        const effectiveHomeScore = homeTeamScore - homeCarryForward;
        const effectiveAwayScore = awayTeamScore - awayCarryForward;

        // Cache effective scores for Pass 2 (cup stage)
        teamScoreCache.set(fixture.homeTeamId, effectiveHomeScore);
        teamScoreCache.set(fixture.awayTeamId, effectiveAwayScore);

        // Determine winner
        let homeMatchPoints = 0, awayMatchPoints = 0;
        if (effectiveHomeScore > effectiveAwayScore) {
          homeMatchPoints = 2;
          awayMatchPoints = 0;
        } else if (effectiveAwayScore > effectiveHomeScore) {
          homeMatchPoints = 0;
          awayMatchPoints = 2;
        } else {
          homeMatchPoints = 1;
          awayMatchPoints = 1;
        }

        // Insert result
        const resultId = generateId();
        await db.insert(results).values({
          id: resultId,
          fixtureId: fixture.id,
          teamId: homeMatchPoints > awayMatchPoints ? fixture.homeTeamId : fixture.awayTeamId,
          homeScore: effectiveHomeScore,
          awayScore: effectiveAwayScore,
          homeMatchPoints,
          awayMatchPoints,
          homeGotBonus: false,
          awayGotBonus: false,
          homeUsedDoublePointer: false,
          awayUsedDoublePointer: false,
        });

        // Update team league points
        const homeTeam = await db.select().from(teams).where(eq(teams.id, fixture.homeTeamId));
        const awayTeam = await db.select().from(teams).where(eq(teams.id, fixture.awayTeamId));

        if (homeTeam[0]) {
          await db.update(teams)
            .set({ leaguePoints: homeTeam[0].leaguePoints + homeMatchPoints })
            .where(eq(teams.id, fixture.homeTeamId));
        }
        if (awayTeam[0]) {
          await db.update(teams)
            .set({ leaguePoints: awayTeam[0].leaguePoints + awayMatchPoints })
            .where(eq(teams.id, fixture.awayTeamId));
        }

        // Track margin for bonus (75+ points)
        const margin = Math.abs(effectiveHomeScore - effectiveAwayScore);
        const groupId = fixture.groupId;
        if (!plMargins.has(groupId)) {
          plMargins.set(groupId, []);
        }
        if (margin >= 75) {
          if (effectiveHomeScore > effectiveAwayScore) {
            plMargins.get(groupId)!.push({
              teamId: fixture.homeTeamId,
              margin,
              resultId,
            });
          } else if (effectiveAwayScore > effectiveHomeScore) {
            plMargins.get(groupId)!.push({
              teamId: fixture.awayTeamId,
              margin,
              resultId,
            });
          }
        }

        processedResults.push(fixture.id);
      } catch (error) {
        errors.push({
          fixtureId: fixture.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Award bonus points (highest margin per PL group)
    for (const [groupId, margins] of plMargins) {
      if (margins.length === 0) continue;
      const highestMargin = Math.max(...margins.map(m => m.margin));
      const bonusWinners = margins.filter(m => m.margin === highestMargin);

      const groupRecord = await db.select().from(groups).where(eq(groups.id, groupId));
      const groupName = groupRecord[0]?.name || groupId;

      for (const winner of bonusWinners) {
        const resultRecord = await db.select().from(results).where(eq(results.id, winner.resultId));
        if (resultRecord[0]) {
          const fixtureRecord = await db.select().from(fixtures).where(eq(fixtures.id, resultRecord[0].fixtureId));
          const isHomeTeam = fixtureRecord[0]?.homeTeamId === winner.teamId;

          // Award bonus point
          await db.update(results)
            .set({
              homeGotBonus: isHomeTeam ? true : resultRecord[0].homeGotBonus,
              awayGotBonus: !isHomeTeam ? true : resultRecord[0].awayGotBonus,
            })
            .where(eq(results.id, winner.resultId));

          const teamRecord = await db.select().from(teams).where(eq(teams.id, winner.teamId));
          if (teamRecord[0]) {
            await db.update(teams)
              .set({
                leaguePoints: teamRecord[0].leaguePoints + 1,
                bonusPoints: teamRecord[0].bonusPoints + 1,
              })
              .where(eq(teams.id, winner.teamId));
          }

          bonusAwards.push({
            teamId: winner.teamId,
            margin: winner.margin,
            group: groupName,
          });
        }
      }
    }

    // ============================================
    // PASS 2: CUP FIXTURES (only on Double Header GWs)
    // ============================================
    if (DOUBLE_HEADER_GWS.includes(gameweekNumber)) {
      const cupFixtures = gameweek.fixtures.filter(
        f => f.competitionType === "cup-group" && !f.result
      ) as FixtureWithRelations[];

      for (const fixture of cupFixtures) {
        try {
          // Determine if fixture involves Ghost team
          const homeTeam = await db.select().from(teams).where(eq(teams.id, fixture.homeTeamId));
          const awayTeam = await db.select().from(teams).where(eq(teams.id, fixture.awayTeamId));
          const homeIsGhost = homeTeam[0]?.isGhost ?? false;
          const awayIsGhost = awayTeam[0]?.isGhost ?? false;

          let homeScore: number, awayScore: number, homeMatchPoints: number, awayMatchPoints: number;

          if (homeIsGhost) {
            // Away is human, home is ghost
            const humanScore = teamScoreCache.get(fixture.awayTeamId) ?? 0;
            const ghostScore = await computeGroupGhostScore(fixture.groupId, fixture.awayTeamId, teamScoreCache);
            homeScore = ghostScore;
            awayScore = humanScore;
            const result = determineGhostMatchResult(humanScore, ghostScore);
            homeMatchPoints = 0;
            awayMatchPoints = calculateCupGroupPoints(result);
          } else if (awayIsGhost) {
            // Home is human, away is ghost
            const humanScore = teamScoreCache.get(fixture.homeTeamId) ?? 0;
            const ghostScore = await computeGroupGhostScore(fixture.groupId, fixture.homeTeamId, teamScoreCache);
            homeScore = humanScore;
            awayScore = ghostScore;
            const result = determineGhostMatchResult(humanScore, ghostScore);
            homeMatchPoints = calculateCupGroupPoints(result);
            awayMatchPoints = 0;
          } else {
            // Human vs human cup fixture
            const homeEffectiveScore = teamScoreCache.get(fixture.homeTeamId) ?? 0;
            const awayEffectiveScore = teamScoreCache.get(fixture.awayTeamId) ?? 0;
            homeScore = homeEffectiveScore;
            awayScore = awayEffectiveScore;

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
          }

          // Insert result
          const resultId = generateId();
          await db.insert(results).values({
            id: resultId,
            fixtureId: fixture.id,
            teamId: homeMatchPoints >= awayMatchPoints ? fixture.homeTeamId : fixture.awayTeamId,
            homeScore,
            awayScore,
            homeMatchPoints,
            awayMatchPoints,
            homeGotBonus: false,
            awayGotBonus: false,
            homeUsedDoublePointer: false,
            awayUsedDoublePointer: false,
          });

          // Update cup group points (only for human teams, not Ghost)
          if (!homeIsGhost && homeTeam[0]) {
            await db.update(teams)
              .set({ cupGroupPoints: homeTeam[0].cupGroupPoints + homeMatchPoints })
              .where(eq(teams.id, fixture.homeTeamId));
          }
          if (!awayIsGhost && awayTeam[0]) {
            await db.update(teams)
              .set({ cupGroupPoints: awayTeam[0].cupGroupPoints + awayMatchPoints })
              .where(eq(teams.id, fixture.awayTeamId));
          }

          processedResults.push(fixture.id);
        } catch (error) {
          errors.push({
            fixtureId: fixture.id,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    }

    return {
      success: true,
      message: `Processed ${processedResults.length} fixtures`,
      processed: processedResults.length,
      errors: errors.length > 0 ? errors : undefined,
      bonusAwards: bonusAwards.length > 0 ? bonusAwards : undefined,
    };
  } catch (error) {
    console.error("Error in processTripleCrownGameweek:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
      processed: 0,
    };
  }
}

/**
 * Compute Ghost score for a cup group fixture
 * Collects all 4 human team scores in the group, calculates ceil(mean)
 */
async function computeGroupGhostScore(
  groupId: string,
  excludeTeamId: string,
  teamScoreCache: Map<string, number>
): Promise<number> {
  // Get all human teams in this cup group
  const groupTeams = await db.select().from(teams).where(
    and(eq(teams.groupId, groupId), eq(teams.isGhost, false))
  );

  // Collect scores (up to 4 human teams)
  const humanScores: number[] = [];
  for (const team of groupTeams) {
    if (team.id !== excludeTeamId) {
      const score = teamScoreCache.get(team.id) ?? 0;
      humanScores.push(score);
    }
  }

  // Should have exactly 4 human team scores
  if (humanScores.length !== 4) {
    console.warn(`Expected 4 human teams in cup group ${groupId}, got ${humanScores.length}`);
  }

  return calculateGhostScore(humanScores);
}
