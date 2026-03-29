import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, playoffTies, gameweeks, results, groups, challengerSurvivalEntries } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

function getPlayoffsGroupId(leagueId: string): Promise<string | null> {
  return db.query.groups.findFirst({ where: and(eq(groups.name, "Playoffs"), eq(groups.leagueId, leagueId)) })
    .then(g => g?.id ?? null);
}

function getGameweekId(gwNumber: number, leagueId: string): Promise<string | null> {
  return db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, gwNumber), eq(gameweeks.leagueId, leagueId)) })
    .then(g => g?.id ?? null);
}

// Get tie by ID with teams resolved
async function getTie(tieId: string) {
  return db.query.playoffTies.findFirst({ where: eq(playoffTies.tieId, tieId) });
}

// Create a single-leg fixture
async function createFixture(params: {
  tieId: string;
  gwId: string;
  homeTeamId: string;
  awayTeamId: string;
  groupId: string;
  roundName: string;
  roundType: string;
  leg?: number | null;
}) {
  const fixtureId = params.leg
    ? `playoff-${params.tieId}-leg${params.leg}`
    : `playoff-${params.tieId}`;

  await db.insert(fixtures).values({
    id: fixtureId,
    gameweekId: params.gwId,
    homeTeamId: params.homeTeamId,
    awayTeamId: params.awayTeamId,
    groupId: params.groupId,
    isChallenge: false,
    isPlayoff: true,
    roundName: params.roundName,
    leg: params.leg ?? null,
    tieId: params.tieId,
    roundType: params.roundType,
  });
  return fixtureId;
}

// Create a 2-legged tie + both fixtures
async function create2LegTie(params: {
  tieId: string;
  leagueId: string;
  roundName: string;
  roundType: string;
  homeTeamId: string;
  awayTeamId: string;
  gw1Id: string;
  gw2Id: string;
  gw1Num: number;
  gw2Num: number;
  groupId: string;
}) {
  await db.insert(playoffTies).values({
    tieId: params.tieId,
    leagueId: params.leagueId,
    roundName: params.roundName,
    roundType: params.roundType,
    homeTeamId: params.homeTeamId,
    awayTeamId: params.awayTeamId,
    gw1: params.gw1Num,
    gw2: params.gw2Num,
    status: "pending",
  });

  // Leg 1: home team hosts
  await createFixture({
    tieId: params.tieId,
    gwId: params.gw1Id,
    homeTeamId: params.homeTeamId,
    awayTeamId: params.awayTeamId,
    groupId: params.groupId,
    roundName: params.roundName,
    roundType: params.roundType,
    leg: 1,
  });

  // Leg 2: swap home/away
  await createFixture({
    tieId: params.tieId,
    gwId: params.gw2Id,
    homeTeamId: params.awayTeamId,
    awayTeamId: params.homeTeamId,
    groupId: params.groupId,
    roundName: params.roundName,
    roundType: params.roundType,
    leg: 2,
  });
}

// Create a single-leg KO tie + fixture
async function create1LegTie(params: {
  tieId: string;
  leagueId: string;
  roundName: string;
  roundType: string;
  homeTeamId: string;
  awayTeamId: string;
  gwId: string;
  gwNum: number;
  groupId: string;
}) {
  await db.insert(playoffTies).values({
    tieId: params.tieId,
    leagueId: params.leagueId,
    roundName: params.roundName,
    roundType: params.roundType,
    homeTeamId: params.homeTeamId,
    awayTeamId: params.awayTeamId,
    gw1: params.gwNum,
    gw2: null,
    status: "pending",
  });

  await createFixture({
    tieId: params.tieId,
    gwId: params.gwId,
    homeTeamId: params.homeTeamId,
    awayTeamId: params.awayTeamId,
    groupId: params.groupId,
    roundName: params.roundName,
    roundType: params.roundType,
    leg: null,
  });
}

