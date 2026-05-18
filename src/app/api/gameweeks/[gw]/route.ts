import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, fixtures, teams, players, groups, results, gameweekCaptains, gameweekChips, auditLogs, type Gameweek, type Fixture, type Team, type Player, type Group, type Result, type GameweekCaptain, type GameweekChip } from "@/lib/db";
import { calculateTeamGameweekScore } from "@/lib/fpl";
import { calculateTVTTeamScore, determineMatchResult } from "@/lib/formats/tvt/scoring";
import { getTop2FromGroup } from "@/lib/formats/tvt/chip-validation";
import { getAllCachedScores, invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { eq, and, isNull } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { leagues, challengerSurvivalEntries } from "@/lib/db/schema";
import { processTripleCrownGameweek } from "@/lib/formats/triple-crown/process-gameweek";
import { processAuctionGameweek } from "@/lib/formats/auction/process-gameweek";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";

interface RouteParams {
  params: Promise<{ gw: string }>;
}

type FixtureWithRelations = Fixture & {
  homeTeam: Team & { players: Player[] };
  awayTeam: Team & { players: Player[] };
  group: Group | null;
  result: Result | null;
};

type CaptainWithRelations = GameweekCaptain & {
  player: Player & { team: Team };
};

type GameweekWithRelations = Gameweek & {
  fixtures: FixtureWithRelations[];
  captains: CaptainWithRelations[];
};

interface PlayerScoreData {
  playerId: string;
  isCaptain: boolean;
  isAutoAssigned?: boolean;
  points: number;
  transferHits: number;
  netScore: number;
}

/**
 * GET /api/gameweeks/[gw]
 * Get gameweek details including fixtures and results
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { gw } = await params;
    const gameweekNumber = parseInt(gw);

    if (isNaN(gameweekNumber) || gameweekNumber < 1 || gameweekNumber > 38) {
      return NextResponse.json(
        { error: "Invalid gameweek number (must be 1-38)" },
        { status: 400 }
      );
    }

    const { searchParams: getSearchParams } = new URL(request.url);
    let getLeagueId = getSearchParams.get("leagueId");
    // Resolve slug → UUID if needed
    if (getLeagueId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(getLeagueId)) {
      const row = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.slug, getLeagueId)).limit(1);
      getLeagueId = row[0]?.id ?? null;
    }
    const getGwWhere = getLeagueId
      ? and(eq(gameweeks.number, gameweekNumber), eq(gameweeks.leagueId, getLeagueId))
      : eq(gameweeks.number, gameweekNumber);

    // Find the gameweek with relations
    const gwList = await db.query.gameweeks.findMany({
      where: getGwWhere,
      with: {
        fixtures: {
          with: {
            homeTeam: {
              with: { players: true },
            },
            awayTeam: {
              with: { players: true },
            },
            group: true,
            result: true,
          },
        },
        captains: {
          with: {
            player: {
              with: { team: true },
            },
          },
        },
      },
    });

    const gameweek = gwList[0] as GameweekWithRelations | undefined;

    if (!gameweek) {
      return NextResponse.json(
        { error: "Gameweek not found" },
        { status: 404 }
      );
    }

    // Challenger Survival counters (32T GW33 only — empty for other GWs / formats)
    const survivalEntries = await db.select().from(challengerSurvivalEntries)
      .where(eq(challengerSurvivalEntries.gameweekId, gameweek.id));
    const survivalRanked = survivalEntries.filter(e => e.rank != null).length;

    return NextResponse.json({
      gameweek: {
        number: gameweek.number,
        deadline: gameweek.deadline,
        isPlayoffs: gameweek.isPlayoffs,
        fixturesCount: gameweek.fixtures.length,
        resultsProcessed: gameweek.fixtures.filter((f: FixtureWithRelations) => f.result).length,
        survivalCount: survivalEntries.length,
        survivalRanked,
      },
      fixtures: gameweek.fixtures.map((f: FixtureWithRelations) => ({
        id: f.id,
        homeTeam: {
          id: f.homeTeam.id,
          name: f.homeTeam.name,
          players: f.homeTeam.players.map((p: Player) => ({ name: p.name, fplId: p.fplId })),
        },
        awayTeam: {
          id: f.awayTeam.id,
          name: f.awayTeam.name,
          players: f.awayTeam.players.map((p: Player) => ({ name: p.name, fplId: p.fplId })),
        },
        group: f.group?.name ?? null,
        isChallenge: f.isChallenge,
        isPlayoff: f.isPlayoff,
        result: f.result
          ? {
              homeScore: f.result.homeScore,
              awayScore: f.result.awayScore,
              homeMatchPoints: f.result.homeMatchPoints,
              awayMatchPoints: f.result.awayMatchPoints,
              homeGotBonus: f.result.homeGotBonus,
              awayGotBonus: f.result.awayGotBonus,
            }
          : null,
      })),
      captains: gameweek.captains.map((c: CaptainWithRelations) => ({
        teamName: c.player.team.name,
        playerName: c.player.name,
        fplScore: c.fplScore,
        doubledScore: c.doubledScore,
        announcedAt: c.announcedAt,
        isValid: c.isValid,
      })),
    });
  } catch (error) {
    console.error("Error fetching gameweek:", error);
    return NextResponse.json(
      { error: "Failed to fetch gameweek" },
      { status: 500 }
    );
  }
}

/**
 * Auto-assign a default captain when no captain was announced.
 * Penalty: the LOWEST scoring player becomes captain (their lower score gets doubled).
 * Tiebreak: if both players have identical netScore, use the previous GW's captain.
 * If no previous captain exists (GW1), pick the first player alphabetically.
 */
async function autoAssignDefaultCaptain(
  team: Team & { players: Player[] },
  scores: { playerId: string; playerName: string; points: number; transferHits: number; netScore: number }[],
  gameweekId: string,
  gameweekNumber: number,
  leagueId?: string | null
): Promise<GameweekCaptain | undefined> {
  if (team.players.length === 0) return undefined;

  // Look up the previous GW's captain for this team (used for tiebreak rotation).
  let prevCaptainPlayerId: string | null = null;
  if (gameweekNumber > 1) {
    const prevGw = await db.query.gameweeks.findFirst({
      where: leagueId
        ? and(eq(gameweeks.number, gameweekNumber - 1), eq(gameweeks.leagueId, leagueId))
        : eq(gameweeks.number, gameweekNumber - 1),
    });
    if (prevGw) {
      const prevCaptains = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.gameweekId, prevGw.id),
        with: { player: true },
      });
      const prevTeamCaptain = prevCaptains.find(c => c.player.teamId === team.id);
      if (prevTeamCaptain) prevCaptainPlayerId = prevTeamCaptain.playerId;
    }
  }

  const candidates = team.players.map(p => {
    const s = scores.find(s => s.playerId === p.id);
    return { id: p.id, name: p.name, netScore: s?.netScore ?? 0 };
  });
  const defaultPlayerId = pickTempCaptain(candidates, prevCaptainPlayerId);
  if (!defaultPlayerId) return undefined;

  // Create a gameweekCaptains record marked as auto-assigned (isValid: false)
  const captainId = generateId();
  await db.insert(gameweekCaptains).values({
    id: captainId,
    gameweekId: gameweekId,
    playerId: defaultPlayerId,
    announcedAt: new Date(),
    isValid: false, // Auto-assigned, not manually announced
  });

  // Return the record in the expected shape
  return {
    id: captainId,
    gameweekId: gameweekId,
    playerId: defaultPlayerId,
    fplScore: 0,
    transferHits: 0,
    doubledScore: 0,
    announcedAt: new Date(),
    isValid: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as GameweekCaptain;
}

