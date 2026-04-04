/**
 * Triple Crown Format Fixture Generation
 * Handles PL (all-season H2H) and Cup group stage fixtures
 */

/**
 * Generate PL (Premier League) fixtures for Triple Crown
 * All 20 teams play each other twice (2 repetitions) across all 38 GWs
 *
 * @param teams - Array of 20 teams {id, name}
 * @returns Array of fixtures {gameweekNumber, homeTeamId, awayTeamId}
 */
export function generatePLFixtures(teams: Array<{ id: string; name: string }>) {
  if (teams.length !== 20) {
    throw new Error(`PL fixtures require exactly 20 teams, got ${teams.length}`);
  }

  const fixtures: Array<{ gameweekNumber: number; homeTeamId: string; awayTeamId: string }> = [];

  // Round-robin with 2 repetitions (Berger table algorithm)
  // 20 teams = 19 rounds per repetition (total 38 GWs)
  for (let rep = 1; rep <= 2; rep++) {
    for (let round = 1; round <= 19; round++) {
      const gwNum = (rep - 1) * 19 + round; // GW1-19 (rep 1), GW20-38 (rep 2)

      // Berger table pairing
      for (let i = 0; i < 10; i++) {
        let homeIdx: number;
        let awayIdx: number;

        if (round <= 10) {
          const offset = round - 1;
          homeIdx = (i + offset) % 19;
          awayIdx = (19 - i - offset) % 19;
        } else {
          const offset = round - 11;
          awayIdx = (i + offset) % 19;
          homeIdx = (19 - i - offset) % 19;
        }

        // Team 20 always plays against the rotated pair
        if (i === 0) {
          homeIdx = 19; // Team 20
          awayIdx = (round - 1) % 19;
        }

        if (homeIdx !== awayIdx) {
          fixtures.push({
            gameweekNumber: gwNum,
            homeTeamId: teams[homeIdx].id,
            awayTeamId: teams[awayIdx].id,
          });
        }
      }
    }
  }

  return fixtures;
}

/**
 * Generate cup group stage fixtures for Triple Crown
 * Each cup group: 5 human teams + 1 Ghost team (6 total)
 * Round-robin with 2 repetitions = 10 matchdays
 * Each human team plays: 8 human matches + 2 Ghost matches = 10 total
 *
 * Cup GWs: 6, 8, 10, 12, 14, 16, 18, 20, 22, 24 (10 matchdays on even GWs)
 *
 * @param teams - Array of 6 teams {id, name} (5 human + 1 Ghost)
 * @param ghostTeamId - ID of the Ghost team (6th team)
 * @returns Array of fixtures {gameweekNumber, homeTeamId, awayTeamId}
 */
export function generateCupGroupFixtures(
  teams: Array<{ id: string; name: string }>,
  ghostTeamId: string
) {
  if (teams.length !== 6) {
    throw new Error(`Cup group fixtures require exactly 6 teams (5 human + 1 Ghost), got ${teams.length}`);
  }

  const cupGWs = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24]; // 10 matchdays
  const fixtures: Array<{ gameweekNumber: number; homeTeamId: string; awayTeamId: string }> = [];

  // Round-robin with 2 repetitions (10 matchdays total)
  for (let rep = 1; rep <= 2; rep++) {
    for (let round = 1; round <= 5; round++) {
      const matchdayNum = (rep - 1) * 5 + round; // 1-10
      const gwNum = cupGWs[matchdayNum - 1];

      // Berger table pairing for 6 teams (3 matches per round)
      for (let i = 0; i < 3; i++) {
        let homeIdx: number;
        let awayIdx: number;

        if (round <= 3) {
          const offset = round - 1;
          homeIdx = (i + offset) % 5;
          awayIdx = (5 - i - offset) % 5;
        } else {
          const offset = round - 4;
          awayIdx = (i + offset) % 5;
          homeIdx = (5 - i - offset) % 5;
        }

        // Team 6 (Ghost) plays against the rotated pair
        if (i === 0) {
          homeIdx = 5; // Ghost
          awayIdx = (round - 1) % 5;
        }

        if (homeIdx !== awayIdx) {
          const homeTeamId = homeIdx === 5 ? ghostTeamId : teams[homeIdx].id;
          const awayTeamId = awayIdx === 5 ? ghostTeamId : teams[awayIdx].id;

          fixtures.push({
            gameweekNumber: gwNum,
            homeTeamId,
            awayTeamId,
          });
        }
      }
    }
  }

  return fixtures;
}

/**
 * Cup group seeding algorithm (snake distribution)
 * After GW5: rank top 20 PL teams by leaguePoints
 * Distribute into 4 groups (A/B/C/D) with 5 teams each using snake pattern
 *
 * Snake pattern example (ranks 1-20):
 *   Group A: 1,  8,  9,  16, 17
 *   Group B: 2,  7,  10, 15, 18
 *   Group C: 3,  6,  11, 14, 19
 *   Group D: 4,  5,  12, 13, 20
 *
 * @param rankedTeams - Array of 20 teams sorted by leaguePoints (descending)
 * @returns Object with 4 groups: { groupA: teams, groupB: teams, groupC: teams, groupD: teams }
 */
export function seedCupGroups(
  rankedTeams: Array<{ id: string; name: string }>
) {
  if (rankedTeams.length !== 20) {
    throw new Error(`Cup group seeding requires exactly 20 teams, got ${rankedTeams.length}`);
  }

  const groups: Record<string, typeof rankedTeams> = {
    groupA: [],
    groupB: [],
    groupC: [],
    groupD: [],
  };

  // Snake distribution (zig-zag pattern)
  const groupKeys = ["groupA", "groupB", "groupC", "groupD"];

  for (let rank = 0; rank < 20; rank++) {
    const groupIdx = rank % 4;
    const groupKey = groupKeys[groupIdx];
    groups[groupKey].push(rankedTeams[rank]);
  }

  return groups as {
    groupA: typeof rankedTeams;
    groupB: typeof rankedTeams;
    groupC: typeof rankedTeams;
    groupD: typeof rankedTeams;
  };
}
