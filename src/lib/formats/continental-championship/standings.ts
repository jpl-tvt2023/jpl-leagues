/**
 * Continental Championship Format Standings Computation
 * Handles PL standings (all season) and Cup group standings (GW6-24)
 */

export interface CupGroupStanding {
  teamId: string;
  name: string;
  isGhost: boolean;
  wins: number;
  draws: number;
  losses: number;
  goalFor: number;
  goalAgainst: number;
  // W=2, D=1, L=0. Draws are possible in cup-group standings: human-vs-Ghost
  // matches draw when the human's score equals the ceiling-of-4-humans average,
  // and human-vs-human cup-day fixtures use the standard H2H rule (which can
  // also draw 1+1). No bonus points in cup group.
  cupGroupPoints: number;
}

export interface CupGroupStandings {
  groupName: string;
  standings: CupGroupStanding[];
}

/**
 * Compute cup group standings from results
 * Only includes cup-group competition fixtures (GW6-24)
 * Excludes Ghost teams from standings display (but shows as opponent in fixtures)
 *
 * @param groupTeams - Array of 6 teams (5 human + 1 Ghost) in the group
 * @param results - Array of fixture results {fixtureId, homeTeamId, awayTeamId, homeScore, awayScore, homeMatchPoints, awayMatchPoints}
 * @returns Sorted standings (by cupGroupPoints, then by GF, then by GA)
 */
export function computeCupGroupStandings(
  groupTeams: Array<{ id: string; name: string; isGhost: boolean }>,
  results: Array<{
    fixtureId: string;
    homeTeamId: string;
    awayTeamId: string;
    homeScore: number;
    awayScore: number;
    homeMatchPoints: number;
    awayMatchPoints: number;
  }>
): CupGroupStanding[] {
  // Initialize standings for all teams (including Ghost for calculation)
  const standingsMap = new Map<string, CupGroupStanding>();

  for (const team of groupTeams) {
    standingsMap.set(team.id, {
      teamId: team.id,
      name: team.name,
      isGhost: team.isGhost,
      wins: 0,
      draws: 0,
      losses: 0,
      goalFor: 0,
      goalAgainst: 0,
      cupGroupPoints: 0,
    });
  }

  // Process results
  for (const result of results) {
    const homeStanding = standingsMap.get(result.homeTeamId);
    const awayStanding = standingsMap.get(result.awayTeamId);

    if (!homeStanding || !awayStanding) continue;

    homeStanding.goalFor += result.homeScore;
    homeStanding.goalAgainst += result.awayScore;
    awayStanding.goalFor += result.awayScore;
    awayStanding.goalAgainst += result.homeScore;

    // Match points (W=2, D=1, L=0)
    homeStanding.cupGroupPoints += result.homeMatchPoints;
    awayStanding.cupGroupPoints += result.awayMatchPoints;

    // Track W/D/L
    if (result.homeMatchPoints === 2) homeStanding.wins++;
    else if (result.homeMatchPoints === 1) homeStanding.draws++;
    else homeStanding.losses++;

    if (result.awayMatchPoints === 2) awayStanding.wins++;
    else if (result.awayMatchPoints === 1) awayStanding.draws++;
    else awayStanding.losses++;
  }

  // Convert map to array and sort
  const standings = Array.from(standingsMap.values());

  // Sort by: cupGroupPoints DESC, then GD (goalFor - goalAgainst) DESC, then GF DESC.
  standings.sort((a, b) => {
    if (a.cupGroupPoints !== b.cupGroupPoints) {
      return b.cupGroupPoints - a.cupGroupPoints;
    }
    const aGD = a.goalFor - a.goalAgainst;
    const bGD = b.goalFor - b.goalAgainst;
    if (aGD !== bGD) return bGD - aGD;
    return b.goalFor - a.goalFor;
  });

  return standings;
}

