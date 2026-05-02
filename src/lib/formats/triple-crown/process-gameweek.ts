/**
 * Triple Crown Format: Gameweek Processing
 * Two-pass processing: Pass 1 = PL H2H, Pass 2 = Cup group stage (Ghost opponent)
 *
 * Pass 1 (PL): Process all league-phase fixtures, update leaguePoints, award bonuses (75+ margin)
 * Pass 2 (Cup): Only on Double Header GWs (6,8,10,12,14,16,18,20,22,24,27,29,33,35,38)
 *   - Compute Ghost score from 4 human team scores in each cup group
 *   - Update cupGroupPoints (W=+2, L=0, no draws possible)
 */

import { db, fixtures, gameweeks, groups, results, teams, players, auditLogs, gameweekCaptains, type Fixture, type Team, type Player, type Group, type Result } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { calculateTeamGameweekScore } from "@/lib/fpl";
import { getAllCachedScores } from "@/lib/fpl-cache";
import { calculateGhostScore, determineGhostMatchResult, calculateCupGroupPoints } from "./scoring";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";
import { generateId } from "@/lib/id";

const DOUBLE_HEADER_GWS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 27, 29, 33, 35, 38];

interface ProcessResult {
  success: boolean;
  message: string;
  processed: number;
  errors?: Array<{ fixtureId: string; error: string }>;
}

