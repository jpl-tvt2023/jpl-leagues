import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { playoffTies, challengerSurvivalEntries, fixtures, results, gameweeks, teams, groups, gameweekCaptains, leagues } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { fetchTeamGameweekPicks, detectLiveGameweek } from "@/lib/fpl";
import { getLiveCachedScores, getCachedPlayoffBracket, setCachedPlayoffBracket } from "@/lib/fpl-cache";

// Seeding tables (same as generate-playoffs)
const RO16_SEEDING: [string, string, number, string, number][] = [
  ["RO16-A", "A", 1, "B", 8], ["RO16-B", "B", 1, "A", 8],
  ["RO16-C", "A", 2, "B", 7], ["RO16-D", "B", 2, "A", 7],
  ["RO16-E", "A", 3, "B", 6], ["RO16-F", "B", 3, "A", 6],
  ["RO16-G", "A", 4, "B", 5], ["RO16-H", "B", 4, "A", 5],
];

// Bracket-paired order: ties whose winners meet are adjacent
const RO16_BRACKET_ORDER = ["RO16-A", "RO16-H", "RO16-B", "RO16-G", "RO16-C", "RO16-F", "RO16-D", "RO16-E"];

const C31_SEEDING: [string, string, number, string, number][] = [
  ["C-31-A", "A", 9, "B", 14], ["C-31-B", "B", 9, "A", 14],
  ["C-31-C", "A", 10, "B", 13], ["C-31-D", "B", 10, "A", 13],
  ["C-31-E", "A", 11, "B", 12], ["C-31-F", "B", 11, "A", 12],
];

// QF seeding (W of RO16 ties)
const QF_SEEDING: [string, string, string][] = [
  ["QF-A", "RO16-A", "RO16-H"], ["QF-B", "RO16-B", "RO16-G"],
  ["QF-C", "RO16-C", "RO16-F"], ["QF-D", "RO16-D", "RO16-E"],
];
// SF seeding
const SF_SEEDING: [string, string, string][] = [
  ["SF-A", "QF-A", "QF-D"], ["SF-B", "QF-B", "QF-C"],
];

// Challenger round seedings for placeholder generation
const C32_SEEDING: [string, string, string][] = [
  ["C-32-A", "C-31-A", "C-31-F"], ["C-32-B", "C-31-B", "C-31-E"], ["C-32-C", "C-31-C", "C-31-D"],
];
const C35_SEEDING: [string, string, string][] = [
  ["C-35-A", "QF-A", "C-34-D"], ["C-35-B", "QF-B", "C-34-C"],
  ["C-35-C", "QF-C", "C-34-B"], ["C-35-D", "QF-D", "C-34-A"],
];
const C36_SEEDING: [string, string, string][] = [
  ["C-36-A", "C-35-A", "C-35-D"], ["C-36-B", "C-35-B", "C-35-C"],
];

interface TieDisplay {
  tieId: string;
  roundName: string;
  status: string;
  gw1: number;
  gw2: number | null;
  home: { teamId: string | null; name: string; abbr: string; leg1Score: number | null; leg2Score: number | null; aggregate: number | null } | null;
  away: { teamId: string | null; name: string; abbr: string; leg1Score: number | null; leg2Score: number | null; aggregate: number | null } | null;
  winnerId: string | null;
  loserId: string | null;
}

interface SurvivalDisplay {
  teamId: string;
  name: string;
  abbr: string;
  score: number;
  rank: number | null;
  advanced: boolean;
}

interface GroupStanding {
  teamId: string;
  name: string;
  abbr: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pointsFor: number;
  leaguePoints: number;
  advanced: boolean;
}

interface GroupData {
  name: string;
  roundPrefix: string;
  standings: GroupStanding[];
  fixtures: TieDisplay[];
}

/**
 * GET /api/playoffs/bracket
 * Returns full bracket state — tentative, projected, or live
 * tentative = GW<30 completed, bracket from current (changeable) standings
 * projected = GW30+ completed, bracket from final standings (not yet admin-generated)
 * live = playoff ties exist in DB
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const leagueSlug = searchParams.get("leagueSlug");

    // Resolve leagueId + league config from slug if provided
    let leagueId: string | null = null;
    let teamSize = 32;
    let playoffStartGw = 31;
    if (leagueSlug) {
      const league = await db.select({ id: leagues.id, teamSize: leagues.teamSize, playoffStartGw: leagues.playoffStartGw })
        .from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
      if (league.length > 0) {
        leagueId = league[0].id;
        teamSize = league[0].teamSize ?? 32;
        playoffStartGw = league[0].playoffStartGw ?? 31;
      }
    }

    // Return cached bracket if available (liveScores excluded from cache; page polls those separately)
    if (leagueId) {
      try {
        const cached = await getCachedPlayoffBracket(leagueId);
        if (cached) return NextResponse.json(cached);
      } catch {
        // Cache miss or Redis error — fall through to DB computation
      }
    }

    const tiesQuery = leagueId
      ? db.select().from(playoffTies).where(eq(playoffTies.leagueId, leagueId)).limit(1)
      : db.select().from(playoffTies).limit(1);
    const existingTies = await tiesQuery;
    const isLive = existingTies.length > 0;
    const leagueStageEnd = playoffStartGw - 1;
    const latestCompletedGw = await getLatestCompletedGw(leagueId);

    if (isLive) {
      const bracket = await buildLiveBracket(latestCompletedGw, leagueId, teamSize, playoffStartGw);
      const liveScores = await fetchLiveScoresForAllPlayoffGws(leagueId, playoffStartGw);
      // Fire-and-forget cache write (liveScores excluded; page polls those separately)
      if (leagueId) {
        setCachedPlayoffBracket(leagueId, bracket).catch(() => {});
      }
      return NextResponse.json({ ...bracket, liveScores });
    }

    // Not yet generated — show from standings
    const mode = latestCompletedGw >= leagueStageEnd ? "projected" : "tentative";
    const tentativeBracket = await buildTentativeBracket(latestCompletedGw, mode, leagueId, teamSize, playoffStartGw);
    if (leagueId) {
      setCachedPlayoffBracket(leagueId, tentativeBracket).catch(() => {});
    }
    return NextResponse.json(tentativeBracket);
  } catch (error) {
    console.error("Error fetching bracket:", error);
    return NextResponse.json({ error: "Failed to fetch bracket" }, { status: 500 });
  }
}

async function getLatestCompletedGw(leagueId?: string | null): Promise<number> {
  let query = db.select({ gwNumber: gameweeks.number })
    .from(results)
    .innerJoin(fixtures, eq(results.fixtureId, fixtures.id))
    .innerJoin(gameweeks, eq(fixtures.gameweekId, gameweeks.id));

  const latestResult = leagueId
    ? await query.where(eq(gameweeks.leagueId, leagueId)).orderBy(desc(gameweeks.number)).limit(1)
    : await query.orderBy(desc(gameweeks.number)).limit(1);

  return latestResult.length > 0 ? latestResult[0].gwNumber : 0;
}

/**
 * Fetch live scores for playoff GWs (31-38)
 * Uses correct data source based on GW status:
 * - Live GW: Fresh from Redis cache (populated by cron every 10 min)
 * - Finished GWs: From DB results table (locked by cron)
 * - Upcoming GWs: Empty (scores = 0)
 */
