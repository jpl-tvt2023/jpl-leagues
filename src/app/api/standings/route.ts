import { NextRequest, NextResponse } from "next/server";
import { db, teams, groups, players, fixtures, results, gameweekChips, gameweeks, leagues, type Team, type Group, type Player, type Fixture, type Result, type Gameweek } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getAllCachedScores } from "@/lib/fpl-cache";
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

    // Resolve leagueId from slug if provided
    let leagueId: string | null = null;
    if (leagueSlug) {
      const league = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
      if (league.length > 0) leagueId = league[0].id;
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

    // Determine which GWs (1-30) have been processed (have at least one result)
    const processedGws = new Set<number>();
    for (const t of allTeamsUnfiltered) {
      for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
        if (f.result && f.gameweek.number <= 30) {
          processedGws.add(f.gameweek.number);
        }
      }
    }

    for (const gw of processedGws) {
      // Try cache first
      const gwCache = await getAllCachedScores(gw);
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
            const score = await calculateTeamGameweekScore(fplId, gw);
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
      // Only count chips from GW 1-30 (league stage)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chipGw = (chip as any).gameweek?.number;
      if (chipGw && chipGw > 30) continue;

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

      // Process home fixtures (league stage only — GW 1-30)
      for (const fixture of team.homeFixtures) {
        if (fixture.gameweek.number > 30) continue;
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

      // Process away fixtures (league stage only — GW 1-30)
      for (const fixture of team.awayFixtures) {
        if (fixture.gameweek.number > 30) continue;
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

      // Build tooltip entries for all 6 chips (WW1/DP1/CC1/WW2/DP2/CC2)
      const chipTooltipEntries: ChipTooltipEntry[] = [];
      for (const [set, gwMin, gwMax] of [[1, 1, 15], [2, 16, 30]] as [number, number, number][]) {
        for (const [type, name] of [["W", "WW"], ["D", "DP"], ["C", "CC"]] as [string, string][]) {
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

    // Add rank to each team
    const rankedStandings = standings.map((team: TeamStanding, index: number) => ({
      ...team,
      rank: index + 1,
      zone: getQualificationZone(index + 1),
    }));

    type RankedStanding = TeamStanding & { rank: number; zone: string };
    
    // Group standings by group
    const groupA = rankedStandings.filter((t: RankedStanding) => t.group === "A");
    const groupB = rankedStandings.filter((t: RankedStanding) => t.group === "B");

    // Re-rank within groups
    const reRankGroup = (teams: RankedStanding[]) => 
      teams.map((team: RankedStanding, index: number) => ({
        ...team,
        groupRank: index + 1,
        zone: getQualificationZone(index + 1),
      }));

    return NextResponse.json({
      groupA: reRankGroup(groupA),
      groupB: reRankGroup(groupB),
      totalTeams: standings.length,
      legend: {
        top8: "TVT Title Play-offs",
        rank9to14: "Challenger Series",
        rank15to16: "Eliminated",
      },
    });
  } catch (error) {
    console.error("Error fetching standings:", error);
    return NextResponse.json(
      { error: "Failed to fetch standings" },
      { status: 500 }
    );
  }
}

/**
 * Get qualification zone based on rank
 */
function getQualificationZone(rank: number): "playoffs" | "challenger" | "eliminated" {
  if (rank <= 8) return "playoffs";
  if (rank <= 14) return "challenger";
  return "eliminated";
}
