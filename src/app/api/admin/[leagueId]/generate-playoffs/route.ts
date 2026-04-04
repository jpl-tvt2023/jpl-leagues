import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, playoffTies, gameweeks, results, groups, teams, leagues } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateId } from "@/lib/id";
import {
  RO16_SEEDING,
  C31_SEEDING_32,
  SF_SEEDING_8,
  CHAMP_GA_MATCHES,
  CHAMP_GB_MATCHES,
  CHALL_GA_MATCHES,
  CHALL_GB_MATCHES,
  getGroupStandings,
  ensurePlayoffGws,
  getInitialRoundNames,
} from "@/lib/formats/tvt/playoffs";

/**
 * GET /api/admin/[leagueId]/generate-playoffs
 * Check if playoffs have already been generated for this league
 */
export async function GET(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const existingTies = await db.select().from(playoffTies)
    .where(eq(playoffTies.leagueId, leagueId))
    .limit(1);
  return NextResponse.json({
    generated: existingTies.length > 0,
  });
}

/**
 * DELETE /api/admin/[leagueId]/generate-playoffs
 * Delete initial playoff ties, fixtures, and results for this league so they can be regenerated.
 */
export async function DELETE(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const leagueRow = await db.select({ teamSize: leagues.teamSize })
    .from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  const teamSize = leagueRow[0]?.teamSize ?? 32;

  const initialRounds = getInitialRoundNames(teamSize);

  const tiesToDelete = await db.select({ tieId: playoffTies.tieId })
    .from(playoffTies)
    .where(and(
      eq(playoffTies.leagueId, leagueId),
      inArray(playoffTies.roundName, initialRounds)
    ));
  const tieIdList = tiesToDelete.map(t => t.tieId);

  if (tieIdList.length === 0) {
    await invalidateLeaguePageCache(leagueId);
    return NextResponse.json({ success: true, message: "No initial ties to delete", deletedFixtures: 0 });
  }

  const fixturesToDelete = await db.select({ id: fixtures.id })
    .from(fixtures)
    .where(inArray(fixtures.tieId, tieIdList));
  const fixtureIds = fixturesToDelete.map(f => f.id);

  await db.transaction(async (tx) => {
    if (fixtureIds.length > 0) {
      await tx.delete(results).where(inArray(results.fixtureId, fixtureIds));
      await tx.delete(fixtures).where(inArray(fixtures.id, fixtureIds));
    }
    await tx.delete(playoffTies).where(inArray(playoffTies.tieId, tieIdList));
  });

  await invalidateLeaguePageCache(leagueId);
  return NextResponse.json({
    success: true,
    message: `Deleted ${tieIdList.length} ties and ${fixtureIds.length} fixtures`,
    deletedFixtures: fixtureIds.length,
  });
}

