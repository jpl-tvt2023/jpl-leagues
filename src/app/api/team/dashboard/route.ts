import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups, fixtures, results, gameweeks, gameweekCaptains, gameweekChips, settings, leagues } from "@/lib/db";
import { eq, and, gt, asc, desc, or } from "drizzle-orm";
import { fetchBootstrapData } from "@/lib/fpl";
import { getTop2FromGroup } from "@/lib/formats/tvt/chip-validation";
import { getChipSet } from "@/lib/formats/tvt/scoring";
import { computeCupGroupStandings } from "@/lib/formats/triple-crown/standings";
import { auctionOwnership, auctionScores, auctionSessions } from "@/lib/db/schema";
import { calculatePurse } from "@/lib/formats/auction/economy";

const DOUBLE_HEADER_GWS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 27, 29, 33, 35, 38];

// ⚠️ TEST OVERRIDE: set to null to use live GW detection
const TEST_GW_OVERRIDE: number | null = null;

// Generate FPL Team URL
function getFplTeamUrl(fplId: string, gameweek?: number): string {
  if (gameweek) {
    return `https://fantasy.premierleague.com/entry/${fplId}/event/${gameweek}`;
  }
  return `https://fantasy.premierleague.com/entry/${fplId}/history`;
}

async function getAnnouncementSettings(leagueId: string) {
  const captainSetting = await db.select().from(settings)
    .where(and(eq(settings.key, "captainAnnouncementEnabled"), eq(settings.leagueId, leagueId)))
    .limit(1);
  const chipSetting = await db.select().from(settings)
    .where(and(eq(settings.key, "chipAnnouncementEnabled"), eq(settings.leagueId, leagueId)))
    .limit(1);
  return {
    captainAnnouncementEnabled: captainSetting.length === 0 || captainSetting[0].value !== "false",
    chipAnnouncementEnabled: chipSetting.length === 0 || chipSetting[0].value !== "false",
  };
}

/**
 * GET /api/team/dashboard
 * Get personalized dashboard data for the logged-in team
 */
