import { NextRequest, NextResponse } from "next/server";
import { db, teams, fixtures, results, gameweeks, gameweekCaptains, leagues } from "@/lib/db";
import { eq, and, asc, desc } from "drizzle-orm";

function getFplTeamUrl(fplId: string, gameweek?: number): string {
  if (gameweek) {
    return `https://fantasy.premierleague.com/entry/${fplId}/event/${gameweek}`;
  }
  return `https://fantasy.premierleague.com/entry/${fplId}/history`;
}

function inferScores(total: number, players: { name: string }[]) {
  const captainBase = Math.floor((total - 1) / 3);
  const captainDoubled = captainBase * 2;
  const nonCaptainScore = total - captainDoubled;
  const sortedPlayers = [...players].sort((a, b) => a.name.localeCompare(b.name));
  return sortedPlayers.map((p, i) => ({
    name: p.name, isCaptain: i === 0,
    fplScore: i === 0 ? captainBase : nonCaptainScore,
    transferHits: 0,
    finalScore: i === 0 ? captainDoubled : nonCaptainScore,
    isInferred: true,
  }));
}

/**
 * GET /api/team/dashboard/gw-result?gw=N
 * Also supports ?cupGw=N for independent cup GW navigation.
 * Lightweight endpoint — no FPL deadline sync, no standings, no chip/captain status refresh.
 */
