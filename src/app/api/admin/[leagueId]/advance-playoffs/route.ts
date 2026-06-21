import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, playoffTies, gameweeks, gameweekCaptains, results, groups, challengerSurvivalEntries, leagues } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

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

  // For TC knockouts, mirror roundType into competitionType so the TC processor's
  // Pass 3 filter (which historically expected competitionType) matches these rows
  // even when called via the advance helpers. Other formats leave it null.
  const competitionType = params.roundType === "jcl-knockout" || params.roundType === "jel-knockout"
    ? params.roundType
    : null;

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
    competitionType,
  }).onConflictDoNothing({ target: fixtures.id });
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
  }).onConflictDoNothing({ target: playoffTies.tieId });

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

// Create a triple-legged tie + 3 fixtures (legs 1/2/3, alternating swap pattern: H-A, A-H, H-A)
async function create3LegTie(params: {
  tieId: string;
  leagueId: string;
  roundName: string;
  roundType: string;
  homeTeamId: string;
  awayTeamId: string;
  gw1Id: string;
  gw2Id: string;
  gw3Id: string;
  gw1Num: number;
  gw2Num: number;
  gw3Num: number;
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
    gw3: params.gw3Num,
    status: "pending",
  }).onConflictDoNothing({ target: playoffTies.tieId });

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

  // Leg 2: swapped
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

  // Leg 3: swapped back to original orientation
  await createFixture({
    tieId: params.tieId,
    gwId: params.gw3Id,
    homeTeamId: params.homeTeamId,
    awayTeamId: params.awayTeamId,
    groupId: params.groupId,
    roundName: params.roundName,
    roundType: params.roundType,
    leg: 3,
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
  }).onConflictDoNothing({ target: playoffTies.tieId });

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
  if (tie.status === "complete" && tie.winnerId && tie.loserId) {
    return { winnerId: tie.winnerId, loserId: tie.loserId };
  }

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
  if (tie.status === "complete" && tie.winnerId && tie.loserId) {
    return { winnerId: tie.winnerId, loserId: tie.loserId };
  }

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

