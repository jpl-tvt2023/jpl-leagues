import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, playoffTies, gameweeks, results, groups, challengerSurvivalEntries, leagues } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

// ── Shared helpers ────────────────────────────────────────────────────────────

function getPlayoffsGroupId(leagueId: string): Promise<string | null> {
  return db.query.groups.findFirst({ where: and(eq(groups.name, "Playoffs"), eq(groups.leagueId, leagueId)) })
    .then(g => g?.id ?? null);
}

function getGameweekId(gwNumber: number, leagueId: string): Promise<string | null> {
  return db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, gwNumber), eq(gameweeks.leagueId, leagueId)) })
    .then(g => g?.id ?? null);
}

// Get tie by ID, filtered to the correct league (tieId is a global PK but filtering by leagueId ensures correctness)
async function getTie(tieId: string, leagueId: string) {
  return db.query.playoffTies.findFirst({
    where: and(eq(playoffTies.tieId, tieId), eq(playoffTies.leagueId, leagueId)),
  });
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

// Resolve a 2-legged tie: sum both legs, determine winner (home team wins on aggregate tie)
async function resolve2LegTie(tieId: string, leagueId: string): Promise<{ winnerId: string; loserId: string } | null> {
  const tie = await getTie(tieId, leagueId);
  if (!tie || !tie.homeTeamId || !tie.awayTeamId) return null;

  const tieFixtures = await db.select().from(fixtures)
    .where(and(eq(fixtures.tieId, tieId), eq(fixtures.isPlayoff, true)));

  const leg1 = tieFixtures.find(f => f.leg === 1);
  const leg2 = tieFixtures.find(f => f.leg === 2);
  if (!leg1 || !leg2) return null;

  const leg1Result = await db.query.results.findFirst({ where: eq(results.fixtureId, leg1.id) });
  const leg2Result = await db.query.results.findFirst({ where: eq(results.fixtureId, leg2.id) });
  if (!leg1Result || !leg2Result) return null;

  const homeTeamId = tie.homeTeamId;
  const awayTeamId = tie.awayTeamId;

  // leg1: homeTeam is home; leg2: homeTeam is away (swapped)
  const homeAgg = leg1Result.homeScore + leg2Result.awayScore;
  const awayAgg = leg1Result.awayScore + leg2Result.homeScore;

  await db.update(playoffTies)
    .set({
      homeAggregate: homeAgg,
      awayAggregate: awayAgg,
      winnerId: homeAgg >= awayAgg ? homeTeamId : awayTeamId,
      loserId: homeAgg >= awayAgg ? awayTeamId : homeTeamId,
      status: "complete",
    })
    .where(eq(playoffTies.tieId, tieId));

  return {
    winnerId: homeAgg >= awayAgg ? homeTeamId : awayTeamId,
    loserId: homeAgg >= awayAgg ? awayTeamId : homeTeamId,
  };
}

// Resolve a single-leg KO tie (home team wins on draw)
async function resolve1LegTie(tieId: string, leagueId: string): Promise<{ winnerId: string; loserId: string } | null> {
  const tie = await getTie(tieId, leagueId);
  if (!tie || !tie.homeTeamId || !tie.awayTeamId) return null;

  const tieFixture = await db.select().from(fixtures)
    .where(and(eq(fixtures.tieId, tieId), eq(fixtures.isPlayoff, true)));

  if (tieFixture.length === 0) return null;

  const result = await db.query.results.findFirst({ where: eq(results.fixtureId, tieFixture[0].id) });
  if (!result) return null;

  const winnerId = result.homeScore >= result.awayScore ? tie.homeTeamId : tie.awayTeamId;
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

// Mark leg1 done for a 2-legged tie
async function markLeg1Done(tieId: string) {
  await db.update(playoffTies)
    .set({ status: "leg1_done" })
    .where(eq(playoffTies.tieId, tieId));
}

// ── POST handler ──────────────────────────────────────────────────────────────

/**
 * POST /api/admin/[leagueId]/advance-playoffs
 * Body: { gameweek: number }
 * Routes to format-specific handlers (8-team, 16-team, 32-team).
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const gwNumber = body.gameweek as number;
  if (!gwNumber) {
    return NextResponse.json({ error: "Gameweek number required" }, { status: 400 });
  }

  // Fetch format config
  const leagueRow = await db.select({
    teamSize: leagues.teamSize,
    playoffStartGw: leagues.playoffStartGw,
  }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  const teamSize = leagueRow[0]?.teamSize ?? 32;
  const playoffStartGw = leagueRow[0]?.playoffStartGw ?? 31;

  const playoffsGroupId = await getPlayoffsGroupId(leagueId);
  if (!playoffsGroupId) {
    return NextResponse.json({ error: "Playoffs group not found" }, { status: 500 });
  }

  const actions: string[] = [];

  try {
    if (teamSize === 8) {
      // ── 8-TEAM FORMAT ────────────────────────────────────────
      // GW36 (playoffStartGw): resolve SFs → create Final + 3rd
      // GW37 (playoffStartGw+1): mark leg1 done
      // GW38 (playoffStartGw+2): resolve Finals
      if (gwNumber < playoffStartGw || gwNumber > playoffStartGw + 2) {
        return NextResponse.json({
          error: `8-team playoff gameweeks are ${playoffStartGw}–${playoffStartGw + 2}`,
        }, { status: 400 });
      }
      if (gwNumber === playoffStartGw) {
        await advanceSF8(playoffsGroupId, leagueId, playoffStartGw, actions);
      } else if (gwNumber === playoffStartGw + 1) {
        await markLeg1Done("8T-FINAL");
        await markLeg1Done("8T-3RD");
        actions.push("8T-FINAL: leg 1 recorded", "8T-3RD: leg 1 recorded");
      } else {
        const finalResult = await resolve2LegTie("8T-FINAL", leagueId);
        if (finalResult) actions.push("8T-FINAL: Champion determined!");
        const thirdResult = await resolve2LegTie("8T-3RD", leagueId);
        if (thirdResult) actions.push("8T-3RD: 3rd place determined!");
        actions.push("8-team tournament complete!");
      }

    } else if (teamSize === 16) {
      // ── 16-TEAM FORMAT ───────────────────────────────────────
      // GW31-33: group stage resolution
      // GW34: merger (seeding + QFs)
      // GW35-36: semi-finals
      // GW37-38: finals
      if (gwNumber < playoffStartGw || gwNumber > playoffStartGw + 7) {
        return NextResponse.json({
          error: `16-team playoff gameweeks are ${playoffStartGw}–${playoffStartGw + 7}`,
        }, { status: 400 });
      }
      const gwOffset = gwNumber - playoffStartGw;
      switch (gwOffset) {
        case 0: await advanceGroupGW_16T(0, leagueId, actions); break;      // GW31
        case 1: await advanceGroupGW_16T(1, leagueId, actions); break;      // GW32
        case 2: await advanceGW33_16T(playoffsGroupId, leagueId, playoffStartGw, actions); break; // GW33 + create GW34
        case 3: await advanceGW34_16T(playoffsGroupId, leagueId, playoffStartGw, actions); break; // GW34 + create SFs
        case 4: await advanceGW35_16T(actions); break;                       // GW35: mark SF leg1
        case 5: await advanceGW36_16T(playoffsGroupId, leagueId, playoffStartGw, actions); break; // GW36 + create Finals
        case 6: await advanceGW37_16T(actions); break;                       // GW37: mark Final leg1
        case 7: await advanceGW38_16T(leagueId, actions); break;             // GW38: resolve all
      }

    } else {
      // ── 32-TEAM FORMAT ───────────────────────────────────────
      if (gwNumber < 31 || gwNumber > 38) {
        return NextResponse.json({ error: "Gameweek must be between 31 and 38" }, { status: 400 });
      }
      switch (gwNumber) {
        case 31: await advanceGW31(playoffsGroupId, leagueId, actions); break;
        case 32: await advanceGW32(playoffsGroupId, leagueId, actions); break;
        case 33:
          await advanceGW33(playoffsGroupId, leagueId, actions);
          await generateC34AfterSurvival(playoffsGroupId, leagueId, actions);
          break;
        case 34: await advanceGW34(playoffsGroupId, leagueId, actions); break;
        case 35: await advanceGW35(playoffsGroupId, leagueId, actions); break;
        case 36: await advanceGW36(playoffsGroupId, leagueId, actions); break;
        case 37: await advanceGW37(playoffsGroupId, leagueId, actions); break;
        case 38: await advanceGW38(leagueId, actions); break;
      }
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

// ── 8-TEAM handlers ───────────────────────────────────────────────────────────

async function advanceSF8(groupId: string, leagueId: string, playoffStartGw: number, actions: string[]) {
  const sfA = await resolve1LegTie("8T-SF-A", leagueId);
  const sfB = await resolve1LegTie("8T-SF-B", leagueId);
  if (sfA) actions.push("8T-SF-A: winner resolved");
  if (sfB) actions.push("8T-SF-B: winner resolved");

  if (!sfA?.winnerId || !sfB?.winnerId) {
    actions.push("SFs incomplete — Final/3rd not created yet (score the GW first)");
    return;
  }

  const gw1Id = await getGameweekId(playoffStartGw + 1, leagueId);
  const gw2Id = await getGameweekId(playoffStartGw + 2, leagueId);
  if (!gw1Id || !gw2Id) throw new Error(`GW${playoffStartGw + 1}/${playoffStartGw + 2} not found — run generate-playoffs to auto-create GWs`);

  await create2LegTie({
    tieId: "8T-FINAL", leagueId,
    roundName: "8T-FINAL", roundType: "tvt",
    homeTeamId: sfA.winnerId, awayTeamId: sfB.winnerId,
    gw1Id, gw2Id,
    gw1Num: playoffStartGw + 1, gw2Num: playoffStartGw + 2,
    groupId,
  });
  actions.push("Created 8T-FINAL (legs GW" + (playoffStartGw + 1) + "+" + (playoffStartGw + 2) + ")");

  await create2LegTie({
    tieId: "8T-3RD", leagueId,
    roundName: "8T-3RD", roundType: "tvt",
    homeTeamId: sfA.loserId!, awayTeamId: sfB.loserId!,
    gw1Id, gw2Id,
    gw1Num: playoffStartGw + 1, gw2Num: playoffStartGw + 2,
    groupId,
  });
  actions.push("Created 8T-3RD (3rd Place)");
}

// ── 16-TEAM handlers ──────────────────────────────────────────────────────────

// Resolve group stage ties for a given gwOffset (0=GW31, 1=GW32)
async function advanceGroupGW_16T(gwOffset: number, leagueId: string, actions: string[]) {
  const suffix = gwOffset === 0 ? "31" : "32";
  const tieIds = [
    `16T-CA-${suffix}-1`, `16T-CA-${suffix}-2`,
    `16T-CB-${suffix}-1`, `16T-CB-${suffix}-2`,
    `16T-XA-${suffix}-1`, `16T-XA-${suffix}-2`,
    `16T-XB-${suffix}-1`, `16T-XB-${suffix}-2`,
  ];
  for (const tieId of tieIds) {
    const result = await resolve1LegTie(tieId, leagueId);
    if (result) actions.push(`${tieId}: resolved`);
  }
}

// GW33: resolve final group stage matches + compute standings + create GW34 matches
async function advanceGW33_16T(groupId: string, leagueId: string, playoffStartGw: number, actions: string[]) {
  // Resolve all 8 GW33 group stage ties
  const gw33TieIds = [
    "16T-CA-33-1", "16T-CA-33-2",
    "16T-CB-33-1", "16T-CB-33-2",
    "16T-XA-33-1", "16T-XA-33-2",
    "16T-XB-33-1", "16T-XB-33-2",
  ];
  for (const tieId of gw33TieIds) {
    const result = await resolve1LegTie(tieId, leagueId);
    if (result) actions.push(`${tieId}: resolved`);
  }

  // Compute group standings across all 3 GWs
  const standings = await compute16TGroupStandings(leagueId);

  const champA = standings["16T-CA"];
  const champB = standings["16T-CB"];
  const challA = standings["16T-XA"];
  const challB = standings["16T-XB"];

  if (champA.length < 4 || champB.length < 4 || challA.length < 4 || challB.length < 4) {
    throw new Error("Incomplete group standings — ensure GW31, GW32, and GW33 have all been scored and advanced before GW33");
  }

  // The Great Cut:
  //   Elite 4   (→ GW34 seeding):     champA[0..1], champB[0..1]
  //   Relegated 4 (→ GW34 Chall QFs): champA[2..3], champB[2..3]
  //   Survivors 4 (→ GW34 Chall QFs): challA[0..1], challB[0..1]
  //   Wooden Spoon 4 (→ GW34 WS seeding): challA[2..3], challB[2..3]

  const gw34Id = await getGameweekId(playoffStartGw + 3, leagueId);
  if (!gw34Id) throw new Error(`GW${playoffStartGw + 3} not found`);

  // Elite Seeding matches (Championship top 4)
  // M1: ChampA1 vs ChampB1 → winner=#1 seed, loser=#2 seed
  // M2: ChampA2 vs ChampB2 → winner=#3 seed, loser=#4 seed
  await create1LegTie({
    tieId: "16T-ES-M1", leagueId,
    roundName: "16T-ES", roundType: "tvt",
    homeTeamId: champA[0].teamId, awayTeamId: champB[0].teamId,
    gwId: gw34Id, gwNum: playoffStartGw + 3, groupId,
  });
  actions.push("Created 16T-ES-M1 (Elite Seeding: ChampA1 vs ChampB1)");

  await create1LegTie({
    tieId: "16T-ES-M2", leagueId,
    roundName: "16T-ES", roundType: "tvt",
    homeTeamId: champA[1].teamId, awayTeamId: champB[1].teamId,
    gwId: gw34Id, gwNum: playoffStartGw + 3, groupId,
  });
  actions.push("Created 16T-ES-M2 (Elite Seeding: ChampA2 vs ChampB2)");

  // Challenger Quarter-Finals (4 relegated + 4 Challenger survivors)
  // QF1: ChampA3 vs ChallB2  QF2: ChampB3 vs ChallA2
  // QF3: ChampA4 vs ChallB1  QF4: ChampB4 vs ChallA1
  const qfMatchups: [string, string, string][] = [
    ["16T-QF1", champA[2].teamId, challB[1].teamId],
    ["16T-QF2", champB[2].teamId, challA[1].teamId],
    ["16T-QF3", champA[3].teamId, challB[0].teamId],
    ["16T-QF4", champB[3].teamId, challA[0].teamId],
  ];
  for (const [tieId, homeId, awayId] of qfMatchups) {
    await create1LegTie({
      tieId, leagueId,
      roundName: "16T-QF", roundType: "challenger-ko",
      homeTeamId: homeId, awayTeamId: awayId,
      gwId: gw34Id, gwNum: playoffStartGw + 3, groupId,
    });
    actions.push(`Created ${tieId} (Challenger QF)`);
  }

  // Wooden Spoon Seeding (bottom 4 Challenger teams)
  // WS-M1: ChallA3 vs ChallB3 → winner=WS#1, loser=WS#2
  // WS-M2: ChallA4 vs ChallB4 → winner=WS#3, loser=WS#4
  await create1LegTie({
    tieId: "16T-WS-M1", leagueId,
    roundName: "16T-WS", roundType: "tvt",
    homeTeamId: challA[2].teamId, awayTeamId: challB[2].teamId,
    gwId: gw34Id, gwNum: playoffStartGw + 3, groupId,
  });
  actions.push("Created 16T-WS-M1 (WS Seeding: ChallA3 vs ChallB3)");

  await create1LegTie({
    tieId: "16T-WS-M2", leagueId,
    roundName: "16T-WS", roundType: "tvt",
    homeTeamId: challA[3].teamId, awayTeamId: challB[3].teamId,
    gwId: gw34Id, gwNum: playoffStartGw + 3, groupId,
  });
  actions.push("Created 16T-WS-M2 (WS Seeding: ChallA4 vs ChallB4)");
}

// GW34: resolve all seeding/QF matches + create GW35-36 semi-finals
async function advanceGW34_16T(groupId: string, leagueId: string, playoffStartGw: number, actions: string[]) {
  const esM1 = await resolve1LegTie("16T-ES-M1", leagueId);
  const esM2 = await resolve1LegTie("16T-ES-M2", leagueId);
  if (esM1) actions.push("16T-ES-M1: Elite Seeding resolved");
  if (esM2) actions.push("16T-ES-M2: Elite Seeding resolved");

  for (const qfId of ["16T-QF1", "16T-QF2", "16T-QF3", "16T-QF4"]) {
    const result = await resolve1LegTie(qfId, leagueId);
    if (result) actions.push(`${qfId}: QF resolved`);
  }

  const wsM1 = await resolve1LegTie("16T-WS-M1", leagueId);
  const wsM2 = await resolve1LegTie("16T-WS-M2", leagueId);
  if (wsM1) actions.push("16T-WS-M1: WS Seeding resolved");
  if (wsM2) actions.push("16T-WS-M2: WS Seeding resolved");

  const gw35Id = await getGameweekId(playoffStartGw + 4, leagueId);
  const gw36Id = await getGameweekId(playoffStartGw + 5, leagueId);
  if (!gw35Id || !gw36Id) throw new Error(`GW${playoffStartGw + 4}/${playoffStartGw + 5} not found`);

  // Championship SFs — fixed seeding:
  // Seed #1 = M1 winner (won group + won GW34), Seed #2 = M1 loser
  // Seed #3 = M2 winner, Seed #4 = M2 loser
  // SF-A: #1 vs #4,  SF-B: #2 vs #3
  if (esM1?.winnerId && esM1.loserId && esM2?.winnerId && esM2.loserId) {
    await create2LegTie({
      tieId: "16T-SF-A", leagueId,
      roundName: "16T-SF", roundType: "tvt",
      homeTeamId: esM1.winnerId, awayTeamId: esM2.loserId,
      gw1Id: gw35Id, gw2Id: gw36Id,
      gw1Num: playoffStartGw + 4, gw2Num: playoffStartGw + 5, groupId,
    });
    actions.push("Created 16T-SF-A (Seed#1 vs Seed#4)");

    await create2LegTie({
      tieId: "16T-SF-B", leagueId,
      roundName: "16T-SF", roundType: "tvt",
      homeTeamId: esM1.loserId, awayTeamId: esM2.winnerId,
      gw1Id: gw35Id, gw2Id: gw36Id,
      gw1Num: playoffStartGw + 4, gw2Num: playoffStartGw + 5, groupId,
    });
    actions.push("Created 16T-SF-B (Seed#2 vs Seed#3)");
  } else {
    actions.push("Elite Seeding incomplete — Championship SFs not created");
  }

  // Challenger SFs (QF1 winner vs QF4 winner, QF2 winner vs QF3 winner)
  const qf1 = await getTie("16T-QF1", leagueId);
  const qf2 = await getTie("16T-QF2", leagueId);
  const qf3 = await getTie("16T-QF3", leagueId);
  const qf4 = await getTie("16T-QF4", leagueId);

  if (qf1?.winnerId && qf4?.winnerId) {
    await create2LegTie({
      tieId: "16T-CSF-A", leagueId,
      roundName: "16T-CSF", roundType: "challenger-ko",
      homeTeamId: qf1.winnerId, awayTeamId: qf4.winnerId,
      gw1Id: gw35Id, gw2Id: gw36Id,
      gw1Num: playoffStartGw + 4, gw2Num: playoffStartGw + 5, groupId,
    });
    actions.push("Created 16T-CSF-A (Winner QF1 vs Winner QF4)");
  }
  if (qf2?.winnerId && qf3?.winnerId) {
    await create2LegTie({
      tieId: "16T-CSF-B", leagueId,
      roundName: "16T-CSF", roundType: "challenger-ko",
      homeTeamId: qf2.winnerId, awayTeamId: qf3.winnerId,
      gw1Id: gw35Id, gw2Id: gw36Id,
      gw1Num: playoffStartGw + 4, gw2Num: playoffStartGw + 5, groupId,
    });
    actions.push("Created 16T-CSF-B (Winner QF2 vs Winner QF3)");
  }

  // Wooden Spoon SFs (WS#1 vs WS#4, WS#2 vs WS#3)
  if (wsM1?.winnerId && wsM1.loserId && wsM2?.winnerId && wsM2.loserId) {
    await create2LegTie({
      tieId: "16T-WSSF-A", leagueId,
      roundName: "16T-WSSF", roundType: "tvt",
      homeTeamId: wsM1.winnerId, awayTeamId: wsM2.loserId,
      gw1Id: gw35Id, gw2Id: gw36Id,
      gw1Num: playoffStartGw + 4, gw2Num: playoffStartGw + 5, groupId,
    });
    actions.push("Created 16T-WSSF-A (WS#1 vs WS#4)");

    await create2LegTie({
      tieId: "16T-WSSF-B", leagueId,
      roundName: "16T-WSSF", roundType: "tvt",
      homeTeamId: wsM1.loserId, awayTeamId: wsM2.winnerId,
      gw1Id: gw35Id, gw2Id: gw36Id,
      gw1Num: playoffStartGw + 4, gw2Num: playoffStartGw + 5, groupId,
    });
    actions.push("Created 16T-WSSF-B (WS#2 vs WS#3)");
  } else {
    actions.push("WS Seeding incomplete — WS SFs not created");
  }
}

// GW35: mark leg 1 done for all 6 SF ties
async function advanceGW35_16T(actions: string[]) {
  for (const tieId of ["16T-SF-A", "16T-SF-B", "16T-CSF-A", "16T-CSF-B", "16T-WSSF-A", "16T-WSSF-B"]) {
    await markLeg1Done(tieId);
    actions.push(`${tieId}: leg 1 recorded`);
  }
}

// GW36: resolve SF aggregates + create GW37-38 finals
async function advanceGW36_16T(groupId: string, leagueId: string, playoffStartGw: number, actions: string[]) {
  const sfA    = await resolve2LegTie("16T-SF-A",    leagueId);
  const sfB    = await resolve2LegTie("16T-SF-B",    leagueId);
  const csfA   = await resolve2LegTie("16T-CSF-A",   leagueId);
  const csfB   = await resolve2LegTie("16T-CSF-B",   leagueId);
  const wssfA  = await resolve2LegTie("16T-WSSF-A",  leagueId);
  const wssfB  = await resolve2LegTie("16T-WSSF-B",  leagueId);

  for (const [id, r] of [["16T-SF-A", sfA], ["16T-SF-B", sfB], ["16T-CSF-A", csfA], ["16T-CSF-B", csfB], ["16T-WSSF-A", wssfA], ["16T-WSSF-B", wssfB]] as [string, typeof sfA][]) {
    if (r) actions.push(`${id}: aggregate resolved`);
  }

  const gw37Id = await getGameweekId(playoffStartGw + 6, leagueId);
  const gw38Id = await getGameweekId(playoffStartGw + 7, leagueId);
  if (!gw37Id || !gw38Id) throw new Error(`GW${playoffStartGw + 6}/${playoffStartGw + 7} not found`);

  // Championship Final + 3rd Place
  if (sfA?.winnerId && sfB?.winnerId) {
    await create2LegTie({ tieId: "16T-FINAL", leagueId, roundName: "16T-FINAL", roundType: "tvt", homeTeamId: sfA.winnerId, awayTeamId: sfB.winnerId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-FINAL (Championship Grand Final)");
  }
  if (sfA?.loserId && sfB?.loserId) {
    await create2LegTie({ tieId: "16T-3RD", leagueId, roundName: "16T-3RD", roundType: "tvt", homeTeamId: sfA.loserId, awayTeamId: sfB.loserId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-3RD (Championship 3rd Place)");
  }

  // Challenger Final + 3rd Place
  if (csfA?.winnerId && csfB?.winnerId) {
    await create2LegTie({ tieId: "16T-CFINAL", leagueId, roundName: "16T-CFINAL", roundType: "challenger-ko", homeTeamId: csfA.winnerId, awayTeamId: csfB.winnerId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-CFINAL (Challenger Grand Final)");
  }
  if (csfA?.loserId && csfB?.loserId) {
    await create2LegTie({ tieId: "16T-C3RD", leagueId, roundName: "16T-C3RD", roundType: "challenger-ko", homeTeamId: csfA.loserId, awayTeamId: csfB.loserId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-C3RD (Challenger 3rd Place)");
  }

  // Wooden Spoon Final + 3rd Place
  if (wssfA?.winnerId && wssfB?.winnerId) {
    await create2LegTie({ tieId: "16T-WSFINAL", leagueId, roundName: "16T-WSFINAL", roundType: "tvt", homeTeamId: wssfA.winnerId, awayTeamId: wssfB.winnerId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-WSFINAL (WS Final — 13th Place)");
  }
  if (wssfA?.loserId && wssfB?.loserId) {
    await create2LegTie({ tieId: "16T-WS3RD", leagueId, roundName: "16T-WS3RD", roundType: "tvt", homeTeamId: wssfA.loserId, awayTeamId: wssfB.loserId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-WS3RD (WS 3rd Place — 15th Place)");
  }
}

// GW37: mark leg 1 done for all 6 final ties
async function advanceGW37_16T(actions: string[]) {
  for (const tieId of ["16T-FINAL", "16T-3RD", "16T-CFINAL", "16T-C3RD", "16T-WSFINAL", "16T-WS3RD"]) {
    await markLeg1Done(tieId);
    actions.push(`${tieId}: leg 1 recorded`);
  }
}

// GW38: resolve all 6 final aggregates
async function advanceGW38_16T(leagueId: string, actions: string[]) {
  const finals: [string, string][] = [
    ["16T-FINAL",   "Championship Champion"],
    ["16T-3RD",     "Championship 3rd Place"],
    ["16T-CFINAL",  "Challenger Champion (5th)"],
    ["16T-C3RD",    "Challenger 3rd Place (7th)"],
    ["16T-WSFINAL", "13th Place"],
    ["16T-WS3RD",   "15th Place"],
  ];
  for (const [tieId, label] of finals) {
    const result = await resolve2LegTie(tieId, leagueId);
    if (result) actions.push(`${tieId}: ${label} determined!`);
  }
  actions.push("16-team tournament complete!");
}

// Compute playoff group standings for all four 16-team groups across GW31-33.
// Returns groups sorted best→worst. Uses pts (W=2, D=1) then GF as tiebreaker.
async function compute16TGroupStandings(leagueId: string) {
  const allTies = await db.select().from(playoffTies)
    .where(and(
      eq(playoffTies.leagueId, leagueId),
      inArray(playoffTies.roundName, ["16T-CA", "16T-CB", "16T-XA", "16T-XB"]),
    ));

  type TeamStat = { W: number; D: number; L: number; GF: number; GA: number };
  const teamStats = new Map<string, TeamStat>();
  const teamGroup = new Map<string, string>(); // teamId → roundName (their playoff group)

  for (const tie of allTies) {
    if (!tie.homeTeamId || !tie.awayTeamId) continue;

    // Record which group each team belongs to
    teamGroup.set(tie.homeTeamId, tie.roundName);
    teamGroup.set(tie.awayTeamId, tie.roundName);

    if (tie.status !== "complete") continue;

    const hId = tie.homeTeamId;
    const aId = tie.awayTeamId;
    const hScore = tie.homeAggregate ?? 0;
    const aScore = tie.awayAggregate ?? 0;

    if (!teamStats.has(hId)) teamStats.set(hId, { W: 0, D: 0, L: 0, GF: 0, GA: 0 });
    if (!teamStats.has(aId)) teamStats.set(aId, { W: 0, D: 0, L: 0, GF: 0, GA: 0 });

    const h = teamStats.get(hId)!;
    const a = teamStats.get(aId)!;
    h.GF += hScore; h.GA += aScore;
    a.GF += aScore; a.GA += hScore;

    if (hScore > aScore)       { h.W++; a.L++; }
    else if (hScore === aScore) { h.D++; a.D++; }
    else                        { h.L++; a.W++; }
  }

  const grouped: Record<string, { teamId: string; W: number; D: number; L: number; GF: number; GA: number; pts: number }[]> = {
    "16T-CA": [], "16T-CB": [], "16T-XA": [], "16T-XB": [],
  };

  for (const [teamId, groupName] of teamGroup.entries()) {
    if (!grouped[groupName]) continue;
    if (grouped[groupName].some(t => t.teamId === teamId)) continue; // de-dup
    const s = teamStats.get(teamId) ?? { W: 0, D: 0, L: 0, GF: 0, GA: 0 };
    grouped[groupName].push({ teamId, ...s, pts: s.W * 2 + s.D });
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => b.pts !== a.pts ? b.pts - a.pts : b.GF - a.GF);
  }

  return grouped;
}

// ── 32-TEAM handlers (unchanged logic, updated getTie/resolve calls with leagueId) ──

async function advanceGW31(groupId: string, leagueId: string, actions: string[]) {
  for (const suffix of ["A", "B", "C", "D", "E", "F"]) {
    const result = await resolve1LegTie(`C-31-${suffix}`, leagueId);
    if (result) actions.push(`C-31-${suffix}: winner resolved`);
  }

  for (const suffix of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    await markLeg1Done(`RO16-${suffix}`);
    actions.push(`RO16-${suffix}: leg 1 recorded`);
  }

  const gw32Id = await getGameweekId(32, leagueId);
  if (!gw32Id) throw new Error("GW32 not found");

  const c32Seeding: [string, string, string][] = [
    ["C-32-A", "C-31-A", "C-31-F"],
    ["C-32-B", "C-31-B", "C-31-E"],
    ["C-32-C", "C-31-C", "C-31-D"],
  ];

  for (const [tieId, homeTieId, awayTieId] of c32Seeding) {
    const homeTie = await getTie(homeTieId, leagueId);
    const awayTie = await getTie(awayTieId, leagueId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create1LegTie({
      tieId, leagueId,
      roundName: "C-32", roundType: "challenger-ko",
      homeTeamId: homeTie.winnerId, awayTeamId: awayTie.winnerId,
      gwId: gw32Id, gwNum: 32, groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}

async function advanceGW32(groupId: string, leagueId: string, actions: string[]) {
  const ro16Losers: string[] = [];
  for (const suffix of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
    const result = await resolve2LegTie(`RO16-${suffix}`, leagueId);
    if (result) {
      actions.push(`RO16-${suffix}: aggregate winner resolved`);
      ro16Losers.push(result.loserId);
    }
  }

  const c32Winners: string[] = [];
  for (const suffix of ["A", "B", "C"]) {
    const result = await resolve1LegTie(`C-32-${suffix}`, leagueId);
    if (result) {
      actions.push(`C-32-${suffix}: winner resolved`);
      c32Winners.push(result.winnerId);
    }
  }

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
    const homeTie = await getTie(homeTieId, leagueId);
    const awayTie = await getTie(awayTieId, leagueId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create2LegTie({
      tieId, leagueId,
      roundName: "QF", roundType: "tvt",
      homeTeamId: homeTie.winnerId, awayTeamId: awayTie.winnerId,
      gw1Id: gw33Id, gw2Id: gw34Id,
      gw1Num: 33, gw2Num: 34, groupId,
    });
    actions.push(`Created ${tieId} (legs GW33+GW34)`);
  }

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
  for (const suffix of ["A", "B", "C", "D"]) {
    await markLeg1Done(`QF-${suffix}`);
    actions.push(`QF-${suffix}: leg 1 recorded`);
  }

  const gw33 = await db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, 33), eq(gameweeks.leagueId, leagueId)) });
  if (!gw33) throw new Error("GW33 not found");

  const survivalEntries = await db.select().from(challengerSurvivalEntries)
    .where(eq(challengerSurvivalEntries.gameweekId, gw33.id));

  const { getAllCachedScores } = await import("@/lib/fpl-cache");
  const { players: playersTable } = await import("@/lib/db/schema");

  const gw33Cache = await getAllCachedScores(33, leagueId);

  for (const entry of survivalEntries) {
    const teamPlayers = await db.select().from(playersTable)
      .where(eq(playersTable.teamId, entry.teamId));

    let teamScore = 0;
    for (const player of teamPlayers) {
      const cacheKey = `${player.fplId}_gw33`;
      const cached = gw33Cache[cacheKey];
      if (cached) teamScore += cached.netScore;
    }

    await db.update(challengerSurvivalEntries)
      .set({ score: teamScore })
      .where(eq(challengerSurvivalEntries.id, entry.id));
  }

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
  for (const suffix of ["A", "B", "C", "D"]) {
    const result = await resolve2LegTie(`QF-${suffix}`, leagueId);
    if (result) actions.push(`QF-${suffix}: aggregate winner resolved`);
  }

  for (const suffix of ["A", "B", "C", "D"]) {
    const result = await resolve1LegTie(`C-34-${suffix}`, leagueId);
    if (result) actions.push(`C-34-${suffix}: winner resolved`);
  }

  const gw35Id = await getGameweekId(35, leagueId);
  const gw36Id = await getGameweekId(36, leagueId);
  if (!gw35Id || !gw36Id) throw new Error("GW35/GW36 not found");

  const sfSeeding: [string, string, string][] = [
    ["SF-A", "QF-A", "QF-D"],
    ["SF-B", "QF-B", "QF-C"],
  ];

  for (const [tieId, homeTieId, awayTieId] of sfSeeding) {
    const homeTie = await getTie(homeTieId, leagueId);
    const awayTie = await getTie(awayTieId, leagueId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create2LegTie({
      tieId, leagueId,
      roundName: "SF", roundType: "tvt",
      homeTeamId: homeTie.winnerId, awayTeamId: awayTie.winnerId,
      gw1Id: gw35Id, gw2Id: gw36Id,
      gw1Num: 35, gw2Num: 36, groupId,
    });
    actions.push(`Created ${tieId} (legs GW35+GW36)`);
  }

  const c35Seeding: [string, string, string][] = [
    ["C-35-A", "QF-A", "C-34-D"],
    ["C-35-B", "QF-B", "C-34-C"],
    ["C-35-C", "QF-C", "C-34-B"],
    ["C-35-D", "QF-D", "C-34-A"],
  ];

  for (const [tieId, qfTieId, c34TieId] of c35Seeding) {
    const qfTie = await getTie(qfTieId, leagueId);
    const c34Tie = await getTie(c34TieId, leagueId);
    if (!qfTie?.loserId || !c34Tie?.winnerId) continue;

    await create1LegTie({
      tieId, leagueId,
      roundName: "C-35", roundType: "challenger-ko",
      homeTeamId: qfTie.loserId, awayTeamId: c34Tie.winnerId,
      gwId: gw35Id, gwNum: 35, groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}

async function advanceGW35(groupId: string, leagueId: string, actions: string[]) {
  for (const suffix of ["A", "B"]) {
    await markLeg1Done(`SF-${suffix}`);
    actions.push(`SF-${suffix}: leg 1 recorded`);
  }

  for (const suffix of ["A", "B", "C", "D"]) {
    const result = await resolve1LegTie(`C-35-${suffix}`, leagueId);
    if (result) actions.push(`C-35-${suffix}: winner resolved`);
  }

  const gw36Id = await getGameweekId(36, leagueId);
  if (!gw36Id) throw new Error("GW36 not found");

  const c36Seeding: [string, string, string][] = [
    ["C-36-A", "C-35-A", "C-35-D"],
    ["C-36-B", "C-35-B", "C-35-C"],
  ];

  for (const [tieId, homeTieId, awayTieId] of c36Seeding) {
    const homeTie = await getTie(homeTieId, leagueId);
    const awayTie = await getTie(awayTieId, leagueId);
    if (!homeTie?.winnerId || !awayTie?.winnerId) continue;

    await create1LegTie({
      tieId, leagueId,
      roundName: "C-36", roundType: "challenger-ko",
      homeTeamId: homeTie.winnerId, awayTeamId: awayTie.winnerId,
      gwId: gw36Id, gwNum: 36, groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}

async function advanceGW36(groupId: string, leagueId: string, actions: string[]) {
  for (const suffix of ["A", "B"]) {
    const result = await resolve2LegTie(`SF-${suffix}`, leagueId);
    if (result) actions.push(`SF-${suffix}: aggregate winner resolved`);
  }

  for (const suffix of ["A", "B"]) {
    const result = await resolve1LegTie(`C-36-${suffix}`, leagueId);
    if (result) actions.push(`C-36-${suffix}: winner resolved`);
  }

  const gw37Id = await getGameweekId(37, leagueId);
  const gw38Id = await getGameweekId(38, leagueId);
  if (!gw37Id || !gw38Id) throw new Error("GW37/GW38 not found");

  const sfA = await getTie("SF-A", leagueId);
  const sfB = await getTie("SF-B", leagueId);
  if (sfA?.winnerId && sfB?.winnerId) {
    await create2LegTie({
      tieId: "Final", leagueId,
      roundName: "Final", roundType: "tvt",
      homeTeamId: sfA.winnerId, awayTeamId: sfB.winnerId,
      gw1Id: gw37Id, gw2Id: gw38Id,
      gw1Num: 37, gw2Num: 38, groupId,
    });
    actions.push("Created Final tie (legs GW37+GW38)");
  }

  const c36A = await getTie("C-36-A", leagueId);
  const c36B = await getTie("C-36-B", leagueId);

  if (sfA?.loserId && c36B?.winnerId) {
    await create1LegTie({
      tieId: "C-37-A", leagueId,
      roundName: "C-37", roundType: "challenger-ko",
      homeTeamId: sfA.loserId, awayTeamId: c36B.winnerId,
      gwId: gw37Id, gwNum: 37, groupId,
    });
    actions.push("Created C-37-A");
  }

  if (sfB?.loserId && c36A?.winnerId) {
    await create1LegTie({
      tieId: "C-37-B", leagueId,
      roundName: "C-37", roundType: "challenger-ko",
      homeTeamId: sfB.loserId, awayTeamId: c36A.winnerId,
      gwId: gw37Id, gwNum: 37, groupId,
    });
    actions.push("Created C-37-B");
  }
}

async function advanceGW37(groupId: string, leagueId: string, actions: string[]) {
  await markLeg1Done("Final");
  actions.push("Final: leg 1 recorded");

  for (const suffix of ["A", "B"]) {
    const result = await resolve1LegTie(`C-37-${suffix}`, leagueId);
    if (result) actions.push(`C-37-${suffix}: winner resolved`);
  }

  const gw38Id = await getGameweekId(38, leagueId);
  if (!gw38Id) throw new Error("GW38 not found");

  const c37A = await getTie("C-37-A", leagueId);
  const c37B = await getTie("C-37-B", leagueId);

  if (c37A?.winnerId && c37B?.winnerId) {
    await create1LegTie({
      tieId: "C-38-A", leagueId,
      roundName: "C-38", roundType: "challenger-ko",
      homeTeamId: c37A.winnerId, awayTeamId: c37B.winnerId,
      gwId: gw38Id, gwNum: 38, groupId,
    });
    actions.push("Created C-38-A (Challenger Final)");
  }
}

async function advanceGW38(leagueId: string, actions: string[]) {
  const result = await resolve2LegTie("Final", leagueId);
  if (result) actions.push("Final: TVT Champion determined!");

  const c38Result = await resolve1LegTie("C-38-A", leagueId);
  if (c38Result) actions.push("C-38-A: Challenger Series Champion determined!");

  actions.push("Tournament complete!");
}

async function generateC34AfterSurvival(groupId: string, leagueId: string, actions: string[]) {
  const gw34Id = await getGameweekId(34, leagueId);
  if (!gw34Id) throw new Error("GW34 not found");

  const gw33 = await db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, 33), eq(gameweeks.leagueId, leagueId)) });
  if (!gw33) return;

  const entries = await db.select().from(challengerSurvivalEntries)
    .where(eq(challengerSurvivalEntries.gameweekId, gw33.id));

  const ranked = entries.filter(e => e.advanced).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  if (ranked.length < 8) return;

  const c34Pairs: [string, number, number][] = [
    ["C-34-A", 0, 7],
    ["C-34-B", 1, 6],
    ["C-34-C", 2, 5],
    ["C-34-D", 3, 4],
  ];

  for (const [tieId, homeIdx, awayIdx] of c34Pairs) {
    await create1LegTie({
      tieId, leagueId,
      roundName: "C-34", roundType: "challenger-ko",
      homeTeamId: ranked[homeIdx].teamId, awayTeamId: ranked[awayIdx].teamId,
      gwId: gw34Id, gwNum: 34, groupId,
    });
    actions.push(`Created ${tieId}`);
  }
}
