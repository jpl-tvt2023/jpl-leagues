import { NextRequest, NextResponse } from "next/server";
import { db, teams, groups, players, fixtures, results, gameweekChips, gameweeks, leagues, settings, type Team, type Group, type Player, type Fixture, type Result, type Gameweek } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getAllCachedScores, getCachedStandings, setCachedStandings } from "@/lib/fpl-cache";
import { calculateTeamGameweekScore } from "@/lib/fpl";

type FixtureWithResult = Fixture & { result: Result | null; gameweek: Gameweek };

type TeamWithRelations = Team & {
  group: Group;
  players: Player[];
  homeFixtures: FixtureWithResult[];
  awayFixtures: FixtureWithResult[];
};

interface ChipTooltipEntry {
  label: string;      // "WW1", "DP1", "CC1", "WW2", "DP2", "CC2"
  status: "available" | "used" | "pending";
  points: number;
  gameweek?: number;
  opponent?: string;  // CC only
}

interface CbpTooltip {
  chips: ChipTooltipEntry[];
  bps: { gameweek: number; points: number }[];
  hitPenalty: {
    penaltyGws: { gameweek: number; playerName: string; hits: number }[];
    totalDeduction: number;
  };
}

interface TeamStanding {
  teamId: string;
  name: string;
  abbreviation: string;
  group: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointsDiff: number;
  leaguePoints: number;
  bonusPoints: number;
  calculatedBonus: number;
  chipPoints: number;
  cbpPoints: number;
  cbpTooltip: CbpTooltip;
  players: { name: string; fplId: string; captaincyChipsUsed: number }[];
}

