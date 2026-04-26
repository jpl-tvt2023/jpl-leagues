/**
 * Triple Crown Format Standings Computation
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
  cupGroupPoints: number; // W=2, D=1, L=0 (no bonus in cup group)
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

  // Sort by: cupGroupPoints DESC, GF DESC, GA ASC
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

/**
 * Extract UCL and UEL bracket seeds from 4 cup group standings
 * UCL: Ranks 1-2 from each group (8 teams total)
 * UEL: Ranks 3-4 from each group (8 teams total)
 * Excludes Ghost teams
 *
 * @param groupA - Cup group A standings (sorted)
 * @param groupB - Cup group B standings (sorted)
 * @param groupC - Cup group C standings (sorted)
 * @param groupD - Cup group D standings (sorted)
 * @returns Object with {ucl: [], uel: []} team arrays
 */
export function extractBracketSeeds(
  groupA: CupGroupStanding[],
  groupB: CupGroupStanding[],
  groupC: CupGroupStanding[],
  groupD: CupGroupStanding[]
) {
  // Filter out Ghost teams and get only human teams
  const humanA = groupA.filter(t => !t.isGhost);
  const humanB = groupB.filter(t => !t.isGhost);
  const humanC = groupC.filter(t => !t.isGhost);
  const humanD = groupD.filter(t => !t.isGhost);

  // UCL: Ranks 1-2 from each group
  const ucl = [
    humanA[0], humanA[1],
    humanB[0], humanB[1],
    humanC[0], humanC[1],
    humanD[0], humanD[1],
  ];

  // UEL: Ranks 3-4 from each group
  const uel = [
    humanA[2], humanA[3],
    humanB[2], humanB[3],
    humanC[2], humanC[3],
    humanD[2], humanD[3],
  ];

  return { ucl, uel };
}