async function fetchLiveScoresForAllPlayoffGws(leagueId: string | null, playoffStartGw: number): Promise<Record<number, any[]>> {
  const liveScoresByGw: Record<number, any[]> = {};

  try {
    // Detect which GW is actually live
    const { liveGw, gwStatus } = await detectLiveGameweek();

    // Process each playoff GW from the league's playoffStartGw
    for (let gwNumber = playoffStartGw; gwNumber <= 38; gwNumber++) {
      const status = gwStatus[gwNumber];

      if (status === "notStarted") {
        // Upcoming GW - return empty
        liveScoresByGw[gwNumber] = [];
        continue;
      }

      if (status === "inProgress" && gwNumber === liveGw) {
        // Live GW - fetch from Redis cache (populated by cron every 10 min)
        try {
          const cachedData = await getLiveCachedScores(gwNumber);
          if (cachedData && cachedData.fixtures && cachedData.fixtures.length > 0) {
            liveScoresByGw[gwNumber] = cachedData.fixtures;
            console.log(`Bracket: Using cached live scores for GW${gwNumber}`);
            continue;
          } else {
            console.warn(`Bracket: No cached data for live GW${gwNumber}, falling back to FPL API`);
            // Cache miss - fetch from FPL API as fallback
            await fetchAndCacheLiveScoresForGw(gwNumber, leagueId);
            const retryData = await getLiveCachedScores(gwNumber);
            if (retryData && retryData.fixtures) {
              liveScoresByGw[gwNumber] = retryData.fixtures;
              continue;
            }
          }
        } catch (err) {
          console.error(`Bracket: Failed to fetch cached scores for GW${gwNumber}:`, err);
          // Silently skip this GW if cache fails
        }
      }

      if (status === "finished") {
        // Finished GW - fetch from DB results table
        try {
          const dbScores = await getFinishedGwScoresFromDb(gwNumber, leagueId);
          if (dbScores.length > 0) {
            liveScoresByGw[gwNumber] = dbScores;
            console.log(`Bracket: Using DB scores for finished GW${gwNumber}`);
            continue;
          }
        } catch (err) {
          console.error(`Bracket: Failed to fetch DB scores for GW${gwNumber}:`, err);
        }
      }

      // Default: return empty if nothing matches
      liveScoresByGw[gwNumber] = [];
    }
  } catch (error) {
    console.error("Error fetching live scores:", error);
  }

  return liveScoresByGw;
}

/**
 * Fetch finished GW scores from database (locked scores)
 */
async function getFinishedGwScoresFromDb(gameweek: number, leagueId: string | null): Promise<any[]> {
  const gwRecord = await db.query.gameweeks.findFirst({
    where: leagueId
      ? and(eq(gameweeks.number, gameweek), eq(gameweeks.leagueId, leagueId))
      : eq(gameweeks.number, gameweek),
  });

  if (!gwRecord) return [];

  // Get all playoff fixtures for this GW with team players for bifurcation
  const gwFixtures = await db.query.fixtures.findMany({
    where: and(
      eq(fixtures.gameweekId, gwRecord.id),
      eq(fixtures.isPlayoff, true)
    ),
    with: {
      homeTeam: { with: { players: true } },
      awayTeam: { with: { players: true } },
    },
  });

  if (gwFixtures.length === 0) return [];

  // Get captain picks for this GW to compute player-level breakdowns
  const captainPicks = await db.query.gameweekCaptains.findMany({
    where: eq(gameweekCaptains.gameweekId, gwRecord.id),
    with: { player: true },
  });

  const captainByTeamId = new Map<string, typeof captainPicks[0]>();
  for (const pick of captainPicks) {
    captainByTeamId.set(pick.player.teamId, pick);
  }

  // Helper to build player breakdown for a team side
  const buildPlayerBreakdown = (
    teamPlayers: { id: string; name: string; fplId: string; teamId: string }[],
    teamId: string,
    totalScore: number
  ) => {
    const captainPick = captainByTeamId.get(teamId);
    if (captainPick) {
      return teamPlayers.map(p => {
        const isCaptain = captainPick.playerId === p.id;
        if (isCaptain) {
          return {
            name: p.name, fplId: p.fplId, isCaptain: true,
            fplScore: captainPick.fplScore, transferHits: captainPick.transferHits,
            finalScore: captainPick.doubledScore,
          };
        } else {
          const nonCaptainScore = totalScore - captainPick.doubledScore;
          return {
            name: p.name, fplId: p.fplId, isCaptain: false,
            fplScore: nonCaptainScore, transferHits: 0,
            finalScore: nonCaptainScore,
          };
        }
      });
    }
    // No captain data — infer (least scorer doubled as captain)
    const captainBase = Math.floor((totalScore - 1) / 3);
    const captainDoubled = captainBase * 2;
    const nonCaptainScore = totalScore - captainDoubled;
    const sorted = [...teamPlayers].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((p, i) => ({
      name: p.name, fplId: p.fplId, isCaptain: i === 0,
      fplScore: i === 0 ? captainBase : nonCaptainScore, transferHits: 0,
      finalScore: i === 0 ? captainDoubled : nonCaptainScore,
    }));
  };

  // Get corresponding results from DB
  const gwLiveScores = [];
  for (const fixture of gwFixtures) {
    try {
      const result = await db.query.results.findFirst({
        where: eq(results.fixtureId, fixture.id),
      });

      if (result) {
        // Prefer stored player scores (TC format stores them; TVT uses captain reconstruction)
        const homePlayers = result.homePlayerScores
          ? JSON.parse(result.homePlayerScores)
          : buildPlayerBreakdown(fixture.homeTeam.players, fixture.homeTeamId, result.homeScore);
        const awayPlayers = result.awayPlayerScores
          ? JSON.parse(result.awayPlayerScores)
          : buildPlayerBreakdown(fixture.awayTeam.players, fixture.awayTeamId, result.awayScore);
        gwLiveScores.push({
          fixtureId: fixture.id,
          gameweek: gameweek,
          homeTeamName: fixture.homeTeam.name,
          awayTeamName: fixture.awayTeam.name,
          homeTeamAbbr: fixture.homeTeam.abbreviation,
          awayTeamAbbr: fixture.awayTeam.abbreviation,
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          homePlayers,
          awayPlayers,
        });
      }
    } catch (err) {
      console.error(`Error fetching DB result for fixture ${fixture.id}:`, err);
    }
  }

  return gwLiveScores;
}

/**
 * Fetch live scores from FPL API for a specific GW and cache in Redis
 * Used as fallback if Redis cache miss for live GW
 */