// Resolve a triple-legged tie: sum all 3 legs (leg2 is swapped). Home wins on aggregate tie.
async function resolve3LegTie(tieId: string, leagueId: string): Promise<{ winnerId: string; loserId: string } | null> {
  const tie = await getTie(tieId, leagueId);
  if (!tie || !tie.homeTeamId || !tie.awayTeamId) return null;
  if (tie.status === "complete" && tie.winnerId && tie.loserId) {
    return { winnerId: tie.winnerId, loserId: tie.loserId };
  }

  const tieFixtures = await db.select().from(fixtures)
    .where(and(eq(fixtures.tieId, tieId), eq(fixtures.isPlayoff, true)));

  const leg1 = tieFixtures.find(f => f.leg === 1);
  const leg2 = tieFixtures.find(f => f.leg === 2);
  const leg3 = tieFixtures.find(f => f.leg === 3);
  if (!leg1 || !leg2 || !leg3) return null;

  const leg1Result = await db.query.results.findFirst({ where: eq(results.fixtureId, leg1.id) });
  const leg2Result = await db.query.results.findFirst({ where: eq(results.fixtureId, leg2.id) });
  const leg3Result = await db.query.results.findFirst({ where: eq(results.fixtureId, leg3.id) });
  if (!leg1Result || !leg2Result || !leg3Result) return null;

  const homeTeamId = tie.homeTeamId;
  const awayTeamId = tie.awayTeamId;

  // leg1/leg3: homeTeam is home; leg2: homeTeam is away (swapped)
  const homeAgg = leg1Result.homeScore + leg2Result.awayScore + leg3Result.homeScore;
  const awayAgg = leg1Result.awayScore + leg2Result.homeScore + leg3Result.awayScore;

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

// Mark leg1 done for a 2-legged tie
async function markLeg1Done(tieId: string) {
  await db.update(playoffTies)
    .set({ status: "leg1_done" })
    .where(eq(playoffTies.tieId, tieId));
}

// Mark leg2 done for a triple-legged tie
async function markLeg2Done(tieId: string) {
  await db.update(playoffTies)
    .set({ status: "leg2_done" })
    .where(eq(playoffTies.tieId, tieId));
}

// ── POST handler ──────────────────────────────────────────────────────────────

/**
 * POST /api/admin/[leagueId]/advance-playoffs
 * Body: { gameweek: number }
 * Routes to format-specific handlers (8-team, 16-team, 32-team).
 */
/**
 * Pure-function variant of the POST handler. Callable in-process from the
 * superadmin "Run Auto-Processing" orchestrator (src/lib/cron/process-all.ts)
 * to avoid HTTP roundtrips and the Vercel Deployment Protection 401 wall.
 *
 * Returns { status, body } — caller wraps in NextResponse.json or interprets
 * body.error / body.success directly.
 */
export async function advancePlayoffsImpl(
  leagueId: string,
  gwNumber: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Fetch format config
  const leagueRow = await db.select({
    format: leagues.format,
    teamSize: leagues.teamSize,
    playoffStartGw: leagues.playoffStartGw,
  }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  const format = leagueRow[0]?.format;
  const teamSize = leagueRow[0]?.teamSize ?? 32;
  const playoffStartGw = leagueRow[0]?.playoffStartGw ?? 31;

  // For TC: use any cup group as the groupId for new fixtures (SF/Final)
  // For TVT: use the "Playoffs" group
  const playoffsGroupId = format === "continental-championship"
    ? (await db.query.groups.findFirst({ where: and(eq(groups.groupType, "cup"), eq(groups.leagueId, leagueId)) }))?.id
    : await getPlayoffsGroupId(leagueId);
  if (!playoffsGroupId) {
    return { status: 500, body: { error: "Playoffs group not found" } };
  }

  // Pre-check: every playoff fixture in the GW being advanced must have a
  // scored result. Otherwise resolve1LegTie / markLeg1Done would silently
  // no-op and the bracket state would drift out of sync with the UI.
  const gwForCheck = await db.query.gameweeks.findFirst({
    where: and(eq(gameweeks.number, gwNumber), eq(gameweeks.leagueId, leagueId)),
  });
  if (!gwForCheck) {
    return { status: 400, body: { error: `GW${gwNumber} not found for this league` } };
  }
  const gwFixturesForCheck = await db.query.fixtures.findMany({
    where: and(eq(fixtures.gameweekId, gwForCheck.id), eq(fixtures.isPlayoff, true)),
    with: { result: true },
  });
  if (gwFixturesForCheck.length === 0) {
    return { status: 400, body: { error: `No playoff fixtures exist for GW${gwNumber}. Generate the bracket or the previous round first.` } };
  }
  const unscored = gwFixturesForCheck.filter(f => !f.result);
  if (unscored.length > 0) {
    const missing = unscored.map(f => {
      const legSuffix = f.leg ? ` (leg ${f.leg})` : "";
      return `${f.tieId ?? f.id}${legSuffix}`;
    });
    return {
      status: 400,
      body: {
        error: `Cannot advance GW${gwNumber} — ${missing.length} of ${gwFixturesForCheck.length} fixture${gwFixturesForCheck.length === 1 ? "" : "s"} not yet scored. Run the scoring job for GW${gwNumber} first, then retry. Missing: ${missing.join(", ")}`,
        gameweek: gwNumber,
        missing,
      },
    };
  }

  const actions: string[] = [];

  try {
    if (format === "continental-championship") {
      // ── TRIPLE CROWN FORMAT ──────────────────────────────────────
      // GW27: QF Leg 1 played (mark leg 1 done)
      // GW29: QF Leg 2 → Resolve QFs + Create SF ties (GW33+35)
      // GW33: SF Leg 1 played (mark leg 1 done)
      // GW35: SF Leg 2 → Resolve SFs + Create 2-leg Finals (GW37+GW38)
      // GW37: Final Leg 1 played (mark leg 1 done)
      // GW38: Final Leg 2 → Resolve 2-leg Finals (UCL + UEL champions crowned)
      if (gwNumber === 27) {
        // QF Leg 1 has been played — mark leg 1 done for all QF ties
        const uclQfTies = await db.select({ tieId: playoffTies.tieId })
          .from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jcl-knockout"), eq(playoffTies.roundName, "UCL-QF")));
        for (const tie of uclQfTies) {
          await markLeg1Done(tie.tieId);
          actions.push(`${tie.tieId}: QF leg 1 recorded`);
        }

        const uelQfTies = await db.select({ tieId: playoffTies.tieId })
          .from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jel-knockout"), eq(playoffTies.roundName, "UEL-QF")));
        for (const tie of uelQfTies) {
          await markLeg1Done(tie.tieId);
          actions.push(`${tie.tieId}: QF leg 1 recorded`);
        }
      } else if (gwNumber === 29) {
        // QF Leg 2 — Resolve all QF ties and create SF ties
        const uclQfTies = await db.select().from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jcl-knockout"), eq(playoffTies.roundName, "UCL-QF")));
        const uelQfTies = await db.select().from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jel-knockout"), eq(playoffTies.roundName, "UEL-QF")));

        // Resolve UCL QFs
        const uclWinners: Array<{ winnerId: string; loserId: string }> = [];
        for (const tie of uclQfTies) {
          const result = await resolve2LegTie(tie.tieId, leagueId);
          if (result) {
            uclWinners.push(result);
            actions.push(`${tie.tieId}: UCL QF winner determined`);
          }
        }

        // Resolve UEL QFs
        const uelWinners: Array<{ winnerId: string; loserId: string }> = [];
        for (const tie of uelQfTies) {
          const result = await resolve2LegTie(tie.tieId, leagueId);
          if (result) {
            uelWinners.push(result);
            actions.push(`${tie.tieId}: UEL QF winner determined`);
          }
        }

        // Create UCL SF ties: QF-1 winner vs QF-4 winner, QF-2 winner vs QF-3 winner
        // Skip if SFs already exist (idempotent re-advance)
        const existingUclSf = await getTie("UCL-SF-1", leagueId);
        if (!existingUclSf && uclWinners.length >= 4) {
          const gw33 = await getGameweekId(33, leagueId);
          const gw35 = await getGameweekId(35, leagueId);
          if (gw33 && gw35) {
            await create2LegTie({
              tieId: "UCL-SF-1",
              leagueId,
              roundName: "UCL-SF",
              roundType: "jcl-knockout",
              homeTeamId: uclWinners[0].winnerId,
              awayTeamId: uclWinners[3].winnerId,
              gw1Id: gw33,
              gw2Id: gw35,
              gw1Num: 33,
              gw2Num: 35,
              groupId: playoffsGroupId,
            });
            await create2LegTie({
              tieId: "UCL-SF-2",
              leagueId,
              roundName: "UCL-SF",
              roundType: "jcl-knockout",
              homeTeamId: uclWinners[1].winnerId,
              awayTeamId: uclWinners[2].winnerId,
              gw1Id: gw33,
              gw2Id: gw35,
              gw1Num: 33,
              gw2Num: 35,
              groupId: playoffsGroupId,
            });
            actions.push("UCL-SF: 2 Semi-Final ties created");
          }
        } else if (!existingUclSf && uclWinners.length >= 2) {
          // Fallback: fewer than 4 QF results — pair sequentially
          const gw33 = await getGameweekId(33, leagueId);
          const gw35 = await getGameweekId(35, leagueId);
          if (gw33 && gw35) {
            await create2LegTie({
              tieId: "UCL-SF-1",
              leagueId,
              roundName: "UCL-SF",
              roundType: "jcl-knockout",
              homeTeamId: uclWinners[0].winnerId,
              awayTeamId: uclWinners[1].winnerId,
              gw1Id: gw33,
              gw2Id: gw35,
              gw1Num: 33,
              gw2Num: 35,
              groupId: playoffsGroupId,
            });
            actions.push("UCL-SF: SF-1 created (partial)");
          }
        }

        // Create UEL SF ties: QF-1 winner vs QF-4 winner, QF-2 winner vs QF-3 winner
        const existingUelSf = await getTie("UEL-SF-1", leagueId);
        if (!existingUelSf && uelWinners.length >= 4) {
          const gw33 = await getGameweekId(33, leagueId);
          const gw35 = await getGameweekId(35, leagueId);
          if (gw33 && gw35) {
            await create2LegTie({
              tieId: "UEL-SF-1",
              leagueId,
              roundName: "UEL-SF",
              roundType: "jel-knockout",
              homeTeamId: uelWinners[0].winnerId,
              awayTeamId: uelWinners[3].winnerId,
              gw1Id: gw33,
              gw2Id: gw35,
              gw1Num: 33,
              gw2Num: 35,
              groupId: playoffsGroupId,
            });
            await create2LegTie({
              tieId: "UEL-SF-2",
              leagueId,
              roundName: "UEL-SF",
              roundType: "jel-knockout",
              homeTeamId: uelWinners[1].winnerId,
              awayTeamId: uelWinners[2].winnerId,
              gw1Id: gw33,
              gw2Id: gw35,
              gw1Num: 33,
              gw2Num: 35,
              groupId: playoffsGroupId,
            });
            actions.push("UEL-SF: 2 Semi-Final ties created");
          }
        } else if (!existingUelSf && uelWinners.length >= 2) {
          const gw33 = await getGameweekId(33, leagueId);
          const gw35 = await getGameweekId(35, leagueId);
          if (gw33 && gw35) {
            await create2LegTie({
              tieId: "UEL-SF-1",
              leagueId,
              roundName: "UEL-SF",
              roundType: "jel-knockout",
              homeTeamId: uelWinners[0].winnerId,
              awayTeamId: uelWinners[1].winnerId,
              gw1Id: gw33,
              gw2Id: gw35,
              gw1Num: 33,
              gw2Num: 35,
              groupId: playoffsGroupId,
            });
            actions.push("UEL-SF: SF-1 created (partial)");
          }
        }
      } else if (gwNumber === 33) {
        // SF Leg 1 played — mark leg 1 done for all SF ties
        const uclSfTies = await db.select({ tieId: playoffTies.tieId })
          .from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jcl-knockout"), eq(playoffTies.roundName, "UCL-SF")));
        for (const tie of uclSfTies) {
          await markLeg1Done(tie.tieId);
          actions.push(`${tie.tieId}: SF leg 1 recorded`);
        }

        const uelSfTies = await db.select({ tieId: playoffTies.tieId })
          .from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jel-knockout"), eq(playoffTies.roundName, "UEL-SF")));
        for (const tie of uelSfTies) {
          await markLeg1Done(tie.tieId);
          actions.push(`${tie.tieId}: SF leg 1 recorded`);
        }
      } else if (gwNumber === 35) {
        // SF Leg 2 — Resolve all SF ties and create Finals
        const uclSfTies = await db.select().from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jcl-knockout"), eq(playoffTies.roundName, "UCL-SF")));
        const uelSfTies = await db.select().from(playoffTies)
          .where(and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jel-knockout"), eq(playoffTies.roundName, "UEL-SF")));

        // Resolve UCL SFs
        const uclSfWinners: Array<{ winnerId: string; loserId: string }> = [];
        for (const tie of uclSfTies) {
          const result = await resolve2LegTie(tie.tieId, leagueId);
          if (result) {
            uclSfWinners.push(result);
            actions.push(`${tie.tieId}: UCL SF winner determined`);
          }
        }

        // Create UCL Final — 2-legged across GW37 (leg 1) + GW38 (leg 2). Skip if already exists.
        const existingUclFinal = await getTie("UCL-FINAL", leagueId);
        if (!existingUclFinal && uclSfWinners.length >= 2) {
          const gw37 = await getGameweekId(37, leagueId);
          const gw38 = await getGameweekId(38, leagueId);
          if (gw37 && gw38) {
            await create2LegTie({
              tieId: "UCL-FINAL",
              leagueId,
              roundName: "UCL-FINAL",
              roundType: "jcl-knockout",
              homeTeamId: uclSfWinners[0].winnerId,
              awayTeamId: uclSfWinners[1].winnerId,
              gw1Id: gw37,
              gw2Id: gw38,
              gw1Num: 37,
              gw2Num: 38,
              groupId: playoffsGroupId,
            });
            actions.push("UCL-FINAL: 2-leg Final created (GW37+38)");
          }
        }

        // Resolve UEL SFs
        const uelSfWinners: Array<{ winnerId: string; loserId: string }> = [];
        for (const tie of uelSfTies) {
          const result = await resolve2LegTie(tie.tieId, leagueId);
          if (result) {
            uelSfWinners.push(result);
            actions.push(`${tie.tieId}: UEL SF winner determined`);
          }
        }

        // Create UEL Final — 2-legged across GW37 (leg 1) + GW38 (leg 2). Skip if already exists.
        const existingUelFinal = await getTie("UEL-FINAL", leagueId);
        if (!existingUelFinal && uelSfWinners.length >= 2) {
          const gw37 = await getGameweekId(37, leagueId);
          const gw38 = await getGameweekId(38, leagueId);
          if (gw37 && gw38) {
            await create2LegTie({
              tieId: "UEL-FINAL",
              leagueId,
              roundName: "UEL-FINAL",
              roundType: "jel-knockout",
              homeTeamId: uelSfWinners[0].winnerId,
              awayTeamId: uelSfWinners[1].winnerId,
              gw1Id: gw37,
              gw2Id: gw38,
              gw1Num: 37,
              gw2Num: 38,
              groupId: playoffsGroupId,
            });
            actions.push("UEL-FINAL: 2-leg Final created (GW37+38)");
          }
        }
      } else if (gwNumber === 37) {
        // Final Leg 1 played — mark leg 1 done for UCL/UEL Finals
        await markLeg1Done("UCL-FINAL");
        actions.push("UCL-FINAL: Final leg 1 recorded");
        await markLeg1Done("UEL-FINAL");
        actions.push("UEL-FINAL: Final leg 1 recorded");
      } else if (gwNumber === 38) {
        // Final Leg 2 — Resolve 2-leg aggregate Finals (UCL + UEL)
        const uclFinal = await resolve2LegTie("UCL-FINAL", leagueId);
        if (uclFinal) actions.push("UCL-FINAL: UCL Champion crowned!");

        const uelFinal = await resolve2LegTie("UEL-FINAL", leagueId);
        if (uelFinal) actions.push("UEL-FINAL: UEL Champion crowned!");

        actions.push("Triple Crown tournament complete!");
      } else {
        return {
          status: 400,
          body: { error: "Triple Crown playoff advancement: GW27 (QF Leg 1), GW29 (QF Leg 2 + SF creation), GW33 (SF Leg 1), GW35 (SF Leg 2 + Final creation), GW37 (Final Leg 1), or GW38 (Final Leg 2)" },
        };
      }

    } else if (teamSize === 8) {
      // ── 8-TEAM FORMAT ────────────────────────────────────────
      // GW36 (playoffStartGw): resolve SFs → create Final + 3rd
      // GW37 (playoffStartGw+1): mark leg1 done
      // GW38 (playoffStartGw+2): resolve Finals
      if (gwNumber < playoffStartGw || gwNumber > playoffStartGw + 2) {
        return {
          status: 400,
          body: { error: `8-team playoff gameweeks are ${playoffStartGw}–${playoffStartGw + 2}` },
        };
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
        return {
          status: 400,
          body: { error: `16-team playoff gameweeks are ${playoffStartGw}–${playoffStartGw + 7}` },
        };
      }
      const gwOffset = gwNumber - playoffStartGw;
      switch (gwOffset) {
        case 0: await advanceGroupGW_16T(0, leagueId, actions); break;      // GW31
        case 1: await advanceGroupGW_16T(1, leagueId, actions); break;      // GW32
        case 2: await advanceGW33_16T(playoffsGroupId, leagueId, playoffStartGw, actions); break; // GW33 + create SFs (GW34+35) + Chall QFs + WS Seeding
        case 3: await advanceGW34_16T(playoffsGroupId, leagueId, playoffStartGw, actions); break; // GW34: SF leg1 + resolve QFs/WS, create CSF/WSSF
        case 4: await advanceGW35_16T(playoffsGroupId, leagueId, playoffStartGw, actions); break; // GW35: resolve SFs, create 3-leg Final/3rd (GW36+37+38), CSF/WSSF leg1
        case 5: await advanceGW36_16T(playoffsGroupId, leagueId, playoffStartGw, actions); break; // GW36: resolve CSFs/WSSFs, create CFINAL/CW3RD/WSFINAL/WS3RD; Final/3rd leg1
        case 6: await advanceGW37_16T(actions); break;                       // GW37: 2-leg finals leg1; 3-leg Final/3rd leg2
        case 7: await advanceGW38_16T(leagueId, actions); break;             // GW38: resolve all (3-leg + 2-leg)
      }

    } else {
      // ── 32-TEAM FORMAT ───────────────────────────────────────
      if (gwNumber < 31 || gwNumber > 38) {
        return { status: 400, body: { error: "Gameweek must be between 31 and 38" } };
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

    await invalidateLeaguePageCache(leagueId);
    return { status: 200, body: { success: true, gameweek: gwNumber, actions } };
  } catch (error) {
    console.error("Error advancing playoffs:", error);
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : "Failed to advance playoffs" },
    };
  }
}

/**
 * Thin HTTP wrapper. Pulls gameweek from `?gw=N` query param OR `{ gameweek: N }`
 * body, then delegates to advancePlayoffsImpl. Per-league admin pages, the cron
 * fallback, and any external caller all hit this route.
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let gwNumber: number | undefined;
  const queryGw = request.nextUrl.searchParams.get("gw");
  if (queryGw) {
    const parsed = parseInt(queryGw, 10);
    if (!isNaN(parsed)) gwNumber = parsed;
  }
  if (gwNumber == null) {
    try {
      const body = await request.json();
      const fromBody = body?.gameweek;
      if (typeof fromBody === "number") gwNumber = fromBody;
    } catch { /* no body */ }
  }
  if (!gwNumber || isNaN(gwNumber)) {
    return NextResponse.json({ error: "Gameweek number required (?gw=N or { gameweek: N })" }, { status: 400 });
  }

  const { status, body } = await advancePlayoffsImpl(leagueId, gwNumber);
  return NextResponse.json(body, { status });
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
  //   Elite 4   (→ Championship SFs GW34+35): champA[0..1], champB[0..1]
  //   Relegated 4 (→ GW34 Chall QFs):         champA[2..3], champB[2..3]
  //   Survivors 4 (→ GW34 Chall QFs):         challA[0..1], challB[0..1]
  //   Wooden Spoon 4 (→ GW34 WS seeding):     challA[2..3], challB[2..3]

  const gw34Id = await getGameweekId(playoffStartGw + 3, leagueId);
  const gw35Id = await getGameweekId(playoffStartGw + 4, leagueId);
  if (!gw34Id || !gw35Id) throw new Error(`GW${playoffStartGw + 3}/${playoffStartGw + 4} not found`);

  // Championship Semi-Finals — directly seeded from group standings (no Elite Seeding round)
  // SF-A: ChampA1 vs ChampB2  (Group A winner vs Group B runner-up)
  // SF-B: ChampB1 vs ChampA2  (Group B winner vs Group A runner-up)
  await create2LegTie({
    tieId: "16T-SF-A", leagueId,
    roundName: "16T-SF", roundType: "tvt",
    homeTeamId: champA[0].teamId, awayTeamId: champB[1].teamId,
    gw1Id: gw34Id, gw2Id: gw35Id,
    gw1Num: playoffStartGw + 3, gw2Num: playoffStartGw + 4, groupId,
  });
  actions.push("Created 16T-SF-A (ChampA1 vs ChampB2, GW34+35)");

  await create2LegTie({
    tieId: "16T-SF-B", leagueId,
    roundName: "16T-SF", roundType: "tvt",
    homeTeamId: champB[0].teamId, awayTeamId: champA[1].teamId,
    gw1Id: gw34Id, gw2Id: gw35Id,
    gw1Num: playoffStartGw + 3, gw2Num: playoffStartGw + 4, groupId,
  });
  actions.push("Created 16T-SF-B (ChampB1 vs ChampA2, GW34+35)");

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

// GW34: SF leg 1 done; resolve 1-leg Challenger QFs + 1-leg WS Seeding; create CSF/WSSF (2-leg, GW35+36)
async function advanceGW34_16T(groupId: string, leagueId: string, playoffStartGw: number, actions: string[]) {
  // Championship SFs played leg 1 in GW34
  await markLeg1Done("16T-SF-A");
  await markLeg1Done("16T-SF-B");
  actions.push("16T-SF-A / 16T-SF-B: leg 1 recorded");

  // Resolve 1-leg Challenger QFs
  for (const qfId of ["16T-QF1", "16T-QF2", "16T-QF3", "16T-QF4"]) {
    const result = await resolve1LegTie(qfId, leagueId);
    if (result) actions.push(`${qfId}: QF resolved`);
  }

  // Resolve 1-leg Wooden Spoon Seeding
  const wsM1 = await resolve1LegTie("16T-WS-M1", leagueId);
  const wsM2 = await resolve1LegTie("16T-WS-M2", leagueId);
  if (wsM1) actions.push("16T-WS-M1: WS Seeding resolved");
  if (wsM2) actions.push("16T-WS-M2: WS Seeding resolved");

  const gw35Id = await getGameweekId(playoffStartGw + 4, leagueId);
  const gw36Id = await getGameweekId(playoffStartGw + 5, leagueId);
  if (!gw35Id || !gw36Id) throw new Error(`GW${playoffStartGw + 4}/${playoffStartGw + 5} not found`);

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

// GW35: resolve Championship SFs (2-leg agg) + create 3-leg Final/3rd (GW36+37+38);
//       mark CSF/WSSF leg 1 done (their leg 2 plays in GW36)
async function advanceGW35_16T(groupId: string, leagueId: string, playoffStartGw: number, actions: string[]) {
  const sfA = await resolve2LegTie("16T-SF-A", leagueId);
  const sfB = await resolve2LegTie("16T-SF-B", leagueId);
  if (sfA) actions.push("16T-SF-A: aggregate resolved");
  if (sfB) actions.push("16T-SF-B: aggregate resolved");

  // CSF/WSSF leg 1 played in GW35; leg 2 will be GW36
  for (const tieId of ["16T-CSF-A", "16T-CSF-B", "16T-WSSF-A", "16T-WSSF-B"]) {
    await markLeg1Done(tieId);
    actions.push(`${tieId}: leg 1 recorded`);
  }

  const gw36Id = await getGameweekId(playoffStartGw + 5, leagueId);
  const gw37Id = await getGameweekId(playoffStartGw + 6, leagueId);
  const gw38Id = await getGameweekId(playoffStartGw + 7, leagueId);
  if (!gw36Id || !gw37Id || !gw38Id) throw new Error(`GW${playoffStartGw + 5}/${playoffStartGw + 6}/${playoffStartGw + 7} not found`);

  // Championship Final + 3rd Place — TRIPLE-LEGGED across GW36+37+38, decided by aggregate
  if (sfA?.winnerId && sfB?.winnerId) {
    await create3LegTie({
      tieId: "16T-FINAL", leagueId, roundName: "16T-FINAL", roundType: "tvt",
      homeTeamId: sfA.winnerId, awayTeamId: sfB.winnerId,
      gw1Id: gw36Id, gw2Id: gw37Id, gw3Id: gw38Id,
      gw1Num: playoffStartGw + 5, gw2Num: playoffStartGw + 6, gw3Num: playoffStartGw + 7,
      groupId,
    });
    actions.push("Created 16T-FINAL (Championship Grand Final — triple-legged GW36+37+38)");
  }
  if (sfA?.loserId && sfB?.loserId) {
    await create3LegTie({
      tieId: "16T-3RD", leagueId, roundName: "16T-3RD", roundType: "tvt",
      homeTeamId: sfA.loserId, awayTeamId: sfB.loserId,
      gw1Id: gw36Id, gw2Id: gw37Id, gw3Id: gw38Id,
      gw1Num: playoffStartGw + 5, gw2Num: playoffStartGw + 6, gw3Num: playoffStartGw + 7,
      groupId,
    });
    actions.push("Created 16T-3RD (Championship 3rd Place — triple-legged GW36+37+38)");
  }
}

// GW36: resolve Challenger SFs and WS SFs (2-leg agg); create 2-leg Challenger/WS finals on GW37+38;
//       mark Championship 3-leg Final/3rd leg 1 done
async function advanceGW36_16T(groupId: string, leagueId: string, playoffStartGw: number, actions: string[]) {
  const csfA  = await resolve2LegTie("16T-CSF-A",  leagueId);
  const csfB  = await resolve2LegTie("16T-CSF-B",  leagueId);
  const wssfA = await resolve2LegTie("16T-WSSF-A", leagueId);
  const wssfB = await resolve2LegTie("16T-WSSF-B", leagueId);

  for (const [id, r] of [["16T-CSF-A", csfA], ["16T-CSF-B", csfB], ["16T-WSSF-A", wssfA], ["16T-WSSF-B", wssfB]] as [string, typeof csfA][]) {
    if (r) actions.push(`${id}: aggregate resolved`);
  }

  // Championship triple-leg finals played leg 1 in GW36
  await markLeg1Done("16T-FINAL");
  await markLeg1Done("16T-3RD");
  actions.push("16T-FINAL / 16T-3RD: leg 1 recorded");

  const gw37Id = await getGameweekId(playoffStartGw + 6, leagueId);
  const gw38Id = await getGameweekId(playoffStartGw + 7, leagueId);
  if (!gw37Id || !gw38Id) throw new Error(`GW${playoffStartGw + 6}/${playoffStartGw + 7} not found`);

  // Challenger Final + 3rd Place (2-leg, GW37+38 — unchanged)
  if (csfA?.winnerId && csfB?.winnerId) {
    await create2LegTie({ tieId: "16T-CFINAL", leagueId, roundName: "16T-CFINAL", roundType: "challenger-ko", homeTeamId: csfA.winnerId, awayTeamId: csfB.winnerId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-CFINAL (Challenger Grand Final)");
  }
  if (csfA?.loserId && csfB?.loserId) {
    await create2LegTie({ tieId: "16T-C3RD", leagueId, roundName: "16T-C3RD", roundType: "challenger-ko", homeTeamId: csfA.loserId, awayTeamId: csfB.loserId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-C3RD (Challenger 3rd Place)");
  }

  // Wooden Spoon Final + 3rd Place (2-leg, GW37+38 — unchanged)
  if (wssfA?.winnerId && wssfB?.winnerId) {
    await create2LegTie({ tieId: "16T-WSFINAL", leagueId, roundName: "16T-WSFINAL", roundType: "tvt", homeTeamId: wssfA.winnerId, awayTeamId: wssfB.winnerId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-WSFINAL (WS Final — 13th Place)");
  }
  if (wssfA?.loserId && wssfB?.loserId) {
    await create2LegTie({ tieId: "16T-WS3RD", leagueId, roundName: "16T-WS3RD", roundType: "tvt", homeTeamId: wssfA.loserId, awayTeamId: wssfB.loserId, gw1Id: gw37Id, gw2Id: gw38Id, gw1Num: playoffStartGw + 6, gw2Num: playoffStartGw + 7, groupId });
    actions.push("Created 16T-WS3RD (WS 3rd Place — 15th Place)");
  }
}

// GW37: 2-leg Challenger/WS finals leg 1 done; 3-leg Championship Final/3rd leg 2 done
async function advanceGW37_16T(actions: string[]) {
  for (const tieId of ["16T-CFINAL", "16T-C3RD", "16T-WSFINAL", "16T-WS3RD"]) {
    await markLeg1Done(tieId);
    actions.push(`${tieId}: leg 1 recorded`);
  }
  for (const tieId of ["16T-FINAL", "16T-3RD"]) {
    await markLeg2Done(tieId);
    actions.push(`${tieId}: leg 2 recorded`);
  }
}

// GW38: resolve all finals — 3-leg aggregate for Championship; 2-leg aggregate for Challenger/WS
async function advanceGW38_16T(leagueId: string, actions: string[]) {
  const tripleFinals: [string, string][] = [
    ["16T-FINAL", "Championship Champion"],
    ["16T-3RD",   "Championship 3rd Place"],
  ];
  for (const [tieId, label] of tripleFinals) {
    const result = await resolve3LegTie(tieId, leagueId);
    if (result) actions.push(`${tieId}: ${label} determined!`);
  }

  const twoLegFinals: [string, string][] = [
    ["16T-CFINAL",  "Challenger Champion (5th)"],
    ["16T-C3RD",    "Challenger 3rd Place (7th)"],
    ["16T-WSFINAL", "13th Place"],
    ["16T-WS3RD",   "15th Place"],
  ];
  for (const [tieId, label] of twoLegFinals) {
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

  const { players: playersTable } = await import("@/lib/db/schema");
  const { calculateTeamGameweekScore } = await import("@/lib/fpl");
  const { pickTempCaptain } = await import("@/lib/scoring/temp-captain");

  // Lookup announced captains for GW33 and GW32 (for temp-cap rotation tiebreak)
  const gw32 = await db.query.gameweeks.findFirst({ where: and(eq(gameweeks.number, 32), eq(gameweeks.leagueId, leagueId)) });
  const gw33Captains = await db.query.gameweekCaptains.findMany({
    where: eq(gameweekCaptains.gameweekId, gw33.id),
    with: { player: true },
  });
  const captainByTeam33 = new Map<string, string>();
  const autoAssignedByTeam33 = new Map<string, boolean>();
  for (const pick of gw33Captains) {
    captainByTeam33.set(pick.player.teamId, pick.player.id);
    autoAssignedByTeam33.set(pick.player.teamId, pick.isValid === false);
  }

  const prevCaptainByTeam = new Map<string, string>();
  if (gw32) {
    const gw32Captains = await db.query.gameweekCaptains.findMany({
      where: eq(gameweekCaptains.gameweekId, gw32.id),
      with: { player: true },
    });
    for (const pick of gw32Captains) prevCaptainByTeam.set(pick.player.teamId, pick.player.id);
  }

  const computed: { entryId: string; total: number; playerScores: unknown[] | null }[] = [];

  for (const entry of survivalEntries) {
    const teamPlayers = await db.select().from(playersTable)
      .where(eq(playersTable.teamId, entry.teamId));

    try {
      // Cache-first; FPL fallback for teams not covered by any GW33 fixture.
      const raw = await Promise.all(teamPlayers.map(async (p) => {
        const s = await calculateTeamGameweekScore(p.fplId, 33, leagueId);
        return { id: p.id, name: p.name, fplId: p.fplId, fplScore: s.points, transferHits: s.transferHits, netScore: s.netScore };
      }));

      // Resolve captain: announced > temp-cap fallback (lowest net, rotate on tie).
      // Auto-assigned captains (gameweek_captains.isValid === false) also count as temp.
      const announcedCaptainId = captainByTeam33.get(entry.teamId) ?? null;
      const prevCaptainId = prevCaptainByTeam.get(entry.teamId) ?? null;
      let resolvedCaptainId: string | null = announcedCaptainId;
      let isTemp = autoAssignedByTeam33.get(entry.teamId) ?? false;
      if (!resolvedCaptainId) {
        // Live preview only — no capContext, so wouldExceedCap is irrelevant here.
        const picked = pickTempCaptain(raw, prevCaptainId);
        resolvedCaptainId = picked?.playerId ?? null;
        isTemp = !!resolvedCaptainId;
      }

      let total = 0;
      const playerScores = raw.map((r) => {
        const isCaptain = resolvedCaptainId === r.id;
        const finalScore = isCaptain ? r.netScore * 2 : r.netScore;
        total += finalScore;
        return {
          name: r.name,
          fplId: r.fplId,
          fplScore: r.fplScore,
          transferHits: r.transferHits,
          isCaptain,
          ...(isCaptain && isTemp ? { isTempCaptain: true } : {}),
          finalScore,
        };
      });

      computed.push({ entryId: entry.id, total, playerScores });
    } catch (err) {
      console.error(`Survival GW33 fetch failed for team ${entry.teamId}:`, err);
      actions.push(`Survival GW33: failed to fetch FPL data for team ${entry.teamId} — re-run advance`);
      computed.push({ entryId: entry.id, total: 0, playerScores: null });
    }
  }

  // Sort descending by total; assign rank + advanced flag (top 8 advance, bottom 3 eliminated)
  computed.sort((a, b) => b.total - a.total);
  for (let i = 0; i < computed.length; i++) {
    const c = computed[i];
    await db.update(challengerSurvivalEntries)
      .set({
        score: c.total,
        rank: i + 1,
        advanced: i < 8,
        playerScores: c.playerScores ? JSON.stringify(c.playerScores) : null,
      })
      .where(eq(challengerSurvivalEntries.id, c.entryId));
  }
  actions.push(`Ranked ${computed.length} survival teams, top 8 advance`);
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