/**
 * POST /api/admin/[leagueId]/generate-playoffs
 * Generate initial playoff ties + fixtures from final group standings.
 * Branches by league teamSize: 32-team (RO16+C31), 16-team (group stage GW31-33), 8-team (SF only).
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Fetch league config
  const leagueRow = await db.select({
    teamSize: leagues.teamSize,
    playoffStartGw: leagues.playoffStartGw,
  }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (leagueRow.length === 0) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }
  const teamSize = leagueRow[0].teamSize ?? 32;
  const playoffStartGw = leagueRow[0].playoffStartGw ?? 31;
  const leagueStageEnd = playoffStartGw - 1;

  // Check if initial ties already exist
  const initialRounds = getInitialRoundNames(teamSize);

  const existingInitialTies = await db.select().from(playoffTies)
    .where(and(
      eq(playoffTies.leagueId, leagueId),
      inArray(playoffTies.roundName, initialRounds)
    ))
    .limit(1);
  if (existingInitialTies.length > 0) {
    return NextResponse.json({
      error: "Initial playoff ties already exist for this league. Delete them first to regenerate.",
    }, { status: 400 });
  }

  // Fetch regular-season group standings
  const groupStandings = await getGroupStandings(leagueId, leagueStageEnd);
  if (!groupStandings) {
    return NextResponse.json({ error: "Failed to compute standings" }, { status: 500 });
  }
  const { groupA, groupB } = groupStandings;

  // Get or create Playoffs group for this league
  let playoffsGroupId: string;
  const existingPlayoffsGroup = await db.query.groups.findFirst({
    where: and(eq(groups.name, "Playoffs"), eq(groups.leagueId, leagueId)),
  });
  if (existingPlayoffsGroup) {
    playoffsGroupId = existingPlayoffsGroup.id;
  } else {
    playoffsGroupId = generateId();
    await db.insert(groups).values({ id: playoffsGroupId, name: "Playoffs", leagueId });
  }

  // Auto-create playoff gameweeks (fetches real FPL deadlines where available)
  const gwCache = await ensurePlayoffGws(playoffStartGw, leagueId);

  // Build rank maps (group letter → rank number → team info)
  const rankMap: Record<string, Record<number, { teamId: string; name: string; abbreviation: string }>> = {
    A: {},
    B: {},
  };
  for (const team of groupA) {
    rankMap["A"][team.groupRank] = { teamId: team.teamId, name: team.name, abbreviation: team.abbreviation };
  }
  for (const team of groupB) {
    rankMap["B"][team.groupRank] = { teamId: team.teamId, name: team.name, abbreviation: team.abbreviation };
  }

  const createdTies: string[] = [];
  const createdFixtures: string[] = [];

  // ============================================================
  // Branch by format — each format is fully isolated
  // ============================================================

  if (teamSize === 8) {
    // ── 8-TEAM FORMAT ─────────────────────────────────────────
    // GW36 (playoffStartGw): SF (1-legged) — 1v4, 2v3
    // GW37+38: Final (2-legged) + 3rd Place (2-legged) — created by advance-playoffs after SF
    const gwSfId = gwCache[playoffStartGw];

    for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of SF_SEEDING_8) {
      const home = rankMap[homeGroup][homeRank];
      const away = rankMap[awayGroup][awayRank];
      if (!home || !away) continue;

      await db.insert(playoffTies).values({
        tieId,
        leagueId,
        roundName: "8T-SF",
        roundType: "tvt",
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        gw1: playoffStartGw,
        gw2: null,
        status: "pending",
      });
      createdTies.push(tieId);

      const fixtureId = `playoff-${tieId}`;
      await db.insert(fixtures).values({
        id: fixtureId,
        gameweekId: gwSfId,
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        groupId: playoffsGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "8T-SF",
        leg: null,
        tieId,
        roundType: "tvt",
      });
      createdFixtures.push(fixtureId);
    }

  } else if (teamSize === 16) {
    // ── 16-TEAM FORMAT (JPL-TVT Merged Funnel) ────────────────
    // GW31-33: Playoff Group Stage (4 groups of 4, snake-seeded)
    //   Championship A (ranks 1,4,5,8), Championship B (ranks 2,3,6,7)
    //   Challenger A (ranks 9,12,13,16), Challenger B (ranks 10,11,14,15)
    // GW34+: Merger — created by advance-playoffs after GW33 standings
    //
    // All 16 teams are expected in Group A (single regular-season group for 16-team leagues)

    const champGA = [1, 4, 5, 8].map(r => rankMap["A"][r]).filter(Boolean);
    const champGB = [2, 3, 6, 7].map(r => rankMap["A"][r]).filter(Boolean);
    const challGA = [9, 12, 13, 16].map(r => rankMap["A"][r]).filter(Boolean);
    const challGB = [10, 11, 14, 15].map(r => rankMap["A"][r]).filter(Boolean);

    if (champGA.length < 4 || champGB.length < 4 || challGA.length < 4 || challGB.length < 4) {
      return NextResponse.json({
        error: "Not enough ranked teams found. Ensure the league has 16 teams ranked 1-16 in Group A.",
      }, { status: 400 });
    }

    type GroupEntry = { teamId: string; name: string; abbreviation: string };
    const groupsMap: [GSMatch16[], GroupEntry[]][] = [
      [CHAMP_GA_MATCHES, champGA],
      [CHAMP_GB_MATCHES, champGB],
      [CHALL_GA_MATCHES, challGA],
      [CHALL_GB_MATCHES, challGB],
    ];

    for (const [matchList, group] of groupsMap) {
      for (const [tieId, gwOffset, homeIdx, awayIdx] of matchList) {
        const gwNum = playoffStartGw + gwOffset; // GW31, GW32, or GW33
        const gwId = gwCache[gwNum];
        const home = group[homeIdx];
        const away = group[awayIdx];
        if (!home || !away) continue;

        // roundName encodes which playoff group this match belongs to
        const roundName =
          tieId.startsWith("16T-CA") ? "16T-CA" :
          tieId.startsWith("16T-CB") ? "16T-CB" :
          tieId.startsWith("16T-XA") ? "16T-XA" : "16T-XB";

        await db.insert(playoffTies).values({
          tieId,
          leagueId,
          roundName,
          roundType: "playoff-group",
          homeTeamId: home.teamId,
          awayTeamId: away.teamId,
          gw1: gwNum,
          gw2: null,
          status: "pending",
        });
        createdTies.push(tieId);

        const fixtureId = `playoff-${tieId}`;
        await db.insert(fixtures).values({
          id: fixtureId,
          gameweekId: gwId,
          homeTeamId: home.teamId,
          awayTeamId: away.teamId,
          groupId: playoffsGroupId,
          isChallenge: false,
          isPlayoff: true,
          roundName,
          leg: null,
          tieId,
          roundType: "playoff-group",
        });
        createdFixtures.push(fixtureId);
      }
    }

  } else {
    // ── 32-TEAM FORMAT (default) ───────────────────────────────
    // GW31+32 (playoffStartGw): RO16 (2-legged) + C-31 (single-leg)
    const gw1Id = gwCache[playoffStartGw];
    const gw2Id = gwCache[playoffStartGw + 1];

    // RO16 ties (2-legged)
    for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of RO16_SEEDING) {
      const home = rankMap[homeGroup][homeRank];
      const away = rankMap[awayGroup][awayRank];
      if (!home || !away) continue;

      await db.insert(playoffTies).values({
        tieId,
        leagueId,
        roundName: "RO16",
        roundType: "tvt",
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        gw1: playoffStartGw,
        gw2: playoffStartGw + 1,
        status: "pending",
      });
      createdTies.push(tieId);

      const leg1Id = `playoff-${tieId}-leg1`;
      await db.insert(fixtures).values({
        id: leg1Id,
        gameweekId: gw1Id,
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        groupId: playoffsGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "RO16",
        leg: 1,
        tieId,
        roundType: "tvt",
      });
      createdFixtures.push(leg1Id);

      const leg2Id = `playoff-${tieId}-leg2`;
      await db.insert(fixtures).values({
        id: leg2Id,
        gameweekId: gw2Id,
        homeTeamId: away.teamId,
        awayTeamId: home.teamId,
        groupId: playoffsGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "RO16",
        leg: 2,
        tieId,
        roundType: "tvt",
      });
      createdFixtures.push(leg2Id);
    }

    // C-31 ties (single-leg, GW31) — cross-group challenger
    for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of C31_SEEDING_32) {
      const home = rankMap[homeGroup][homeRank];
      const away = rankMap[awayGroup][awayRank];
      if (!home || !away) continue;

      await db.insert(playoffTies).values({
        tieId,
        leagueId,
        roundName: "C-31",
        roundType: "challenger-ko",
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        gw1: playoffStartGw,
        gw2: null,
        status: "pending",
      });
      createdTies.push(tieId);

      const fixtureId = `playoff-${tieId}`;
      await db.insert(fixtures).values({
        id: fixtureId,
        gameweekId: gw1Id,
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        groupId: playoffsGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "C-31",
        leg: null,
        tieId,
        roundType: "challenger-ko",
      });
      createdFixtures.push(fixtureId);
    }
  }

  await invalidateLeaguePageCache(leagueId);
  return NextResponse.json({
    success: true,
    message: `Generated ${createdTies.length} playoff ties and ${createdFixtures.length} fixtures`,
    ties: createdTies,
    fixtures: createdFixtures,
  });
}

