import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, playoffTies, gameweeks, results, groups, teams, leagues } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getAllCachedScores } from "@/lib/fpl-cache";
import { calculateTeamGameweekScore } from "@/lib/fpl";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateId } from "@/lib/id";

// ============================================
// Seeding tables — 32-team (cross-group)
// ============================================

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

// C-31 seeding (32-team): cross-group 9v14, 10v13, ... 14v9
const C31_SEEDING_32: [string, string, number, string, number][] = [
  ["C-31-A", "A", 9,  "B", 14],
  ["C-31-B", "A", 10, "B", 13],
  ["C-31-C", "A", 11, "B", 12],
  ["C-31-D", "A", 12, "B", 11],
  ["C-31-E", "A", 13, "B", 10],
  ["C-31-F", "A", 14, "B", 9],
];

// ============================================
// Seeding tables — 16-team (single group A)
// ============================================

// QF seeding (16-team): 1v8, 2v7, 3v6, 4v5 all from group A
const QF_SEEDING_16: [string, string, number, string, number][] = [
  ["QF-A", "A", 1, "A", 8],
  ["QF-B", "A", 2, "A", 7],
  ["QF-C", "A", 3, "A", 6],
  ["QF-D", "A", 4, "A", 5],
];

// C-31 seeding (16-team): 9v14, 10v13, 11v12 within group A
const C31_SEEDING_16: [string, string, number, string, number][] = [
  ["C-31-A", "A", 9,  "A", 14],
  ["C-31-B", "A", 10, "A", 13],
  ["C-31-C", "A", 11, "A", 12],
];

// ============================================
// Seeding tables — 8-team (single group A)
// ============================================

// SF seeding (8-team): 1v4, 2v3 within group A
const SF_SEEDING_8: [string, string, number, string, number][] = [
  ["SF-A", "A", 1, "A", 4],
  ["SF-B", "A", 2, "A", 3],
];

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
 * Only removes the first-round ties (RO16/QF/SF) and their C-31 companion, not later rounds.
 */
export async function DELETE(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Fetch league config to know which initial rounds to delete
  const leagueRow = await db.select({ teamSize: leagues.teamSize })
    .from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  const teamSize = leagueRow[0]?.teamSize ?? 32;

  // Initial round names to delete depend on variant
  const initialRounds =
    teamSize === 8  ? ["SF"] :
    teamSize === 16 ? ["QF", "C-31"] :
                     ["RO16", "C-31"];

  // Get tie IDs for this league's initial rounds
  const tiesToDelete = await db.select({ tieId: playoffTies.tieId })
    .from(playoffTies)
    .where(and(
      eq(playoffTies.leagueId, leagueId),
      inArray(playoffTies.roundName, initialRounds)
    ));
  const tieIdList = tiesToDelete.map(t => t.tieId);

  if (tieIdList.length === 0) {
    return NextResponse.json({ success: true, message: "No initial ties to delete", deletedFixtures: 0 });
  }

  // Get fixture IDs for these ties
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

  return NextResponse.json({
    success: true,
    message: `Deleted ${tieIdList.length} ties and ${fixtureIds.length} fixtures`,
    deletedFixtures: fixtureIds.length,
  });
}