type FixtureWithRelations = Fixture & {
  homeTeam: Team & { players: Player[] };
  awayTeam: Team & { players: Player[] };
  group: Group | null;
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
    const playerScoreCache = new Map<string, string>(); // teamId → JSON player scores

    const plFixtures = gameweek.fixtures.filter(
      f => f.competitionType === "pl" && !f.result
    ) as FixtureWithRelations[];

    if (plFixtures.length === 0 && !DOUBLE_HEADER_GWS.includes(gameweekNumber)) {
      return { success: true, message: "No PL fixtures to process", processed: 0 };
    }

    // Captain lookup for this GW (announced via gameweek_captains; isValid=false ⇒ auto-assigned).
    // Same pattern as TVT scoring path so badges + doubling stay consistent across formats.
    const gwCaptains = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.gameweekId, gameweekId),
      with: { player: true },
    });
    const captainByTeam = new Map<string, string>();
    const autoAssignedByTeam = new Map<string, boolean>();
    for (const pick of gwCaptains) {
      captainByTeam.set(pick.player.teamId, pick.player.id);
      autoAssignedByTeam.set(pick.player.teamId, pick.isValid === false);
    }

    // Previous-GW captains for temp-cap rotation tiebreak when auto-assigning.
    const prevCaptainByTeam = new Map<string, string>();
    if (gameweekNumber > 1) {
      const prevGw = await db.query.gameweeks.findFirst({
        where: and(eq(gameweeks.number, gameweekNumber - 1), eq(gameweeks.leagueId, leagueId)),
      });
      if (prevGw) {
        const prevPicks = await db.query.gameweekCaptains.findMany({
          where: eq(gameweekCaptains.gameweekId, prevGw.id),
          with: { player: true },
        });
        for (const p of prevPicks) prevCaptainByTeam.set(p.player.teamId, p.player.id);
      }
    }

    // Helper to insert an auto-pick gameweek_captains row when no captain announced.
    // Mirrors autoAssignDefaultCaptain in /api/gameweeks/[gw] route — keeps the captain
    // visible to live-refresh / dashboard / playoff-bracket paths post-process.
    async function persistAutoCaptain(teamId: string, playerId: string): Promise<void> {
      await db.insert(gameweekCaptains).values({
        id: generateId(),
        gameweekId,
        playerId,
        announcedAt: new Date(),
        isValid: false,
      });
      captainByTeam.set(teamId, playerId);
      autoAssignedByTeam.set(teamId, true);
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

        // Resolve captain per side (announced > auto via lowest net + prev-GW rotation).
        // Persist auto-picks into gameweek_captains so live-refresh / dashboard share the same captain.
        const resolveCaptainForSide = async (teamId: string, teamPlayers: Player[], scoresArr: typeof homeScores) => {
          let captainId = captainByTeam.get(teamId) ?? null;
          let isAutoAssigned = autoAssignedByTeam.get(teamId) ?? false;
          if (!captainId) {
            const candidates = teamPlayers.map((p, idx) => ({
              id: p.id,
              name: p.name,
              netScore: scoresArr[idx].points - scoresArr[idx].transferHits,
            }));
            const picked = pickTempCaptain(candidates, prevCaptainByTeam.get(teamId) ?? null);
            if (picked) {
              await persistAutoCaptain(teamId, picked);
              captainId = picked;
              isAutoAssigned = true;
            }
          }
          return { captainId, isAutoAssigned };
        };

        const homeCap = await resolveCaptainForSide(fixture.homeTeamId, fixture.homeTeam.players, homeScores);
        const awayCap = await resolveCaptainForSide(fixture.awayTeamId, fixture.awayTeam.players, awayScores);

        // Per-format docs: Team Score = sum(non-captain net) + (captain net × 2). Same captain
        // applies to PL, cup, and knockout. See TripleCrownHelp.tsx → "Captain & Scoring".
        const homeTeamScore = homeScores.reduce((sum, s, i) => {
          const net = s.points - s.transferHits;
          const isCap = fixture.homeTeam.players[i]?.id === homeCap.captainId;
          return sum + (isCap ? net * 2 : net);
        }, 0);
        const awayTeamScore = awayScores.reduce((sum, s, i) => {
          const net = s.points - s.transferHits;
          const isCap = fixture.awayTeam.players[i]?.id === awayCap.captainId;
          return sum + (isCap ? net * 2 : net);
        }, 0);

        // Apply carry-forward deductions
        const homeCarryForward = fixture.homeTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );
        const awayCarryForward = fixture.awayTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );

        const effectiveHomeScore = homeTeamScore - homeCarryForward;
        const effectiveAwayScore = awayTeamScore - awayCarryForward;

        // Cache effective scores and player breakdowns for Pass 2 (cup stage)
        teamScoreCache.set(fixture.homeTeamId, effectiveHomeScore);
        teamScoreCache.set(fixture.awayTeamId, effectiveAwayScore);

        playerScoreCache.set(fixture.homeTeamId, JSON.stringify(
          homeScores.map((s, i) => {
            const p = fixture.homeTeam.players[i];
            const net = s.points - s.transferHits;
            const isCaptain = p?.id === homeCap.captainId;
            return {
              name: p?.name ?? "",
              fplId: p?.fplId ?? "",
              fplScore: s.points,
              transferHits: s.transferHits,
              isCaptain,
              ...(isCaptain && homeCap.isAutoAssigned ? { isTempCaptain: true } : {}),
              finalScore: isCaptain ? net * 2 : net,
            };
          })
        ));
        playerScoreCache.set(fixture.awayTeamId, JSON.stringify(
          awayScores.map((s, i) => {
            const p = fixture.awayTeam.players[i];
            const net = s.points - s.transferHits;
            const isCaptain = p?.id === awayCap.captainId;
            return {
              name: p?.name ?? "",
              fplId: p?.fplId ?? "",
              fplScore: s.points,
              transferHits: s.transferHits,
              isCaptain,
              ...(isCaptain && awayCap.isAutoAssigned ? { isTempCaptain: true } : {}),
              finalScore: isCaptain ? net * 2 : net,
            };
          })
        ));

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
          homePlayerScores: playerScoreCache.get(fixture.homeTeamId) ?? null,
          awayPlayerScores: playerScoreCache.get(fixture.awayTeamId) ?? null,
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

        processedResults.push(fixture.id);
      } catch (error) {
        errors.push({
          fixtureId: fixture.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
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
          // Skip cup fixtures without a group assignment
          if (!fixture.groupId) {
            continue;
          }

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
            homePlayerScores: playerScoreCache.get(fixture.homeTeamId) ?? null,
            awayPlayerScores: playerScoreCache.get(fixture.awayTeamId) ?? null,
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

    // ============================================
    // PASS 3: UCL / UEL KNOCKOUT FIXTURES
    // ============================================
    const knockoutFixtures = gameweek.fixtures.filter(
      f => (f.competitionType === "ucl-knockout" || f.competitionType === "uel-knockout") && !f.result
    ) as FixtureWithRelations[];

    for (const fixture of knockoutFixtures) {
      try {
        // Use cached scores from Pass 1 if available, otherwise fetch fresh
        let homeTeamScore = teamScoreCache.get(fixture.homeTeamId);
        let awayTeamScore = teamScoreCache.get(fixture.awayTeamId);
        let homePlayerScoresJson = playerScoreCache.get(fixture.homeTeamId) ?? null;
        let awayPlayerScoresJson = playerScoreCache.get(fixture.awayTeamId) ?? null;

        if (homeTeamScore === undefined) {
          const homeScores = await Promise.all(
            fixture.homeTeam.players.map(async (p: Player) => {
              const score = await calculateTeamGameweekScore(p.fplId, gameweekNumber, leagueId);
              return { ...score, player: p };
            })
          );
          homeTeamScore = homeScores.reduce((sum, s) => sum + (s.points - s.transferHits), 0);
          homePlayerScoresJson = JSON.stringify(
            homeScores.map(s => ({
              name: s.player.name, fplId: s.player.fplId,
              fplScore: s.points, transferHits: s.transferHits,
              isCaptain: false, finalScore: s.points - s.transferHits,
            }))
          );
        }

        if (awayTeamScore === undefined) {
          const awayScores = await Promise.all(
            fixture.awayTeam.players.map(async (p: Player) => {
              const score = await calculateTeamGameweekScore(p.fplId, gameweekNumber, leagueId);
              return { ...score, player: p };
            })
          );
          awayTeamScore = awayScores.reduce((sum, s) => sum + (s.points - s.transferHits), 0);
          awayPlayerScoresJson = JSON.stringify(
            awayScores.map(s => ({
              name: s.player.name, fplId: s.player.fplId,
              fplScore: s.points, transferHits: s.transferHits,
              isCaptain: false, finalScore: s.points - s.transferHits,
            }))
          );
        }

        let homeMatchPoints = 0, awayMatchPoints = 0;
        if (homeTeamScore > awayTeamScore) {
          homeMatchPoints = 1; awayMatchPoints = 0;
        } else if (awayTeamScore > homeTeamScore) {
          homeMatchPoints = 0; awayMatchPoints = 1;
        } else {
          homeMatchPoints = 0; awayMatchPoints = 0; // draw — aggregate decides
        }

        const resultId = generateId();
        await db.insert(results).values({
          id: resultId,
          fixtureId: fixture.id,
          teamId: homeMatchPoints >= awayMatchPoints ? fixture.homeTeamId : fixture.awayTeamId,
          homeScore: homeTeamScore,
          awayScore: awayTeamScore,
          homeMatchPoints,
          awayMatchPoints,
          homeGotBonus: false,
          awayGotBonus: false,
          homeUsedDoublePointer: false,
          awayUsedDoublePointer: false,
          homePlayerScores: homePlayerScoresJson,
          awayPlayerScores: awayPlayerScoresJson,
        });

        processedResults.push(fixture.id);
      } catch (error) {
        errors.push({
          fixtureId: fixture.id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return {
      success: true,
      message: `Processed ${processedResults.length} fixtures`,
      processed: processedResults.length,
      errors: errors.length > 0 ? errors : undefined,
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
