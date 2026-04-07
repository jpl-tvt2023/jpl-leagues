import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups, fixtures, results, gameweeks, gameweekCaptains, gameweekChips, settings, leagues } from "@/lib/db";
import { eq, and, gt, asc, desc, or } from "drizzle-orm";
import { fetchBootstrapData } from "@/lib/fpl";
import { getTop2FromGroup } from "@/lib/formats/tvt/chip-validation";
import { getChipSet } from "@/lib/formats/tvt/scoring";

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
    
    // Find the latest GW that has a result (current/completed GW)
    const completedGWs = allTeamFixtures
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
              fplUrl: getFplTeamUrl(p.fplId, currentGwNumber || undefined),
            })),
          },
          gameweek: nextGameweek.number,
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
              fplUrl: getFplTeamUrl(p.fplId, currentGwNumber || undefined),
            })),
          },
          gameweek: nextGameweek.number,
        };
      }
    } else {
      upcomingFixture = null;
    }

    // ============================================
    // RECENT FORM (Last 5 results)
    // ============================================
    const allFixtures = [...team.homeFixtures, ...team.awayFixtures]
      .filter(f => f.result)
      .sort((a, b) => b.gameweek.number - a.gameweek.number);
    
    // ============================================
    // LAST GW RESULT (most recent completed fixture, or requested GW)
    // ============================================
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
      
      // Helper to infer scores when no captain data: assume least scoring was captain
      // Total = 2*captainBase + nonCaptain, where captainBase < nonCaptain
      // So captainBase < Total/3, max captainBase = floor((Total-1)/3)
      const inferScores = (total: number, players: { name: string }[]) => {
        const captainBase = Math.floor((total - 1) / 3);
        const captainDoubled = captainBase * 2;
        const nonCaptainScore = total - captainDoubled;
        
        // First player (alphabetically) is inferred as captain
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
    
    // Count actual captain announcements per player (only in league stage GW1-30)
    const player1CaptainCount = captainHistory.filter(
      c => c.playerId === team.players[0]?.id && c.gameweek.number <= 30
    ).length;
    const player2CaptainCount = captainHistory.filter(
      c => c.playerId === team.players[1]?.id && c.gameweek.number <= 30
    ).length;

    const isPlayoffPhase = (nextGameweek?.number || 0) > 30;

    const captaincyStatus = {
      player1: {
        id: team.players[0]?.id || "",
        name: team.players[0]?.name || "",
        chipsUsed: player1CaptainCount,
        chipsRemaining: isPlayoffPhase ? 999 : 15 - player1CaptainCount,
      },
      player2: {
        id: team.players[1]?.id || "",
        name: team.players[1]?.name || "",
        chipsUsed: player2CaptainCount,
        chipsRemaining: isPlayoffPhase ? 999 : 15 - player2CaptainCount,
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
    // NEXT 5 FIXTURES
    // ============================================
    const upcomingHomeFixtures = team.homeFixtures
      .filter(f => !f.result)
      .map(f => ({
        gameweek: f.gameweek.number,
        opponent: f.awayTeam.name,
        isHome: true,
      }));
    const upcomingAwayFixtures = team.awayFixtures
      .filter(f => !f.result)
      .map(f => ({
        gameweek: f.gameweek.number,
        opponent: f.homeTeam.name,
        isHome: false,
      }));
    const upcomingFixtures = [...upcomingHomeFixtures, ...upcomingAwayFixtures]
      .sort((a, b) => a.gameweek - b.gameweek)
      .slice(0, 5);

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
    let highestGw: { gameweek: number; score: number } | null = null;
    let lowestGw: { gameweek: number; score: number } | null = null;
    
    // Only consider fixtures from gameweeks strictly before the latest completed GW (ignore current and upcoming)
    const concludedFixtures = allFixtures.filter(f => 
      f.gameweek.number < latestCompletedGW
    );
    
    for (const f of concludedFixtures) {
      const isHome = f.homeTeamId === teamId;
      const myScore = isHome ? f.result!.homeScore : f.result!.awayScore;
      if (!highestGw || myScore > highestGw.score) {
        highestGw = { gameweek: f.gameweek.number, score: myScore };
      }
      if (!lowestGw || myScore < lowestGw.score) {
        lowestGw = { gameweek: f.gameweek.number, score: myScore };
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
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard data" },
      { status: 500 }
    );
  }
}