/**
 * POST /api/admin/[leagueId]/generate-playoffs
 * Generate initial playoff ties + fixtures from final group standings.
 * Branches by league teamSize: 32-team (RO16+C31), 16-team (QF+C31), 8-team (SF only).
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

  // Check if initial ties for THIS league already exist
  const initialRounds =
    teamSize === 8  ? ["SF"] :
    teamSize === 16 ? ["QF", "C-31"] :
                     ["RO16", "C-31"];

  const existingInitialTies = await db.select().from(playoffTies)
    .where(and(
      eq(playoffTies.leagueId, leagueId),
      inArray(playoffTies.roundName, initialRounds)
    ))
    .limit(1);
  if (existingInitialTies.length > 0) {
    return NextResponse.json({
      error: `Initial playoff ties already exist for this league. Delete them first to regenerate.`,
    }, { status: 400 });
  }

  // Fetch group standings
  const groupStandings = await getGroupStandings(leagueId, leagueStageEnd);
  if (!groupStandings) {
    return NextResponse.json({ error: "Failed to compute standings" }, { status: 500 });
  }
  const { groupA, groupB } = groupStandings;

  // Get or create playoffs group for this league
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

  // Build rank maps
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
  // Branch by variant
  // ============================================================
  if (teamSize === 8) {
    // 8-team: SF (single-leg at playoffStartGw) — no challenger
    const gwSf = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, playoffStartGw), eq(gameweeks.leagueId, leagueId)),
    });
    if (!gwSf) {
      return NextResponse.json({ error: `GW${playoffStartGw} must exist for SF leg` }, { status: 400 });
    }

    for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of SF_SEEDING_8) {
      const home = rankMap[homeGroup][homeRank];
      const away = rankMap[awayGroup][awayRank];
      if (!home || !away) continue;

      await db.insert(playoffTies).values({
        tieId,
        leagueId,
        roundName: "SF",
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
        gameweekId: gwSf.id,
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        groupId: playoffsGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "SF",
        leg: null,
        tieId,
        roundType: "tvt",
      });
      createdFixtures.push(fixtureId);
    }

  } else if (teamSize === 16) {
    // 16-team: QF (2-legged, GW31+32) + C-31 (single-leg, GW31)
    const gwQf1 = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, playoffStartGw), eq(gameweeks.leagueId, leagueId)),
    });
    const gwQf2 = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, playoffStartGw + 1), eq(gameweeks.leagueId, leagueId)),
    });
    if (!gwQf1 || !gwQf2) {
      return NextResponse.json({ error: `GW${playoffStartGw} and GW${playoffStartGw + 1} must exist for QF legs` }, { status: 400 });
    }

    // QF ties (2-legged)
    for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of QF_SEEDING_16) {
      const home = rankMap[homeGroup][homeRank];
      const away = rankMap[awayGroup][awayRank];
      if (!home || !away) continue;

      await db.insert(playoffTies).values({
        tieId,
        leagueId,
        roundName: "QF",
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
        gameweekId: gwQf1.id,
        homeTeamId: home.teamId,
        awayTeamId: away.teamId,
        groupId: playoffsGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "QF",
        leg: 1,
        tieId,
        roundType: "tvt",
      });
      createdFixtures.push(leg1Id);

      const leg2Id = `playoff-${tieId}-leg2`;
      await db.insert(fixtures).values({
        id: leg2Id,
        gameweekId: gwQf2.id,
        homeTeamId: away.teamId,
        awayTeamId: home.teamId,
        groupId: playoffsGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "QF",
        leg: 2,
        tieId,
        roundType: "tvt",
      });
      createdFixtures.push(leg2Id);
    }

    // C-31 ties (single-leg, GW31) — ranks 9-14 within group A
    for (const [tieId, homeGroup, homeRank, awayGroup, awayRank] of C31_SEEDING_16) {
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
        gameweekId: gwQf1.id,
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

  } else {
    // 32-team (default): RO16 (2-legged, GW31+32) + C-31 (single-leg, GW31)
    const gw1 = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, playoffStartGw), eq(gameweeks.leagueId, leagueId)),
    });
    const gw2 = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, playoffStartGw + 1), eq(gameweeks.leagueId, leagueId)),
    });
    if (!gw1 || !gw2) {
      return NextResponse.json({ error: `GW${playoffStartGw} and GW${playoffStartGw + 1} must exist` }, { status: 400 });
    }

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
        gameweekId: gw1.id,
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
        gameweekId: gw2.id,
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
        gameweekId: gw1.id,
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

  return NextResponse.json({
    success: true,
    message: `Generated ${createdTies.length} playoff ties and ${createdFixtures.length} fixtures`,
    ties: createdTies,
    fixtures: createdFixtures,
  });
}

// ============================================
// Reusable standings computation
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

async function getGroupStandings(leagueId: string, leagueStageEnd: number): Promise<{ groupA: RankedTeam[]; groupB: RankedTeam[] } | null> {
  try {
    const allTeams = await db.query.teams.findMany({
      where: eq(teams.leagueId, leagueId),
      with: {
        group: true,
        players: true,
        homeFixtures: { with: { result: true, gameweek: true } },
        awayFixtures: { with: { result: true, gameweek: true } },
      },
    });

    // Build per-GW, per-player hits map for hit penalty
    const playerGwHitsMap = new Map<string, Map<number, number>>();
    const allFplIds = new Set<string>();
    for (const t of allTeams) {
      for (const p of t.players) {
        allFplIds.add(p.fplId);
      }
    }

    // Determine which league-stage GWs have been processed
    const processedGws = new Set<number>();
    for (const t of allTeams) {
      for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
        if (f.result && f.gameweek.number <= leagueStageEnd) {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chipGw = (chip as any).gameweek?.number;
      if (chipGw && chipGw > leagueStageEnd) continue;
      if (chip.isProcessed) {
        const pts = chip.pointsAwarded || 0;
        if (chip.chipType === "C" || pts > 0) {
          chipPointsByTeam.set(chip.teamId, (chipPointsByTeam.get(chip.teamId) || 0) + pts);
        }
      }
    }

    const standings = allTeams.map((team) => {
      let wins = 0, draws = 0, losses = 0, pointsFor = 0, pointsAgainst = 0, bonusPtsTotal = 0;

      for (const fixture of team.homeFixtures) {
        if (fixture.gameweek.number > leagueStageEnd) continue;
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

      for (const fixture of team.awayFixtures) {
        if (fixture.gameweek.number > leagueStageEnd) continue;
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