// Resolve a 2-legged tie: sum both legs, determine winner
async function resolve2LegTie(tieId: string): Promise<{ winnerId: string; loserId: string } | null> {
  const tie = await getTie(tieId);
  if (!tie || !tie.homeTeamId || !tie.awayTeamId) return null;

  // Get both leg fixtures
  const tieFixtures = await db.select().from(fixtures)
    .where(and(eq(fixtures.tieId, tieId), eq(fixtures.isPlayoff, true)));

  const leg1 = tieFixtures.find(f => f.leg === 1);
  const leg2 = tieFixtures.find(f => f.leg === 2);
  if (!leg1 || !leg2) return null;

  // Get results for both legs
  const leg1Result = await db.query.results.findFirst({ where: eq(results.fixtureId, leg1.id) });
  const leg2Result = await db.query.results.findFirst({ where: eq(results.fixtureId, leg2.id) });
  if (!leg1Result || !leg2Result) return null;

  // In leg1: tie.homeTeamId is home, tie.awayTeamId is away
  // In leg2: swapped (tie.awayTeamId is home, tie.homeTeamId is away)
  const homeTeamId = tie.homeTeamId;
  const awayTeamId = tie.awayTeamId;

  const homeAgg = leg1Result.homeScore + leg2Result.awayScore; // Leg1 home + Leg2 away (they're the same team)
  const awayAgg = leg1Result.awayScore + leg2Result.homeScore;

  await db.update(playoffTies)
    .set({
      homeAggregate: homeAgg,
      awayAggregate: awayAgg,
      winnerId: homeAgg >= awayAgg ? homeTeamId : awayTeamId, // Home team wins on aggregate tie
      loserId: homeAgg >= awayAgg ? awayTeamId : homeTeamId,
      status: "complete",
    })
    .where(eq(playoffTies.tieId, tieId));

  return {
    winnerId: homeAgg >= awayAgg ? homeTeamId : awayTeamId,
    loserId: homeAgg >= awayAgg ? awayTeamId : homeTeamId,
  };
}

// Resolve a single-leg KO tie
async function resolve1LegTie(tieId: string): Promise<{ winnerId: string; loserId: string } | null> {
  const tie = await getTie(tieId);
  if (!tie || !tie.homeTeamId || !tie.awayTeamId) return null;

  const tieFixture = await db.select().from(fixtures)
    .where(and(eq(fixtures.tieId, tieId), eq(fixtures.isPlayoff, true)));

  if (tieFixture.length === 0) return null;

  const result = await db.query.results.findFirst({ where: eq(results.fixtureId, tieFixture[0].id) });
  if (!result) return null;

  const winnerId = result.homeScore >= result.awayScore ? tie.homeTeamId : tie.awayTeamId; // Home wins on draw
  const loserId = winnerId === tie.homeTeamId ? tie.awayTeamId : tie.homeTeamId;

  await db.update(playoffTies)
    .set({
      homeAggregate: result.homeScore,
      awayAggregate: result.awayScore,
      winnerId,
      loserId,
      status: "complete",
    })
    .where(eq(playoffTies.tieId, tieId));

  return { winnerId, loserId };
}

// Mark leg1 done for a 2-legged tie (after first GW of a 2-leg tie is processed)
async function markLeg1Done(tieId: string) {
  await db.update(playoffTies)
    .set({ status: "leg1_done" })
    .where(eq(playoffTies.tieId, tieId));
}