export async function GET(request: NextRequest) {
  try {
    // Check if team is logged in
    const teamId = request.headers.get("x-session-id");
    if (!teamId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // --- FPL API: Sync deadlines for this team's league gameweeks ---
    // Get team's leagueId for scoped deadline sync
    const teamBasic = await db.select({ leagueId: teams.leagueId }).from(teams).where(eq(teams.id, teamId)).limit(1);
    const teamLeagueId = teamBasic[0]?.leagueId;
    const leagueSlugRow = teamLeagueId
      ? await db.select({ slug: leagues.slug, groupCount: leagues.groupCount, format: leagues.format }).from(leagues).where(eq(leagues.id, teamLeagueId)).limit(1)
      : [];
    const leagueSlug = leagueSlugRow[0]?.slug ?? "";
    const leagueGroupCount = leagueSlugRow[0]?.groupCount ?? 1;
    const leagueFormat = leagueSlugRow[0]?.format ?? "tvt";

    // ===== Auction format: separate dashboard payload =====
    if (leagueFormat === "auction" && teamLeagueId) {
      return await getAuctionDashboard(teamId, teamLeagueId, leagueSlug);
    }

    if (teamLeagueId) {
      try {
        const fplData = await fetchBootstrapData();
        if (fplData && Array.isArray(fplData.events)) {
          for (const event of fplData.events) {
            const deadline = event.deadline_time ? new Date(event.deadline_time) : new Date('2099-12-31T23:59:59Z');
            await db.update(gameweeks)
              .set({ deadline })
              .where(and(eq(gameweeks.leagueId, teamLeagueId), eq(gameweeks.number, event.id)));
          }
        }
      } catch (err) {
        console.error("Failed to sync FPL deadlines:", err);
      }
    }

    // Get team with all relations
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: {
        group: true,
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

    // Get GW param from query string
    const url = new URL(request.url);
    const gwParam = url.searchParams.get("gw");
    const requestedGw = gwParam ? parseInt(gwParam, 10) : undefined;

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    // Get all gameweeks ordered by number
    const allGameweeks = await db.query.gameweeks.findMany({
      orderBy: [asc(gameweeks.number)],
    });

    // Combine all fixtures for this team
    const allTeamFixtures = [...team.homeFixtures, ...team.awayFixtures];

    // For TC: separate PL vs cup fixtures. For TVT: all fixtures are PL.
    const plTeamFixtures = leagueFormat === "triple-crown"
      ? allTeamFixtures.filter(f => (f as any).competitionType === "pl" || !(f as any).competitionType)
      : allTeamFixtures;
    const cupTeamFixtures = leagueFormat === "triple-crown"
      ? allTeamFixtures.filter(f =>
          (f as any).competitionType === "cup-group" ||
          (f as any).competitionType === "ucl-knockout" ||
          (f as any).competitionType === "uel-knockout"
        )
      : [];

    // Find the latest GW that has a result (current/completed GW) — PL fixtures only for TC
    const completedGWs = plTeamFixtures
      .filter(f => f.result)
      .map(f => f.gameweek.number);
    const latestCompletedGW = TEST_GW_OVERRIDE !== null
      ? TEST_GW_OVERRIDE - 1
      : (completedGWs.length > 0 ? Math.max(...completedGWs) : 0);
    
    // Find the next gameweek after the latest completed GW (for deadline)
    const nextGameweek = allGameweeks.find(gw => gw.number === latestCompletedGW + 1) || null;
    // For FPL links, still use the next GW number (if exists), else latestCompletedGW + 1
    const currentGwNumber = nextGameweek?.number || (latestCompletedGW + 1);

    // ============================================
    // UPCOMING FIXTURE
    // ============================================
    let upcomingFixture = null;
    if (nextGameweek) {
      const homeFixture = team.homeFixtures.find(f => f.gameweek.id === nextGameweek.id);
      const awayFixture = team.awayFixtures.find(f => f.gameweek.id === nextGameweek.id);
      if (homeFixture) {
        upcomingFixture = {
          isHome: true,
          opponent: {
            id: homeFixture.awayTeam.id,
            name: homeFixture.awayTeam.name,
            abbreviation: homeFixture.awayTeam.abbreviation,
            players: homeFixture.awayTeam.players.map(p => ({
              name: p.name,
              fplId: p.fplId,
              fplUrl: getFplTeamUrl(p.fplId, latestCompletedGW || undefined),
            })),
          },
          gameweek: nextGameweek.number,
          lastCompletedGw: latestCompletedGW,
        };
      } else if (awayFixture) {
        upcomingFixture = {
          isHome: false,
          opponent: {
            id: awayFixture.homeTeam.id,
            name: awayFixture.homeTeam.name,
            abbreviation: awayFixture.homeTeam.abbreviation,
            players: awayFixture.homeTeam.players.map(p => ({
              name: p.name,
              fplId: p.fplId,
              fplUrl: getFplTeamUrl(p.fplId, latestCompletedGW || undefined),
            })),
          },
          gameweek: nextGameweek.number,
          lastCompletedGw: latestCompletedGW,
        };
      }
    } else {
      upcomingFixture = null;
    }

    // ============================================
    // RECENT FORM (Last 5 PL results)
    // ============================================
    const allFixtures = plTeamFixtures
      .filter(f => f.result)
      .sort((a, b) => b.gameweek.number - a.gameweek.number);

    // ============================================
    // LAST GW RESULT (most recent completed PL fixture, or requested GW)
    // ============================================
    // Helper to infer scores when no captain data available
    const inferScores = (total: number, players: { name: string }[]) => {
      const captainBase = Math.floor((total - 1) / 3);
      const captainDoubled = captainBase * 2;
      const nonCaptainScore = total - captainDoubled;
      const sortedPlayers = [...players].sort((a, b) => a.name.localeCompare(b.name));
      return sortedPlayers.map((p, i) => ({
        name: p.name,
        isCaptain: i === 0,
        fplScore: i === 0 ? captainBase : nonCaptainScore,
        transferHits: 0,
        finalScore: i === 0 ? captainDoubled : nonCaptainScore,
        isInferred: true,
      }));
    };

    let lastGwResult = null;
    let lastF: any = null;
    if (allFixtures.length > 0) {
      if (requestedGw) {
        lastF = allFixtures.find(f => f.gameweek.number === requestedGw) || allFixtures[0];
      } else {
        lastF = allFixtures[0];
      }
      const isHome = lastF.homeTeamId === teamId;
      const myScore = isHome ? lastF.result!.homeScore : lastF.result!.awayScore;
      const oppScore = isHome ? lastF.result!.awayScore : lastF.result!.homeScore;
      const myPoints = isHome ? lastF.result!.homeMatchPoints : lastF.result!.awayMatchPoints;
      const gotBonus = isHome ? lastF.result!.homeGotBonus : lastF.result!.awayGotBonus;
      
      let result: "W" | "D" | "L";
      if (myPoints === 2) result = "W";
      else if (myPoints === 1) result = "D";
      else result = "L";
      
      // Get opponent info
      const opponentTeam = isHome 
        ? team.homeFixtures.find(f => f.id === lastF.id)?.awayTeam
        : team.awayFixtures.find(f => f.id === lastF.id)?.homeTeam;
      
      // Get captain info for this gameweek
      const lastGwCaptains = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.gameweekId, lastF.gameweek.id),
        with: { player: true },
      });
      
      // Find captain for my team
      const myCaptain = lastGwCaptains.find(c => c.player.teamId === teamId);
      const oppCaptain = opponentTeam ? lastGwCaptains.find(c => c.player.teamId === opponentTeam.id) : null;
      
      // Build player scores for my team
      let myPlayerScores: { name: string; isCaptain: boolean; fplScore: number; transferHits: number; finalScore: number; isInferred?: boolean; fplId?: string; fplUrl?: string }[] = [];
      let hasMyCaptainData = false;
      
      if (myCaptain) {
        hasMyCaptainData = true;
        myPlayerScores = team.players.map(p => {
          const isCaptain = myCaptain.playerId === p.id;
          const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
          if (isCaptain) {
            return {
              name: p.name,
              isCaptain: true,
              fplScore: myCaptain.fplScore,
              transferHits: myCaptain.transferHits,
              finalScore: myCaptain.doubledScore,
              fplId: p.fplId,
              fplUrl,
            };
          } else {
            // Non-captain score = total - captain's doubled score
            const nonCaptainScore = myScore - myCaptain.doubledScore;
            return {
              name: p.name,
              isCaptain: false,
              fplScore: nonCaptainScore,
              transferHits: 0,
              finalScore: nonCaptainScore,
              fplId: p.fplId,
              fplUrl,
            };
          }
        });
      } else {
        // No captain data - infer scores
        myPlayerScores = team.players.map((p, i) => {
          const inferred = inferScores(myScore, team.players)[i];
          const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
          return {
            ...inferred,
            fplId: p.fplId,
            fplUrl,
          };
        });
      }
      
      // Build player scores for opponent team
      let oppPlayerScores: { name: string; isCaptain: boolean; fplScore: number; transferHits: number; finalScore: number; isInferred?: boolean; fplId?: string; fplUrl?: string }[] = [];
      let hasOppCaptainData = false;
      
      if (oppCaptain && opponentTeam) {
        hasOppCaptainData = true;
        oppPlayerScores = opponentTeam.players.map(p => {
          const isCaptain = oppCaptain.playerId === p.id;
          const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
          if (isCaptain) {
            return {
              name: p.name,
              isCaptain: true,
              fplScore: oppCaptain.fplScore,
              transferHits: oppCaptain.transferHits,
              finalScore: oppCaptain.doubledScore,
              fplId: p.fplId,
              fplUrl,
            };
          } else {
            const nonCaptainScore = oppScore - oppCaptain.doubledScore;
            return {
              name: p.name,
              isCaptain: false,
              fplScore: nonCaptainScore,
              transferHits: 0,
              finalScore: nonCaptainScore,
              fplId: p.fplId,
              fplUrl,
            };
          }
        });
      } else if (opponentTeam) {
        // No captain data - infer scores
        oppPlayerScores = opponentTeam.players.map((p, i) => {
          const inferred = inferScores(oppScore, opponentTeam.players)[i];
          const fplUrl = getFplTeamUrl(p.fplId, lastF.gameweek.number);
          return {
            ...inferred,
            fplId: p.fplId,
            fplUrl,
          };
        });
      }
      
      lastGwResult = {
        gameweek: lastF.gameweek.number,
        result,
        myScore,
        oppScore,
        gotBonus,
        isHome,
        myTeamName: team.name,
        myTeamAbbr: team.abbreviation,
        opponent: opponentTeam?.name || "Unknown",
        opponentAbbr: opponentTeam?.abbreviation || "??",
        hasMyCaptainData,
        hasOppCaptainData,
        myPlayerScores,
        oppPlayerScores,
        isPlayoff: lastF.isPlayoff || false,
        roundName: lastF.roundName || null,
        tieId: lastF.tieId || null,
        leg: lastF.leg || null,
      };
    }
    
    const recentForm = allFixtures.slice(0, 5).map(f => {
      const isHome = f.homeTeamId === teamId;
      const myScore = isHome ? f.result!.homeScore : f.result!.awayScore;
      const oppScore = isHome ? f.result!.awayScore : f.result!.homeScore;
      const myPoints = isHome ? f.result!.homeMatchPoints : f.result!.awayMatchPoints;
      
      let result: "W" | "D" | "L";
      if (myPoints === 2) result = "W";
      else if (myPoints === 1) result = "D";
      else result = "L";
      
      return {
        gameweek: f.gameweek.number,
        result,
        score: `${myScore}-${oppScore}`,
        gotBonus: isHome ? f.result!.homeGotBonus : f.result!.awayGotBonus,
      };
    });

    // ============================================
    // SEASON STATS
    // ============================================
    let totalWins = 0, totalDraws = 0, totalLosses = 0;
    let totalPointsFor = 0, totalPointsAgainst = 0;
    let bonusPointsEarned = 0;
    
    for (const f of allFixtures) {
      const isHome = f.homeTeamId === teamId;
      const myPoints = isHome ? f.result!.homeMatchPoints : f.result!.awayMatchPoints;
      const myScore = isHome ? f.result!.homeScore : f.result!.awayScore;
      const oppScore = isHome ? f.result!.awayScore : f.result!.homeScore;
      const gotBonus = isHome ? f.result!.homeGotBonus : f.result!.awayGotBonus;
      
      if (myPoints === 2) totalWins++;
      else if (myPoints === 1) totalDraws++;
      else totalLosses++;
      
      totalPointsFor += myScore;
      totalPointsAgainst += oppScore;
      if (gotBonus) bonusPointsEarned++;
    }

    // Get chip points
    const teamChips = await db.query.gameweekChips.findMany({
      where: and(
        eq(gameweekChips.teamId, teamId),
        eq(gameweekChips.isProcessed, true)
      ),
    });
    const chipPointsEarned = teamChips.reduce((sum, c) => sum + (c.pointsAwarded || 0), 0);

    // ============================================
    // CHIP STATUS
    // ============================================
    const chipSet = nextGameweek ? getChipSet(nextGameweek.number) : 1;
    
    const chipStatus = {
      currentSet: chipSet,
      set1: {
        doublePointer: { used: team.doublePointerSet1Used, name: "Double Pointer" },
        challengeChip: { used: team.challengeChipSet1Used, name: "Challenge Chip" },
        winWin: { used: team.winWinSet1Used, name: "Win-Win" },
      },
      set2: {
        doublePointer: { used: team.doublePointerSet2Used, name: "Double Pointer" },
        challengeChip: { used: team.challengeChipSet2Used, name: "Challenge Chip" },
        winWin: { used: team.winWinSet2Used, name: "Win-Win" },
      },
    };

    // ============================================
    // CAPTAINCY STATUS
    // ============================================
    const captainHistory = await db.query.gameweekCaptains.findMany({
      where: or(
        eq(gameweekCaptains.playerId, team.players[0]?.id || ""),
        eq(gameweekCaptains.playerId, team.players[1]?.id || "")
      ),
      with: {
        gameweek: true,
        player: true,
      },
      orderBy: [desc(gameweekCaptains.createdAt)],
    });
    
    // Count actual captain announcements per player (within the league stage GW range)
    const captainCheckLimit = leagueFormat === "triple-crown" ? 38 : 30;
    const player1CaptainCount = captainHistory.filter(
      c => c.playerId === team.players[0]?.id && c.gameweek.number <= captainCheckLimit
    ).length;
    const player2CaptainCount = captainHistory.filter(
      c => c.playerId === team.players[1]?.id && c.gameweek.number <= captainCheckLimit
    ).length;

    const CAPTAIN_CAP = leagueFormat === "triple-crown" ? 19 : 15;
    const isPlayoffPhase = leagueFormat === "triple-crown" ? false : (nextGameweek?.number || 0) > 30;

    const captaincyStatus = {
      player1: {
        id: team.players[0]?.id || "",
        name: team.players[0]?.name || "",
        chipsUsed: player1CaptainCount,
        chipsRemaining: isPlayoffPhase ? 999 : CAPTAIN_CAP - player1CaptainCount,
      },
      player2: {
        id: team.players[1]?.id || "",
        name: team.players[1]?.name || "",
        chipsUsed: player2CaptainCount,
        chipsRemaining: isPlayoffPhase ? 999 : CAPTAIN_CAP - player2CaptainCount,
      },
      recentCaptains: [...captainHistory]
        .sort((a, b) => b.gameweek.number - a.gameweek.number)
        .map(c => ({
          gameweek: c.gameweek.number,
          playerName: c.player.name,
          score: c.doubledScore,
        })),
    };

    // Check if captain is submitted for upcoming GW — return details for switching UI
    let upcomingCaptain: { playerId: string; playerName: string } | null = null;
    if (nextGameweek) {
      const existingCaptain = captainHistory.find(c => c.gameweek.id === nextGameweek.id);
      if (existingCaptain) {
        upcomingCaptain = {
          playerId: existingCaptain.player.id,
          playerName: existingCaptain.player.name,
        };
      }
    }
    
    // Get upcoming chip submission for this team
    let upcomingChip = null;
    if (nextGameweek) {
      const upcomingChipSubmission = await db.query.gameweekChips.findFirst({
        where: and(
          eq(gameweekChips.teamId, teamId),
          eq(gameweekChips.gameweekId, nextGameweek.id)
        ),
      });
      if (upcomingChipSubmission) {
        upcomingChip = {
          type: upcomingChipSubmission.chipType,
          chipName: upcomingChipSubmission.chipType === "D" ? "Double Pointer" 
            : upcomingChipSubmission.chipType === "C" ? "Challenge Chip" 
            : "Win-Win",
        };
      }
    }

    // ============================================
    // LEAGUE POSITION
    // ============================================
    let groupRank = 0;
    let pointsToTop = 0;
    let zone: "playoffs" | "challenger" | "eliminated" = "eliminated";
    let miniTable: Array<{ rank: number; name: string; points: number; isCurrentTeam: boolean }> = [];

    if (team.groupId) {
      // Get all teams in same group for ranking
      const groupTeams = await db.query.teams.findMany({
        where: eq(teams.groupId, team.groupId),
        with: {
          homeFixtures: { with: { result: true } },
          awayFixtures: { with: { result: true } },
        },
      });

      // Calculate standings
      const standings = groupTeams.map(t => {
        let pts = t.leaguePoints;
        let wins = 0;

        [...t.homeFixtures, ...t.awayFixtures].forEach(f => {
          if (f.result) {
            const isHome = f.homeTeamId === t.id;
            const matchPts = isHome ? f.result.homeMatchPoints : f.result.awayMatchPoints;
            if (matchPts === 2) wins++;
          }
        });

        return { id: t.id, name: t.name, points: pts, wins };
      }).sort((a, b) => {
        if (a.points !== b.points) return b.points - a.points;
        return b.wins - a.wins;
      });

      groupRank = standings.findIndex(t => t.id === teamId) + 1;
      pointsToTop = standings[0]?.points - team.leaguePoints || 0;

      // Determine zone
      zone = "playoffs";
      if (groupRank > 8) zone = "challenger";
      if (groupRank > 14) zone = "eliminated";

      // Mini table (2 above, current, 2 below)
      const myIndex = standings.findIndex(t => t.id === teamId);
      miniTable = standings.slice(
        Math.max(0, myIndex - 2),
        Math.min(standings.length, myIndex + 3)
      ).map((t, i) => ({
        rank: standings.indexOf(t) + 1,
        name: t.name,
        points: t.points,
        isCurrentTeam: t.id === teamId,
      }));
    }

    // ============================================
    // NEXT 5 PL FIXTURES
    // ============================================
    const plHomeFixtures = leagueFormat === "triple-crown"
      ? team.homeFixtures.filter(f => !(f as any).competitionType || (f as any).competitionType === "pl")
      : team.homeFixtures;
    const plAwayFixtures = leagueFormat === "triple-crown"
      ? team.awayFixtures.filter(f => !(f as any).competitionType || (f as any).competitionType === "pl")
      : team.awayFixtures;

    const upcomingHomeFixtures = plHomeFixtures
      .filter(f => !f.result)
      .map(f => ({
        gameweek: f.gameweek.number,
        opponent: f.awayTeam.name,
        isHome: true,
        competitionType: "pl" as string,
        competitionLabel: "PL",
      }));
    const upcomingAwayFixtures = plAwayFixtures
      .filter(f => !f.result)
      .map(f => ({
        gameweek: f.gameweek.number,
        opponent: f.homeTeam.name,
        isHome: false,
        competitionType: "pl" as string,
        competitionLabel: "PL",
      }));
    const upcomingPlFixtures = [...upcomingHomeFixtures, ...upcomingAwayFixtures]
      .sort((a, b) => a.gameweek - b.gameweek)
      .slice(0, 5);

    // For TC: interleave cup fixtures after PL fixture for same GW
    let upcomingFixtures = upcomingPlFixtures;
    if (leagueFormat === "triple-crown") {
      const upcomingCupRows = cupTeamFixtures
        .filter(f => !f.result)
        .sort((a, b) => a.gameweek.number - b.gameweek.number)
        .map(f => {
          const isHome = f.homeTeamId === teamId;
          // homeFixtures have awayTeam; awayFixtures have homeTeam
          const opponent = isHome
            ? ((f as any).awayTeam?.name ?? "TBD")
            : ((f as any).homeTeam?.name ?? "TBD");
          return {
            gameweek: f.gameweek.number,
            opponent,
            isHome,
            competitionType: f.competitionType ?? "cup-group",
            competitionLabel: f.competitionType === "ucl-knockout" ? "UCL" : f.competitionType === "uel-knockout" ? "Europa" : "Cup",
          };
        });

      // Build merged list: for each PL fixture, append cup fixture for same GW if exists
      const merged: typeof upcomingPlFixtures = [];
      for (const plF of upcomingPlFixtures) {
        merged.push(plF);
        const cupF = upcomingCupRows.find(c => c.gameweek === plF.gameweek);
        if (cupF) merged.push(cupF);
      }
      // Also include any cup fixtures on GWs not in the PL top-5 (e.g. standalone knockout GWs)
      for (const cupF of upcomingCupRows) {
        if (!merged.find(m => m.gameweek === cupF.gameweek && m.competitionType !== "pl")) {
          if (!upcomingPlFixtures.find(p => p.gameweek === cupF.gameweek)) {
            merged.push(cupF);
          }
        }
      }
      upcomingFixtures = merged.sort((a, b) => a.gameweek - b.gameweek || (a.competitionType === "pl" ? -1 : 1));
    }

    // ============================================
    // TEAM MEMBERS
    // ============================================
    const teamMembers = team.players.map(p => ({
      name: p.name,
      fplId: p.fplId,
      fplUrl: getFplTeamUrl(p.fplId, currentGwNumber || undefined),
      fplHistoryUrl: getFplTeamUrl(p.fplId),
      captaincyChipsUsed: p.captaincyChipsUsed,
    }));

    // ============================================
    // HIGHEST / LOWEST SCORING GW
    // ============================================
    let highestGw: { gameweek: number; score: number; opponent?: string; opponentAbbr?: string } | null = null;
    let lowestGw: { gameweek: number; score: number; opponent?: string; opponentAbbr?: string } | null = null;

    // Only consider fixtures from gameweeks strictly before the latest completed GW (ignore current and upcoming)
    const concludedFixtures = allFixtures.filter(f =>
      f.gameweek.number < latestCompletedGW
    );

    for (const f of concludedFixtures) {
      const isHome = f.homeTeamId === teamId;
      const myScore = isHome ? f.result!.homeScore : f.result!.awayScore;
      const oppTeam = isHome ? (f as any).awayTeam : (f as any).homeTeam;
      const opponent = oppTeam?.name as string | undefined;
      const opponentAbbr = oppTeam?.abbreviation as string | undefined;
      if (!highestGw || myScore > highestGw.score) {
        highestGw = { gameweek: f.gameweek.number, score: myScore, opponent, opponentAbbr };
      }
      if (!lowestGw || myScore < lowestGw.score) {
        lowestGw = { gameweek: f.gameweek.number, score: myScore, opponent, opponentAbbr };
      }
    }

    // Calculate win streak
    let currentStreak = 0;
    let streakType: "W" | "D" | "L" | null = null;
    for (const f of recentForm) {
      if (streakType === null) {
        streakType = f.result;
        currentStreak = 1;
      } else if (f.result === streakType) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Find min/max completed GW for navigation
    const completedGwNumbers = allFixtures.map(f => f.gameweek.number);
    const minCompletedGw = completedGwNumbers.length > 0 ? Math.min(...completedGwNumbers) : null;
    const maxCompletedGw = completedGwNumbers.length > 0 ? Math.max(...completedGwNumbers) : null;

    // ============================================
    // OPPOSITE GROUP TOP-2 (for Challenge Chip target selection)
    // ============================================
    let oppositeGroupTeams: { id: string; name: string; abbreviation: string }[] = [];
    try {
      const allGroups = await db.query.groups.findMany();
      const oppositeGroup = allGroups.find(g => g.id !== team.groupId);
      if (oppositeGroup && currentGwNumber) {
        const top2 = await getTop2FromGroup(oppositeGroup.id, currentGwNumber);
        const top2Ids = top2.map(t => t.teamId);
        const top2Teams = await db.query.teams.findMany();
        oppositeGroupTeams = top2Teams
          .filter(t => top2Ids.includes(t.id))
          .sort((a, b) => top2Ids.indexOf(a.id) - top2Ids.indexOf(b.id))
          .map(t => ({ id: t.id, name: t.name, abbreviation: t.abbreviation }));
      }
    } catch {
      // Non-critical — leave empty if standings not yet available
    }

    // ============================================
    // TC: PL RANK (all 20 non-ghost teams)
    // ============================================
    let plPosition: { rank: number; totalTeams: number } | null = null;
    let allNonGhostSorted: { id: string; name: string; leaguePoints: number }[] = [];
    if (leagueFormat === "triple-crown" && teamLeagueId) {
      try {
        const allNonGhost = await db.select({ id: teams.id, name: teams.name, leaguePoints: teams.leaguePoints })
          .from(teams)
          .where(and(eq(teams.leagueId, teamLeagueId), eq(teams.isGhost, false)));
        allNonGhost.sort((a, b) => b.leaguePoints - a.leaguePoints);
        allNonGhostSorted = allNonGhost;
        const plRank = allNonGhost.findIndex(t => t.id === teamId) + 1;
        plPosition = { rank: plRank, totalTeams: allNonGhost.length };

        // Override miniTable to use all 20 league teams (not cup-group subset)
        const myIdx = allNonGhost.findIndex(t => t.id === teamId);
        miniTable = allNonGhost.slice(
          Math.max(0, myIdx - 2),
          Math.min(allNonGhost.length, myIdx + 3)
        ).map(t => ({
          rank: allNonGhost.indexOf(t) + 1,
          name: t.name,
          points: t.leaguePoints,
          isCurrentTeam: t.id === teamId,
        }));
        groupRank = myIdx + 1;
      } catch {
        // non-critical
      }
    }

    // ============================================
    // TC: CUP GROUP PROGRESS
    // ============================================
    let cupProgress: {
      groupName: string;
      rank: number;
      totalTeams: number;
      cupZone: "ucl" | "uel";
      minCompletedCupGw: number | null;
      maxCompletedCupGw: number | null;
      completedCupGws: number[];
      miniTable: { rank: number; name: string; wins: number; losses: number; cupGroupPoints: number; isCurrentTeam: boolean }[];
      lastCupResult: {
        gameweek: number;
        competitionType: string;
        competitionLabel: string;
        opponent: string;
        opponentAbbr: string;
        isHome: boolean;
        myScore: number;
        oppScore: number;
        result: "W" | "L";
        myPlayerScores: any[];
        oppPlayerScores: any[];
        hasMyCaptainData: boolean;
        hasOppCaptainData: boolean;
      } | null;
      upcomingCupFixture: {
        gameweek: number;
        competitionType: string;
        competitionLabel: string;
        opponent: string;
        isHome: boolean;
        isDoubleHeader: boolean;
      } | null;
    } | null = null;

    if (leagueFormat === "triple-crown" && team.groupId) {
      try {
        const cupGroupTeams = await db.select().from(teams).where(eq(teams.groupId, team.groupId));
        const cupGroupFixtures = await db.query.fixtures.findMany({
          where: and(eq(fixtures.groupId, team.groupId), eq(fixtures.competitionType, "cup-group")),
          with: {
            result: true,
            homeTeam: true,
            awayTeam: true,
          },
        });
        const fixtureResults = cupGroupFixtures.filter(f => f.result).map(f => ({
          fixtureId: f.id,
          homeTeamId: f.homeTeamId,
          awayTeamId: f.awayTeamId,
          homeScore: f.result!.homeScore,
          awayScore: f.result!.awayScore,
          homeMatchPoints: f.result!.homeMatchPoints,
          awayMatchPoints: f.result!.awayMatchPoints,
        }));
        const standings = computeCupGroupStandings(
          cupGroupTeams.map(t => ({ id: t.id, name: t.name, abbreviation: t.abbreviation, isGhost: t.isGhost ?? false })),
          fixtureResults
        );
        const humanStandings = standings.filter(s => !s.isGhost);
        const myStandingIdx = humanStandings.findIndex(s => s.teamId === teamId);
        const cupGroupRank = myStandingIdx >= 0 ? myStandingIdx + 1 : humanStandings.length;

        // Last cup result
        const lastCupF = cupTeamFixtures
          .filter(f => f.result)
          .sort((a, b) => b.gameweek.number - a.gameweek.number)[0] as any | undefined;

        // Next cup fixture
        const nextCupF = cupTeamFixtures
          .filter(f => !f.result)
          .sort((a, b) => a.gameweek.number - b.gameweek.number)[0] as any | undefined;

        // Cup GW navigation bounds
        const completedCupGwNums = cupTeamFixtures.filter(f => f.result).map(f => f.gameweek.number);
        const minCompletedCupGw = completedCupGwNums.length > 0 ? Math.min(...completedCupGwNums) : null;
        const maxCompletedCupGw = completedCupGwNums.length > 0 ? Math.max(...completedCupGwNums) : null;
        const completedCupGws = [...new Set(completedCupGwNums)].sort((a, b) => a - b);

        const compLabel = (type: string) =>
          type === "cup-group" ? "Cup Group" : type === "ucl-knockout" ? "UCL" : "Europa";

        // Build cup player scores for lastCupResult
        let cupLastMyPlayerScores: any[] = [];
        let cupLastOppPlayerScores: any[] = [];
        let cupLastHasMyCaptainData = false;
        let cupLastHasOppCaptainData = false;
        if (lastCupF && lastCupF.result) {
          const cupIsHome = lastCupF.homeTeamId === teamId;
          const cupMyScore = cupIsHome ? lastCupF.result.homeScore : lastCupF.result.awayScore;
          const cupOppScore = cupIsHome ? lastCupF.result.awayScore : lastCupF.result.homeScore;
          const cupOpponentTeam = cupIsHome ? lastCupF.awayTeam : lastCupF.homeTeam;
          const cupCaptains = await db.query.gameweekCaptains.findMany({
            where: eq(gameweekCaptains.gameweekId, lastCupF.gameweek.id),
            with: { player: true },
          });
          const cupMyCaptain = cupCaptains.find((c: any) => c.player.teamId === teamId);
          const cupOppCaptain = cupOpponentTeam ? cupCaptains.find((c: any) => c.player.teamId === cupOpponentTeam.id) : null;

          if (cupMyCaptain) {
            cupLastHasMyCaptainData = true;
            cupLastMyPlayerScores = team.players.map(p => {
              const isCaptain = cupMyCaptain.playerId === p.id;
              const fplUrl = getFplTeamUrl(p.fplId, lastCupF.gameweek.number);
              if (isCaptain) return { name: p.name, isCaptain: true, fplScore: cupMyCaptain.fplScore, transferHits: cupMyCaptain.transferHits, finalScore: cupMyCaptain.doubledScore, fplId: p.fplId, fplUrl };
              const nonCaptain = cupMyScore - cupMyCaptain.doubledScore;
              return { name: p.name, isCaptain: false, fplScore: nonCaptain, transferHits: 0, finalScore: nonCaptain, fplId: p.fplId, fplUrl };
            });
          } else {
            cupLastMyPlayerScores = team.players.map((p, i) => {
              const inf = inferScores(cupMyScore, team.players)[i];
              return { ...inf, fplId: p.fplId, fplUrl: getFplTeamUrl(p.fplId, lastCupF.gameweek.number) };
            });
          }

          if (cupOppCaptain && cupOpponentTeam?.players) {
            cupLastHasOppCaptainData = true;
            cupLastOppPlayerScores = cupOpponentTeam.players.map((p: any) => {
              const isCaptain = cupOppCaptain.playerId === p.id;
              const fplUrl = getFplTeamUrl(p.fplId, lastCupF.gameweek.number);
              if (isCaptain) return { name: p.name, isCaptain: true, fplScore: cupOppCaptain.fplScore, transferHits: cupOppCaptain.transferHits, finalScore: cupOppCaptain.doubledScore, fplId: p.fplId, fplUrl };
              const nonCaptain = cupOppScore - cupOppCaptain.doubledScore;
              return { name: p.name, isCaptain: false, fplScore: nonCaptain, transferHits: 0, finalScore: nonCaptain, fplId: p.fplId, fplUrl };
            });
          } else if (cupOpponentTeam?.players) {
            cupLastOppPlayerScores = cupOpponentTeam.players.map((p: any, i: number) => {
              const inf = inferScores(cupOppScore, cupOpponentTeam.players)[i];
              return { ...inf, fplId: p.fplId, fplUrl: getFplTeamUrl(p.fplId, lastCupF.gameweek.number) };
            });
          }
        }

        cupProgress = {
          groupName: team.group?.name || "Cup Group",
          rank: cupGroupRank,
          totalTeams: humanStandings.length,
          cupZone: cupGroupRank <= 2 ? "ucl" : "uel",
          minCompletedCupGw,
          maxCompletedCupGw,
          completedCupGws,
          miniTable: humanStandings.map((s, i) => ({
            rank: i + 1,
            name: s.name,
            wins: s.wins,
            losses: s.losses,
            cupGroupPoints: s.cupGroupPoints,
            isCurrentTeam: s.teamId === teamId,
          })),
          lastCupResult: lastCupF && lastCupF.result ? {
            gameweek: lastCupF.gameweek.number,
            competitionType: lastCupF.competitionType || "cup-group",
            competitionLabel: compLabel(lastCupF.competitionType || "cup-group"),
            opponent: lastCupF.homeTeamId === teamId
              ? (lastCupF.awayTeam?.name || "Unknown")
              : (lastCupF.homeTeam?.name || "Unknown"),
            opponentAbbr: lastCupF.homeTeamId === teamId
              ? (lastCupF.awayTeam?.abbreviation || "??")
              : (lastCupF.homeTeam?.abbreviation || "??"),
            isHome: lastCupF.homeTeamId === teamId,
            myScore: lastCupF.homeTeamId === teamId ? lastCupF.result.homeScore : lastCupF.result.awayScore,
            oppScore: lastCupF.homeTeamId === teamId ? lastCupF.result.awayScore : lastCupF.result.homeScore,
            result: (lastCupF.homeTeamId === teamId
              ? lastCupF.result.homeMatchPoints
              : lastCupF.result.awayMatchPoints) === 2 ? "W" : "L",
            myPlayerScores: cupLastMyPlayerScores,
            oppPlayerScores: cupLastOppPlayerScores,
            hasMyCaptainData: cupLastHasMyCaptainData,
            hasOppCaptainData: cupLastHasOppCaptainData,
          } : null,
          upcomingCupFixture: nextCupF ? {
            gameweek: nextCupF.gameweek.number,
            competitionType: nextCupF.competitionType || "cup-group",
            competitionLabel: compLabel(nextCupF.competitionType || "cup-group"),
            opponent: nextCupF.homeTeamId === teamId
              ? (nextCupF.awayTeam?.name || "Unknown")
              : (nextCupF.homeTeam?.name || "Unknown"),
            isHome: nextCupF.homeTeamId === teamId,
            isDoubleHeader: DOUBLE_HEADER_GWS.includes(nextCupF.gameweek.number),
          } : null,
        };
      } catch (err) {
        console.error("Cup progress error:", err);
        // non-critical — leave null
      }
    }

    return NextResponse.json({
      team: {
        id: team.id,
        name: team.name,
        abbreviation: team.abbreviation,
        group: team.group?.name || null,
        leaguePoints: team.leaguePoints,
        bonusPoints: team.bonusPoints,
      },
      deadline: {
        gameweek: nextGameweek?.number || 0,
        timestamp: nextGameweek?.deadline?.toISOString() || null,
      },
      serverTime: new Date().toISOString(),
      upcomingFixture,
      upcomingCaptain,
      upcomingChip,
      lastGwResult,
      minCompletedGw,
      maxCompletedGw,
      recentForm,
      seasonStats: {
        played: totalWins + totalDraws + totalLosses,
        wins: totalWins,
        draws: totalDraws,
        losses: totalLosses,
        pointsFor: totalPointsFor,
        pointsAgainst: totalPointsAgainst,
        pointsDiff: totalPointsFor - totalPointsAgainst,
        bonusPointsEarned,
        chipPointsEarned,
        highestScoringGW: highestGw,
        lowestScoringGW: lowestGw,
        currentStreak: streakType ? { type: streakType, count: currentStreak } : null,
      },
      leaguePosition: {
        groupRank,
        zone,
        pointsToTop,
        miniTable,
      },
      chipStatus,
      captaincyStatus,
      upcomingFixtures,
      teamMembers,
      oppositeGroupTeams,
      announcementSettings: await getAnnouncementSettings(teamLeagueId!),
      leagueSlug,
      leagueGroupCount,
      leagueFormat,
      plPosition,
      cupProgress,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard data" },
      { status: 500 }
    );
  }
}

// ===== Auction format dashboard =====
async function getAuctionDashboard(teamId: string, leagueId: string, leagueSlug: string) {
  try {
    // Get league config (for initialBudget)
    const leagueRow = await db.select({ initialBudget: leagues.initialBudget }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);

    // Get team info
    const team = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team.length) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }
    const t = team[0];

    // Get squad (active players)
    const squad = await db.select().from(auctionOwnership)
      .where(and(eq(auctionOwnership.teamId, teamId), eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "active")));

    // Get all GW scores for this manager
    const scores = await db.select({
      totalPoints: auctionScores.totalPoints,
      rank: auctionScores.rank,
      payout: auctionScores.payout,
      gwNumber: gameweeks.number,
    })
      .from(auctionScores)
      .innerJoin(gameweeks, eq(auctionScores.gameweekId, gameweeks.id))
      .where(and(eq(auctionScores.teamId, teamId), eq(auctionScores.leagueId, leagueId)))
      .orderBy(asc(gameweeks.number));

    const totalPoints = scores.reduce((sum, s) => sum + s.totalPoints, 0);
    const totalIncome = scores.reduce((sum, s) => sum + s.payout, 0);

    // Get all teams for standings
    const allTeams = await db.select().from(teams).where(eq(teams.leagueId, leagueId));

    // Compute simple standings: total points per team from auctionScores
    const teamPointsMap = new Map<string, number>();
    for (const at of allTeams) {
      const tScores = await db.select({ totalPoints: auctionScores.totalPoints })
        .from(auctionScores)
        .where(and(eq(auctionScores.teamId, at.id), eq(auctionScores.leagueId, leagueId)));
      teamPointsMap.set(at.id, tScores.reduce((sum, s) => sum + s.totalPoints, 0));
    }

    const standings = allTeams
      .map(at => ({ id: at.id, name: at.name, abbreviation: at.abbreviation, totalPoints: teamPointsMap.get(at.id) || 0 }))
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .map((s, i) => ({ ...s, rank: i + 1, isCurrentTeam: s.id === teamId }));

    const myRank = standings.find(s => s.isCurrentTeam)?.rank ?? 0;

    // Get active/pending auction sessions
    const sessions = await db.select().from(auctionSessions)
      .where(and(eq(auctionSessions.leagueId, leagueId)));
    const activeSession = sessions.find(s => s.status === "active" || s.status === "paused");
    const nowForAuction = new Date();
    const nextScheduledAuction = sessions
      .filter(s => s.status === "pending" && s.scheduledAt && s.scheduledAt > nowForAuction)
      .sort((a, b) => (a.scheduledAt!.getTime() - b.scheduledAt!.getTime()))[0] ?? null;

    // Squad value = sum of purchase prices
    const squadValue = squad.reduce((sum, p) => sum + p.purchasePrice, 0);

    // Last GW result
    const lastGw = scores.length > 0 ? scores[scores.length - 1] : null;

    // GW deadline (next upcoming gameweek)
    const now = new Date();
    const nextGw = await db.select().from(gameweeks)
      .where(and(eq(gameweeks.leagueId, leagueId), gt(gameweeks.deadline, now)))
      .orderBy(asc(gameweeks.number))
      .limit(1);

    return NextResponse.json({
      leagueSlug,
      leagueFormat: "auction",
      team: {
        id: t.id,
        name: t.name,
        abbreviation: t.abbreviation,
      },
      purse: calculatePurse(leagueRow[0]?.initialBudget ?? 0, totalIncome, t.totalSpent ?? 0, t.totalRefunds ?? 0),
      totalSpent: t.totalSpent ?? 0,
      totalIncome,
      totalPoints,
      squadValue,
      squadSize: squad.length,
      squad: squad.map(p => ({
        id: p.id,
        fplElementId: p.fplElementId,
        playerName: p.playerName,
        purchasePrice: p.purchasePrice,
        acquiredGw: p.acquiredGw,
        status: p.status,
      })),
      rank: myRank,
      totalManagers: allTeams.length,
      standings: standings.slice(0, 10), // top 10 for mini-table
      gwHistory: scores.map(s => ({
        gameweek: s.gwNumber,
        points: s.totalPoints,
        rank: s.rank,
        income: s.payout,
      })),
      lastGwResult: lastGw ? {
        gameweek: lastGw.gwNumber,
        points: lastGw.totalPoints,
        rank: lastGw.rank,
        income: lastGw.payout,
      } : null,
      auctionSession: activeSession ? {
        id: activeSession.id,
        type: activeSession.type,
        status: activeSession.status,
      } : null,
      nextAuction: nextScheduledAuction ? {
        id: nextScheduledAuction.id,
        type: nextScheduledAuction.type,
        cycleNumber: nextScheduledAuction.cycleNumber,
        scheduledAt: nextScheduledAuction.scheduledAt!.toISOString(),
      } : null,
      deadline: nextGw.length > 0 ? {
        gameweek: nextGw[0].number,
        timestamp: nextGw[0].deadline?.toISOString() ?? null,
      } : { gameweek: 0, timestamp: null },
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Auction dashboard error:", error);
    return NextResponse.json({ error: "Failed to fetch auction dashboard" }, { status: 500 });
  }
}