async function fetchAndCacheLiveScoresForGw(gameweek: number, leagueId: string | null): Promise<void> {
  try {
    const gwRecord = await db.query.gameweeks.findFirst({
      where: leagueId
        ? and(eq(gameweeks.number, gameweek), eq(gameweeks.leagueId, leagueId))
        : eq(gameweeks.number, gameweek),
    });

    if (!gwRecord) return;

    // Get all playoff fixtures for this GW
    const gwFixtures = await db.query.fixtures.findMany({
      where: and(
        eq(fixtures.gameweekId, gwRecord.id),
        eq(fixtures.isPlayoff, true)
      ),
      with: {
        homeTeam: { with: { players: true } },
        awayTeam: { with: { players: true } },
      },
    });

    if (gwFixtures.length === 0) return;

    // Get captain picks for this GW
    const captainPicks = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.gameweekId, gwRecord.id),
      with: { player: true },
    });

    const captainByTeamId = new Map<string, string>();
    for (const pick of captainPicks) {
      captainByTeamId.set(pick.player.teamId, pick.player.id);
    }

    // Calculate live scores for each fixture from FPL API
    const gwLiveScores = [];
    for (const fixture of gwFixtures) {
      try {
        const homeScore = await calculateLiveTeamScore(
          fixture.homeTeam.players,
          captainByTeamId.get(fixture.homeTeamId),
          gameweek
        );
        const awayScore = await calculateLiveTeamScore(
          fixture.awayTeam.players,
          captainByTeamId.get(fixture.awayTeamId),
          gameweek
        );

        gwLiveScores.push({
          fixtureId: fixture.id,
          gameweek: gameweek,  // Track which GW this score is from
          homeTeamName: fixture.homeTeam.name,
          awayTeamName: fixture.awayTeam.name,
          homeTeamAbbr: fixture.homeTeam.abbreviation,
          awayTeamAbbr: fixture.awayTeam.abbreviation,
          homeScore: homeScore.total,
          awayScore: awayScore.total,
          homePlayers: homeScore.players,
          awayPlayers: awayScore.players,
        });
      } catch (err) {
        console.error(`Live score error for fixture ${fixture.id}:`, err);
      }
    }

    if (gwLiveScores.length > 0) {
      const { setLiveCachedScores } = await import("@/lib/fpl-cache");
      await setLiveCachedScores(gameweek, {
        gameweek,
        fixtures: gwLiveScores,
        cachedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error(`Error fetching live scores for GW${gameweek}:`, error);
  }
}

/**
 * Calculate live score for a TVT team (2 FPL players + captaincy doubling)
 * Fetches always from FPL API (never cached)
 */
async function calculateLiveTeamScore(
  teamPlayers: { id: string; name: string; fplId: string }[],
  captainPlayerId: string | undefined,
  gameweek: number
): Promise<{
  total: number;
  players: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
}> {
  const playerScores = [];
  let total = 0;

  for (const player of teamPlayers) {
    try {
      // Fetch from FPL API - always fresh data
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek);
      const fplScore = picks.entry_history.points;
      const transferHits = picks.entry_history.event_transfers_cost;
      const netScore = fplScore - transferHits;
      const isCaptain = captainPlayerId === player.id;
      const finalScore = isCaptain ? netScore * 2 : netScore;

      playerScores.push({
        name: player.name,
        fplId: player.fplId,
        fplScore,
        transferHits,
        isCaptain,
        finalScore,
      });

      total += finalScore;
    } catch (err) {
      console.error(`Failed to fetch FPL data for player ${player.fplId} in GW${gameweek}:`, err);
      // Use 0 for this player
      playerScores.push({
        name: player.name,
        fplId: player.fplId,
        fplScore: 0,
        transferHits: 0,
        isCaptain: false,
        finalScore: 0,
      });
    }
  }

  return { total, players: playerScores };
}

// ============================================
// TENTATIVE / PROJECTED MODE
// ============================================
function placeholder(label: string): { teamId: null; name: string; abbr: string; leg1Score: null; leg2Score: null; aggregate: null } {
  return { teamId: null, name: label, abbr: label, leg1Score: null, leg2Score: null, aggregate: null };
}

/** 8-team bracket: SF (GW36, single-leg) → 3rd place (GW37) + Final (GW37+38, 2-legged). No challenger. */
function buildTentative8Team(
  latestCompletedGw: number,
  mode: "tentative" | "projected",
  standings: { groupA: { teamId: string; name: string; abbreviation: string; groupRank: number }[]; groupB: { teamId: string; name: string; abbreviation: string; groupRank: number }[] },
  playoffStartGw: number,
) {
  const all = standings.groupA; // 8-team has 1 group
  const ts = (rank: number) => {
    const t = all.find(x => x.groupRank === rank);
    return t ? { teamId: t.teamId, name: t.name, abbr: t.abbreviation, leg1Score: null, leg2Score: null, aggregate: null } : null;
  };
  const gw1 = playoffStartGw;
  const sf: TieDisplay[] = [
    { tieId: "SF-A", roundName: "SF", status: "projected", gw1, gw2: null, home: ts(1), away: ts(4), winnerId: null, loserId: null },
    { tieId: "SF-B", roundName: "SF", status: "projected", gw1, gw2: null, home: ts(2), away: ts(3), winnerId: null, loserId: null },
  ];
  const thirdPlace: TieDisplay = {
    tieId: "3rd", roundName: "3rd Place", status: "projected", gw1: gw1 + 1, gw2: gw1 + 2,
    home: placeholder("Loser of SF-A"), away: placeholder("Loser of SF-B"), winnerId: null, loserId: null,
  };
  const finalTie: TieDisplay = {
    tieId: "Final", roundName: "Final", status: "projected", gw1: gw1 + 1, gw2: gw1 + 2,
    home: placeholder("Winner of SF-A"), away: placeholder("Winner of SF-B"), winnerId: null, loserId: null,
  };
  return { mode, latestCompletedGw, teamSize: 8, tvt: { sf, thirdPlace: [thirdPlace], final: [finalTie] }, challenger: {} };
}

/** 16-team bracket: QF (GW31-32) → SF (GW33-34) → Final (GW35-36). Challenger C-31 to C-36. */
function buildTentative16Team(
  latestCompletedGw: number,
  mode: "tentative" | "projected",
  standings: { groupA: { teamId: string; name: string; abbreviation: string; groupRank: number }[]; groupB: { teamId: string; name: string; abbreviation: string; groupRank: number }[] },
  playoffStartGw: number,
) {
  const all = standings.groupA; // 16-team has 1 group
  const ts = (rank: number) => {
    const t = all.find(x => x.groupRank === rank);
    return t ? { teamId: t.teamId, name: t.name, abbr: t.abbreviation, leg1Score: null, leg2Score: null, aggregate: null } : null;
  };
  const gw1 = playoffStartGw;
  // QF: bracket-paired — 1v8 and 4v5 feed into SF-A; 2v7 and 3v6 feed into SF-B
  const qf: TieDisplay[] = [
    { tieId: "QF-A", roundName: "QF", status: "projected", gw1, gw2: gw1 + 1, home: ts(1), away: ts(8), winnerId: null, loserId: null },
    { tieId: "QF-D", roundName: "QF", status: "projected", gw1, gw2: gw1 + 1, home: ts(4), away: ts(5), winnerId: null, loserId: null },
    { tieId: "QF-B", roundName: "QF", status: "projected", gw1, gw2: gw1 + 1, home: ts(2), away: ts(7), winnerId: null, loserId: null },
    { tieId: "QF-C", roundName: "QF", status: "projected", gw1, gw2: gw1 + 1, home: ts(3), away: ts(6), winnerId: null, loserId: null },
  ];
  const sf: TieDisplay[] = [
    { tieId: "SF-A", roundName: "SF", status: "projected", gw1: gw1 + 2, gw2: gw1 + 3, home: placeholder("Winner of QF-A"), away: placeholder("Winner of QF-D"), winnerId: null, loserId: null },
    { tieId: "SF-B", roundName: "SF", status: "projected", gw1: gw1 + 2, gw2: gw1 + 3, home: placeholder("Winner of QF-B"), away: placeholder("Winner of QF-C"), winnerId: null, loserId: null },
  ];
  const finalTie: TieDisplay = {
    tieId: "Final", roundName: "Final", status: "projected", gw1: gw1 + 4, gw2: gw1 + 5,
    home: placeholder("Winner of SF-A"), away: placeholder("Winner of SF-B"), winnerId: null, loserId: null,
  };
  // Challenger (ranks 9-14, single group)
  const c31: TieDisplay[] = [
    { tieId: "C-31-A", roundName: "C-31", status: "projected", gw1, gw2: null, home: ts(9), away: ts(14), winnerId: null, loserId: null },
    { tieId: "C-31-B", roundName: "C-31", status: "projected", gw1, gw2: null, home: ts(10), away: ts(13), winnerId: null, loserId: null },
    { tieId: "C-31-C", roundName: "C-31", status: "projected", gw1, gw2: null, home: ts(11), away: ts(12), winnerId: null, loserId: null },
  ];
  // C-33 survival: 3 C-31 winners + 4 QF losers = 7 teams
  const c33Placeholder: SurvivalDisplay[] = [
    ...["C-31-A", "C-31-B", "C-31-C"].map(id => ({ teamId: "", name: `Winner of ${id}`, abbr: `Winner of ${id}`, score: 0, rank: null, advanced: false })),
    ...["QF-A", "QF-B", "QF-C", "QF-D"].map(id => ({ teamId: "", name: `Loser of ${id}`, abbr: `Loser of ${id}`, score: 0, rank: null, advanced: false })),
  ];
  // C-34: top 4 from survival
  const c34: TieDisplay[] = [
    { tieId: "C-34-A", roundName: "C-34", status: "projected", gw1: gw1 + 3, gw2: null, home: placeholder("Surv #1"), away: placeholder("Surv #4"), winnerId: null, loserId: null },
    { tieId: "C-34-B", roundName: "C-34", status: "projected", gw1: gw1 + 3, gw2: null, home: placeholder("Surv #2"), away: placeholder("Surv #3"), winnerId: null, loserId: null },
  ];
  const c35: TieDisplay[] = [
    { tieId: "C-35-A", roundName: "C-35", status: "projected", gw1: gw1 + 4, gw2: null, home: placeholder("Winner of C-34-A"), away: placeholder("Winner of C-34-B"), winnerId: null, loserId: null },
  ];
  const c36: TieDisplay[] = [
    { tieId: "C-36-A", roundName: "C-36", status: "projected", gw1: gw1 + 5, gw2: null, home: placeholder("Winner of C-35-A"), away: placeholder("Surv #5+"), winnerId: null, loserId: null },
  ];
  return {
    mode, latestCompletedGw, teamSize: 16,
    tvt: { qf, sf, final: [finalTie] },
    challenger: { c31, c33: c33Placeholder, c34, c35, c36 },
  };
}