/**
 * GET /api/standings
 * Get current standings for all groups
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const group = searchParams.get("group");
    const leagueSlug = searchParams.get("leagueSlug");

    // leagueSlug is required
    if (!leagueSlug) {
      return NextResponse.json(
        { error: "leagueSlug parameter is required" },
        { status: 400 }
      );
    }

    // Resolve leagueId and config from slug
    const league = await db.select({ id: leagues.id, playoffStartGw: leagues.playoffStartGw, teamSize: leagues.teamSize, enabledChips: leagues.enabledChips })
      .from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
    if (league.length === 0) {
      return NextResponse.json(
        { error: "League not found" },
        { status: 404 }
      );
    }

    const leagueId = league[0].id;
    let playoffStartGw = league[0].playoffStartGw ?? 31;
    let leagueTeamSize = league[0].teamSize ?? 32;
    let leagueEnabledChips: string[] = ["D", "W", "C"];
    try { leagueEnabledChips = JSON.parse(league[0].enabledChips ?? '["D","W","C"]'); } catch { /* keep default */ }
    const leagueStageEnd = playoffStartGw - 1; // last GW of the group stage

    // Check if groups have been revealed to teams
    const groupsRevealedRows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.leagueId, leagueId), eq(settings.key, "groupsRevealed")));
    const groupsRevealed = groupsRevealedRows[0]?.value === "true";

    // Return cached standings if available (populated by cron or previous request)
    try {
      const cached = await getCachedStandings(leagueId);
      if (cached) return NextResponse.json(cached);
    } catch {
      // Cache miss or Redis error — fall through to DB computation
    }

    // Get all teams with their relations using relational query
    const allTeamsUnfiltered = await db.query.teams.findMany({
      with: {
        group: true,
        players: true,
        homeFixtures: {
          with: {
            result: true,
            gameweek: true,
          },
        },
        awayFixtures: {
          with: {
            result: true,
            gameweek: true,
          },
        },
      },
    });

    // Build a map of teamId → abbreviation (from ALL teams, needed for CC opponent lookup)
    const teamAbbrMap = new Map<string, string>(allTeamsUnfiltered.map(t => [t.id, t.abbreviation]));

    // Build per-GW, per-player hits map for hit penalty calculation (-1 league pt per GW a player exceeds 12 hits)
    // First try Redis cache; if empty, fetch from FPL API for processed GWs
    const playerGwHitsMap = new Map<string, Map<number, number>>(); // fplId → gwNumber → transferHits

    // Collect all unique fplIds from all teams
    const allFplIds = new Set<string>();
    for (const t of allTeamsUnfiltered) {
      for (const p of t.players) {
        allFplIds.add(p.fplId);
      }
    }

    // Determine which league-stage GWs have been processed (have at least one result)
    const processedGws = new Set<number>();
    for (const t of allTeamsUnfiltered) {
      for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
        if (f.result && f.gameweek.number <= leagueStageEnd) {
          processedGws.add(f.gameweek.number);
        }
      }
    }

    for (const gw of processedGws) {
      // Try cache first
      const gwCache = await getAllCachedScores(gw, leagueId);
      const suffix = `_gw${gw}`;

      if (Object.keys(gwCache).length > 0) {
        // Cache has data — use it
        for (const [key, data] of Object.entries(gwCache)) {
          if (key.endsWith(suffix)) {
            const fplId = key.slice(0, -suffix.length);
            if (!playerGwHitsMap.has(fplId)) {
              playerGwHitsMap.set(fplId, new Map());
            }
            playerGwHitsMap.get(fplId)!.set(gw, data.transferHits);
          }
        }
      } else {
        // Cache empty — fetch from FPL API (also populates cache for next time)
        for (const fplId of allFplIds) {
          try {
            const score = await calculateTeamGameweekScore(fplId, gw, leagueId);
            if (!playerGwHitsMap.has(fplId)) {
              playerGwHitsMap.set(fplId, new Map());
            }
            playerGwHitsMap.get(fplId)!.set(gw, score.transferHits);
          } catch {
            // FPL API may fail for some players/GWs — skip gracefully
          }
        }
      }
    }

    let allTeams = allTeamsUnfiltered;

    // Filter by league if leagueSlug provided
    if (leagueId) {
      allTeams = allTeams.filter(t => t.leagueId === leagueId);
    }

    // Filter by group if provided
    if (group) {
      allTeams = allTeams.filter(t => t.group.name === group);
    }

    // Fetch all chips for all teams — only need gameweek relation
    const allChipsRaw = await db.query.gameweekChips.findMany({
      with: { gameweek: true },
    });


    const chipPointsByTeam = new Map<string, number>();
    const teamChipsRawMap = new Map<string, (typeof allChipsRaw)[number][]>();

    for (const chip of allChipsRaw) {
      // Only count chips from the league stage (not playoffs)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chipGw = (chip as any).gameweek?.number;
      if (chipGw && chipGw > leagueStageEnd) continue;

      // Accumulate processed extra points for cbpPoints total
      if (chip.isProcessed) {
        const pts = chip.pointsAwarded || 0;
        if (chip.chipType === "C" || pts > 0) {
          chipPointsByTeam.set(chip.teamId, (chipPointsByTeam.get(chip.teamId) || 0) + pts);
        }
      }
      // Group all chips by team
      const arr = teamChipsRawMap.get(chip.teamId) || [];
      arr.push(chip);
      teamChipsRawMap.set(chip.teamId, arr);
    }

    // Calculate standings for each team
    const standings: TeamStanding[] = allTeams.map((team) => {
      let wins = 0;
      let draws = 0;
      let losses = 0;
      let pointsFor = 0;
      let pointsAgainst = 0;
      let bonusPtsTotal = 0;
      const bpsEntries: { gameweek: number; points: number }[] = [];

      // Process home fixtures (league stage only)
      for (const fixture of team.homeFixtures) {
        if (fixture.gameweek.number > leagueStageEnd) continue;
        if (fixture.result) {
          pointsFor += fixture.result.homeScore;
          pointsAgainst += fixture.result.awayScore;

          // W/D/L based on raw FPL scores (not chip-adjusted match points)
          if (fixture.result.homeScore > fixture.result.awayScore) wins++;
          else if (fixture.result.homeScore === fixture.result.awayScore) draws++;
          else losses++;

          if (fixture.result.homeGotBonus) {
            const pts = fixture.result.homeUsedDoublePointer ? 2 : 1;
            bonusPtsTotal += pts;
            bpsEntries.push({ gameweek: fixture.gameweek.number, points: pts });
          }
        }
      }

      // Process away fixtures (league stage only)
      for (const fixture of team.awayFixtures) {
        if (fixture.gameweek.number > leagueStageEnd) continue;
        if (fixture.result) {
          pointsFor += fixture.result.awayScore;
          pointsAgainst += fixture.result.homeScore;

          // W/D/L based on raw FPL scores (not chip-adjusted match points)
          if (fixture.result.awayScore > fixture.result.homeScore) wins++;
          else if (fixture.result.awayScore === fixture.result.homeScore) draws++;
          else losses++;

          if (fixture.result.awayGotBonus) {
            const pts = fixture.result.awayUsedDoublePointer ? 2 : 1;
            bonusPtsTotal += pts;
            bpsEntries.push({ gameweek: fixture.gameweek.number, points: pts });
          }
        }
      }

      const played = wins + draws + losses;
      const chipPts = chipPointsByTeam.get(team.id) || 0;
      const cbpPts = chipPts + bonusPtsTotal;

      // Compute hit penalty: -1 league point per GW where any player on this team took >12 raw FPL hits
      const hitPenaltyGws: { gameweek: number; playerName: string; hits: number }[] = [];
      for (const player of team.players) {
        const gwHits = playerGwHitsMap.get(player.fplId);
        if (gwHits) {
          for (const [gw, hits] of gwHits.entries()) {
            if (hits > 12) {
              hitPenaltyGws.push({ gameweek: gw, playerName: player.name, hits });
            }
          }
        }
      }
      hitPenaltyGws.sort((a, b) => a.gameweek - b.gameweek);
      const hitPenaltyTotal = hitPenaltyGws.length;

      const leaguePoints = (wins * 2) + (draws * 1) + cbpPts - hitPenaltyTotal;
      const teamRawChips = teamChipsRawMap.get(team.id) || [];

      // Build tooltip entries for only the 3 enabled chips (2 sets = 6 entries)
      // Set boundaries are dynamic: midpoint = ceil(leagueStageEnd / 2)
      const chipSetMid = Math.ceil(leagueStageEnd / 2);
      const chipSets: [number, number, number][] = [
        [1, 1, chipSetMid],
        [2, chipSetMid + 1, leagueStageEnd],
      ];
      // Map from chip code → display name
      const CHIP_DISPLAY_NAMES: Record<string, string> = { W: "WW", D: "DP", C: "CC", SL: "SL", CB: "CB", UD: "UD" };
      const chipTooltipEntries: ChipTooltipEntry[] = [];
      for (const [set, gwMin, gwMax] of chipSets) {
        for (const type of leagueEnabledChips) {
          const name = CHIP_DISPLAY_NAMES[type] ?? type;
          const label = `${name}${set}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const chip = teamRawChips.find((c) => c.chipType === type && (c as any).gameweek.number >= gwMin && (c as any).gameweek.number <= gwMax);
          if (!chip) {
            chipTooltipEntries.push({ label, status: "available", points: 0 });
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const gwNumber = (chip as any).gameweek.number as number;
            const oppAbbr: string | undefined = type === "C" && chip.challengedTeamId
              ? (teamAbbrMap.get(chip.challengedTeamId) ?? undefined)
              : undefined;
            chipTooltipEntries.push({
              label,
              status: chip.isProcessed ? "used" : "pending",
              points: chip.pointsAwarded || 0,
              gameweek: gwNumber,
              opponent: oppAbbr,
            });
          }
        }
      }

      const cbpTooltip: CbpTooltip = {
        chips: chipTooltipEntries,
        bps: [...bpsEntries].sort((a, b) => a.gameweek - b.gameweek),
        hitPenalty: {
          penaltyGws: hitPenaltyGws,
          totalDeduction: hitPenaltyTotal,
        },
      };

      return {
        teamId: team.id,
        name: team.name,
        abbreviation: team.abbreviation,
        group: team.group.name,
        played,
        wins,
        draws,
        losses,
        pointsFor,
        pointsAgainst,
        pointsDiff: pointsFor - pointsAgainst,
        leaguePoints,
        bonusPoints: team.bonusPoints,
        calculatedBonus: bonusPtsTotal,
        chipPoints: chipPts,
        cbpPoints: cbpPts,
        cbpTooltip,
        players: team.players.map((p: Player) => ({
          name: p.name,
          fplId: p.fplId,
          captaincyChipsUsed: p.captaincyChipsUsed,
        })),
      };
    });

    // Sort by league points (desc), then wins (desc), then points diff (desc)
    standings.sort((a: TeamStanding, b: TeamStanding) => {
      if (a.leaguePoints !== b.leaguePoints) return b.leaguePoints - a.leaguePoints;
      if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
      return b.cbpPoints - a.cbpPoints;
    });

    type RankedStanding = TeamStanding & { rank: number; zone: string };

    // Group standings by group name
    const groupNames = [...new Set(standings.map(t => t.group))].sort();
    const groupMap: Record<string, RankedStanding[]> = {};
    for (const gName of groupNames) {
      const groupTeams = standings.filter(t => t.group === gName);
      groupMap[gName] = groupTeams.map((team, index) => ({
        ...team,
        rank: index + 1,
        groupRank: index + 1,
        zone: getQualificationZone(index + 1, leagueTeamSize),
      }));
    }

    const responseData = {
      groupA: groupMap["A"] ?? [],
      groupB: groupMap["B"] ?? [],
      totalTeams: standings.length,
      enabledChips: leagueEnabledChips,
      leagueStageEnd,
      teamSize: leagueTeamSize,
      groupsRevealed,
      legend: {
        top8: "TVT Title Play-offs",
        rank9to14: "Challenger Series",
        rank15to16: "Eliminated",
      },
    };

    // Fire-and-forget cache write — must not block or break the response
    if (leagueId) {
      setCachedStandings(leagueId, responseData).catch(() => {});
    }

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Error fetching standings:", error);
    // Return empty standings instead of error — likely no fixtures generated yet
    return NextResponse.json({
      groupA: [],
      groupB: [],
      leagueStageEnd: 30,
      teamSize: 32,
      groupsRevealed: false,
    });
  }
}

/**
 * Get qualification zone based on rank within a group and total league team size.
 * 8-team: top 4 playoffs, 5-8 eliminated (no challenger)
 * 16 or 32-team: top 8 playoffs, 9-14 challenger, 15-16 eliminated
 */
function getQualificationZone(rank: number, teamSize: number): "playoffs" | "challenger" | "eliminated" {
  if (teamSize === 8) {
    return rank <= 4 ? "playoffs" : "eliminated";
  }
  if (rank <= 8) return "playoffs";
  if (rank <= 14) return "challenger";
  return "eliminated";
}