/**
 * POST /api/gameweeks/[gw]
 * Process gameweek - fetch FPL scores and calculate results
 * Query params:
 *   - force=true: Delete existing results and reprocess
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    // Verify admin (defense-in-depth — middleware also checks)
    const adminId = request.headers.get("x-session-id");
    const sessionType = request.headers.get("x-session-type");
    if (!adminId || sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const { gw } = await params;
    const gameweekNumber = parseInt(gw);
    const { searchParams } = new URL(request.url);
    const forceReprocess = searchParams.get("force") === "true";

    if (isNaN(gameweekNumber) || gameweekNumber < 1 || gameweekNumber > 38) {
      return NextResponse.json(
        { error: "Invalid gameweek number (must be 1-38)" },
        { status: 400 }
      );
    }

    // Find the gameweek — filter by leagueId if provided (prevents wrong-league match in multi-league setups)
    let leagueId = searchParams.get("leagueId");
    // Resolve slug → UUID if needed
    if (leagueId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leagueId)) {
      const row = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.slug, leagueId)).limit(1);
      leagueId = row[0]?.id ?? null;
    }
    const gwWhere = leagueId
      ? and(eq(gameweeks.number, gameweekNumber), eq(gameweeks.leagueId, leagueId))
      : eq(gameweeks.number, gameweekNumber);

    const gwList = await db.query.gameweeks.findMany({
      where: gwWhere,
      with: {
        fixtures: {
          with: {
            homeTeam: {
              with: { players: true },
            },
            awayTeam: {
              with: { players: true },
            },
            group: true,
            result: true,
          },
        },
        captains: true,
      },
    });

    const gameweek = gwList[0];

    if (!gameweek) {
      return NextResponse.json(
        { error: "Gameweek not found" },
        { status: 404 }
      );
    }

    // ============================================
    // FORMAT DISPATCHER
    // ============================================
    // Fetch league format and delegate to format-specific processor
    const leagueRow = await db.select({ format: leagues.format })
      .from(leagues)
      .where(eq(leagues.id, leagueId || ""))
      .limit(1);

    if (leagueRow[0]?.format === "triple-crown") {
      const result = await processTripleCrownGameweek(
        gameweek.id,
        gameweekNumber,
        leagueId || "",
        forceReprocess
      );
      await invalidateLeaguePageCache(leagueId || "");
      // Normalize response to match ScoringResult shape expected by admin frontend
      return NextResponse.json({
        success: result.success,
        gameweek: gameweekNumber,
        processed: result.processed,
        failed: result.errors?.length ?? 0,
        results: [],
        errors: result.errors,
        message: result.message,
      });
    }

    if (leagueRow[0]?.format === "auction") {
      const result = await processAuctionGameweek(
        gameweek.id,
        gameweekNumber,
        leagueId || "",
        forceReprocess
      );
      await invalidateLeaguePageCache(leagueId || "");
      return NextResponse.json({
        success: result.success,
        gameweek: gameweekNumber,
        processed: result.teamsProcessed,
        failed: 0,
        results: result.scores,
        errors: result.error ? [result.error] : [],
        message: result.success
          ? `Auction GW${gameweekNumber}: ${result.teamsProcessed} teams scored`
          : result.error,
      });
    }

    // ============================================
    // TVT FORMAT (default)
    // ============================================

    // If force reprocess, delete existing results and revert team points
    if (forceReprocess) {
      for (const fixture of gameweek.fixtures) {
        if (fixture.result) {
          // Use stored DP flags from results for accurate bonus revert
          const homeUsedDP = fixture.result.homeUsedDoublePointer;
          const awayUsedDP = fixture.result.awayUsedDoublePointer;

          // Calculate bonus points to revert (doubled if DP was used)
          const homeBonusToRevert = fixture.result.homeGotBonus ? (homeUsedDP ? 2 : 1) : 0;
          const awayBonusToRevert = fixture.result.awayGotBonus ? (awayUsedDP ? 2 : 1) : 0;

          // Revert home team points
          const homeTeam = await db.select().from(teams).where(eq(teams.id, fixture.homeTeamId));
          if (homeTeam[0]) {
            await db.update(teams)
              .set({
                leaguePoints: Math.max(0, homeTeam[0].leaguePoints - fixture.result.homeMatchPoints - homeBonusToRevert),
                bonusPoints: Math.max(0, homeTeam[0].bonusPoints - (fixture.result.homeGotBonus ? 1 : 0)),
              })
              .where(eq(teams.id, fixture.homeTeamId));
          }

          // Revert away team points
          const awayTeam = await db.select().from(teams).where(eq(teams.id, fixture.awayTeamId));
          if (awayTeam[0]) {
            await db.update(teams)
              .set({
                leaguePoints: Math.max(0, awayTeam[0].leaguePoints - fixture.result.awayMatchPoints - awayBonusToRevert),
                bonusPoints: Math.max(0, awayTeam[0].bonusPoints - (fixture.result.awayGotBonus ? 1 : 0)),
              })
              .where(eq(teams.id, fixture.awayTeamId));
          }

          // Delete the result
          await db.delete(results).where(eq(results.id, fixture.result.id));
        }
      }
      
      // Revert challenge chip points
      const processedChallengeChips = await db.select().from(gameweekChips).where(
        and(
          eq(gameweekChips.gameweekId, gameweek.id),
          eq(gameweekChips.chipType, "C"),
          eq(gameweekChips.isProcessed, true)
        )
      );
      for (const chip of processedChallengeChips) {
        if (chip.pointsAwarded > 0) {
          const teamRecord = await db.select().from(teams).where(eq(teams.id, chip.teamId));
          if (teamRecord[0]) {
            await db.update(teams)
              .set({
                leaguePoints: Math.max(0, teamRecord[0].leaguePoints - chip.pointsAwarded),
              })
              .where(eq(teams.id, chip.teamId));
          }
        }
      }
      
      // Also reset chip processing for this gameweek
      await db.update(gameweekChips)
        .set({ isProcessed: false, pointsAwarded: 0, hadNegativeHits: false })
        .where(eq(gameweekChips.gameweekId, gameweek.id));
      
      // Re-fetch gameweek with cleared results
      const updatedGwList = await db.query.gameweeks.findMany({
        where: gwWhere,
        with: {
          fixtures: {
            with: {
              homeTeam: { with: { players: true } },
              awayTeam: { with: { players: true } },
              group: true,
              result: true,
            },
          },
          captains: true,
        },
      });
      
      // Use the updated gameweek for processing
      const updatedGameweek = updatedGwList[0];
      if (updatedGameweek) {
        gameweek.fixtures = updatedGameweek.fixtures;
      }
    }

    // Filter only unprocessed fixtures
    const unprocessedFixtures = gameweek.fixtures.filter(f => !f.result);

    if (unprocessedFixtures.length === 0) {
      return NextResponse.json(
        { message: "All fixtures already processed", processed: 0 },
        { status: 200 }
      );
    }

    const processedResults = [];
    const errors = [];

    // ============================================
    // CARRY-FORWARD HIT DEDUCTION MAP (GW N-1 → GW N)
    // ============================================
    // Any player who took >12 raw FPL transfer hits in GW N-1 has their
    // FULL hit value deducted from their team's match score in GW N.
    const carryForwardMap = new Map<string, number>(); // fplId → transferHits to carry forward
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

    // Track margins for bonus point calculation per group
    // Key: groupId, Value: array of { teamId, margin, fixtureId, usedDoublePointer }
    const groupMargins: Map<string, { teamId: string; margin: number; fixtureId: string; resultId: string; usedDoublePointer: boolean }[]> = new Map();

    // Process each fixture
    for (const fixture of unprocessedFixtures) {
      try {
        // Get captain info for each team — sort newest first so last-set captain wins
        const sortedCaptains = [...gameweek.captains].sort(
          (a: GameweekCaptain, b: GameweekCaptain) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        let homeCaptain = sortedCaptains.find(
          (c: GameweekCaptain) => fixture.homeTeam.players.some((p: Player) => p.id === c.playerId)
        );
        let awayCaptain = sortedCaptains.find(
          (c: GameweekCaptain) => fixture.awayTeam.players.some((p: Player) => p.id === c.playerId)
        );

        // Fetch FPL scores for all players (captain flag set after default assignment)
        const homeScoresRaw = await Promise.all(
          fixture.homeTeam.players.map(async (player: Player) => {
            const score = await calculateTeamGameweekScore(player.fplId, gameweekNumber, leagueId);
            return { playerId: player.id, playerName: player.name, ...score };
          })
        );

        const awayScoresRaw = await Promise.all(
          fixture.awayTeam.players.map(async (player: Player) => {
            const score = await calculateTeamGameweekScore(player.fplId, gameweekNumber, leagueId);
            return { playerId: player.id, playerName: player.name, ...score };
          })
        );

        // Auto-assign default captain if none announced
        // Penalty: the LOWEST scoring player becomes captain (doubling the lower score)
        if (!homeCaptain) {
          homeCaptain = await autoAssignDefaultCaptain(
            fixture.homeTeam, homeScoresRaw, gameweek.id, gameweekNumber, leagueId
          );
        }
        if (!awayCaptain) {
          awayCaptain = await autoAssignDefaultCaptain(
            fixture.awayTeam, awayScoresRaw, gameweek.id, gameweekNumber, leagueId
          );
        }

        // Set isCaptain + isAutoAssigned flags now that captains are resolved
        const homeIsAutoAssigned = homeCaptain?.isValid === false;
        const awayIsAutoAssigned = awayCaptain?.isValid === false;

        const homeScores = homeScoresRaw.map(s => ({
          ...s,
          isCaptain: homeCaptain?.playerId === s.playerId,
          isAutoAssigned: homeCaptain?.playerId === s.playerId && homeIsAutoAssigned,
        }));

        const awayScores = awayScoresRaw.map(s => ({
          ...s,
          isCaptain: awayCaptain?.playerId === s.playerId,
          isAutoAssigned: awayCaptain?.playerId === s.playerId && awayIsAutoAssigned,
        }));

        // Persist captain FPL scores to gameweekCaptains table
        // so dashboard can display actual player-by-player score breakdowns
        if (homeCaptain) {
          const captainScore = homeScores.find(s => s.playerId === homeCaptain!.playerId);
          if (captainScore) {
            const doubled = (captainScore.points - captainScore.transferHits) * 2;
            await db.update(gameweekCaptains)
              .set({
                fplScore: captainScore.points,
                transferHits: captainScore.transferHits,
                doubledScore: doubled,
                updatedAt: new Date(),
              })
              .where(eq(gameweekCaptains.id, homeCaptain.id));
          }
        }
        if (awayCaptain) {
          const captainScore = awayScores.find(s => s.playerId === awayCaptain!.playerId);
          if (captainScore) {
            const doubled = (captainScore.points - captainScore.transferHits) * 2;
            await db.update(gameweekCaptains)
              .set({
                fplScore: captainScore.points,
                transferHits: captainScore.transferHits,
                doubledScore: doubled,
                updatedAt: new Date(),
              })
              .where(eq(gameweekCaptains.id, awayCaptain.id));
          }
        }

        // Calculate TVT team scores
        // Pass raw `points` (not netScore) because calculateTVTTeamScore subtracts hits internally
        const homeTeamScore = calculateTVTTeamScore(
          homeScores.map((s) => ({
            fplScore: s.points,
            transferHits: s.transferHits,
            isCaptain: s.isCaptain,
          }))
        );

        const awayTeamScore = calculateTVTTeamScore(
          awayScores.map((s: PlayerScoreData) => ({
            fplScore: s.points,
            transferHits: s.transferHits,
            isCaptain: s.isCaptain,
          }))
        );

        // Apply carry-forward hit deduction from previous GW
        // (players who took >12 raw hits last GW have their full hit total deducted this GW)
        const homeCarryForward = fixture.homeTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );
        const awayCarryForward = fixture.awayTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );
        const effectiveHomeScore = homeTeamScore - homeCarryForward;
        const effectiveAwayScore = awayTeamScore - awayCarryForward;

        // Determine match result (using effective scores with carry-forward applied)
        const matchResult = determineMatchResult(effectiveHomeScore, effectiveAwayScore);

        // Calculate margin for bonus point eligibility (to be determined after all fixtures processed)
        const margin = Math.abs(effectiveHomeScore - effectiveAwayScore);
        // NOTE: Bonus will be awarded AFTER all fixtures are processed to find highest margin per group
        // Set to false initially - will be updated in bonus calculation phase
        const homeGotBonus = false;
        const awayGotBonus = false;

        // ============================================
        // TVT CHIP PROCESSING
        // ============================================
        
        // Get chips for both teams in this gameweek
        const homeChips = await db.select().from(gameweekChips).where(
          and(
            eq(gameweekChips.teamId, fixture.homeTeamId),
            eq(gameweekChips.gameweekId, gameweek.id),
            eq(gameweekChips.isValid, true)
          )
        );
        
        const awayChips = await db.select().from(gameweekChips).where(
          and(
            eq(gameweekChips.teamId, fixture.awayTeamId),
            eq(gameweekChips.gameweekId, gameweek.id),
            eq(gameweekChips.isValid, true)
          )
        );

        let homePointsToAward = matchResult.homeMatchPoints;
        let awayPointsToAward = matchResult.awayMatchPoints;
        let homeUsedDoublePointer = false;
        let awayUsedDoublePointer = false;

        // Process home team chips
        for (const chip of homeChips) {
          if (chip.chipType === "W") {
            // Win-Win: Check for negative hits
            const totalHits = homeScores.reduce((sum, s) => sum + s.transferHits, 0);
            if (totalHits > 0) {
              // Chip wasted - mark as processed with no effect
              await db.update(gameweekChips)
                .set({ 
                  isProcessed: true, 
                  hadNegativeHits: true,
                  pointsAwarded: 0,
                })
                .where(eq(gameweekChips.id, chip.id));
            } else {
              // Win-Win gives 2 points regardless of result
              // Win-Win users CAN still compete for bonus (2+1=3 if they win by 75+)
              // EXTRA points = 2 - what they would have earned naturally
              const extraPoints = 2 - matchResult.homeMatchPoints;
              homePointsToAward = 2;
              await db.update(gameweekChips)
                .set({ 
                  isProcessed: true, 
                  pointsAwarded: extraPoints, // Store EXTRA points only
                })
                .where(eq(gameweekChips.id, chip.id));
            }
          } else if (chip.chipType === "D") {
            // Double Pointer: Double match points (bonus will also be doubled later)
            // EXTRA points = the original match points (since we're doubling)
            const extraPoints = matchResult.homeMatchPoints;
            homePointsToAward = matchResult.homeMatchPoints * 2;
            homeUsedDoublePointer = true;
            await db.update(gameweekChips)
              .set({ 
                isProcessed: true, 
                pointsAwarded: extraPoints, // Store EXTRA points only
                teamRankAtValidation: 0, // TODO: Calculate actual rank
                opponentRankAtValidation: 0,
              })
              .where(eq(gameweekChips.id, chip.id));
          }
          // Challenge chip is processed separately after regular fixtures
        }

        // Process away team chips
        for (const chip of awayChips) {
          if (chip.chipType === "W") {
            const totalHits = awayScores.reduce((sum: number, s: PlayerScoreData) => sum + s.transferHits, 0);
            if (totalHits > 0) {
              await db.update(gameweekChips)
                .set({ 
                  isProcessed: true, 
                  hadNegativeHits: true,
                  pointsAwarded: 0,
                })
                .where(eq(gameweekChips.id, chip.id));
            } else {
              // Win-Win gives 2 points regardless of result
              // Win-Win users CAN still compete for bonus (2+1=3 if they win by 75+)
              // EXTRA points = 2 - what they would have earned naturally
              const extraPoints = 2 - matchResult.awayMatchPoints;
              awayPointsToAward = 2;
              await db.update(gameweekChips)
                .set({ 
                  isProcessed: true, 
                  pointsAwarded: extraPoints, // Store EXTRA points only
                })
                .where(eq(gameweekChips.id, chip.id));
            }
          } else if (chip.chipType === "D") {
            // Double Pointer: Double match points (bonus will also be doubled later)
            // EXTRA points = the original match points (since we're doubling)
            const extraPoints = matchResult.awayMatchPoints;
            awayPointsToAward = matchResult.awayMatchPoints * 2;
            awayUsedDoublePointer = true;
            await db.update(gameweekChips)
              .set({ 
                isProcessed: true, 
                pointsAwarded: extraPoints, // Store EXTRA points only
                teamRankAtValidation: 0,
                opponentRankAtValidation: 0,
              })
              .where(eq(gameweekChips.id, chip.id));
          }
        }

        // Build per-player score breakdown JSON for display on fixtures page
        const homePlayerScores = JSON.stringify(
          homeScores.map(s => {
            const player = fixture.homeTeam.players.find((p: Player) => p.id === s.playerId);
            const finalScore = s.isCaptain
              ? (s.points - s.transferHits) * 2
              : s.points - s.transferHits;
            return {
              name: s.playerName,
              fplId: player?.fplId ?? "",
              fplScore: s.points,
              transferHits: s.transferHits,
              isCaptain: s.isCaptain,
              ...(s.isAutoAssigned ? { isTempCaptain: true } : {}),
              finalScore,
            };
          })
        );
        const awayPlayerScores = JSON.stringify(
          awayScores.map((s: PlayerScoreData & { playerName: string }) => {
            const player = fixture.awayTeam.players.find((p: Player) => p.id === s.playerId);
            const finalScore = s.isCaptain
              ? (s.points - s.transferHits) * 2
              : s.points - s.transferHits;
            return {
              name: s.playerName,
              fplId: player?.fplId ?? "",
              fplScore: s.points,
              transferHits: s.transferHits,
              isCaptain: s.isCaptain,
              ...(s.isAutoAssigned ? { isTempCaptain: true } : {}),
              finalScore,
            };
          })
        );

        // Create result in database
        const resultId = generateId();
        await db.insert(results).values({
          id: resultId,
          fixtureId: fixture.id,
          teamId: matchResult.homeMatchPoints > matchResult.awayMatchPoints 
            ? fixture.homeTeamId 
            : matchResult.awayMatchPoints > matchResult.homeMatchPoints 
              ? fixture.awayTeamId 
              : fixture.homeTeamId, // For draws, just use home team
          homeScore: effectiveHomeScore,
          awayScore: effectiveAwayScore,
          homeMatchPoints: homePointsToAward, // Use chip-adjusted points
          awayMatchPoints: awayPointsToAward, // Use chip-adjusted points
          homeGotBonus: false, // Will be updated in bonus calculation phase
          awayGotBonus: false, // Will be updated in bonus calculation phase
          homeUsedDoublePointer: homeUsedDoublePointer,
          awayUsedDoublePointer: awayUsedDoublePointer,
          homePlayerScores,
          awayPlayerScores,
        });

        // Track margin for bonus calculation (only winning teams with 75+ margin)
        // Only track if fixture has a group assigned
        const groupId = fixture.groupId;
        if (groupId) {
          if (!groupMargins.has(groupId)) {
            groupMargins.set(groupId, []);
          }

          if (margin >= 75) {
            if (effectiveHomeScore > effectiveAwayScore) {
              // Home team won by 75+
              groupMargins.get(groupId)!.push({
                teamId: fixture.homeTeamId,
                margin,
                fixtureId: fixture.id,
                resultId,
                usedDoublePointer: homeUsedDoublePointer,
              });
            } else if (effectiveAwayScore > effectiveHomeScore) {
              // Away team won by 75+
              groupMargins.get(groupId)!.push({
                teamId: fixture.awayTeamId,
                margin,
                fixtureId: fixture.id,
                resultId,
                usedDoublePointer: awayUsedDoublePointer,
              });
            }
          }
        }

        // Update home team league points (with chip adjustments, no bonus yet)
        const homeTeam = await db.select().from(teams).where(eq(teams.id, fixture.homeTeamId));
        if (homeTeam[0]) {
          await db.update(teams)
            .set({
              leaguePoints: homeTeam[0].leaguePoints + homePointsToAward,
              // bonusPoints will be updated in bonus calculation phase
            })
            .where(eq(teams.id, fixture.homeTeamId));
        }

        // Update away team league points (with chip adjustments, no bonus yet)
        const awayTeam = await db.select().from(teams).where(eq(teams.id, fixture.awayTeamId));
        if (awayTeam[0]) {
          await db.update(teams)
            .set({
              leaguePoints: awayTeam[0].leaguePoints + awayPointsToAward,
              // bonusPoints will be updated in bonus calculation phase
            })
            .where(eq(teams.id, fixture.awayTeamId));
        }

        processedResults.push({
          fixtureId: fixture.id,
          homeTeam: fixture.homeTeam.name,
          awayTeam: fixture.awayTeam.name,
          homeScore: effectiveHomeScore,
          awayScore: effectiveAwayScore,
          homeMatchPoints: homePointsToAward,
          awayMatchPoints: awayPointsToAward,
          homeChips: homeChips.map(c => c.chipType),
          awayChips: awayChips.map(c => c.chipType),
          resultId: resultId,
          margin,
          homeCarryForward: homeCarryForward > 0 ? homeCarryForward : undefined,
          awayCarryForward: awayCarryForward > 0 ? awayCarryForward : undefined,
        });

        // Write AuditLog entries for carry-forward deductions
        if (homeCarryForward > 0) {
          const offenders = fixture.homeTeam.players
            .filter((p: Player) => carryForwardMap.has(p.fplId))
            .map((p: Player) => `${p.name} (${carryForwardMap.get(p.fplId)} hits)`)
            .join(", ");
          await db.insert(auditLogs).values({
            id: generateId(),
            type: "HIT_CARRY_FORWARD",
            description: `GW${gameweekNumber}: ${fixture.homeTeam.name} score reduced by ${homeCarryForward} pts (carry-forward from GW${gameweekNumber - 1}: ${offenders})`,
            teamId: fixture.homeTeamId,
            gameweekId: gameweek.id,
            pointsAffected: -homeCarryForward,
          });
        }
        if (awayCarryForward > 0) {
          const offenders = fixture.awayTeam.players
            .filter((p: Player) => carryForwardMap.has(p.fplId))
            .map((p: Player) => `${p.name} (${carryForwardMap.get(p.fplId)} hits)`)
            .join(", ");
          await db.insert(auditLogs).values({
            id: generateId(),
            type: "HIT_CARRY_FORWARD",
            description: `GW${gameweekNumber}: ${fixture.awayTeam.name} score reduced by ${awayCarryForward} pts (carry-forward from GW${gameweekNumber - 1}: ${offenders})`,
            teamId: fixture.awayTeamId,
            gameweekId: gameweek.id,
            pointsAffected: -awayCarryForward,
          });
        }
      } catch (fixtureError) {
        console.error(`Error processing fixture ${fixture.id}:`, fixtureError);
        errors.push({
          fixtureId: fixture.id,
          homeTeam: fixture.homeTeam.name,
          awayTeam: fixture.awayTeam.name,
          error: fixtureError instanceof Error ? fixtureError.message : "Unknown error",
        });
      }
    }

    // ============================================
    // BONUS POINT CALCULATION (Per Group - Highest Margin)
    // ============================================
    const bonusResults: { teamId: string; margin: number; group: string; usedDoublePointer?: boolean; bonusPointsAwarded?: number }[] = [];
    
    for (const [groupId, margins] of groupMargins) {
      if (margins.length === 0) continue;
      
      // Find the highest margin in this group
      const highestMargin = Math.max(...margins.map(m => m.margin));
      
      // Get all teams with the highest margin (could be tied)
      const bonusWinners = margins.filter(m => m.margin === highestMargin);
      
      // Get group name for logging
      const groupRecord = await db.select().from(groups).where(eq(groups.id, groupId));
      const groupName = groupRecord[0]?.name || groupId;
      
      for (const winner of bonusWinners) {
        // Update result to mark bonus
        const resultRecord = await db.select().from(results).where(eq(results.id, winner.resultId));
        if (resultRecord[0]) {
          const fixtureRecord = await db.select().from(fixtures).where(eq(fixtures.id, resultRecord[0].fixtureId));
          const isHomeTeam = fixtureRecord[0]?.homeTeamId === winner.teamId;
          
          await db.update(results)
            .set({
              homeGotBonus: isHomeTeam ? true : resultRecord[0].homeGotBonus,
              awayGotBonus: !isHomeTeam ? true : resultRecord[0].awayGotBonus,
            })
            .where(eq(results.id, winner.resultId));
        }
        
        // Calculate bonus points (doubled if using Double Pointer)
        // Double Pointer: (2+1)*2 = 6 points total, so bonus is also doubled
        const bonusPointsToAward = winner.usedDoublePointer ? 2 : 1;
        
        // Update team league points (bonus as league points, not separate)
        // And update bonusPoints count for display
        const teamRecord = await db.select().from(teams).where(eq(teams.id, winner.teamId));
        if (teamRecord[0]) {
          await db.update(teams)
            .set({
              leaguePoints: teamRecord[0].leaguePoints + bonusPointsToAward,
              bonusPoints: teamRecord[0].bonusPoints + 1, // Count of bonuses earned (not points)
            })
            .where(eq(teams.id, winner.teamId));
        }
        
        bonusResults.push({
          teamId: winner.teamId,
          margin: winner.margin,
          group: groupName,
          usedDoublePointer: winner.usedDoublePointer,
          bonusPointsAwarded: bonusPointsToAward,
        });
      }
    }

    // ============================================
    // CHALLENGE CHIP PROCESSING (After regular fixtures)
    // ============================================
    const challengeResults = [];
    const challengeErrors = [];
    
    // Get all Challenge chips for this gameweek that haven't been processed
    const challengeChips = await db.select().from(gameweekChips).where(
      and(
        eq(gameweekChips.gameweekId, gameweek.id),
        eq(gameweekChips.chipType, "C"),
        eq(gameweekChips.isValid, true),
        eq(gameweekChips.isProcessed, false)
      )
    );

    for (const chip of challengeChips) {
      try {
        if (!chip.challengedTeamId) {
          // Invalid Challenge chip - no target specified
          await db.update(gameweekChips)
            .set({ 
              isProcessed: true, 
              pointsAwarded: 0,
              validationErrors: "No challenged team specified",
            })
            .where(eq(gameweekChips.id, chip.id));
          continue;
        }

        // Get challenger team with players
        const challengerTeamList = await db.query.teams.findMany({
          where: eq(teams.id, chip.teamId),
          with: { players: true },
        });
        const challengerTeam = challengerTeamList[0];

        // Get challenged team with players
        const challengedTeamList = await db.query.teams.findMany({
          where: eq(teams.id, chip.challengedTeamId),
          with: { players: true },
        });
        const challengedTeam = challengedTeamList[0];

        if (!challengerTeam || !challengedTeam) {
          await db.update(gameweekChips)
            .set({ 
              isProcessed: true, 
              pointsAwarded: 0,
              validationErrors: "Team not found",
            })
            .where(eq(gameweekChips.id, chip.id));
          continue;
        }

        // Get captain info for each team
        const challengerCaptain = gameweek.captains.find(
          (c: GameweekCaptain) => challengerTeam.players.some((p: Player) => p.id === c.playerId)
        );
        const challengedCaptain = gameweek.captains.find(
          (c: GameweekCaptain) => challengedTeam.players.some((p: Player) => p.id === c.playerId)
        );

        // Fetch FPL scores for challenger team
        const challengerScores = await Promise.all(
          challengerTeam.players.map(async (player: Player) => {
            const score = await calculateTeamGameweekScore(player.fplId, gameweekNumber, leagueId);
            return {
              playerId: player.id,
              isCaptain: challengerCaptain?.playerId === player.id,
              ...score,
            };
          })
        );

        // Fetch FPL scores for challenged team
        const challengedScores = await Promise.all(
          challengedTeam.players.map(async (player: Player) => {
            const score = await calculateTeamGameweekScore(player.fplId, gameweekNumber, leagueId);
            return {
              playerId: player.id,
              isCaptain: challengedCaptain?.playerId === player.id,
              ...score,
            };
          })
        );

        // Calculate TVT team scores
        // Pass raw `points` (not netScore) because calculateTVTTeamScore subtracts hits internally
        const challengerTeamScore = calculateTVTTeamScore(
          challengerScores.map((s) => ({
            fplScore: s.points,
            transferHits: s.transferHits,
            isCaptain: s.isCaptain,
          }))
        );

        const challengedTeamScore = calculateTVTTeamScore(
          challengedScores.map((s: PlayerScoreData) => ({
            fplScore: s.points,
            transferHits: s.transferHits,
            isCaptain: s.isCaptain,
          }))
        );

        // Apply carry-forward hit deduction from previous GW
        const challengerCarryForward = challengerTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );
        const challengedCarryForward = challengedTeam.players.reduce(
          (sum: number, p: Player) => sum + (carryForwardMap.get(p.fplId) ?? 0), 0
        );
        const effectiveChallengerScore = challengerTeamScore - challengerCarryForward;
        const effectiveChallengedScore = challengedTeamScore - challengedCarryForward;

        // Write AuditLog entries for challenge carry-forward deductions
        if (challengerCarryForward > 0) {
          const offenders = challengerTeam.players
            .filter((p: Player) => carryForwardMap.has(p.fplId))
            .map((p: Player) => `${p.name} (${carryForwardMap.get(p.fplId)} hits)`)
            .join(", ");
          await db.insert(auditLogs).values({
            id: generateId(),
            type: "HIT_CARRY_FORWARD",
            description: `GW${gameweekNumber} CC: ${challengerTeam.name} score reduced by ${challengerCarryForward} pts (carry-forward from GW${gameweekNumber - 1}: ${offenders})`,
            teamId: chip.teamId,
            gameweekId: gameweek.id,
            pointsAffected: -challengerCarryForward,
          });
        }
        if (challengedCarryForward > 0) {
          const offenders = challengedTeam.players
            .filter((p: Player) => carryForwardMap.has(p.fplId))
            .map((p: Player) => `${p.name} (${carryForwardMap.get(p.fplId)} hits)`)
            .join(", ");
          await db.insert(auditLogs).values({
            id: generateId(),
            type: "HIT_CARRY_FORWARD",
            description: `GW${gameweekNumber} CC: ${challengedTeam.name} score reduced by ${challengedCarryForward} pts (carry-forward from GW${gameweekNumber - 1}: ${offenders})`,
            teamId: chip.challengedTeamId!,
            gameweekId: gameweek.id,
            pointsAffected: -challengedCarryForward,
          });
        }

        // Determine challenge result (using effective scores with carry-forward applied)
        const challengeMatchResult = determineMatchResult(effectiveChallengerScore, effectiveChallengedScore);
        
        // Update chip with points awarded to challenger
        await db.update(gameweekChips)
          .set({ 
            isProcessed: true, 
            pointsAwarded: challengeMatchResult.homeMatchPoints,
          })
          .where(eq(gameweekChips.id, chip.id));

        // Update challenger team league points
        const currentChallengerTeam = await db.select().from(teams).where(eq(teams.id, chip.teamId));
        if (currentChallengerTeam[0]) {
          await db.update(teams)
            .set({
              leaguePoints: currentChallengerTeam[0].leaguePoints + challengeMatchResult.homeMatchPoints,
            })
            .where(eq(teams.id, chip.teamId));
        }

        challengeResults.push({
          chipId: chip.id,
          challenger: challengerTeam.name,
          challenged: challengedTeam.name,
          challengerScore: effectiveChallengerScore,
          challengedScore: effectiveChallengedScore,
          pointsAwarded: challengeMatchResult.homeMatchPoints,
        });
      } catch (challengeError) {
        console.error(`Error processing challenge chip ${chip.id}:`, challengeError);
        challengeErrors.push({
          chipId: chip.id,
          teamId: chip.teamId,
          error: challengeError instanceof Error ? challengeError.message : "Unknown error",
        });
      }
    }

    // Invalidate page cache so standings/fixtures/playoffs reflect new results
    if (gameweek.leagueId) {
      await invalidateLeaguePageCache(gameweek.leagueId);
    }

    return NextResponse.json({
      success: true,
      gameweek: gameweekNumber,
      processed: processedResults.length,
      failed: errors.length,
      results: processedResults,
      bonusPointsAwarded: bonusResults.length > 0 ? bonusResults : undefined,
      challengeResults: challengeResults.length > 0 ? challengeResults : undefined,
      errors: errors.length > 0 ? errors : undefined,
      challengeErrors: challengeErrors.length > 0 ? challengeErrors : undefined,
    });
  } catch (error) {
    console.error("Error processing gameweek:", error);
    return NextResponse.json(
      { error: "Failed to process gameweek" },
      { status: 500 }
    );
  }
}