async function buildTentativeTC(latestCompletedGw: number, mode: "tentative" | "projected", leagueId?: string | null) {
  // TC seeding: UCL = rank 1-2 per cup group, UEL = rank 3-4 per cup group
  // Cross-group QF pairing: A1 vs C2, A2 vs C1, B1 vs D2, B2 vs D1 (UCL)
  //                          A3 vs C4, A4 vs C3, B3 vs D4, B4 vs D3 (UEL)
  void leagueId; // reserved for future projected seed lookup

  const rankLabel = (rank: number) => rank === 1 ? "1st" : rank === 2 ? "2nd" : rank === 3 ? "3rd" : "4th";
  const tcSide = (group: string, rank: number): { teamId: null; name: string; abbr: string; leg1Score: null; leg2Score: null; aggregate: null } => {
    const label = `${rankLabel(rank)} Cup-${group}`;
    return { teamId: null, name: label, abbr: `${group}${rank}`, leg1Score: null, leg2Score: null, aggregate: null };
  };

  const uclQF: TieDisplay[] = [
    { tieId: "UCL-QF-1", roundName: "UCL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("A", 1), away: tcSide("C", 2), winnerId: null, loserId: null },
    { tieId: "UCL-QF-2", roundName: "UCL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("A", 2), away: tcSide("C", 1), winnerId: null, loserId: null },
    { tieId: "UCL-QF-3", roundName: "UCL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("B", 1), away: tcSide("D", 2), winnerId: null, loserId: null },
    { tieId: "UCL-QF-4", roundName: "UCL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("B", 2), away: tcSide("D", 1), winnerId: null, loserId: null },
  ];

  const uclSF: TieDisplay[] = [
    { tieId: "UCL-SF-1", roundName: "UCL-SF", status: "projected", gw1: 33, gw2: 35, home: placeholder("Winner of UCL-QF-1"), away: placeholder("Winner of UCL-QF-3"), winnerId: null, loserId: null },
    { tieId: "UCL-SF-2", roundName: "UCL-SF", status: "projected", gw1: 33, gw2: 35, home: placeholder("Winner of UCL-QF-2"), away: placeholder("Winner of UCL-QF-4"), winnerId: null, loserId: null },
  ];

  const uclFinal: TieDisplay[] = [
    { tieId: "UCL-FINAL", roundName: "UCL-FINAL", status: "projected", gw1: 38, gw2: null, home: placeholder("Winner of UCL-SF-1"), away: placeholder("Winner of UCL-SF-2"), winnerId: null, loserId: null },
  ];

  const uelQF: TieDisplay[] = [
    { tieId: "UEL-QF-1", roundName: "UEL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("A", 3), away: tcSide("C", 4), winnerId: null, loserId: null },
    { tieId: "UEL-QF-2", roundName: "UEL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("A", 4), away: tcSide("C", 3), winnerId: null, loserId: null },
    { tieId: "UEL-QF-3", roundName: "UEL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("B", 3), away: tcSide("D", 4), winnerId: null, loserId: null },
    { tieId: "UEL-QF-4", roundName: "UEL-QF", status: "projected", gw1: 27, gw2: 29, home: tcSide("B", 4), away: tcSide("D", 3), winnerId: null, loserId: null },
  ];

  const uelSF: TieDisplay[] = [
    { tieId: "UEL-SF-1", roundName: "UEL-SF", status: "projected", gw1: 33, gw2: 35, home: placeholder("Winner of UEL-QF-1"), away: placeholder("Winner of UEL-QF-3"), winnerId: null, loserId: null },
    { tieId: "UEL-SF-2", roundName: "UEL-SF", status: "projected", gw1: 33, gw2: 35, home: placeholder("Winner of UEL-QF-2"), away: placeholder("Winner of UEL-QF-4"), winnerId: null, loserId: null },
  ];

  const uelFinal: TieDisplay[] = [
    { tieId: "UEL-FINAL", roundName: "UEL-FINAL", status: "projected", gw1: 38, gw2: null, home: placeholder("Winner of UEL-SF-1"), away: placeholder("Winner of UEL-SF-2"), winnerId: null, loserId: null },
  ];

  return {
    mode,
    latestCompletedGw,
    teamSize: 20,
    tvt: { qf: uclQF, sf: uclSF, final: uclFinal },
    challenger: { c31: uelQF, c35: uelSF, c38: uelFinal },
  };
}

async function buildTentativeBracket(latestCompletedGw: number, mode: "tentative" | "projected", leagueId?: string | null, teamSize = 32, playoffStartGw = 31) {
  const standings = await getGroupStandings(leagueId);
  if (!standings) {
    return { mode, latestCompletedGw, teamSize, error: "Failed to compute standings", tvt: {}, challenger: {} };
  }

  // Branch by variant
  if (teamSize === 8) return buildTentative8Team(latestCompletedGw, mode, standings, playoffStartGw);
  if (teamSize === 16) return buildTentative16Team(latestCompletedGw, mode, standings, playoffStartGw);
  if (teamSize === 20) return buildTentativeTC(latestCompletedGw, mode, leagueId);

  const { groupA, groupB } = standings;
  const rankMap: Record<string, Record<number, { teamId: string; name: string; abbr: string }>> = { A: {}, B: {} };
  for (const t of groupA) rankMap["A"][t.groupRank] = { teamId: t.teamId, name: t.name, abbr: t.abbreviation };
  for (const t of groupB) rankMap["B"][t.groupRank] = { teamId: t.teamId, name: t.name, abbr: t.abbreviation };

  const lookup = (group: string, rank: number) => rankMap[group]?.[rank] || null;

  const teamSide = (group: string, rank: number) => {
    const t = lookup(group, rank);
    return t ? { teamId: t.teamId, name: t.name, abbr: t.abbr, leg1Score: null, leg2Score: null, aggregate: null } : null;
  };

  // Build tentative RO16 (in bracket-paired order)
  const ro16Map = new Map<string, TieDisplay>();
  for (const [tieId, hg, hr, ag, ar] of RO16_SEEDING) {
    ro16Map.set(tieId, {
      tieId, roundName: "RO16", status: "projected", gw1: 31, gw2: 32,
      home: teamSide(hg, hr), away: teamSide(ag, ar),
      winnerId: null, loserId: null,
    });
  }
  const ro16: TieDisplay[] = RO16_BRACKET_ORDER.map(id => ro16Map.get(id)!);

  // Build tentative QF with placeholder labels
  const qf: TieDisplay[] = QF_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "QF", status: "projected", gw1: 33, gw2: 34,
    home: placeholder(`Winner of ${h}`),
    away: placeholder(`Winner of ${a}`),
    winnerId: null, loserId: null,
  }));

  // Build tentative SF
  const sf: TieDisplay[] = SF_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "SF", status: "projected", gw1: 35, gw2: 36,
    home: placeholder(`Winner of ${h}`),
    away: placeholder(`Winner of ${a}`),
    winnerId: null, loserId: null,
  }));

  // Build tentative Final
  const finalTie: TieDisplay = {
    tieId: "Final", roundName: "Final", status: "projected", gw1: 37, gw2: 38,
    home: placeholder("Winner of SF-A"),
    away: placeholder("Winner of SF-B"),
    winnerId: null, loserId: null,
  };

  // --- Challenger placeholders ---
  const c31: TieDisplay[] = C31_SEEDING.map(([tieId, hg, hr, ag, ar]) => ({
    tieId, roundName: "C-31", status: "projected", gw1: 31, gw2: null,
    home: teamSide(hg, hr), away: teamSide(ag, ar),
    winnerId: null, loserId: null,
  }));

  const c32: TieDisplay[] = C32_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "C-32", status: "projected", gw1: 32, gw2: null,
    home: placeholder(`Winner of ${h}`),
    away: placeholder(`Winner of ${a}`),
    winnerId: null, loserId: null,
  }));

  // C-33 survival: placeholder list of 11 teams (3 C-32 winners + 8 RO16 losers)
  const c33Placeholder: SurvivalDisplay[] = [
    ...C32_SEEDING.map(([tieId]) => ({ teamId: "", name: `Winner of ${tieId}`, abbr: `Winner of ${tieId}`, score: 0, rank: null, advanced: false })),
    ...RO16_SEEDING.map(([tieId]) => ({ teamId: "", name: `Loser of ${tieId}`, abbr: `Loser of ${tieId}`, score: 0, rank: null, advanced: false })),
  ];

  // C-34: top 8 from survival, seeded 1v8, 2v7, 3v6, 4v5
  const c34: TieDisplay[] = [
    { tieId: "C-34-A", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #1"), away: placeholder("Surv #8"), winnerId: null, loserId: null },
    { tieId: "C-34-B", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #2"), away: placeholder("Surv #7"), winnerId: null, loserId: null },
    { tieId: "C-34-C", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #3"), away: placeholder("Surv #6"), winnerId: null, loserId: null },
    { tieId: "C-34-D", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #4"), away: placeholder("Surv #5"), winnerId: null, loserId: null },
  ];

  // C-35: QF losers vs C-34 winners
  const c35: TieDisplay[] = C35_SEEDING.map(([tieId, qfTie, c34Tie]) => ({
    tieId, roundName: "C-35", status: "projected", gw1: 35, gw2: null,
    home: placeholder(`Loser of ${qfTie}`),
    away: placeholder(`Winner of ${c34Tie}`),
    winnerId: null, loserId: null,
  }));

  // C-36
  const c36: TieDisplay[] = C36_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "C-36", status: "projected", gw1: 36, gw2: null,
    home: placeholder(`Winner of ${h}`),
    away: placeholder(`Winner of ${a}`),
    winnerId: null, loserId: null,
  }));

  // C-37: SF losers vs C-36 winners
  const c37: TieDisplay[] = [
    { tieId: "C-37-A", roundName: "C-37", status: "projected", gw1: 37, gw2: null,
      home: placeholder("Loser of SF-A"), away: placeholder("Winner of C-36-B"), winnerId: null, loserId: null },
    { tieId: "C-37-B", roundName: "C-37", status: "projected", gw1: 37, gw2: null,
      home: placeholder("Loser of SF-B"), away: placeholder("Winner of C-36-A"), winnerId: null, loserId: null },
  ];

  // C-38: Challenger Final
  const c38: TieDisplay[] = [
    { tieId: "C-38-A", roundName: "C-38", status: "projected", gw1: 38, gw2: null,
      home: placeholder("Winner of C-37-A"), away: placeholder("Winner of C-37-B"), winnerId: null, loserId: null },
  ];

  return {
    mode, latestCompletedGw, teamSize: 32,
    tvt: { ro16, qf, sf, final: [finalTie] },
    challenger: { c31, c32, c33: c33Placeholder, c34, c35, c36, c37, c38 },
  };
}

