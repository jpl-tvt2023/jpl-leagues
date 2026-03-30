import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fixtures, playoffTies, gameweeks, results, groups, teams, leagues } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getAllCachedScores, invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { calculateTeamGameweekScore, fetchBootstrapData } from "@/lib/fpl";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateId } from "@/lib/id";

// ============================================
// Seeding tables — 32-team (cross-group)
// ============================================

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

const C31_SEEDING_32: [string, string, number, string, number][] = [
  ["C-31-A", "A", 9,  "B", 14],
  ["C-31-B", "A", 10, "B", 13],
  ["C-31-C", "A", 11, "B", 12],
  ["C-31-D", "A", 12, "B", 11],
  ["C-31-E", "A", 13, "B", 10],
  ["C-31-F", "A", 14, "B", 9],
];

// ============================================
// Seeding tables — 8-team (single group A)
// ============================================

// tieIds prefixed "8T-" to prevent collisions with 32-team tieIds
const SF_SEEDING_8: [string, string, number, string, number][] = [
  ["8T-SF-A", "A", 1, "A", 4],
  ["8T-SF-B", "A", 2, "A", 3],
];

// ============================================
// 16-team playoff group stage schedule
// ============================================
// All 16 teams are ranked 1-16 (single regular-season group A).
// Playoff groups (snake-seeded from regular-season ranks):
//   Champ Group A: ranks [1, 4, 5, 8]  → group indices [0, 1, 2, 3]
//   Champ Group B: ranks [2, 3, 6, 7]  → group indices [0, 1, 2, 3]
//   Chall  Group A: ranks [9, 12,13,16] → group indices [0, 1, 2, 3]
//   Chall  Group B: ranks [10,11,14,15] → group indices [0, 1, 2, 3]
// gwOffset: 0=playoffStartGw(GW31), 1=GW32, 2=GW33
// tieIds prefixed "16T-" to prevent collisions.
type GSMatch16 = [string, number, number, number]; // [tieId, gwOffset, homeIdx, awayIdx]

const CHAMP_GA_MATCHES: GSMatch16[] = [
  ["16T-CA-31-1", 0, 0, 3], // GW31: rank1 v rank8
  ["16T-CA-31-2", 0, 1, 2], // GW31: rank4 v rank5
  ["16T-CA-32-1", 1, 0, 2], // GW32: rank1 v rank5
  ["16T-CA-32-2", 1, 1, 3], // GW32: rank4 v rank8
  ["16T-CA-33-1", 2, 0, 1], // GW33: rank1 v rank4  ("Group Final")
  ["16T-CA-33-2", 2, 2, 3], // GW33: rank5 v rank8
];

const CHAMP_GB_MATCHES: GSMatch16[] = [
  ["16T-CB-31-1", 0, 0, 3], // GW31: rank2 v rank7
  ["16T-CB-31-2", 0, 1, 2], // GW31: rank3 v rank6
  ["16T-CB-32-1", 1, 0, 2], // GW32: rank2 v rank6
  ["16T-CB-32-2", 1, 1, 3], // GW32: rank3 v rank7
  ["16T-CB-33-1", 2, 0, 1], // GW33: rank2 v rank3  ("Group Final")
  ["16T-CB-33-2", 2, 2, 3], // GW33: rank6 v rank7
];

const CHALL_GA_MATCHES: GSMatch16[] = [
  ["16T-XA-31-1", 0, 0, 3], // GW31: rank9  v rank16
  ["16T-XA-31-2", 0, 1, 2], // GW31: rank12 v rank13
  ["16T-XA-32-1", 1, 0, 2], // GW32: rank9  v rank13
  ["16T-XA-32-2", 1, 1, 3], // GW32: rank12 v rank16
  ["16T-XA-33-1", 2, 0, 1], // GW33: rank9  v rank12
  ["16T-XA-33-2", 2, 2, 3], // GW33: rank13 v rank16
];

const CHALL_GB_MATCHES: GSMatch16[] = [
  ["16T-XB-31-1", 0, 0, 3], // GW31: rank10 v rank15
  ["16T-XB-31-2", 0, 1, 2], // GW31: rank11 v rank14
  ["16T-XB-32-1", 1, 0, 2], // GW32: rank10 v rank14
  ["16T-XB-32-2", 1, 1, 3], // GW32: rank11 v rank15
  ["16T-XB-33-1", 2, 0, 1], // GW33: rank10 v rank11
  ["16T-XB-33-2", 2, 2, 3], // GW33: rank14 v rank15
];

// ============================================
// Auto-create playoff gameweeks
// ============================================
async function ensurePlayoffGws(playoffStartGw: number, leagueId: string): Promise<Record<number, string>> {
  // Fetch real FPL deadlines (best-effort; fall back to evenly-spaced placeholders)
  const fplDeadlines: Record<number, Date> = {};
  try {
    const bootstrap = await fetchBootstrapData();
    for (const event of (bootstrap.events as { id: number; deadline_time: string }[])) {
      fplDeadlines[event.id] = new Date(event.deadline_time);
    }
  } catch { /* non-fatal */ }

  const gwCache: Record<number, string> = {};
  for (let gwNum = playoffStartGw; gwNum <= 38; gwNum++) {
    const existing = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, gwNum), eq(gameweeks.leagueId, leagueId)),
    });
    if (existing) {
      gwCache[gwNum] = existing.id;
    } else {
      const gwId = generateId();
      const deadline = fplDeadlines[gwNum] ?? (() => {
        const d = new Date();
        d.setDate(d.getDate() + 7 * (gwNum - playoffStartGw + 1));
        d.setHours(11, 0, 0, 0);
        return d;
      })();
      await db.insert(gameweeks).values({ id: gwId, number: gwNum, deadline, isPlayoffs: true, leagueId });
      gwCache[gwNum] = gwId;
    }
  }
  return gwCache;
}

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

  // Initial round names per format (used to identify what to delete on re-generate)
  const initialRounds =
    teamSize === 8  ? ["8T-SF"] :
    teamSize === 16 ? ["16T-CA", "16T-CB", "16T-XA", "16T-XB"] :
                     ["RO16", "C-31"];

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
  const initialRounds =
    teamSize === 8  ? ["8T-SF"] :
    teamSize === 16 ? ["16T-CA", "16T-CB", "16T-XA", "16T-XB"] :
                     ["RO16", "C-31"];

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

    const playerGwHitsMap = new Map<string, Map<number, number>>();
    const allFplIds = new Set<string>();
    for (const t of allTeams) {
      for (const p of t.players) {
        allFplIds.add(p.fplId);
      }
    }

    const processedGws = new Set<number>();
    for (const t of allTeams) {
      for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
        if (f.result && f.gameweek.number <= leagueStageEnd) {
          processedGws.add(f.gameweek.number);
        }
      }
    }

    for (const gw of processedGws) {
      const gwCache = await getAllCachedScores(gw, leagueId);
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
            const score = await calculateTeamGameweekScore(fplId, gw, leagueId);
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
