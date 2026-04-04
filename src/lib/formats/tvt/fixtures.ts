// Fixture Generation Utilities
// Generates round-robin fixtures for TVT Fantasy Super League

interface TeamForFixture {
  id: string;
  name: string;
}

interface GeneratedFixture {
  homeTeamId: string;
  awayTeamId: string;
  gameweekNumber: number;
}

/**
 * Generate round-robin fixtures for a group of teams.
 *
 * @param teams - Teams in the group
 * @param repetitions - How many full round-robins to generate (default 2 = home+away).
 *   32/16-team: 2 repetitions = (N-1)*2 GWs (30 GWs for 16 teams)
 *   8-team:     5 repetitions = (7)*5 = 35 GWs
 *
 * GW numbering starts at 1 and increments across all repetitions.
 */
export function generateRoundRobinFixtures(
  teams: TeamForFixture[],
  repetitions: number = 2
): GeneratedFixture[] {
  const n = teams.length;
  if (n < 2) return [];

  const teamIds = teams.map(t => t.id);

  // If odd number of teams, add a "bye" team
  if (n % 2 !== 0) {
    teamIds.push("BYE");
  }

  const totalTeams = teamIds.length;
  const roundsPerRepetition = totalTeams - 1; // rounds in a single round-robin pass
  const matchesPerRound = totalTeams / 2;

  const fixtures: GeneratedFixture[] = [];
  let gwOffset = 0;

  for (let rep = 0; rep < repetitions; rep++) {
    // Alternate home/away in odd repetitions (1, 3, 5…) to swap sides
    const swapHomeAway = rep % 2 === 1;

    for (let round = 0; round < roundsPerRepetition; round++) {
      const gameweekNumber = gwOffset + round + 1;

      for (let match = 0; match < matchesPerRound; match++) {
        const home = (round + match) % (totalTeams - 1);
        let away = (totalTeams - 1 - match + round) % (totalTeams - 1);

        // Last team stays in place, others rotate
        if (match === 0) {
          away = totalTeams - 1;
        }

        let homeTeamId = teamIds[home];
        let awayTeamId = teamIds[away];

        // Skip "BYE" matches
        if (homeTeamId === "BYE" || awayTeamId === "BYE") continue;

        // Swap home/away for even repetitions to give each team a home leg
        if (swapHomeAway) {
          [homeTeamId, awayTeamId] = [awayTeamId, homeTeamId];
        }

        fixtures.push({ homeTeamId, awayTeamId, gameweekNumber });
      }
    }

    gwOffset += roundsPerRepetition;
  }

  return fixtures;
}

/**
 * Generate all gameweeks for the season.
 * @param playoffStartGw - First playoff gameweek (default 31). League stage = GW1 to playoffStartGw-1.
 * Total GWs always 38 (FPL season length).
 */
export function generateGameweeks(playoffStartGw: number = 31): { number: number; isPlayoffs: boolean }[] {
  const gameweeks: { number: number; isPlayoffs: boolean }[] = [];
  for (let i = 1; i <= 38; i++) {
    gameweeks.push({ number: i, isPlayoffs: i >= playoffStartGw });
  }
  return gameweeks;
}

/**
 * Check if a gameweek is in the league stage
 */
export function isLeagueStage(gameweekNumber: number, playoffStartGw: number = 31): boolean {
  return gameweekNumber >= 1 && gameweekNumber < playoffStartGw;
}

/**
 * Check if a gameweek is in the playoffs
 */
export function isPlayoffs(gameweekNumber: number, playoffStartGw: number = 31): boolean {
  return gameweekNumber >= playoffStartGw && gameweekNumber <= 38;
}