// ============================================
// LIVE MODE
// ============================================
async function buildLiveBracket(latestCompletedGw: number, leagueId?: string | null, teamSize = 32, playoffStartGw = 31) {
  // Fetch playoff ties for this league
  const allTiesRaw = await db.query.playoffTies.findMany({
    with: { homeTeam: true, awayTeam: true, winner: true, loser: true },
  });
  const allTies = leagueId ? allTiesRaw.filter(t => t.leagueId === leagueId) : allTiesRaw;

  // Build team name map for quick lookup
  const teamMap = new Map<string, { name: string; abbr: string }>();
  const allTeams = await db.select({ id: teams.id, name: teams.name, abbr: teams.abbreviation }).from(teams);
  for (const t of allTeams) teamMap.set(t.id, { name: t.name, abbr: t.abbr });

  // Fetch all playoff fixture results in one query
  const playoffFixtures = await db.select()
    .from(fixtures)
    .where(eq(fixtures.isPlayoff, true));

  const fixtureResults = new Map<string, { homeScore: number; awayScore: number }>();
  for (const f of playoffFixtures) {
    const r = await db.query.results.findFirst({ where: eq(results.fixtureId, f.id) });
    if (r) fixtureResults.set(f.id, { homeScore: r.homeScore, awayScore: r.awayScore });
  }

  // Build display ties
  const buildTieDisplay = (tie: typeof allTies[0]): TieDisplay => {
    const homeInfo = tie.homeTeamId ? teamMap.get(tie.homeTeamId) : null;
    const awayInfo = tie.awayTeamId ? teamMap.get(tie.awayTeamId) : null;

    let homeLeg1: number | null = null, homeLeg2: number | null = null;
    let awayLeg1: number | null = null, awayLeg2: number | null = null;

    if (tie.gw2) {
      // 2-legged
      const leg1Id = `playoff-${tie.tieId}-leg1`;
      const leg2Id = `playoff-${tie.tieId}-leg2`;
      const l1 = fixtureResults.get(leg1Id);
      const l2 = fixtureResults.get(leg2Id);
      if (l1) { homeLeg1 = l1.homeScore; awayLeg1 = l1.awayScore; }
      if (l2) { homeLeg2 = l2.awayScore; awayLeg2 = l2.homeScore; } // Swapped in leg2
    } else {
      // Single-leg
      const fId = `playoff-${tie.tieId}`;
      const r = fixtureResults.get(fId);
      if (r) { homeLeg1 = r.homeScore; awayLeg1 = r.awayScore; }
    }

    return {
      tieId: tie.tieId,
      roundName: tie.roundName,
      status: tie.status,
      gw1: tie.gw1,
      gw2: tie.gw2,
      home: tie.homeTeamId ? {
        teamId: tie.homeTeamId,
        name: homeInfo?.name || "TBD",
        abbr: homeInfo?.abbr || "?",
        leg1Score: homeLeg1,
        leg2Score: homeLeg2,
        aggregate: tie.status === "complete" ? tie.homeAggregate : null,
      } : null,
      away: tie.awayTeamId ? {
        teamId: tie.awayTeamId,
        name: awayInfo?.name || "TBD",
        abbr: awayInfo?.abbr || "?",
        leg1Score: awayLeg1,
        leg2Score: awayLeg2,
        aggregate: tie.status === "complete" ? tie.awayAggregate : null,
      } : null,
      winnerId: tie.winnerId,
      loserId: tie.loserId,
    };
  };

  const tiesByRound = (round: string) => allTies
    .filter(t => t.roundName === round)
    .map(buildTieDisplay)
    .sort((a, b) => a.tieId.localeCompare(b.tieId));

  // ── TRIPLE CROWN (teamSize === 20) ──────────────────────────────────────
  if (teamSize === 20) {
    return {
      mode: "live" as const,
      latestCompletedGw,
      teamSize: 20,
      tvt: {
        qf: tiesByRound("UCL-QF"),
        sf: tiesByRound("UCL-SF"),
        final: tiesByRound("UCL-FINAL"),
      },
      challenger: {
        c31: tiesByRound("UEL-QF"),
        c35: tiesByRound("UEL-SF"),
        c38: tiesByRound("UEL-FINAL"),
      },
    };
  }

  // Build winner/loser maps from completed ties for placeholder resolution
  const winnerMap = new Map<string, { teamId: string; name: string; abbr: string }>();
  const loserMap = new Map<string, { teamId: string; name: string; abbr: string }>();
  for (const tie of allTies) {
    if (tie.winnerId) {
      const info = teamMap.get(tie.winnerId);
      if (info) winnerMap.set(tie.tieId, { teamId: tie.winnerId, ...info });
    }
    if (tie.loserId) {
      const info = teamMap.get(tie.loserId);
      if (info) loserMap.set(tie.tieId, { teamId: tie.loserId, ...info });
    }
  }

  // Resolve a winner/loser reference: use real team if tie is complete, else placeholder label
  const resolveWinner = (srcTieId: string) => {
    const w = winnerMap.get(srcTieId);
    return w
      ? { teamId: w.teamId, name: w.name, abbr: w.abbr, leg1Score: null, leg2Score: null, aggregate: null }
      : placeholder(`Winner of ${srcTieId}`);
  };
  const resolveLoser = (srcTieId: string) => {
    const l = loserMap.get(srcTieId);
    return l
      ? { teamId: l.teamId, name: l.name, abbr: l.abbr, leg1Score: null, leg2Score: null, aggregate: null }
      : placeholder(`Loser of ${srcTieId}`);
  };

  // RO16: bracket-paired order so adjacent matches feed into same QF
  const ro16Ties = allTies.filter(t => t.roundName === "RO16").map(buildTieDisplay);
  const ro16Map = new Map(ro16Ties.map(t => [t.tieId, t]));
  const ro16Ordered = RO16_BRACKET_ORDER.map(id => ro16Map.get(id)).filter(Boolean) as TieDisplay[];

  // For each round: use DB ties if available, else generate placeholders with resolved names
  const qfFromDb = tiesByRound("QF");
  const qf = qfFromDb.length > 0 ? qfFromDb : QF_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "QF", status: "projected", gw1: 33, gw2: 34,
    home: resolveWinner(h), away: resolveWinner(a), winnerId: null, loserId: null,
  }));

  const sfFromDb = tiesByRound("SF");
  const sf = sfFromDb.length > 0 ? sfFromDb : SF_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "SF", status: "projected", gw1: 35, gw2: 36,
    home: resolveWinner(h), away: resolveWinner(a), winnerId: null, loserId: null,
  }));

  const finalFromDb = tiesByRound("Final");
  const finalTies = finalFromDb.length > 0 ? finalFromDb : [{
    tieId: "Final", roundName: "Final", status: "projected", gw1: 37, gw2: 38,
    home: resolveWinner("SF-A"), away: resolveWinner("SF-B"), winnerId: null, loserId: null,
  }];

  // Challenger rounds
  const c31 = tiesByRound("C-31");

  const c32FromDb = tiesByRound("C-32");
  const c32 = c32FromDb.length > 0 ? c32FromDb : C32_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "C-32", status: "projected", gw1: 32, gw2: null,
    home: resolveWinner(h), away: resolveWinner(a), winnerId: null, loserId: null,
  }));

  // C-33 Survival
  const survivalEntries: SurvivalDisplay[] = [];
  const gw33 = await db.query.gameweeks.findFirst({ where: eq(gameweeks.number, 33) });
  if (gw33) {
    const entries = await db.select().from(challengerSurvivalEntries)
      .where(eq(challengerSurvivalEntries.gameweekId, gw33.id));
    for (const e of entries) {
      const info = teamMap.get(e.teamId);
      survivalEntries.push({
        teamId: e.teamId,
        name: info?.name || "Unknown",
        abbr: info?.abbr || "?",
        score: e.score,
        rank: e.rank,
        advanced: e.advanced,
      });
    }
    survivalEntries.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  }
  // If no survival entries in DB yet, build placeholders from known winners/losers
  const c33: SurvivalDisplay[] = survivalEntries.length > 0 ? survivalEntries : [
    ...C32_SEEDING.map(([tieId]) => {
      const w = winnerMap.get(tieId);
      return { teamId: w?.teamId || "", name: w?.name || `Winner of ${tieId}`, abbr: w?.abbr || `Winner of ${tieId}`, score: 0, rank: null, advanced: false };
    }),
    ...RO16_SEEDING.map(([tieId]) => {
      const l = loserMap.get(tieId);
      return { teamId: l?.teamId || "", name: l?.name || `Loser of ${tieId}`, abbr: l?.abbr || `Loser of ${tieId}`, score: 0, rank: null, advanced: false };
    }),
  ];

  const c34FromDb = tiesByRound("C-34");
  const c34 = c34FromDb.length > 0 ? c34FromDb : [
    { tieId: "C-34-A", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #1"), away: placeholder("Surv #8"), winnerId: null, loserId: null },
    { tieId: "C-34-B", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #2"), away: placeholder("Surv #7"), winnerId: null, loserId: null },
    { tieId: "C-34-C", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #3"), away: placeholder("Surv #6"), winnerId: null, loserId: null },
    { tieId: "C-34-D", roundName: "C-34", status: "projected", gw1: 34, gw2: null,
      home: placeholder("Surv #4"), away: placeholder("Surv #5"), winnerId: null, loserId: null },
  ];

  const c35FromDb = tiesByRound("C-35");
  const c35 = c35FromDb.length > 0 ? c35FromDb : C35_SEEDING.map(([tieId, qfTie, c34Tie]) => ({
    tieId, roundName: "C-35", status: "projected", gw1: 35, gw2: null,
    home: resolveLoser(qfTie), away: resolveWinner(c34Tie), winnerId: null, loserId: null,
  }));

  const c36FromDb = tiesByRound("C-36");
  const c36 = c36FromDb.length > 0 ? c36FromDb : C36_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "C-36", status: "projected", gw1: 36, gw2: null,
    home: resolveWinner(h), away: resolveWinner(a), winnerId: null, loserId: null,
  }));

  const c37FromDb = tiesByRound("C-37");
  const c37 = c37FromDb.length > 0 ? c37FromDb : [
    { tieId: "C-37-A", roundName: "C-37", status: "projected", gw1: 37, gw2: null,
      home: resolveLoser("SF-A"), away: resolveWinner("C-36-B"), winnerId: null, loserId: null },
    { tieId: "C-37-B", roundName: "C-37", status: "projected", gw1: 37, gw2: null,
      home: resolveLoser("SF-B"), away: resolveWinner("C-36-A"), winnerId: null, loserId: null },
  ];

  const c38FromDb = tiesByRound("C-38");
  const c38 = c38FromDb.length > 0 ? c38FromDb : [{
    tieId: "C-38-A", roundName: "C-38", status: "projected", gw1: 38, gw2: null,
    home: resolveWinner("C-37-A"), away: resolveWinner("C-37-B"), winnerId: null, loserId: null,
  }];

  // Helper to build group stage data (for 16-team format)
  const buildGroupData = (roundPrefix: string, displayName: string): GroupData => {
    const fixtures = tiesByRound(roundPrefix);

    // Build standings from completed ties
    const teamStats = new Map<string, GroupStanding>();

    for (const tie of fixtures) {
      // Add teams if not already in map
      if (tie.home?.teamId && !teamStats.has(tie.home.teamId)) {
        teamStats.set(tie.home.teamId, {
          teamId: tie.home.teamId,
          name: tie.home.name,
          abbr: tie.home.abbr,
          played: 0,
          won: 0,
          drawn: 0,
          lost: 0,
          pointsFor: 0,
          leaguePoints: 0,
          advanced: false,
        });
      }
      if (tie.away?.teamId && !teamStats.has(tie.away.teamId)) {
        teamStats.set(tie.away.teamId, {
          teamId: tie.away.teamId,
          name: tie.away.name,
          abbr: tie.away.abbr,
          played: 0,
          won: 0,
          drawn: 0,
          lost: 0,
          pointsFor: 0,
          leaguePoints: 0,
          advanced: false,
        });
      }

      // Update stats from completed tie
      if (tie.home?.teamId && tie.away?.teamId) {
        const homeStat = teamStats.get(tie.home.teamId)!;
        const awayStat = teamStats.get(tie.away.teamId)!;

        const homeScore = tie.home.leg1Score ?? 0;
        const awayScore = tie.away.leg1Score ?? 0;

        homeStat.pointsFor += homeScore;
        awayStat.pointsFor += awayScore;

        if (tie.winnerId) {
          // Tie is complete
          if (tie.winnerId === tie.home.teamId) {
            homeStat.won++;
            awayStat.lost++;
          } else {
            awayStat.won++;
            homeStat.lost++;
          }
          homeStat.played++;
          awayStat.played++;
          homeStat.leaguePoints = homeStat.won * 2 + homeStat.drawn;
          awayStat.leaguePoints = awayStat.won * 2 + awayStat.drawn;
        } else if (homeScore === awayScore && homeScore !== 0) {
          // Draw
          homeStat.drawn++;
          awayStat.drawn++;
          homeStat.played++;
          awayStat.played++;
          homeStat.leaguePoints = homeStat.won * 2 + homeStat.drawn;
          awayStat.leaguePoints = awayStat.won * 2 + awayStat.drawn;
        }
      }
    }

    // Sort standings by league points desc, then points for desc
    const standings = Array.from(teamStats.values()).sort((a, b) => {
      if (a.leaguePoints !== b.leaguePoints) return b.leaguePoints - a.leaguePoints;
      return b.pointsFor - a.pointsFor;
    });

    // Mark top 2 as advanced if group stage is complete (all 6 matches done)
    const totalMatches = fixtures.filter(f => f.winnerId !== null).length;
    if (totalMatches === 6) {
      standings[0].advanced = true;
      standings[1].advanced = true;
    }

    return {
      name: displayName,
      roundPrefix,
      standings,
      fixtures,
    };
  };

  // Branch output by variant
  if (teamSize === 8) {
    const sfLive = tiesByRound("8T-SF");
    const thirdPlaceLive = tiesByRound("8T-3RD");
    const finalLive = tiesByRound("8T-FINAL");
    return {
      mode: "live", latestCompletedGw, teamSize: 8,
      tvt: {
        sf: sfLive.length > 0 ? sfLive : [
          { tieId: "8T-SF-A", roundName: "8T-SF", status: "projected", gw1: playoffStartGw, gw2: null, home: placeholder("1st"), away: placeholder("4th"), winnerId: null, loserId: null },
          { tieId: "8T-SF-B", roundName: "8T-SF", status: "projected", gw1: playoffStartGw, gw2: null, home: placeholder("2nd"), away: placeholder("3rd"), winnerId: null, loserId: null },
        ],
        thirdPlace: thirdPlaceLive.length > 0 ? thirdPlaceLive : [
          { tieId: "8T-3RD", roundName: "8T-3RD", status: "projected", gw1: playoffStartGw + 1, gw2: playoffStartGw + 2, home: resolveLoser("8T-SF-A"), away: resolveLoser("8T-SF-B"), winnerId: null, loserId: null },
        ],
        final: finalLive.length > 0 ? finalLive : [
          { tieId: "8T-FINAL", roundName: "8T-FINAL", status: "projected", gw1: playoffStartGw + 1, gw2: playoffStartGw + 2, home: resolveWinner("8T-SF-A"), away: resolveWinner("8T-SF-B"), winnerId: null, loserId: null },
        ],
      },
      challenger: {},
    };
  }

  if (teamSize === 16) {
    // 16T championship path: Group Stage → Elite Seeding (GW34) → SF (GW35-36) → Final (GW37-38)
    // "qf" slot maps to the 2 Elite Seeding matches (16T-ES-M1/M2)
    const qfLive = tiesByRound("16T-ES");
    const sfLive = tiesByRound("16T-SF");
    const finalLive = tiesByRound("16T-FINAL");

    // Build group stage data
    const groupStageData = [
      buildGroupData("16T-CA", "Championship Group A"),
      buildGroupData("16T-CB", "Championship Group B"),
      buildGroupData("16T-XA", "Challenger Group A"),
      buildGroupData("16T-XB", "Challenger Group B"),
    ];

    // Challenger rounds with placeholders
    const c34Live = tiesByRound("16T-QF");
    const c35Live = tiesByRound("16T-CSF");
    const c36Live = tiesByRound("16T-CFINAL");

    return {
      mode: "live", latestCompletedGw, teamSize: 16,
      groupStage: { groups: groupStageData },
      tvt: {
        qf: qfLive.length > 0 ? qfLive : [
          { tieId: "16T-ES-M1", roundName: "16T-ES", status: "projected", gw1: playoffStartGw + 3, gw2: null, home: placeholder("Champ A1"), away: placeholder("Champ B1"), winnerId: null, loserId: null },
          { tieId: "16T-ES-M2", roundName: "16T-ES", status: "projected", gw1: playoffStartGw + 3, gw2: null, home: placeholder("Champ A2"), away: placeholder("Champ B2"), winnerId: null, loserId: null },
        ],
        // SF-A: ES-M1 winner vs ES-M2 loser (Seed#1 vs Seed#4), SF-B: ES-M1 loser vs ES-M2 winner (Seed#2 vs Seed#3)
        sf: sfLive.length > 0 ? sfLive : [
          { tieId: "16T-SF-A", roundName: "16T-SF", status: "projected", gw1: playoffStartGw + 4, gw2: playoffStartGw + 5, home: resolveWinner("16T-ES-M1"), away: resolveLoser("16T-ES-M2"), winnerId: null, loserId: null },
          { tieId: "16T-SF-B", roundName: "16T-SF", status: "projected", gw1: playoffStartGw + 4, gw2: playoffStartGw + 5, home: resolveLoser("16T-ES-M1"), away: resolveWinner("16T-ES-M2"), winnerId: null, loserId: null },
        ],
        final: finalLive.length > 0 ? finalLive : [
          { tieId: "16T-FINAL", roundName: "16T-FINAL", status: "projected", gw1: playoffStartGw + 6, gw2: playoffStartGw + 7, home: resolveWinner("16T-SF-A"), away: resolveWinner("16T-SF-B"), winnerId: null, loserId: null },
        ],
      },
      challenger: {
        c31: [],
        c33: [],
        c34: c34Live.length > 0 ? c34Live : [
          { tieId: "16T-QF1", roundName: "16T-QF", status: "projected", gw1: playoffStartGw + 3, gw2: null, home: placeholder("Champ A 3rd"), away: placeholder("Chall B 2nd"), winnerId: null, loserId: null },
          { tieId: "16T-QF2", roundName: "16T-QF", status: "projected", gw1: playoffStartGw + 3, gw2: null, home: placeholder("Champ B 3rd"), away: placeholder("Chall A 2nd"), winnerId: null, loserId: null },
          { tieId: "16T-QF3", roundName: "16T-QF", status: "projected", gw1: playoffStartGw + 3, gw2: null, home: placeholder("Champ A 4th"), away: placeholder("Chall B 1st"), winnerId: null, loserId: null },
          { tieId: "16T-QF4", roundName: "16T-QF", status: "projected", gw1: playoffStartGw + 3, gw2: null, home: placeholder("Champ B 4th"), away: placeholder("Chall A 1st"), winnerId: null, loserId: null },
        ],
        c35: c35Live.length > 0 ? c35Live : [
          { tieId: "16T-CSF-A", roundName: "16T-CSF", status: "projected", gw1: playoffStartGw + 4, gw2: playoffStartGw + 5, home: resolveWinner("16T-QF1"), away: resolveWinner("16T-QF4"), winnerId: null, loserId: null },
          { tieId: "16T-CSF-B", roundName: "16T-CSF", status: "projected", gw1: playoffStartGw + 4, gw2: playoffStartGw + 5, home: resolveWinner("16T-QF2"), away: resolveWinner("16T-QF3"), winnerId: null, loserId: null },
        ],
        c36: c36Live.length > 0 ? c36Live : [
          { tieId: "16T-CFINAL", roundName: "16T-CFINAL", status: "projected", gw1: playoffStartGw + 6, gw2: playoffStartGw + 7, home: resolveWinner("16T-CSF-A"), away: resolveWinner("16T-CSF-B"), winnerId: null, loserId: null },
        ],
      },
    };
  }

  return {
    mode: "live",
    latestCompletedGw,
    teamSize: 32,
    tvt: {
      ro16: ro16Ordered,
      qf,
      sf,
      final: finalTies,
    },
    challenger: {
      c31, c32, c33, c34, c35, c36, c37, c38,
    },
  };
}

