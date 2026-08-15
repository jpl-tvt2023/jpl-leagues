import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups, fixtures, results, gameweeks, gameweekCaptains, gameweekChips, settings, leagues } from "@/lib/db";
import { eq, and, gt, asc, desc, or, inArray } from "drizzle-orm";
import { fetchBootstrapData } from "@/lib/fpl";
import { shouldSyncDeadlines } from "@/lib/fpl-cache";
import { getTop2FromGroup, CHIP_GW1_POSITION_REASON } from "@/lib/formats/tvt/chip-validation";
import { getChipSet } from "@/lib/formats/tvt/scoring";
import { computeCupGroupStandings } from "@/lib/formats/continental-championship/standings";
import { auctionOwnership, auctionScores, auctionSessions } from "@/lib/db/schema";
import { calculatePurse, calculateRefund, calculateFMV } from "@/lib/formats/auction/economy";
import { fetchClubOwnershipMap } from "@/lib/teams/rename-rows";
import { buildTeamLedger } from "@/lib/formats/auction/finance";
import { computeCaptainCap, computeCaptainCheckLimit } from "@/lib/captains";
import { resolveSubmissionWindow } from "@/lib/gameweek-window";
import { getDoublePointerEligibility } from "@/lib/formats/tvt/double-pointer-eligibility";

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
  const [captainSetting, chipSetting] = await Promise.all([
    db.select().from(settings)
      .where(and(eq(settings.key, "captainAnnouncementEnabled"), eq(settings.leagueId, leagueId)))
      .limit(1),
    db.select().from(settings)
      .where(and(eq(settings.key, "chipAnnouncementEnabled"), eq(settings.leagueId, leagueId)))
      .limit(1),
  ]);
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
      ? await db.select({ slug: leagues.slug, groupCount: leagues.groupCount, format: leagues.format, playoffStartGw: leagues.playoffStartGw }).from(leagues).where(eq(leagues.id, teamLeagueId)).limit(1)
      : [];
    const leagueSlug = leagueSlugRow[0]?.slug ?? "";
    const leagueGroupCount = leagueSlugRow[0]?.groupCount ?? 1;
    const leagueFormat = leagueSlugRow[0]?.format ?? "tvt";
    const leaguePlayoffStartGw = leagueSlugRow[0]?.playoffStartGw ?? 31;

    // ===== Auction format: separate dashboard payload =====
    if (leagueFormat === "auction" && teamLeagueId) {
      return await getAuctionDashboard(teamId, teamLeagueId, leagueSlug);
    }

    if (teamLeagueId) {
      try {
        // Deadlines rarely change once FPL publishes them — only one request
        // per league actually does this sync every 30 minutes; everyone else
        // skips both the outbound FPL fetch and the DB writes below.
        if (await shouldSyncDeadlines(teamLeagueId)) {
          const fplData = await fetchBootstrapData();
          if (fplData && Array.isArray(fplData.events)) {
            await Promise.all(fplData.events.map((event: { deadline_time?: string; id: number }) => {
              const deadline = event.deadline_time ? new Date(event.deadline_time) : new Date('2099-12-31T23:59:59Z');
              return db.update(gameweeks)
                .set({ deadline })
                .where(and(eq(gameweeks.leagueId, teamLeagueId), eq(gameweeks.number, event.id)));
            }));
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
            awayTeam: true,
          },
        },
        awayFixtures: {
          with: {
            result: true,
            gameweek: true,
            homeTeam: true,
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

    // Get all gameweeks for this team's league only.
    // Without the where clause we'd load every gameweek across every league.
    const allGameweeks = await db.query.gameweeks.findMany({
      where: teamLeagueId ? eq(gameweeks.leagueId, teamLeagueId) : undefined,
      orderBy: [asc(gameweeks.number)],
    });

    // Combine all fixtures for this team
    const allTeamFixtures = [...team.homeFixtures, ...team.awayFixtures];

    // For TC: separate PL vs cup fixtures. For TVT: all fixtures are PL.
    const plTeamFixtures = leagueFormat === "continental-championship"
      ? allTeamFixtures.filter(f => (f as any).competitionType === "jpl" || !(f as any).competitionType)
      : allTeamFixtures;
    const cupTeamFixtures = leagueFormat === "continental-championship"
      ? allTeamFixtures.filter(f =>
          (f as any).competitionType === "cup-group" ||
          (f as any).competitionType === "jcl-knockout" ||
          (f as any).competitionType === "jel-knockout"
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
    // SUBMISSION WINDOW (captain/chip forms)
    // ============================================
    // Deliberately separate from nextGameweek above: nextGameweek tracks
    // results processing (can lag days behind a deadline), but the
    // captain/chip submission form must open purely on the deadline clock —
    // a team should be able to lock in next week's captain immediately once
    // this week's deadline (plus its 30-min lock) has passed, not wait for
    // this week's scores to be entered. Fixture/results display below keeps
    // using nextGameweek, untouched.
    const submissionWindow = resolveSubmissionWindow(allGameweeks, new Date());
    const submissionGw = submissionWindow.gw;

    // ============================================
    // UPCOMING FIXTURE
    // ============================================
    let upcomingFixture = null;
    if (nextGameweek) {
      const homeFixture = team.homeFixtures.find(f => f.gameweek.id === nextGameweek.id);
      const awayFixture = team.awayFixtures.find(f => f.gameweek.id === nextGameweek.id);
      // Opponent's roster is only ever needed for this one upcoming fixture, so
      // it's fetched here rather than eagerly loaded on every fixture above.
      const opponentTeam = homeFixture ? homeFixture.awayTeam : awayFixture ? awayFixture.homeTeam : null;
      const opponentPlayers = opponentTeam
        ? await db.query.players.findMany({ where: eq(players.teamId, opponentTeam.id) })
        : [];
      if (homeFixture && opponentTeam) {
        upcomingFixture = {
          isHome: true,
          opponent: {
            id: opponentTeam.id,
            name: opponentTeam.name,
            players: opponentPlayers.map(p => ({
              name: p.name,
              fplId: p.fplId,
              fplUrl: getFplTeamUrl(p.fplId, latestCompletedGW || undefined),
            })),
          },
          gameweek: nextGameweek.number,
          lastCompletedGw: latestCompletedGW,
        };
      } else if (awayFixture && opponentTeam) {
        upcomingFixture = {
          isHome: false,
          opponent: {
            id: opponentTeam.id,
            name: opponentTeam.name,
            players: opponentPlayers.map(p => ({
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
      // Roster is only needed for this specific last-GW opponent (a targeted
      // fetch instead of the removed eager-load on every fixture's opponent).
      const opponentTeamPlayers = opponentTeam
        ? await db.query.players.findMany({ where: eq(players.teamId, opponentTeam.id) })
        : [];

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
        oppPlayerScores = opponentTeamPlayers.map(p => {
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
        oppPlayerScores = opponentTeamPlayers.map((p, i) => {
          const inferred = inferScores(oppScore, opponentTeamPlayers)[i];
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
        myTeamId: teamId,
        myTeamName: team.name,
        opponentTeamId: opponentTeam?.id ?? null,
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
    // Tied to submissionGw (deadline-driven), not nextGameweek (results-driven)
    // — this is what actually drives the chip picker's set boundaries.
    const chipSet = submissionGw ? getChipSet(submissionGw.number, leaguePlayoffStartGw) : 1;

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
    const captainCheckLimit = computeCaptainCheckLimit(leagueFormat, leaguePlayoffStartGw);
    const player1CaptainCount = captainHistory.filter(
      c => c.playerId === team.players[0]?.id && c.gameweek.number <= captainCheckLimit
    ).length;
    const player2CaptainCount = captainHistory.filter(
      c => c.playerId === team.players[1]?.id && c.gameweek.number <= captainCheckLimit
    ).length;

    const CAPTAIN_CAP = computeCaptainCap(leagueFormat, leaguePlayoffStartGw);
    // Tied to submissionGw (deadline-driven) — this gates whether captaincy
    // is "unlimited" for the GW the picker is actually submitting toward.
    const isPlayoffPhase = leagueFormat === "continental-championship" ? false : (submissionGw?.number || 0) > captainCheckLimit;

    const player1ChipsRemaining = isPlayoffPhase ? 999 : CAPTAIN_CAP - player1CaptainCount;
    const player2ChipsRemaining = isPlayoffPhase ? 999 : CAPTAIN_CAP - player2CaptainCount;

    const captaincyStatus = {
      cap: CAPTAIN_CAP,
      player1: {
        id: team.players[0]?.id || "",
        name: team.players[0]?.name || "",
        chipsUsed: player1CaptainCount,
        chipsRemaining: player1ChipsRemaining,
        reason: player1ChipsRemaining <= 0
          ? `No captaincy chips remaining (${CAPTAIN_CAP}/${CAPTAIN_CAP} used this League Stage)`
          : null,
      },
      player2: {
        id: team.players[1]?.id || "",
        name: team.players[1]?.name || "",
        chipsUsed: player2CaptainCount,
        chipsRemaining: player2ChipsRemaining,
        reason: player2ChipsRemaining <= 0
          ? `No captaincy chips remaining (${CAPTAIN_CAP}/${CAPTAIN_CAP} used this League Stage)`
          : null,
      },
      recentCaptains: [...captainHistory]
        .sort((a, b) => b.gameweek.number - a.gameweek.number)
        .map(c => ({
          gameweek: c.gameweek.number,
          playerName: c.player.name,
          score: c.doubledScore,
        })),
    };

    // Check if captain is submitted for the open submission GW — return
    // details for switching UI.
    let upcomingCaptain: { playerId: string; playerName: string } | null = null;
    if (submissionGw) {
      const existingCaptain = captainHistory.find(c => c.gameweek.id === submissionGw.id);
      if (existingCaptain) {
        upcomingCaptain = {
          playerId: existingCaptain.player.id,
          playerName: existingCaptain.player.name,
        };
      }
    }

    // Get upcoming chip submission for this team (for the open submission GW)
    let upcomingChip = null;
    if (submissionGw) {
      const upcomingChipSubmission = await db.query.gameweekChips.findFirst({
        where: and(
          eq(gameweekChips.teamId, teamId),
          eq(gameweekChips.gameweekId, submissionGw.id)
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
    // CHIP ELIGIBILITY (for the always-shown, disable-if-unusable picker)
    // ============================================
    // Reuses the same used-flags chipStatus already reads (no re-query) and,
    // for Double Pointer, the same rank-eligibility helper the chips POST
    // route enforces server-side — so the UI and the enforcement can never
    // drift apart.
    const buildUsedReason = (used: boolean, set: 1 | 2 | "playoffs") =>
      used && set !== "playoffs" ? `Already used in Set ${set}` : null;

    let dpEligible = true;
    let dpReason: string | null = null;
    const dpUsed = chipSet === 1 ? team.doublePointerSet1Used : chipSet === 2 ? team.doublePointerSet2Used : false;
    if (dpUsed) {
      dpReason = buildUsedReason(true, chipSet);
      dpEligible = false;
    } else if (submissionGw && chipSet !== "playoffs" && team.groupId) {
      const groupId = team.groupId;
      const homeFixture = team.homeFixtures.find(f => f.gameweek.id === submissionGw.id);
      const awayFixture = team.awayFixtures.find(f => f.gameweek.id === submissionGw.id);
      const opponentTeamId = homeFixture?.awayTeam.id ?? awayFixture?.homeTeam.id ?? null;
      const dp = await getDoublePointerEligibility(
        teamId, groupId, opponentTeamId, submissionGw.number, leaguePlayoffStartGw
      );
      dpEligible = dp.eligible;
      dpReason = dp.reason;
    }

    const ccUsed = chipSet === 1 ? team.challengeChipSet1Used : chipSet === 2 ? team.challengeChipSet2Used : false;
    const wwUsed = chipSet === 1 ? team.winWinSet1Used : chipSet === 2 ? team.winWinSet2Used : false;

    // Challenge Chip's "top 2 from opposite group" target is just as
    // position-dependent as Double Pointer's rank check — block it in GW1
    // for the same reason (see CHIP_GW1_POSITION_REASON).
    const ccGw1Blocked = submissionGw?.number === 1;

    const chipEligibility = {
      D: { used: !!dpUsed, eligible: dpEligible, reason: dpReason },
      C: {
        used: !!ccUsed,
        eligible: !ccUsed && !ccGw1Blocked,
        reason: ccUsed ? buildUsedReason(true, chipSet) : ccGw1Blocked ? CHIP_GW1_POSITION_REASON : null,
      },
      W: { used: !!wwUsed, eligible: !wwUsed, reason: buildUsedReason(!!wwUsed, chipSet) },
    };

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
        const pts = t.leaguePoints;
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
    const plHomeFixtures = leagueFormat === "continental-championship"
      ? team.homeFixtures.filter(f => !(f as any).competitionType || (f as any).competitionType === "jpl")
      : team.homeFixtures;
    const plAwayFixtures = leagueFormat === "continental-championship"
      ? team.awayFixtures.filter(f => !(f as any).competitionType || (f as any).competitionType === "jpl")
      : team.awayFixtures;

    const upcomingHomeFixtures = plHomeFixtures
      .filter(f => !f.result)
      .map(f => ({
        gameweek: f.gameweek.number,
        opponent: f.awayTeam.name,
        isHome: true,
        competitionType: "jpl" as string,
        competitionLabel: "JPL",
      }));
    const upcomingAwayFixtures = plAwayFixtures
      .filter(f => !f.result)
      .map(f => ({
        gameweek: f.gameweek.number,
        opponent: f.homeTeam.name,
        isHome: false,
        competitionType: "jpl" as string,
        competitionLabel: "JPL",
      }));
    const upcomingPlFixtures = [...upcomingHomeFixtures, ...upcomingAwayFixtures]
      .sort((a, b) => a.gameweek - b.gameweek)
      .slice(0, 5);

    // For TC: interleave cup fixtures after PL fixture for same GW
    let upcomingFixtures = upcomingPlFixtures;
    if (leagueFormat === "continental-championship") {
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
            competitionLabel: f.competitionType === "jcl-knockout" ? "JCL" : f.competitionType === "jel-knockout" ? "JEL" : "JPL Cup",
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
        if (!merged.find(m => m.gameweek === cupF.gameweek && m.competitionType !== "jpl")) {
          if (!upcomingPlFixtures.find(p => p.gameweek === cupF.gameweek)) {
            merged.push(cupF);
          }
        }
      }
      upcomingFixtures = merged.sort((a, b) => a.gameweek - b.gameweek || (a.competitionType === "jpl" ? -1 : 1));
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
    let highestGw: { gameweek: number; score: number; opponent?: string } | null = null;
    let lowestGw: { gameweek: number; score: number; opponent?: string } | null = null;

    // Only consider fixtures from gameweeks strictly before the latest completed GW (ignore current and upcoming)
    const concludedFixtures = allFixtures.filter(f =>
      f.gameweek.number < latestCompletedGW
    );

    for (const f of concludedFixtures) {
      const isHome = f.homeTeamId === teamId;
      const myScore = isHome ? f.result!.homeScore : f.result!.awayScore;
      const oppTeam = isHome ? (f as any).awayTeam : (f as any).homeTeam;
      const opponent = oppTeam?.name as string | undefined;
      if (!highestGw || myScore > highestGw.score) {
        highestGw = { gameweek: f.gameweek.number, score: myScore, opponent };
      }
      if (!lowestGw || myScore < lowestGw.score) {
        lowestGw = { gameweek: f.gameweek.number, score: myScore, opponent };
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
    let oppositeGroupTeams: { id: string; name: string }[] = [];
    try {
      // Scope groups query to this team's league. The teams query is scoped via
      // inArray on the top-2 IDs (no point loading all teams just to filter).
      const allGroups = teamLeagueId
        ? await db.query.groups.findMany({ where: eq(groups.leagueId, teamLeagueId) })
        : await db.query.groups.findMany();
      const oppositeGroup = allGroups.find(g => g.id !== team.groupId);
      // Challenge Chip targeting follows the submission GW (deadline-driven),
      // not currentGwNumber (results-driven, still used for FPL links above).
      if (oppositeGroup && submissionGw) {
        const top2 = await getTop2FromGroup(oppositeGroup.id, submissionGw.number);
        const top2Ids = top2.map(t => t.teamId);
        const top2Teams = top2Ids.length === 0 ? [] : await db.query.teams.findMany({
          where: inArray(teams.id, top2Ids),
        });
        oppositeGroupTeams = top2Teams
          .sort((a, b) => top2Ids.indexOf(a.id) - top2Ids.indexOf(b.id))
          .map(t => ({ id: t.id, name: t.name }));
      }
    } catch {
      // Non-critical — leave empty if standings not yet available
    }

    // ============================================
    // TC: PL RANK (all 20 non-ghost teams)
    // ============================================
    let plPosition: { rank: number; totalTeams: number } | null = null;
    let allNonGhostSorted: { id: string; name: string; leaguePoints: number }[] = [];
    if (leagueFormat === "continental-championship" && teamLeagueId) {
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
      cupZone: "jcl" | "jel";
      minCompletedCupGw: number | null;
      maxCompletedCupGw: number | null;
      completedCupGws: number[];
      miniTable: { rank: number; name: string; wins: number; losses: number; cupGroupPoints: number; isCurrentTeam: boolean }[];
      lastCupResult: {
        gameweek: number;
        competitionType: string;
        competitionLabel: string;
        opponent: string;
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

    if (leagueFormat === "continental-championship" && team.groupId) {
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
          cupGroupTeams.map(t => ({ id: t.id, name: t.name, isGhost: t.isGhost ?? false })),
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
          type === "cup-group" ? "JPL Cup Group" : type === "jcl-knockout" ? "JCL" : "JEL";

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
          cupZone: cupGroupRank <= 2 ? "jcl" : "jel",
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

    // League-wide captain + chip announcements for the upcoming GW — shown in
    // the dashboard's top widget. Immediately visible to every team on
    // announcement; no deadline gate. Chips are TVT-only — for Continental Championship the
    // chip mapping stays null. Queries bounded by team count (≤32 per league).
    const CHIP_NAMES_TVT: Record<string, string> = {
      W: "Win-Win",
      D: "Double Pointer",
      C: "Challenge Chip",
      SL: "Score Lock",
      CB: "Comeback",
      UD: "Underdog",
    };
    let leagueCaptains: Array<{
      teamId: string;
      teamName: string;
      groupName: string;
      isOwnTeam: boolean;
      captainPlayerName: string | null;
      announcedAt: string | null;
      chipType: string | null;
      chipName: string | null;
    }> = [];
    if (nextGameweek && teamLeagueId) {
      const allTeamsInLeague = await db.query.teams.findMany({
        where: eq(teams.leagueId, teamLeagueId),
        with: { group: true },
      });
      const captainsForGw = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.gameweekId, nextGameweek.id),
        with: { player: true },
      });
      const captainByTeam = new Map<string, { name: string; announcedAt: Date | null }>();
      for (const c of captainsForGw) {
        if (c.player?.teamId) {
          captainByTeam.set(c.player.teamId, {
            name: c.player.name,
            announcedAt: c.announcedAt ?? null,
          });
        }
      }
      // Chip announcements — only TVT has chips. TC + auction skip the fetch.
      const chipByTeam = new Map<string, string>();
      if (leagueFormat !== "continental-championship") {
        const chipsForGw = await db.query.gameweekChips.findMany({
          where: eq(gameweekChips.gameweekId, nextGameweek.id),
        });
        for (const ch of chipsForGw) {
          if (ch.teamId && ch.chipType) {
            chipByTeam.set(ch.teamId, ch.chipType);
          }
        }
      }
      leagueCaptains = allTeamsInLeague.map((t) => {
        const picked = captainByTeam.get(t.id);
        const chipType = chipByTeam.get(t.id) ?? null;
        return {
          teamId: t.id,
          teamName: t.name,
          groupName: t.group?.name ?? "",
          isOwnTeam: t.id === team.id,
          captainPlayerName: picked?.name ?? null,
          announcedAt: picked?.announcedAt ? picked.announcedAt.toISOString() : null,
          chipType,
          chipName: chipType ? (CHIP_NAMES_TVT[chipType] ?? chipType) : null,
        };
      });
      leagueCaptains.sort((a, b) => {
        if (a.isOwnTeam !== b.isOwnTeam) return a.isOwnTeam ? -1 : 1;
        const g = a.groupName.localeCompare(b.groupName);
        if (g !== 0) return g;
        return a.teamName.localeCompare(b.teamName);
      });
    }

    return NextResponse.json({
      team: {
        id: team.id,
        name: team.name,
        group: team.group?.name || null,
        leaguePoints: team.leaguePoints,
        bonusPoints: team.bonusPoints,
      },
      deadline: {
        gameweek: nextGameweek?.number || 0,
        timestamp: nextGameweek?.deadline?.toISOString() || null,
      },
      // Deadline-driven, decoupled from results processing — this is what
      // the captain/chip forms actually submit against (see submissionGw
      // above). `deadline` above stays results-driven for fixture display.
      submission: {
        gameweek: submissionGw?.number || 0,
        timestamp: submissionGw?.deadline?.toISOString() || null,
        state: submissionWindow.state,
        opensAt: submissionWindow.opensAt,
      },
      serverTime: new Date().toISOString(),
      upcomingFixture,
      upcomingCaptain,
      upcomingChip,
      chipEligibility,
      leagueCaptains,
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
    // Get league config (for initialBudget + tier gating + whether the team name is club-derived)
    const leagueRow = await db.select({ initialBudget: leagues.initialBudget, auctionTier: leagues.auctionTier, clubAuctionEnabled: leagues.clubAuctionEnabled }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);

    // Get team info
    const team = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team.length) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }
    const t = team[0];

    // Get squad (active players)
    const squad = await db.select().from(auctionOwnership)
      .where(and(eq(auctionOwnership.teamId, teamId), eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "active")));

    // Get released players for forfeit breakdown
    const releasedPlayers = await db.select().from(auctionOwnership)
      .where(and(eq(auctionOwnership.teamId, teamId), eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "released")));

    const releases = releasedPlayers.map(p => {
      const refund = calculateRefund(p.purchasePrice);
      return {
        id: p.id,
        playerName: p.playerName,
        purchasePrice: p.purchasePrice,
        refund,
        forfeit: p.purchasePrice - refund,
        releasedGw: p.releasedGw,
      };
    });
    const totalForfeit = releases.reduce((sum, r) => sum + r.forfeit, 0);
    const totalRefunds = releases.reduce((sum, r) => sum + r.refund, 0);

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

    // Per-player RAW points across the season for FMV calc + squad summary / top-4.
    // Prefer `rawPoints` over the legacy `points` field — FMV spec is RAW-only (synergy never
    // compounds into squad value). Matches the standings route at api/standings/route.ts:139-146.
    const myScoreRows = await db
      .select({ playerBreakdown: auctionScores.playerBreakdown })
      .from(auctionScores)
      .where(and(eq(auctionScores.teamId, teamId), eq(auctionScores.leagueId, leagueId)));
    const playerPointsMap = new Map<number, number>();
    for (const row of myScoreRows) {
      try {
        const breakdown: { elementId: number; points?: number; rawPoints?: number }[] = JSON.parse(row.playerBreakdown);
        for (const entry of breakdown) {
          const pts = entry.rawPoints ?? entry.points ?? 0;
          playerPointsMap.set(entry.elementId, (playerPointsMap.get(entry.elementId) ?? 0) + pts);
        }
      } catch {
        // ignore malformed rows
      }
    }

    // Get all teams for standings
    const allTeams = await db.select().from(teams).where(eq(teams.leagueId, leagueId));

    // Compute simple standings: total points per team from auctionScores
    // (single query for all teams instead of one round trip per team)
    const teamPointsMap = new Map<string, number>();
    for (const at of allTeams) teamPointsMap.set(at.id, 0);
    if (allTeams.length > 0) {
      const allScores = await db.select({ teamId: auctionScores.teamId, totalPoints: auctionScores.totalPoints })
        .from(auctionScores)
        .where(and(inArray(auctionScores.teamId, allTeams.map(at => at.id)), eq(auctionScores.leagueId, leagueId)));
      for (const s of allScores) {
        teamPointsMap.set(s.teamId, (teamPointsMap.get(s.teamId) ?? 0) + s.totalPoints);
      }
    }

    // Apply the PL Club Auction rename: any team that owns a club displays as the club's name.
    const clubByTeamId = await fetchClubOwnershipMap(leagueId);

    const standings = allTeams
      .map(at => {
        const ownedClub = clubByTeamId.get(at.id) ?? null;
        return {
          id: at.id,
          name: ownedClub?.plTeamName ?? at.name,
          // Compact 3-letter form for cramped surfaces (dashboard mini-table). Falls back to the
          // first 3 chars of the team name when no club is owned.
          shortName: ownedClub?.plTeamShort ?? at.name.slice(0, 3).toUpperCase(),
          totalPoints: teamPointsMap.get(at.id) || 0,
          ownedClub,
        };
      })
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

    // Squad value = sum of FMV per active player (FMV = purchasePrice + appreciation tier on RAW points).
    // Matches the standings page calculation.
    const squadValue = squad.reduce((sum, p) => {
      const pts = playerPointsMap.get(p.fplElementId) ?? 0;
      return sum + calculateFMV(p.purchasePrice, pts);
    }, 0);

    // Last GW result
    const lastGw = scores.length > 0 ? scores[scores.length - 1] : null;

    // The Finance ledger drives every economy summary here — single source of truth so dashboard
    // and Finance page can't disagree. Release entries store the refund (positive) in `amount`;
    // the matching forfeit is in metadata.
    const ledgerData = await buildTeamLedger(leagueId, teamId);

    const expenseByType: Record<string, number> = {
      purchase: 0,
      club_purchase: 0,
      release_forfeit: 0,
      trade_cash_out: 0,
      trade_swap: 0,
      transfer_fee: 0,
      slot_unlock: 0,
      slot_redeem: 0,
    };
    const incomeByType: Record<string, number> = {
      gw_payout: 0,
      trade_cash_in: 0,
      release_refund: 0,
    };
    if (ledgerData) {
      for (const entry of ledgerData.ledger) {
        if (entry.isPending) continue;
        if (entry.type === "release_refund") {
          // Refund is positive income; the matching forfeit is bucketed under expenses.
          incomeByType.release_refund += entry.amount;
          expenseByType.release_forfeit += entry.metadata?.forfeitAmount ?? 0;
        } else if (entry.amount < 0) {
          if (entry.type in expenseByType) expenseByType[entry.type] += Math.abs(entry.amount);
        } else if (entry.amount > 0 && entry.type !== "initial_budget") {
          if (entry.type in incomeByType) incomeByType[entry.type] += entry.amount;
        }
      }
    }
    const expenseTotal = Object.values(expenseByType).reduce((s, n) => s + n, 0);
    const incomeTotal = Object.values(incomeByType).reduce((s, n) => s + n, 0);
    const expenseBreakdown = { total: expenseTotal, byType: expenseByType };
    const incomeBreakdown = { total: incomeTotal, byType: incomeByType };

    // Purse + summary totals come from the ledger so they agree with Finance by construction.
    // Falls back to the persisted column / formula on the (impossible) path where the ledger build
    // returned null — defensive only.
    const initialBudget = leagueRow[0]?.initialBudget ?? 0;
    const ledgerPurse = ledgerData?.currentPurse ?? calculatePurse(initialBudget, totalIncome, t.totalSpent ?? 0, t.totalRefunds ?? 0);
    const ledgerTotalSpent = ledgerData?.summary.totalSpent ?? (t.totalSpent ?? 0);
    const ledgerTotalIncome = ledgerData?.summary.totalIncome ?? totalIncome;
    const ledgerTotalRefunds = ledgerData?.summary.totalRefunds ?? totalRefunds;

    // GW deadline (next upcoming gameweek)
    const now = new Date();
    const nextGw = await db.select().from(gameweeks)
      .where(and(eq(gameweeks.leagueId, leagueId), gt(gameweeks.deadline, now)))
      .orderBy(asc(gameweeks.number))
      .limit(1);

    // Owned-club info for THIS team — surfaced so the dashboard header can render the team's
    // user-supplied name alongside a club chip (per user preference; everywhere else the
    // existing club-name override still applies).
    const myClub = clubByTeamId.get(t.id) ?? null;

    return NextResponse.json({
      leagueSlug,
      leagueFormat: "auction",
      auctionTier: leagueRow[0]?.auctionTier ?? "complete",
      clubAuctionEnabled: !!leagueRow[0]?.clubAuctionEnabled,
      team: {
        id: t.id,
        name: t.name,
        teamLoginId: t.teamLoginId,
        ownedClub: myClub,
      },
      purse: ledgerPurse,
      initialBudget,
      totalSpent: ledgerTotalSpent,
      totalIncome: ledgerTotalIncome,
      totalRefunds: ledgerTotalRefunds,
      totalForfeit,
      releases,
      expenseBreakdown,
      incomeBreakdown,
      totalPoints,
      squadValue,
      squadSize: squad.length,
      squad: squad.map(p => {
        const pts = playerPointsMap.get(p.fplElementId) ?? 0;
        return {
          id: p.id,
          fplElementId: p.fplElementId,
          playerName: p.playerName,
          purchasePrice: p.purchasePrice,
          fmv: calculateFMV(p.purchasePrice, pts),
          acquiredGw: p.acquiredGw,
          status: p.status,
          elementType: p.elementType ?? null,
          totalPoints: pts,
        };
      }),
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
