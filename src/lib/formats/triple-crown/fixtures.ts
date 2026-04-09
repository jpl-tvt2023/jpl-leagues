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

  // Circle-method round-robin for 6 teams (indices 0-4 human, 5 ghost)
  // Fix team 5 (ghost) in place, rotate teams 0-4
  // 5 rounds per rep, 2 reps = 10 matchdays
  // Round k (0-indexed): ghost vs rotating[0], rotating[1] vs rotating[4], rotating[2] vs rotating[3]
  const rotating = [0, 1, 2, 3, 4]; // team indices that rotate

  for (let rep = 0; rep < 2; rep++) {
    const rotated = [...rotating]; // reset rotation each rep
    for (let round = 0; round < 5; round++) {
      const matchdayNum = rep * 5 + round; // 0-9
      const gwNum = cupGWs[matchdayNum];

      // 3 matches per round
      const pairs: [number, number][] = [
        [5, rotated[0]],            // ghost vs first in rotation
        [rotated[1], rotated[4]],   // 2nd vs 5th
        [rotated[2], rotated[3]],   // 3rd vs 4th
      ];

      for (const [homeIdx, awayIdx] of pairs) {
        // Rep 2 reverses home/away
        const [h, a] = rep === 0 ? [homeIdx, awayIdx] : [awayIdx, homeIdx];
        const homeTeamId = h === 5 ? ghostTeamId : teams[h].id;
        const awayTeamId = a === 5 ? ghostTeamId : teams[a].id;

        fixtures.push({
          gameweekNumber: gwNum,
          homeTeamId,
          awayTeamId,
        });
      }

      // Rotate: move last element to position 1 (keep index 0 fixed is wrong — rotate all)
      // Standard circle method: fix ghost (idx 5), rotate 0-4 clockwise
      // [0,1,2,3,4] → [4,0,1,2,3] → [3,4,0,1,2] → ...
      const last = rotated.pop()!;
      rotated.splice(0, 0, last);
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
  // Row 1 (→): A=1,  B=2,  C=3,  D=4
  // Row 2 (←): A=8,  B=7,  C=6,  D=5
  // Row 3 (→): A=9,  B=10, C=11, D=12
  // Row 4 (←): A=16, B=15, C=14, D=13
  // Row 5 (→): A=17, B=18, C=19, D=20
  const groupKeys = ["groupA", "groupB", "groupC", "groupD"];

  for (let rank = 0; rank < 20; rank++) {
    const row = Math.floor(rank / 4);
    const posInRow = rank % 4;
    // Even rows go left→right (A,B,C,D), odd rows go right→left (D,C,B,A)
    const groupIdx = row % 2 === 0 ? posInRow : 3 - posInRow;
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