// ============================================
// Standings computation (copy from generate-playoffs)
// ============================================
async function getGroupStandings(leagueId?: string | null) {
  try {
    const allTeamsRaw = await db.query.teams.findMany({
      with: {
        group: true,
        players: true,
        homeFixtures: { with: { result: true, gameweek: true } },
        awayFixtures: { with: { result: true, gameweek: true } },
      },
    });
    const allTeams = leagueId ? allTeamsRaw.filter(t => t.leagueId === leagueId) : allTeamsRaw;

    const allChipsRaw = await db.query.gameweekChips.findMany({ with: { gameweek: true } });
    const chipPointsByTeam = new Map<string, number>();
    for (const chip of allChipsRaw) {
      if (chip.isProcessed) {
        const pts = chip.pointsAwarded || 0;
        if (chip.chipType === "C" || pts > 0) {
          chipPointsByTeam.set(chip.teamId, (chipPointsByTeam.get(chip.teamId) || 0) + pts);
        }
      }
    }

    const standings = allTeams.filter(t => !t.group || t.group.name !== "Playoffs").map((team) => {
      let wins = 0, draws = 0, pointsFor = 0, bonusPtsTotal = 0;

      for (const fixture of team.homeFixtures) {
        if (fixture.result && !fixture.isPlayoff && (!fixture.competitionType || fixture.competitionType === "pl")) {
          pointsFor += fixture.result.homeScore;
          if (fixture.result.homeScore > fixture.result.awayScore) wins++;
          else if (fixture.result.homeScore === fixture.result.awayScore) draws++;
          if (fixture.result.homeGotBonus) bonusPtsTotal += fixture.result.homeUsedDoublePointer ? 2 : 1;
        }
      }

      for (const fixture of team.awayFixtures) {
        if (fixture.result && !fixture.isPlayoff && (!fixture.competitionType || fixture.competitionType === "pl")) {
          pointsFor += fixture.result.awayScore;
          if (fixture.result.awayScore > fixture.result.homeScore) wins++;
          else if (fixture.result.awayScore === fixture.result.homeScore) draws++;
          if (fixture.result.awayGotBonus) bonusPtsTotal += fixture.result.awayUsedDoublePointer ? 2 : 1;
        }
      }

      const chipPts = chipPointsByTeam.get(team.id) || 0;
      const cbpPts = chipPts + bonusPtsTotal;

      return {
        teamId: team.id,
        name: team.name,
        abbreviation: team.abbreviation,
        group: team.group?.name ?? null,
        leaguePoints: (wins * 2) + draws + cbpPts,
        pointsFor,
        cbpPoints: cbpPts,
        groupRank: 0,
      };
    });

    const sortFn = (a: typeof standings[0], b: typeof standings[0]) => {
      if (a.leaguePoints !== b.leaguePoints) return b.leaguePoints - a.leaguePoints;
      if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
      return b.cbpPoints - a.cbpPoints;
    };

    const groupA = standings.filter(t => t.group === "A").sort(sortFn).map((t, i) => ({ ...t, groupRank: i + 1 }));
    const groupB = standings.filter(t => t.group === "B").sort(sortFn).map((t, i) => ({ ...t, groupRank: i + 1 }));

    // For groupless formats (8-team, 16-team), all teams go into groupA
    if (groupA.length === 0 && groupB.length === 0 && standings.length > 0) {
      const all = standings.sort(sortFn).map((t, i) => ({ ...t, group: "A", groupRank: i + 1 }));
      return { groupA: all, groupB: [] };
    }

    return { groupA, groupB };
  } catch (error) {
    console.error("Error computing group standings:", error);
    return null;
  }
}
