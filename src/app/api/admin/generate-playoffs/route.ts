import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, playoffTies, gameweeks, results, groups } from "@/lib/db/schema";
import { eq, and, sql, or, like, inArray } from "drizzle-orm";
import { getAllCachedScores } from "@/lib/fpl-cache";
import { calculateTeamGameweekScore } from "@/lib/fpl";

// RO16 seeding: [tieId, homeGroupLetter, homeRank, awayGroupLetter, awayRank]
const RO16_SEEDING: [string, string, number, string, number][] = [
  ["RO16-A", "A", 1, "B", 8],
  ["RO16-B", "B", 1, "A", 8],
  ["RO16-C", "A", 2, "B", 7],
  ["RO16-D", "B", 2, "A", 7],
  ["RO16-E", "A", 3, "B", 6],
  ["RO16-F", "B", 3, "A", 6],
  ["RO16-G", "A", 4, "B", 5],
  ["RO16-H", "B", 4, "A", 5],
];

// C-31 seeding: [tieId, homeGroupLetter, homeRank, awayGroupLetter, awayRank]
// Cross-group: Group A rank vs Group B mirror rank (9v14, 10v13, ..., 14v9)
const C31_SEEDING: [string, string, number, string, number][] = [
  ["C-31-A", "A", 9,  "B", 14],
  ["C-31-B", "A", 10, "B", 13],
  ["C-31-C", "A", 11, "B", 12],
  ["C-31-D", "A", 12, "B", 11],
  ["C-31-E", "A", 13, "B", 10],
  ["C-31-F", "A", 14, "B", 9],
];

/**
 * GET /api/admin/generate-playoffs
 * Check if playoffs have already been generated
 */