export async function GET(request: NextRequest) {
  try {
    const teamId = request.headers.get("x-session-id");
    if (!teamId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const url = new URL(request.url);
    const gwParam = url.searchParams.get("gw");
    const cupGwParam = url.searchParams.get("cupGw");

    if (!gwParam && !cupGwParam) {
      return NextResponse.json({ error: "gw or cupGw parameter required" }, { status: 400 });
    }
    const requestedGw = gwParam ? parseInt(gwParam, 10) : null;
    const requestedCupGw = cupGwParam ? parseInt(cupGwParam, 10) : null;

    if (requestedGw !== null && (isNaN(requestedGw) || requestedGw < 1)) {
      return NextResponse.json({ error: "Invalid gw parameter" }, { status: 400 });
    }
    if (requestedCupGw !== null && (isNaN(requestedCupGw) || requestedCupGw < 1)) {
      return NextResponse.json({ error: "Invalid cupGw parameter" }, { status: 400 });
    }

    // Get team with players
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: {
        players: true,
        homeFixtures: {
          with: {
            result: true,
            gameweek: true,
            awayTeam: { with: { players: true } },
          },
        },
        awayFixtures: {
          with: {
            result: true,
            gameweek: true,
            homeTeam: { with: { players: true } },
          },
        },
      },
    });

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    // Get league format
    const leagueRow = await db.select({ format: leagues.format }).from(leagues)
      .where(eq(leagues.id, team.leagueId)).limit(1);
    const leagueFormat = leagueRow[0]?.format ?? "tvt";

    // All completed fixtures
    const allFixtures = [...team.homeFixtures, ...team.awayFixtures].filter(f => f.result);

    // For TC: separate PL and cup fixtures
    const plFixtures = leagueFormat === "continental-championship"
      ? allFixtures.filter(f => !((f as any).competitionType) || (f as any).competitionType === "jpl")
      : allFixtures;
    const cupFixtures = leagueFormat === "continental-championship"
      ? allFixtures.filter(f => (f as any).competitionType && (f as any).competitionType !== "jpl")
      : [];

    const plFixturesSorted = plFixtures.sort((a, b) => b.gameweek.number - a.gameweek.number);

    // Min/max for cup GW navigation
    const cupGwNumbers = cupFixtures.map(f => f.gameweek.number);
    const minCompletedCupGw = cupGwNumbers.length > 0 ? Math.min(...cupGwNumbers) : null;
    const maxCompletedCupGw = cupGwNumbers.length > 0 ? Math.max(...cupGwNumbers) : null;
    const completedCupGws = [...new Set(cupGwNumbers)].sort((a, b) => a - b);

    // ---- Cup-only navigation path ----
    if (requestedCupGw !== null) {
      const cupF: any = cupFixtures.find(f => f.gameweek.number === requestedCupGw) || cupFixtures.sort((a, b) => b.gameweek.number - a.gameweek.number)[0];
      if (!cupF || !cupF.result) {
        return NextResponse.json({ cupGwResult: null, minCompletedCupGw, maxCompletedCupGw, completedCupGws });
      }
      const cupIsHome = cupF.homeTeamId === teamId;
      const cupMyScore = cupIsHome ? cupF.result.homeScore : cupF.result.awayScore;
      const cupOppScore = cupIsHome ? cupF.result.awayScore : cupF.result.homeScore;
      const cupMyPoints = cupIsHome ? cupF.result.homeMatchPoints : cupF.result.awayMatchPoints;
      const cupOpponentTeam = cupIsHome
        ? team.homeFixtures.find((f: any) => f.id === cupF.id)?.awayTeam
        : team.awayFixtures.find((f: any) => f.id === cupF.id)?.homeTeam;
      const cupCaptains = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.gameweekId, cupF.gameweek.id),
        with: { player: true },
      });
      const cupMyCaptain = cupCaptains.find((c: any) => c.player.teamId === teamId);
      const cupOppCaptain = cupOpponentTeam ? cupCaptains.find((c: any) => c.player.teamId === cupOpponentTeam.id) : null;
      let cupMyPlayerScores: any[] = [];
      let cupHasMyCaptainData = false;
      if (cupMyCaptain) {
        cupHasMyCaptainData = true;
        cupMyPlayerScores = team.players.map(p => {
          const isCaptain = cupMyCaptain.playerId === p.id;
          const fplUrl = getFplTeamUrl(p.fplId, cupF.gameweek.number);
          if (isCaptain) return { name: p.name, isCaptain: true, fplScore: cupMyCaptain.fplScore, transferHits: cupMyCaptain.transferHits, finalScore: cupMyCaptain.doubledScore, fplId: p.fplId, fplUrl };
          const nc = cupMyScore - cupMyCaptain.doubledScore;
          return { name: p.name, isCaptain: false, fplScore: nc, transferHits: 0, finalScore: nc, fplId: p.fplId, fplUrl };
        });
      } else {
        cupMyPlayerScores = team.players.map((p, i) => {
          const inf = inferScores(cupMyScore, team.players)[i];
          return { ...inf, fplId: p.fplId, fplUrl: getFplTeamUrl(p.fplId, cupF.gameweek.number) };
        });
      }
      let cupOppPlayerScores: any[] = [];
      let cupHasOppCaptainData = false;
      const oppPlayers = (cupOpponentTeam as any)?.players ?? [];
      if (cupOppCaptain && oppPlayers.length > 0) {
        cupHasOppCaptainData = true;
        cupOppPlayerScores = oppPlayers.map((p: any) => {
          const isCaptain = cupOppCaptain.playerId === p.id;
          const fplUrl = getFplTeamUrl(p.fplId, cupF.gameweek.number);
          if (isCaptain) return { name: p.name, isCaptain: true, fplScore: cupOppCaptain.fplScore, transferHits: cupOppCaptain.transferHits, finalScore: cupOppCaptain.doubledScore, fplId: p.fplId, fplUrl };
          const nc = cupOppScore - cupOppCaptain.doubledScore;
          return { name: p.name, isCaptain: false, fplScore: nc, transferHits: 0, finalScore: nc, fplId: p.fplId, fplUrl };
        });
      } else if (oppPlayers.length > 0) {
        cupOppPlayerScores = oppPlayers.map((p: any, i: number) => {
          const inf = inferScores(cupOppScore, oppPlayers)[i];
          return { ...inf, fplId: p.fplId, fplUrl: getFplTeamUrl(p.fplId, cupF.gameweek.number) };
        });
      }
      const compType = cupF.competitionType ?? "cup-group";
      return NextResponse.json({
        cupGwResult: {
          gameweek: cupF.gameweek.number, competitionType: compType,
          competitionLabel: compType === "jcl-knockout" ? "UCL" : compType === "jel-knockout" ? "Europa" : "Cup Group",
          result: cupMyPoints === 2 ? "W" : "L",
          myScore: cupMyScore, oppScore: cupOppScore, isHome: cupIsHome,
          myTeamName: team.name,
          opponent: (cupOpponentTeam as any)?.name ?? "Unknown",
          hasMyCaptainData: cupHasMyCaptainData, hasOppCaptainData: cupHasOppCaptainData,
          myPlayerScores: cupMyPlayerScores, oppPlayerScores: cupOppPlayerScores,
        },
        minCompletedCupGw, maxCompletedCupGw, completedCupGws,
      });
    }
    // ---- End cup-only path ----

    if (plFixturesSorted.length === 0) {
      return NextResponse.json({ lastGwResult: null, cupGwResult: null, minCompletedGw: null, maxCompletedGw: null, minCompletedCupGw: null, maxCompletedCupGw: null, completedCupGws: [] });
    }

    // Min/max for navigation (PL GWs)
    const completedGwNumbers = plFixturesSorted.map(f => f.gameweek.number);
    const minCompletedGw = Math.min(...completedGwNumbers);
    const maxCompletedGw = Math.max(...completedGwNumbers);

    // Find the requested PL fixture
    const lastF: any = plFixturesSorted.find(f => f.gameweek.number === requestedGw) || plFixturesSorted[0];

    const isHome = lastF.homeTeamId === teamId;
    const myScore = isHome ? lastF.result!.homeScore : lastF.result!.awayScore;
    const oppScore = isHome ? lastF.result!.awayScore : lastF.result!.homeScore;
    const myPoints = isHome ? lastF.result!.homeMatchPoints : lastF.result!.awayMatchPoints;
    const gotBonus = isHome ? lastF.result!.homeGotBonus : lastF.result!.awayGotBonus;

    let result: "W" | "D" | "L";
    if (myPoints === 2) result = "W";
    else if (myPoints === 1) result = "D";
    else result = "L";

    const opponentTeam = isHome
      ? team.homeFixtures.find(f => f.id === lastF.id)?.awayTeam
      : team.awayFixtures.find(f => f.id === lastF.id)?.homeTeam;

    // Get captain info for this gameweek
    const lastGwCaptains = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.gameweekId, lastF.gameweek.id),
      with: { player: true },
    });

    const myCaptain = lastGwCaptains.find(c => c.player.teamId === teamId);
    const oppCaptain = opponentTeam ? lastGwCaptains.find(c => c.player.teamId === opponentTeam.id) : null;

    // Build my player scores
    let myPlayerScores: any[] = [];
    let hasMyCaptainData = false;

    if (myCaptain) {
      hasMyCaptainData = true;
      myPlayerScores = team.players.map(p => {
        const isCaptain = myCaptain.playerId === p.id;
        const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
        if (isCaptain) {
          return {
            name: p.name, isCaptain: true,
            fplScore: myCaptain.fplScore, transferHits: myCaptain.transferHits,
            finalScore: myCaptain.doubledScore, fplId: p.fplId, fplUrl,
          };
        } else {
          const nonCaptainScore = myScore - myCaptain.doubledScore;
          return {
            name: p.name, isCaptain: false,
            fplScore: nonCaptainScore, transferHits: 0,
            finalScore: nonCaptainScore, fplId: p.fplId, fplUrl,
          };
        }
      });
    } else {
      myPlayerScores = team.players.map((p, i) => {
        const inferred = inferScores(myScore, team.players)[i];
        const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
        return { ...inferred, fplId: p.fplId, fplUrl };
      });
    }

    // Build opponent player scores
    let oppPlayerScores: any[] = [];
    let hasOppCaptainData = false;

    if (oppCaptain && opponentTeam) {
      hasOppCaptainData = true;
      oppPlayerScores = opponentTeam.players.map(p => {
        const isCaptain = oppCaptain.playerId === p.id;
        const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
        if (isCaptain) {
          return {
            name: p.name, isCaptain: true,
            fplScore: oppCaptain.fplScore, transferHits: oppCaptain.transferHits,
            finalScore: oppCaptain.doubledScore, fplId: p.fplId, fplUrl,
          };
        } else {
          const nonCaptainScore = oppScore - oppCaptain.doubledScore;
          return {
            name: p.name, isCaptain: false,
            fplScore: nonCaptainScore, transferHits: 0,
            finalScore: nonCaptainScore, fplId: p.fplId, fplUrl,
          };
        }
      });
    } else if (opponentTeam) {
      oppPlayerScores = opponentTeam.players.map((p, i) => {
        const inferred = inferScores(oppScore, opponentTeam.players)[i];
        const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
        return { ...inferred, fplId: p.fplId, fplUrl };
      });
    }

    const lastGwResult = {
      gameweek: lastF.gameweek.number,
      result,
      myScore,
      oppScore,
      gotBonus,
      isHome,
      myTeamName: team.name,
      opponent: opponentTeam?.name || "Unknown",
      hasMyCaptainData,
      hasOppCaptainData,
      myPlayerScores,
      oppPlayerScores,
      isPlayoff: lastF.isPlayoff || false,
      roundName: lastF.roundName || null,
      tieId: lastF.tieId || null,
      leg: lastF.leg || null,
    };

    // ============================================================
    // TC: Cup fixture for the same GW (double-header)
    // ============================================================
    let cupGwResult: any = null;
    if (leagueFormat === "continental-championship") {
      const cupF: any = cupFixtures.find(f => f.gameweek.number === lastF.gameweek.number);
      if (cupF && cupF.result) {
        const cupIsHome = cupF.homeTeamId === teamId;
        const cupMyScore = cupIsHome ? cupF.result.homeScore : cupF.result.awayScore;
        const cupOppScore = cupIsHome ? cupF.result.awayScore : cupF.result.homeScore;
        const cupMyPoints = cupIsHome ? cupF.result.homeMatchPoints : cupF.result.awayMatchPoints;
        const cupResult: "W" | "L" = cupMyPoints === 2 ? "W" : "L";

        const cupOpponentTeam = cupIsHome
          ? team.homeFixtures.find(f => f.id === cupF.id)?.awayTeam
          : team.awayFixtures.find(f => f.id === cupF.id)?.homeTeam;

        const cupGwId = cupF.gameweek.id;
        const cupCaptains = await db.query.gameweekCaptains.findMany({
          where: eq(gameweekCaptains.gameweekId, cupGwId),
          with: { player: true },
        });
        const cupMyCaptain = cupCaptains.find(c => c.player.teamId === teamId);
        const cupOppCaptain = cupOpponentTeam ? cupCaptains.find(c => c.player.teamId === cupOpponentTeam.id) : null;

        let cupMyPlayerScores: any[] = [];
        let cupHasMyCaptainData = false;
        if (cupMyCaptain) {
          cupHasMyCaptainData = true;
          cupMyPlayerScores = team.players.map(p => {
            const isCaptain = cupMyCaptain.playerId === p.id;
            const fplUrl = getFplTeamUrl(p.fplId, cupF.gameweek.number);
            if (isCaptain) {
              return { name: p.name, isCaptain: true, fplScore: cupMyCaptain.fplScore, transferHits: cupMyCaptain.transferHits, finalScore: cupMyCaptain.doubledScore, fplId: p.fplId, fplUrl };
            }
            const nonCaptainScore = cupMyScore - cupMyCaptain.doubledScore;
            return { name: p.name, isCaptain: false, fplScore: nonCaptainScore, transferHits: 0, finalScore: nonCaptainScore, fplId: p.fplId, fplUrl };
          });
        } else {
          cupMyPlayerScores = team.players.map((p, i) => {
            const inferred = inferScores(cupMyScore, team.players)[i];
            return { ...inferred, fplId: p.fplId, fplUrl: getFplTeamUrl(p.fplId, cupF.gameweek.number) };
          });
        }

        let cupOppPlayerScores: any[] = [];
        let cupHasOppCaptainData = false;
        if (cupOppCaptain && cupOpponentTeam) {
          cupHasOppCaptainData = true;
          cupOppPlayerScores = (cupOpponentTeam as any).players?.map((p: any) => {
            const isCaptain = cupOppCaptain.playerId === p.id;
            const fplUrl = getFplTeamUrl(p.fplId, cupF.gameweek.number);
            if (isCaptain) {
              return { name: p.name, isCaptain: true, fplScore: cupOppCaptain.fplScore, transferHits: cupOppCaptain.transferHits, finalScore: cupOppCaptain.doubledScore, fplId: p.fplId, fplUrl };
            }
            const nonCaptainScore = cupOppScore - cupOppCaptain.doubledScore;
            return { name: p.name, isCaptain: false, fplScore: nonCaptainScore, transferHits: 0, finalScore: nonCaptainScore, fplId: p.fplId, fplUrl };
          }) ?? [];
        } else if (cupOpponentTeam) {
          const oppPlayers = (cupOpponentTeam as any).players ?? [];
          cupOppPlayerScores = oppPlayers.map((p: any, i: number) => {
            const inferred = inferScores(cupOppScore, oppPlayers)[i];
            return { ...inferred, fplId: p.fplId, fplUrl: getFplTeamUrl(p.fplId, cupF.gameweek.number) };
          });
        }

        const compType = cupF.competitionType ?? "cup-group";
        cupGwResult = {
          gameweek: cupF.gameweek.number,
          competitionType: compType,
          competitionLabel: compType === "jcl-knockout" ? "UCL" : compType === "jel-knockout" ? "Europa" : "Cup Group",
          result: cupResult,
          myScore: cupMyScore,
          oppScore: cupOppScore,
          isHome: cupIsHome,
          myTeamName: team.name,
          opponent: (cupOpponentTeam as any)?.name ?? "Unknown",
          hasMyCaptainData: cupHasMyCaptainData,
          hasOppCaptainData: cupHasOppCaptainData,
          myPlayerScores: cupMyPlayerScores,
          oppPlayerScores: cupOppPlayerScores,
        };
      }
    }

    return NextResponse.json({ lastGwResult, cupGwResult, minCompletedGw, maxCompletedGw, minCompletedCupGw, maxCompletedCupGw, completedCupGws });
  } catch (error) {
    console.error("GW result error:", error);
    return NextResponse.json({ error: "Failed to fetch GW result" }, { status: 500 });
  }
}