/**
 * POST /api/admin/[leagueId]/advance-playoffs
 * Body: { gameweek: number }
 * Resolves current GW results and auto-generates next GW fixtures
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const gwNumber = body.gameweek as number;
  if (!gwNumber || gwNumber < 31 || gwNumber > 38) {
    return NextResponse.json({ error: "Gameweek must be between 31 and 38" }, { status: 400 });
  }

  const playoffsGroupId = await getPlayoffsGroupId(leagueId);
  if (!playoffsGroupId) {
    return NextResponse.json({ error: "Playoffs group not found" }, { status: 500 });
  }

  const actions: string[] = [];

  try {
    switch (gwNumber) {
      case 31:
        await advanceGW31(playoffsGroupId, leagueId, actions);
        break;
      case 32:
        await advanceGW32(playoffsGroupId, leagueId, actions);
        break;
      case 33:
        await advanceGW33(playoffsGroupId, leagueId, actions);
        await generateC34AfterSurvival(playoffsGroupId, leagueId, actions);
        break;
      case 34:
        await advanceGW34(playoffsGroupId, leagueId, actions);
        break;
      case 35:
        await advanceGW35(playoffsGroupId, leagueId, actions);
        break;
      case 36:
        await advanceGW36(playoffsGroupId, leagueId, actions);
        break;
      case 37:
        await advanceGW37(playoffsGroupId, leagueId, actions);
        break;
      case 38:
        await advanceGW38(actions);
        break;
    }

    return NextResponse.json({ success: true, gameweek: gwNumber, actions });
  } catch (error) {
    console.error("Error advancing playoffs:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to advance playoffs" },
      { status: 500 }
    );
  }
}

// ============================================
// Per-GW advance logic
// ============================================

async function advanceGW31(groupId: string, leagueId: string, actions: string[]) {
  // Resolve C-31 single-leg ties (6 KO matches)
  for (const suffix of ["A", "B", "C", "D", "E", "F"]) {
    const result = await resolve1LegTie(`C-31-${suffix}`);
    if (result) actions.push(`C-31-${suffix}: winner resolved`);
  }

  // Mark RO16 ties as leg1_done
  for (const suffix of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    await markLeg1Done(`RO16-${suffix}`);
    actions.push(`RO16-${suffix}: leg 1 recorded`);
  }

  // Auto-generate C-32 fixtures (GW32): W(C-31-A) vs W(C-31-F), etc.
  const gw32Id = await getGameweekId(32, leagueId);
  if (!gw32Id) throw new Error("GW32 not found");

  const c32Seeding: [string, string, string][] = [
    ["C-32-A", "C-31-A", "C-31-F"],
    ["C-32-B", "C-31-B", "C-31-E"],
    ["C-32-C", "C-31-C", "C-31-D"],
  ];

  for (const [tieId, homeTieId, awayTieId] of c32Seeding) {
    const homeTie = await getTie(homeTieId);
    const awayTie = await getTie(awayTieId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create1LegTie({
      tieId,
      leagueId,
      roundName: "C-32",
      roundType: "challenger-ko",
      homeTeamId: homeTie.winnerId,
      awayTeamId: awayTie.winnerId,
      gwId: gw32Id,
      gwNum: 32,
      groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}

async function advanceGW32(groupId: string, leagueId: string, actions: string[]) {
  // Resolve RO16 aggregate (2-legged)
  const ro16Losers: string[] = [];
  for (const suffix of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    const result = await resolve2LegTie(`RO16-${suffix}`);
    if (result) {
      actions.push(`RO16-${suffix}: aggregate winner resolved`);
      ro16Losers.push(result.loserId);
    }
  }

  // Resolve C-32 single-leg ties
  const c32Winners: string[] = [];
  for (const suffix of ["A", "B", "C"]) {
    const result = await resolve1LegTie(`C-32-${suffix}`);
    if (result) {
      actions.push(`C-32-${suffix}: winner resolved`);
      c32Winners.push(result.winnerId);
    }
  }

  // Auto-generate QF fixtures (GW33+GW34)
  const gw33Id = await getGameweekId(33, leagueId);
  const gw34Id = await getGameweekId(34, leagueId);
  if (!gw33Id || !gw34Id) throw new Error("GW33/GW34 not found");

  const qfSeeding: [string, string, string][] = [
    ["QF-A", "RO16-A", "RO16-H"],
    ["QF-B", "RO16-B", "RO16-G"],
    ["QF-C", "RO16-C", "RO16-F"],
    ["QF-D", "RO16-D", "RO16-E"],
  ];

  for (const [tieId, homeTieId, awayTieId] of qfSeeding) {
    const homeTie = await getTie(homeTieId);
    const awayTie = await getTie(awayTieId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create2LegTie({
      tieId,
      leagueId,
      roundName: "QF",
      roundType: "tvt",
      homeTeamId: homeTie.winnerId,
      awayTeamId: awayTie.winnerId,
      gw1Id: gw33Id,
      gw2Id: gw34Id,
      gw1Num: 33,
      gw2Num: 34,
      groupId,
    });
    actions.push(`Created ${tieId} (legs GW33+GW34)`);
  }

  // Seed Challenger Survival (GW33): 3 C-32 winners + 8 RO16 losers = 11 teams
  const survivalTeamIds = [...c32Winners, ...ro16Losers];
  const gw33 = await db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, 33), eq(gameweeks.leagueId, leagueId)) });
  if (gw33) {
    for (const teamId of survivalTeamIds) {
      await db.insert(challengerSurvivalEntries).values({
        id: `survival-gw33-${teamId}`,
        gameweekId: gw33.id,
        teamId,
        score: 0,
        rank: null,
        advanced: false,
      });
    }
    actions.push(`Seeded ${survivalTeamIds.length} Challenger Survival entries for GW33`);
  }
}

async function advanceGW33(groupId: string, leagueId: string, actions: string[]) {
  // Mark QF ties as leg1_done
  for (const suffix of ["A", "B", "C", "D"]) {
    await markLeg1Done(`QF-${suffix}`);
    actions.push(`QF-${suffix}: leg 1 recorded`);
  }

  // Resolve Challenger Survival: read each team's GW33 score from results
  const gw33 = await db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, 33), eq(gameweeks.leagueId, leagueId)) });
  if (!gw33) throw new Error("GW33 not found");

  const survivalEntries = await db.select().from(challengerSurvivalEntries)
    .where(eq(challengerSurvivalEntries.gameweekId, gw33.id));

  // For each survival team, find their GW33 score from any playoff fixture result
  // Survival teams don't have head-to-head fixtures in GW33, so get score from their QF fixture if they're in QF,
  // or we need another approach. Actually per the rules, GW33 survival = individual FPL team score for that GW.
  // The survival team's "score" is their TVT team score for GW33 from the FPL cache.
  // Since these teams are not in QF fixtures, we need to compute their score differently.
  // For now: the admin should update survival scores via the advance endpoint after GW33 is processed.
  // We'll read their scores from QF fixture results (they may appear as home/away in QF fixtures if they made it)
  // OR from a dedicated scoring mechanism.

  // Actually: survival teams DON'T play any fixture in GW33. Their score = combined FPL score of their 2 players.
  // We should compute this from FPL cache. Let's use getAllCachedScores.

  // Import dynamically to avoid circular deps
  const { getAllCachedScores } = await import("@/lib/fpl-cache");
  const { players: playersTable } = await import("@/lib/db/schema");

  const gw33Cache = await getAllCachedScores(33);

  // For each survival team, get their players' FPL scores
  for (const entry of survivalEntries) {
    const teamPlayers = await db.select().from(playersTable)
      .where(eq(playersTable.teamId, entry.teamId));

    let teamScore = 0;
    for (const player of teamPlayers) {
      const cacheKey = `${player.fplId}_gw33`;
      const cached = gw33Cache[cacheKey];
      if (cached) {
        teamScore += cached.netScore;
      }
    }

    await db.update(challengerSurvivalEntries)
      .set({ score: teamScore })
      .where(eq(challengerSurvivalEntries.id, entry.id));
  }

  // Re-read, rank, and mark top 8 as advanced
  const updatedEntries = await db.select().from(challengerSurvivalEntries)
    .where(eq(challengerSurvivalEntries.gameweekId, gw33.id));

  updatedEntries.sort((a, b) => b.score - a.score);

  for (let i = 0; i < updatedEntries.length; i++) {
    const advanced = i < 8;
    await db.update(challengerSurvivalEntries)
      .set({ rank: i + 1, advanced })
      .where(eq(challengerSurvivalEntries.id, updatedEntries[i].id));
  }
  actions.push(`Ranked ${updatedEntries.length} survival teams, top 8 advance`);
}

async function advanceGW34(groupId: string, leagueId: string, actions: string[]) {
  // Resolve QF aggregates (2-legged)
  for (const suffix of ["A", "B", "C", "D"]) {
    const result = await resolve2LegTie(`QF-${suffix}`);
    if (result) actions.push(`QF-${suffix}: aggregate winner resolved`);
  }

  // Resolve C-34 single-leg ties
  for (const suffix of ["A", "B", "C", "D"]) {
    const result = await resolve1LegTie(`C-34-${suffix}`);
    if (result) actions.push(`C-34-${suffix}: winner resolved`);
  }

  // Auto-generate SF fixtures (GW35+GW36)
  const gw35Id = await getGameweekId(35, leagueId);
  const gw36Id = await getGameweekId(36, leagueId);
  if (!gw35Id || !gw36Id) throw new Error("GW35/GW36 not found");

  const sfSeeding: [string, string, string][] = [
    ["SF-A", "QF-A", "QF-D"],
    ["SF-B", "QF-B", "QF-C"],
  ];

  for (const [tieId, homeTieId, awayTieId] of sfSeeding) {
    const homeTie = await getTie(homeTieId);
    const awayTie = await getTie(awayTieId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create2LegTie({
      tieId,
      leagueId,
      roundName: "SF",
      roundType: "tvt",
      homeTeamId: homeTie.winnerId,
      awayTeamId: awayTie.winnerId,
      gw1Id: gw35Id,
      gw2Id: gw36Id,
      gw1Num: 35,
      gw2Num: 36,
      groupId,
    });
    actions.push(`Created ${tieId} (legs GW35+GW36)`);
  }

  // Auto-generate C-35 fixtures (GW35): QF losers vs C-34 winners
  const c35Seeding: [string, string, string][] = [
    ["C-35-A", "QF-A", "C-34-D"], // L(QF-A) vs W(C-34-D)
    ["C-35-B", "QF-B", "C-34-C"],
    ["C-35-C", "QF-C", "C-34-B"],
    ["C-35-D", "QF-D", "C-34-A"],
  ];

  for (const [tieId, qfTieId, c34TieId] of c35Seeding) {
    const qfTie = await getTie(qfTieId);
    const c34Tie = await getTie(c34TieId);
    if (!qfTie?.loserId || !c34Tie?.winnerId) continue;

    await create1LegTie({
      tieId,
      leagueId,
      roundName: "C-35",
      roundType: "challenger-ko",
      homeTeamId: qfTie.loserId,
      awayTeamId: c34Tie.winnerId,
      gwId: gw35Id,
      gwNum: 35,
      groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}

async function advanceGW35(groupId: string, leagueId: string, actions: string[]) {
  // Mark SF ties as leg1_done
  for (const suffix of ["A", "B"]) {
    await markLeg1Done(`SF-${suffix}`);
    actions.push(`SF-${suffix}: leg 1 recorded`);
  }

  // Resolve C-35 single-leg ties
  for (const suffix of ["A", "B", "C", "D"]) {
    const result = await resolve1LegTie(`C-35-${suffix}`);
    if (result) actions.push(`C-35-${suffix}: winner resolved`);
  }

  // Auto-generate C-36 fixtures (GW36)
  const gw36Id = await getGameweekId(36, leagueId);
  if (!gw36Id) throw new Error("GW36 not found");

  const c36Seeding: [string, string, string][] = [
    ["C-36-A", "C-35-A", "C-35-D"],
    ["C-36-B", "C-35-B", "C-35-C"],
  ];

  for (const [tieId, homeTieId, awayTieId] of c36Seeding) {
    const homeTie = await getTie(homeTieId);
    const awayTie = await getTie(awayTieId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create1LegTie({
      tieId,
      leagueId,
      roundName: "C-36",
      roundType: "challenger-ko",
      homeTeamId: homeTie.winnerId,
      awayTeamId: awayTie.winnerId,
      gwId: gw36Id,
      gwNum: 36,
      groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}

async function advanceGW36(groupId: string, leagueId: string, actions: string[]) {
  // Resolve SF aggregates (2-legged)
  for (const suffix of ["A", "B"]) {
    const result = await resolve2LegTie(`SF-${suffix}`);
    if (result) actions.push(`SF-${suffix}: aggregate winner resolved`);
  }

  // Resolve C-36 single-leg ties
  for (const suffix of ["A", "B"]) {
    const result = await resolve1LegTie(`C-36-${suffix}`);
    if (result) actions.push(`C-36-${suffix}: winner resolved`);
  }

  // Auto-generate Final fixtures (GW37+GW38)
  const gw37Id = await getGameweekId(37, leagueId);
  const gw38Id = await getGameweekId(38, leagueId);
  if (!gw37Id || !gw38Id) throw new Error("GW37/GW38 not found");

  const sfA = await getTie("SF-A");
  const sfB = await getTie("SF-B");
  if (sfA?.winnerId && sfB?.winnerId) {
    await create2LegTie({
      tieId: "Final",
      leagueId,
      roundName: "Final",
      roundType: "tvt",
      homeTeamId: sfA.winnerId,
      awayTeamId: sfB.winnerId,
      gw1Id: gw37Id,
      gw2Id: gw38Id,
      gw1Num: 37,
      gw2Num: 38,
      groupId,
    });
    actions.push("Created Final tie (legs GW37+GW38)");
  }

  // Auto-generate C-37 (Challenger SF): L(SF-A) vs W(C-36-B), L(SF-B) vs W(C-36-A)
  const c36A = await getTie("C-36-A");
  const c36B = await getTie("C-36-B");

  if (sfA?.loserId && c36B?.winnerId) {
    await create1LegTie({
      tieId: "C-37-A",
      leagueId,
      roundName: "C-37",
      roundType: "challenger-ko",
      homeTeamId: sfA.loserId,
      awayTeamId: c36B.winnerId,
      gwId: gw37Id,
      gwNum: 37,
      groupId,
    });
    actions.push("Created C-37-A");
  }

  if (sfB?.loserId && c36A?.winnerId) {
    await create1LegTie({
      tieId: "C-37-B",
      leagueId,
      roundName: "C-37",
      roundType: "challenger-ko",
      homeTeamId: sfB.loserId,
      awayTeamId: c36A.winnerId,
      gwId: gw37Id,
      gwNum: 37,
      groupId,
    });
    actions.push("Created C-37-B");
  }
}

async function advanceGW37(groupId: string, leagueId: string, actions: string[]) {
  // Mark Final as leg1_done
  await markLeg1Done("Final");
  actions.push("Final: leg 1 recorded");

  // Resolve C-37 single-leg ties
  for (const suffix of ["A", "B"]) {
    const result = await resolve1LegTie(`C-37-${suffix}`);
    if (result) actions.push(`C-37-${suffix}: winner resolved`);
  }

  // Auto-generate C-38 (Challenger Final, GW38)
  const gw38Id = await getGameweekId(38, leagueId);
  if (!gw38Id) throw new Error("GW38 not found");

  const c37A = await getTie("C-37-A");
  const c37B = await getTie("C-37-B");

  if (c37A?.winnerId && c37B?.winnerId) {
    await create1LegTie({
      tieId: "C-38-A",
      leagueId,
      roundName: "C-38",
      roundType: "challenger-ko",
      homeTeamId: c37A.winnerId,
      awayTeamId: c37B.winnerId,
      gwId: gw38Id,
      gwNum: 38,
      groupId,
    });
    actions.push("Created C-38-A (Challenger Final)");
  }
}

async function advanceGW38(actions: string[]) {
  // Resolve Final aggregate (2-legged)
  const result = await resolve2LegTie("Final");
  if (result) actions.push("Final: TVT Champion determined!");

  // Resolve C-38 (Challenger Final)
  const c38Result = await resolve1LegTie("C-38-A");
  if (c38Result) actions.push("C-38-A: Challenger Series Champion determined!");

  actions.push("Tournament complete!");
}

// Generate C-34 fixtures after GW33 survival is resolved
async function generateC34AfterSurvival(groupId: string, leagueId: string, actions: string[]) {
  const gw34Id = await getGameweekId(34, leagueId);
  if (!gw34Id) throw new Error("GW34 not found");

  // Get survival rankings
  const gw33 = await db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, 33), eq(gameweeks.leagueId, leagueId)) });
  if (!gw33) return;

  const entries = await db.select().from(challengerSurvivalEntries)
    .where(eq(challengerSurvivalEntries.gameweekId, gw33.id));

  const ranked = entries.filter(e => e.advanced).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  if (ranked.length < 8) return;

  // C-34: Rank1 vs Rank8, Rank2 vs Rank7, Rank3 vs Rank6, Rank4 vs Rank5
  const c34Pairs: [string, number, number][] = [
    ["C-34-A", 0, 7], // indices into ranked array
    ["C-34-B", 1, 6],
    ["C-34-C", 2, 5],
    ["C-34-D", 3, 4],
  ];

  for (const [tieId, homeIdx, awayIdx] of c34Pairs) {
    await create1LegTie({
      tieId,
      leagueId,
      roundName: "C-34",
      roundType: "challenger-ko",
      homeTeamId: ranked[homeIdx].teamId,
      awayTeamId: ranked[awayIdx].teamId,
      gwId: gw34Id,
      gwNum: 34,
      groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}
