import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { playoffTies, challengerSurvivalEntries, fixtures, results, gameweeks, teams, groups, gameweekCaptains, leagues } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { fetchTeamGameweekPicks, detectLiveGameweek } from "@/lib/fpl";
import { getLiveCachedScores } from "@/lib/fpl-cache";

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

    const tiesQuery = leagueId
      ? db.select().from(playoffTies).where(eq(playoffTies.leagueId, leagueId)).limit(1)
      : db.select().from(playoffTies).limit(1);
    const existingTies = await tiesQuery;
    const isLive = existingTies.length > 0;
    const leagueStageEnd = playoffStartGw - 1;
    const latestCompletedGw = await getLatestCompletedGw(leagueId);

    if (isLive) {
      const bracket = await buildLiveBracket(latestCompletedGw, leagueId, teamSize, playoffStartGw);
      const liveScores = await fetchLiveScoresForAllPlayoffGws();
      return NextResponse.json({ ...bracket, liveScores });
    }

    // Not yet generated — show from standings
    const mode = latestCompletedGw >= leagueStageEnd ? "projected" : "tentative";
    return NextResponse.json(await buildTentativeBracket(latestCompletedGw, mode, leagueId, teamSize, playoffStartGw));
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
async function fetchLiveScoresForAllPlayoffGws(): Promise<Record<number, any[]>> {
  const liveScoresByGw: Record<number, any[]> = {};

  try {
    // Detect which GW is actually live
    const { liveGw, gwStatus } = await detectLiveGameweek();

    // Process each playoff GW
    for (let gwNumber = 31; gwNumber <= 38; gwNumber++) {
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
            await fetchAndCacheLiveScoresForGw(gwNumber);
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
          const dbScores = await getFinishedGwScoresFromDb(gwNumber);
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
async function getFinishedGwScoresFromDb(gameweek: number): Promise<any[]> {
  const gwRecord = await db.query.gameweeks.findFirst({
    where: eq(gameweeks.number, gameweek),
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
        gwLiveScores.push({
          fixtureId: fixture.id,
          gameweek: gameweek,
          homeTeamName: fixture.homeTeam.name,
          awayTeamName: fixture.awayTeam.name,
          homeTeamAbbr: fixture.homeTeam.abbreviation,
          awayTeamAbbr: fixture.awayTeam.abbreviation,
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          homePlayers: buildPlayerBreakdown(fixture.homeTeam.players, fixture.homeTeamId, result.homeScore),
          awayPlayers: buildPlayerBreakdown(fixture.awayTeam.players, fixture.awayTeamId, result.awayScore),
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
async function fetchAndCacheLiveScoresForGw(gameweek: number): Promise<void> {
  try {
    const gwRecord = await db.query.gameweeks.findFirst({
      where: eq(gameweeks.number, gameweek),
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
    tieId: "3rd", roundName: "3rd Place", status: "projected", gw1: gw1 + 1, gw2: null,
    home: placeholder("L SF-A"), away: placeholder("L SF-B"), winnerId: null, loserId: null,
  };
  const finalTie: TieDisplay = {
    tieId: "Final", roundName: "Final", status: "projected", gw1: gw1 + 1, gw2: gw1 + 2,
    home: placeholder("W SF-A"), away: placeholder("W SF-B"), winnerId: null, loserId: null,
  };
  return { mode, latestCompletedGw, tvt: { sf, thirdPlace: [thirdPlace], final: [finalTie] }, challenger: {} };
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
    { tieId: "SF-A", roundName: "SF", status: "projected", gw1: gw1 + 2, gw2: gw1 + 3, home: placeholder("W QF-A"), away: placeholder("W QF-D"), winnerId: null, loserId: null },
    { tieId: "SF-B", roundName: "SF", status: "projected", gw1: gw1 + 2, gw2: gw1 + 3, home: placeholder("W QF-B"), away: placeholder("W QF-C"), winnerId: null, loserId: null },
  ];
  const finalTie: TieDisplay = {
    tieId: "Final", roundName: "Final", status: "projected", gw1: gw1 + 4, gw2: gw1 + 5,
    home: placeholder("W SF-A"), away: placeholder("W SF-B"), winnerId: null, loserId: null,
  };
  // Challenger (ranks 9-14, single group)
  const c31: TieDisplay[] = [
    { tieId: "C-31-A", roundName: "C-31", status: "projected", gw1, gw2: null, home: ts(9), away: ts(14), winnerId: null, loserId: null },
    { tieId: "C-31-B", roundName: "C-31", status: "projected", gw1, gw2: null, home: ts(10), away: ts(13), winnerId: null, loserId: null },
    { tieId: "C-31-C", roundName: "C-31", status: "projected", gw1, gw2: null, home: ts(11), away: ts(12), winnerId: null, loserId: null },
  ];
  // C-33 survival: 3 C-31 winners + 4 QF losers = 7 teams
  const c33Placeholder: SurvivalDisplay[] = [
    ...["C-31-A", "C-31-B", "C-31-C"].map(id => ({ teamId: "", name: `W ${id}`, abbr: `W ${id}`, score: 0, rank: null, advanced: false })),
    ...["QF-A", "QF-B", "QF-C", "QF-D"].map(id => ({ teamId: "", name: `L ${id}`, abbr: `L ${id}`, score: 0, rank: null, advanced: false })),
  ];
  // C-34: top 4 from survival
  const c34: TieDisplay[] = [
    { tieId: "C-34-A", roundName: "C-34", status: "projected", gw1: gw1 + 3, gw2: null, home: placeholder("Surv #1"), away: placeholder("Surv #4"), winnerId: null, loserId: null },
    { tieId: "C-34-B", roundName: "C-34", status: "projected", gw1: gw1 + 3, gw2: null, home: placeholder("Surv #2"), away: placeholder("Surv #3"), winnerId: null, loserId: null },
  ];
  const c35: TieDisplay[] = [
    { tieId: "C-35-A", roundName: "C-35", status: "projected", gw1: gw1 + 4, gw2: null, home: placeholder("W C-34-A"), away: placeholder("W C-34-B"), winnerId: null, loserId: null },
  ];
  const c36: TieDisplay[] = [
    { tieId: "C-36-A", roundName: "C-36", status: "projected", gw1: gw1 + 5, gw2: null, home: placeholder("W C-35-A"), away: placeholder("Surv #5+"), winnerId: null, loserId: null },
  ];
  return {
    mode, latestCompletedGw,
    tvt: { qf, sf, final: [finalTie] },
    challenger: { c31, c33: c33Placeholder, c34, c35, c36 },
  };
}

async function buildTentativeBracket(latestCompletedGw: number, mode: "tentative" | "projected", leagueId?: string | null, teamSize = 32, playoffStartGw = 31) {
  const standings = await getGroupStandings(leagueId);
  if (!standings) {
    return { mode, latestCompletedGw, error: "Failed to compute standings", tvt: {}, challenger: {} };
  }

  // Branch by variant
  if (teamSize === 8) return buildTentative8Team(latestCompletedGw, mode, standings, playoffStartGw);
  if (teamSize === 16) return buildTentative16Team(latestCompletedGw, mode, standings, playoffStartGw);

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
    home: placeholder(`W ${h}`),
    away: placeholder(`W ${a}`),
    winnerId: null, loserId: null,
  }));

  // Build tentative SF
  const sf: TieDisplay[] = SF_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "SF", status: "projected", gw1: 35, gw2: 36,
    home: placeholder(`W ${h}`),
    away: placeholder(`W ${a}`),
    winnerId: null, loserId: null,
  }));

  // Build tentative Final
  const finalTie: TieDisplay = {
    tieId: "Final", roundName: "Final", status: "projected", gw1: 37, gw2: 38,
    home: placeholder("W SF-A"),
    away: placeholder("W SF-B"),
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
    home: placeholder(`W ${h}`),
    away: placeholder(`W ${a}`),
    winnerId: null, loserId: null,
  }));

  // C-33 survival: placeholder list of 11 teams (3 C-32 winners + 8 RO16 losers)
  const c33Placeholder: SurvivalDisplay[] = [
    ...C32_SEEDING.map(([tieId]) => ({ teamId: "", name: `W ${tieId}`, abbr: `W ${tieId}`, score: 0, rank: null, advanced: false })),
    ...RO16_SEEDING.map(([tieId]) => ({ teamId: "", name: `L ${tieId}`, abbr: `L ${tieId}`, score: 0, rank: null, advanced: false })),
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
    home: placeholder(`L ${qfTie}`),
    away: placeholder(`W ${c34Tie}`),
    winnerId: null, loserId: null,
  }));

  // C-36
  const c36: TieDisplay[] = C36_SEEDING.map(([tieId, h, a]) => ({
    tieId, roundName: "C-36", status: "projected", gw1: 36, gw2: null,
    home: placeholder(`W ${h}`),
    away: placeholder(`W ${a}`),
    winnerId: null, loserId: null,
  }));

  // C-37: SF losers vs C-36 winners
  const c37: TieDisplay[] = [
    { tieId: "C-37-A", roundName: "C-37", status: "projected", gw1: 37, gw2: null,
      home: placeholder("L SF-A"), away: placeholder("W C-36-B"), winnerId: null, loserId: null },
    { tieId: "C-37-B", roundName: "C-37", status: "projected", gw1: 37, gw2: null,
      home: placeholder("L SF-B"), away: placeholder("W C-36-A"), winnerId: null, loserId: null },
  ];

  // C-38: Challenger Final
  const c38: TieDisplay[] = [
    { tieId: "C-38-A", roundName: "C-38", status: "projected", gw1: 38, gw2: null,
      home: placeholder("W C-37-A"), away: placeholder("W C-37-B"), winnerId: null, loserId: null },
  ];

  return {
    mode,
    latestCompletedGw,
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
      : placeholder(`W ${srcTieId}`);
  };
  const resolveLoser = (srcTieId: string) => {
    const l = loserMap.get(srcTieId);
    return l
      ? { teamId: l.teamId, name: l.name, abbr: l.abbr, leg1Score: null, leg2Score: null, aggregate: null }
      : placeholder(`L ${srcTieId}`);
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
      return { teamId: w?.teamId || "", name: w?.name || `W ${tieId}`, abbr: w?.abbr || `W ${tieId}`, score: 0, rank: null, advanced: false };
    }),
    ...RO16_SEEDING.map(([tieId]) => {
      const l = loserMap.get(tieId);
      return { teamId: l?.teamId || "", name: l?.name || `L ${tieId}`, abbr: l?.abbr || `L ${tieId}`, score: 0, rank: null, advanced: false };
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

  // Branch output by variant
  if (teamSize === 8) {
    const sfLive = tiesByRound("SF");
    const thirdPlaceLive = tiesByRound("3rd Place");
    const finalLive = tiesByRound("Final");
    return {
      mode: "live", latestCompletedGw,
      tvt: {
        sf: sfLive.length > 0 ? sfLive : [
          { tieId: "SF-A", roundName: "SF", status: "projected", gw1: playoffStartGw, gw2: null, home: placeholder("1st"), away: placeholder("4th"), winnerId: null, loserId: null },
          { tieId: "SF-B", roundName: "SF", status: "projected", gw1: playoffStartGw, gw2: null, home: placeholder("2nd"), away: placeholder("3rd"), winnerId: null, loserId: null },
        ],
        thirdPlace: thirdPlaceLive.length > 0 ? thirdPlaceLive : [
          { tieId: "3rd", roundName: "3rd Place", status: "projected", gw1: playoffStartGw + 1, gw2: null, home: resolveLoser("SF-A"), away: resolveLoser("SF-B"), winnerId: null, loserId: null },
        ],
        final: finalLive.length > 0 ? finalLive : [
          { tieId: "Final", roundName: "Final", status: "projected", gw1: playoffStartGw + 1, gw2: playoffStartGw + 2, home: resolveWinner("SF-A"), away: resolveWinner("SF-B"), winnerId: null, loserId: null },
        ],
      },
      challenger: {},
    };
  }

  if (teamSize === 16) {
    const qfLive = tiesByRound("QF");
    const sfLive = tiesByRound("SF");
    const finalLive = tiesByRound("Final");
    const c31Live = tiesByRound("C-31");
    const c33Live: SurvivalDisplay[] = [];
    const gw33 = await db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, playoffStartGw + 2), ...(leagueId ? [eq(gameweeks.leagueId, leagueId)] : [])) });
    if (gw33) {
      const entries = await db.select().from(challengerSurvivalEntries).where(eq(challengerSurvivalEntries.gameweekId, gw33.id));
      for (const e of entries) {
        const info = teamMap.get(e.teamId);
        c33Live.push({ teamId: e.teamId, name: info?.name || "Unknown", abbr: info?.abbr || "?", score: e.score, rank: e.rank, advanced: e.advanced });
      }
      c33Live.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    }
    return {
      mode: "live", latestCompletedGw,
      tvt: {
        qf: qfLive.length > 0 ? qfLive : [
          { tieId: "QF-A", roundName: "QF", status: "projected", gw1: playoffStartGw, gw2: playoffStartGw + 1, home: placeholder("1st"), away: placeholder("8th"), winnerId: null, loserId: null },
          { tieId: "QF-D", roundName: "QF", status: "projected", gw1: playoffStartGw, gw2: playoffStartGw + 1, home: placeholder("4th"), away: placeholder("5th"), winnerId: null, loserId: null },
          { tieId: "QF-B", roundName: "QF", status: "projected", gw1: playoffStartGw, gw2: playoffStartGw + 1, home: placeholder("2nd"), away: placeholder("7th"), winnerId: null, loserId: null },
          { tieId: "QF-C", roundName: "QF", status: "projected", gw1: playoffStartGw, gw2: playoffStartGw + 1, home: placeholder("3rd"), away: placeholder("6th"), winnerId: null, loserId: null },
        ],
        sf: sfLive.length > 0 ? sfLive : [
          { tieId: "SF-A", roundName: "SF", status: "projected", gw1: playoffStartGw + 2, gw2: playoffStartGw + 3, home: resolveWinner("QF-A"), away: resolveWinner("QF-D"), winnerId: null, loserId: null },
          { tieId: "SF-B", roundName: "SF", status: "projected", gw1: playoffStartGw + 2, gw2: playoffStartGw + 3, home: resolveWinner("QF-B"), away: resolveWinner("QF-C"), winnerId: null, loserId: null },
        ],
        final: finalLive.length > 0 ? finalLive : [
          { tieId: "Final", roundName: "Final", status: "projected", gw1: playoffStartGw + 4, gw2: playoffStartGw + 5, home: resolveWinner("SF-A"), away: resolveWinner("SF-B"), winnerId: null, loserId: null },
        ],
      },
      challenger: { c31: c31Live, c33: c33Live.length > 0 ? c33Live : [], c34: tiesByRound("C-34"), c35: tiesByRound("C-35"), c36: tiesByRound("C-36") },
    };
  }

  return {
    mode: "live",
    latestCompletedGw,
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

    const standings = allTeams.filter(t => t.group.name !== "Playoffs").map((team) => {
      let wins = 0, draws = 0, pointsFor = 0, bonusPtsTotal = 0;

      for (const fixture of team.homeFixtures) {
        if (fixture.result && !fixture.isPlayoff) {
          pointsFor += fixture.result.homeScore;
          if (fixture.result.homeScore > fixture.result.awayScore) wins++;
          else if (fixture.result.homeScore === fixture.result.awayScore) draws++;
          if (fixture.result.homeGotBonus) bonusPtsTotal += fixture.result.homeUsedDoublePointer ? 2 : 1;
        }
      }

      for (const fixture of team.awayFixtures) {
        if (fixture.result && !fixture.isPlayoff) {
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
        group: team.group.name,
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

    return { groupA, groupB };
  } catch (error) {
    console.error("Error computing group standings:", error);
    return null;
  }
}