export async function GET(request: NextRequest) {
  const sessionType = request.headers.get("x-session-type");
  if (sessionType !== "admin" && sessionType !== "superadmin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const existingTies = await db.select().from(playoffTies).limit(1);
  return NextResponse.json({
    generated: existingTies.length > 0,
  });
}

/**
 * DELETE /api/admin/generate-playoffs
 * Delete existing RO16 + C-31 playoff ties, fixtures, and results so they can be regenerated
 */
export async function DELETE(request: NextRequest) {
  const sessionType = request.headers.get("x-session-type");
  if (sessionType !== "admin" && sessionType !== "superadmin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Find all RO16 and C-31 fixture IDs to delete their results first
  const initialFixtures = await db.select({ id: fixtures.id }).from(fixtures)
    .where(or(like(fixtures.tieId, "RO16-%"), like(fixtures.tieId, "C-31-%")));
  const fixtureIds = initialFixtures.map(f => f.id);

  await db.transaction(async (tx) => {
    // Delete results for these fixtures
    if (fixtureIds.length > 0) {
      await tx.delete(results).where(inArray(results.fixtureId, fixtureIds));
    }
    // Delete the fixtures themselves
    await tx.run(sql`DELETE FROM fixtures WHERE tie_id LIKE 'RO16-%' OR tie_id LIKE 'C-31-%'`);
    // Delete the playoff ties
    await tx.run(sql`DELETE FROM playoff_ties WHERE tie_id LIKE 'RO16-%' OR tie_id LIKE 'C-31-%'`);
  });

  return NextResponse.json({
    success: true,
    message: `Deleted ${fixtureIds.length} fixtures and their associated ties/results`,
    deletedFixtures: fixtureIds.length,
  });
}

/**
 * POST /api/admin/generate-playoffs
 * Generate RO16 + C-31 fixtures from GW30 group standings
 */
export async function POST(request: NextRequest) {
  const sessionType = request.headers.get("x-session-type");
  if (sessionType !== "admin" && sessionType !== "superadmin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Check if RO16/C-31 already exist (allow regeneration after DELETE)
  const existingInitialTies = await db.select().from(playoffTies)
    .where(or(like(playoffTies.tieId, "RO16-%"), like(playoffTies.tieId, "C-31-%")))
    .limit(1);
  if (existingInitialTies.length > 0) {
    return NextResponse.json({ error: "RO16/C-31 playoffs already exist. Delete them first to regenerate." }, { status: 400 });
  }

  // Fetch group standings (reuse same logic as standings route)
  const groupStandings = await getGroupStandings();
  if (!groupStandings) {
    return NextResponse.json({ error: "Failed to compute standings" }, { status: 500 });
  }

  const { groupA, groupB } = groupStandings;

  // Need GW31 and GW32 gameweek IDs
  const gw31 = await db.query.gameweeks.findFirst({ where: eq(gameweeks.number, 31) });
  const gw32 = await db.query.gameweeks.findFirst({ where: eq(gameweeks.number, 32) });
  if (!gw31 || !gw32) {
    return NextResponse.json({ error: "GW31 and GW32 must exist" }, { status: 400 });
  }

  // Get playoffs group ID
  const playoffsGroup = await db.query.groups.findFirst({ where: eq(groups.name, "Playoffs") });
  if (!playoffsGroup) {
    return NextResponse.json({ error: "Playoffs group not found. Run migration first." }, { status: 500 });
  }
  const playoffsGroupId = playoffsGroup.id;

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

  // Create RO16 ties + fixtures (2 legs: GW31 + GW32)
  for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of RO16_SEEDING) {
    const home = rankMap[homeGroup][homeRank];
    const away = rankMap[awayGroup][awayRank];
    if (!home || !away) continue;

    await db.insert(playoffTies).values({
      tieId,
      roundName: "RO16",
      roundType: "tvt",
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      gw1: 31,
      gw2: 32,
      status: "pending",
    });
    createdTies.push(tieId);

    // Leg 1 (GW31): higher-ranked team = home
    const leg1Id = `playoff-${tieId}-leg1`;
    await db.insert(fixtures).values({
      id: leg1Id,
      gameweekId: gw31.id,
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

    // Leg 2 (GW32): swap home/away
    const leg2Id = `playoff-${tieId}-leg2`;
    await db.insert(fixtures).values({
      id: leg2Id,
      gameweekId: gw32.id,
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

  // Create C-31 ties + fixtures (single leg: GW31)
  for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of C31_SEEDING) {
    const home = rankMap[homeGroup][homeRank];
    const away = rankMap[awayGroup][awayRank];
    if (!home || !away) continue;

    await db.insert(playoffTies).values({
      tieId,
      roundName: "C-31",
      roundType: "challenger-ko",
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      gw1: 31,
      gw2: null,
      status: "pending",
    });
    createdTies.push(tieId);

    const fixtureId = `playoff-${tieId}`;
    await db.insert(fixtures).values({
      id: fixtureId,
      gameweekId: gw31.id,
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

  return NextResponse.json({
    success: true,
    message: `Generated ${createdTies.length} playoff ties and ${createdFixtures.length} fixtures`,
    ties: createdTies,
    fixtures: createdFixtures,
  });
}

// ============================================
// Reusable standings computation (same as /api/standings)
// ============================================
interface RankedTeam {
  teamId: string;
  name: string;
  abbreviation: string;
  group: string;
  groupRank: number;
  leaguePoints: number;
  pointsFor: number;
  cbpPoints: number;
}

async function getGroupStandings(): Promise<{ groupA: RankedTeam[]; groupB: RankedTeam[] } | null> {
  try {
    const allTeams = await db.query.teams.findMany({
      with: {
        group: true,
        players: true,
        homeFixtures: { with: { result: true, gameweek: true } },
        awayFixtures: { with: { result: true, gameweek: true } },
      },
    });

    // Build per-GW, per-player hits map for hit penalty (-1 league pt per GW a player exceeds 12 hits)
    const playerGwHitsMap = new Map<string, Map<number, number>>();
    const allFplIds = new Set<string>();
    for (const t of allTeams) {
      for (const p of t.players) {
        allFplIds.add(p.fplId);
      }
    }

    // Determine which GWs (1-30) have been processed
    const processedGws = new Set<number>();
    for (const t of allTeams) {
      for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
        if (f.result && f.gameweek.number <= 30) {
          processedGws.add(f.gameweek.number);
        }
      }
    }

    for (const gw of processedGws) {
      const gwCache = await getAllCachedScores(gw);
      const suffix = `_gw${gw}`;
      if (Object.keys(gwCache).length > 0) {
        for (const [key, data] of Object.entries(gwCache)) {
          if (key.endsWith(suffix)) {
            const fplId = key.slice(0, -suffix.length);
            if (!playerGwHitsMap.has(fplId)) playerGwHitsMap.set(fplId, new Map());
            playerGwHitsMap.get(fplId)!.set(gw, data.transferHits);
          }
        }
      } else {
        for (const fplId of allFplIds) {
          try {
            const score = await calculateTeamGameweekScore(fplId, gw);
            if (!playerGwHitsMap.has(fplId)) playerGwHitsMap.set(fplId, new Map());
            playerGwHitsMap.get(fplId)!.set(gw, score.transferHits);
          } catch {
            // FPL API may fail — skip gracefully
          }
        }
      }
    }

    const allChipsRaw = await db.query.gameweekChips.findMany({
      with: { gameweek: true },
    });

    const chipPointsByTeam = new Map<string, number>();
    for (const chip of allChipsRaw) {
      // Only count chips from league stage (GW 1-30)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chipGw = (chip as any).gameweek?.number;
      if (chipGw && chipGw > 30) continue;
      if (chip.isProcessed) {
        const pts = chip.pointsAwarded || 0;
        if (chip.chipType === "C" || pts > 0) {
          chipPointsByTeam.set(chip.teamId, (chipPointsByTeam.get(chip.teamId) || 0) + pts);
        }
      }
    }

    const standings = allTeams.map((team) => {
      let wins = 0, draws = 0, losses = 0, pointsFor = 0, pointsAgainst = 0, bonusPtsTotal = 0;

      // Process home fixtures (league stage only — GW 1-30)
      for (const fixture of team.homeFixtures) {
        if (fixture.gameweek.number > 30) continue;
        if (fixture.result) {
          pointsFor += fixture.result.homeScore;
          pointsAgainst += fixture.result.awayScore;
          if (fixture.result.homeScore > fixture.result.awayScore) wins++;
          else if (fixture.result.homeScore === fixture.result.awayScore) draws++;
          else losses++;
          if (fixture.result.homeGotBonus) {
            bonusPtsTotal += fixture.result.homeUsedDoublePointer ? 2 : 1;
          }
        }
      }

      // Process away fixtures (league stage only — GW 1-30)
      for (const fixture of team.awayFixtures) {
        if (fixture.gameweek.number > 30) continue;
        if (fixture.result) {
          pointsFor += fixture.result.awayScore;
          pointsAgainst += fixture.result.homeScore;
          if (fixture.result.awayScore > fixture.result.homeScore) wins++;
          else if (fixture.result.awayScore === fixture.result.homeScore) draws++;
          else losses++;
          if (fixture.result.awayGotBonus) {
            bonusPtsTotal += fixture.result.awayUsedDoublePointer ? 2 : 1;
          }
        }
      }

      const chipPts = chipPointsByTeam.get(team.id) || 0;
      const cbpPts = chipPts + bonusPtsTotal;

      // Compute hit penalty: -1 league point per GW where any player on this team took >12 hits
      let hitPenaltyTotal = 0;
      for (const player of team.players) {
        const gwHits = playerGwHitsMap.get(player.fplId);
        if (gwHits) {
          for (const [, hits] of gwHits.entries()) {
            if (hits > 12) hitPenaltyTotal++;
          }
        }
      }

      const leaguePoints = (wins * 2) + draws + cbpPts - hitPenaltyTotal;

      return {
        teamId: team.id,
        name: team.name,
        abbreviation: team.abbreviation,
        group: team.group.name,
        leaguePoints,
        pointsFor,
        cbpPoints: cbpPts,
        groupRank: 0,
      };
    });

    // Sort within each group
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
