import { NextRequest, NextResponse } from "next/server";
import { db, teams, groups, players, fixtures, results, gameweekChips, gameweeks, leagues, settings, auctionScores, auctionOwnership, type Team, type Group, type Player, type Fixture, type Result, type Gameweek } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getAllCachedScores, getCachedStandings, setCachedStandings } from "@/lib/fpl-cache";
import { calculateTeamGameweekScore } from "@/lib/fpl";
import { computeAuctionStandings } from "@/lib/formats/auction/standings";
import { calculateFMV } from "@/lib/formats/auction/economy";
import { getClubOwnershipsByTeam } from "@/lib/formats/auction/club-auction";

type FixtureWithResult = Fixture & { result: Result | null; gameweek: Gameweek };

type TeamWithRelations = Team & {
  group: Group | null;
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
  group: string | null;
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
    const league = await db.select({ id: leagues.id, playoffStartGw: leagues.playoffStartGw, teamSize: leagues.teamSize, enabledChips: leagues.enabledChips, format: leagues.format })
      .from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
    if (league.length === 0) {
      return NextResponse.json(
        { error: "League not found" },
        { status: 404 }
      );
    }

    const leagueId = league[0].id;
    const playoffStartGw = league[0].playoffStartGw ?? 31;
    const leagueTeamSize = league[0].teamSize ?? 32;
    const leagueFormat = league[0].format ?? "tvt";
    let leagueEnabledChips: string[] = ["D", "W", "C"];
    try { leagueEnabledChips = JSON.parse(league[0].enabledChips ?? '["D","W","C"]'); } catch { /* keep default */ }
    // Triple Crown runs PL all 38 GWs; TVT league stage ends at playoffStartGw - 1
    const leagueStageEnd = leagueFormat === "triple-crown" ? 38 : playoffStartGw - 1;

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

    // ============================================
    // JPL AUCTION FORMAT — separate standings computation
    // ============================================
    if (leagueFormat === "auction") {
      const leagueTeams = await db
        .select({ id: teams.id, name: teams.name, purse: teams.purse })
        .from(teams)
        .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));

      const scores = await db
        .select()
        .from(auctionScores)
        .where(eq(auctionScores.leagueId, leagueId));

      // Build gameweekId -> gwNumber map
      const gwRows = await db
        .select({ id: gameweeks.id, number: gameweeks.number })
        .from(gameweeks)
        .where(eq(gameweeks.leagueId, leagueId));
      const gwNumbers = new Map(gwRows.map((g) => [g.id, g.number]));

      // Calculate squad value (sum of FMV) per team
      const allOwnership = await db
        .select()
        .from(auctionOwnership)
        .where(and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "active")));

      const squadValues = new Map<string, number>();
      for (const owned of allOwnership) {
        // FMV uses RAW points only (per locked spec — synergy never compounds into FMV).
        // Legacy breakdown rows carry `points` (no `rawPoints`); we tolerate both shapes.
        const playerTotalPoints = scores
          .filter((s) => s.teamId === owned.teamId)
          .reduce((sum, s) => {
            const breakdown = JSON.parse(s.playerBreakdown || "[]") as Array<{ elementId: number; points?: number; rawPoints?: number }>;
            const match = breakdown.find((p) => p.elementId === owned.fplElementId);
            const playerPts = match?.rawPoints ?? match?.points ?? 0;
            return sum + playerPts;
          }, 0);
        const fmv = calculateFMV(owned.purchasePrice, playerTotalPoints);
        squadValues.set(owned.teamId, (squadValues.get(owned.teamId) ?? 0) + fmv);
      }

      const standings = computeAuctionStandings(leagueTeams, scores, gwNumbers, squadValues);
      const clubByTeamId = await getClubOwnershipsByTeam(leagueId);

      // Apply PL Club Auction rename to each standings row's `teamName` so downstream consumers that
      // only read `teamName` (e.g., marketplace's team picker) pick up the rename automatically.
      // The standings UI uses `clubByTeamId` separately for the tier chip; both are wire-compatible.
      const renamedStandings = standings.map((s) => ({
        ...s,
        teamName: clubByTeamId[s.teamId]?.plTeamName ?? s.teamName,
      }));

      const responseData = {
        format: "auction" as const,
        standings: renamedStandings,
        totalTeams: leagueTeams.length,
        clubByTeamId,
      };

      setCachedStandings(leagueId, responseData).catch(() => {});
      return NextResponse.json(responseData);
    }

    // Get all teams with their relations using relational query.
    // CRITICAL: filter by leagueId here. Without this clause we'd load every team
    // across every league + their fixtures + their results, then iterate them all
    // to build `processedGws` and `allFplIds` — which causes the cold-cache FPL
    // fetch loop below to make thousands of sequential FPL roundtrips and time out.
    const allTeamsUnfiltered = await db.query.teams.findMany({
      where: eq(teams.leagueId, leagueId),
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

    // Build a map of teamId → name (from ALL teams, needed for CC opponent lookup)
    const teamNameMap = new Map<string, string>(allTeamsUnfiltered.map(t => [t.id, t.name]));

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
    // For Triple Crown: skip FPL hit-penalty computation — leaguePoints is stored directly
    // by processTripleCrownGameweek and is authoritative. Computing it here via FPL API
    // calls would be extremely slow (38 GWs × 40 players = 1500+ sequential requests).
    const processedGws = new Set<number>();
    if (leagueFormat !== "triple-crown") {
      // Wrap the whole hit-penalty fetch in try/catch — if FPL is down or rate-limited,
      // we skip the deduction this run rather than 500ing the entire standings response.
      // The standings remain useful (chip + bonus points still computed); the hit penalty
      // is a small correction that the next request can populate once FPL recovers.
      try {
        for (const t of allTeamsUnfiltered) {
          for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
            if (f.result && f.gameweek.number <= leagueStageEnd && (!f.competitionType || f.competitionType === "pl")) {
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
            // Cache empty — fetch from FPL API in parallel within this GW.
            // (Sequential per-fplId previously caused multi-minute cold-cache stalls.)
            // GW loop stays sequential to bound concurrency vs FPL rate limits.
            const fetched = await Promise.all(
              [...allFplIds].map(async (fplId) => {
                try {
                  const score = await calculateTeamGameweekScore(fplId, gw, leagueId);
                  return { fplId, hits: score.transferHits };
                } catch {
                  return null;
                }
              }),
            );
            for (const r of fetched) {
              if (!r) continue;
              if (!playerGwHitsMap.has(r.fplId)) {
                playerGwHitsMap.set(r.fplId, new Map());
              }
              playerGwHitsMap.get(r.fplId)!.set(gw, r.hits);
            }
          }
        }
      } catch (e) {
        console.error("standings: hit-penalty fetch failed (continuing without deductions):", e);
      }
    }

    let allTeams = allTeamsUnfiltered;

    // Filter by league if leagueSlug provided
    if (leagueId) {
      allTeams = allTeams.filter(t => t.leagueId === leagueId);
    }

    // Exclude ghost teams (TC cup-group phantoms) from PL standings
    allTeams = allTeams.filter(t => !t.isGhost);

    // Filter by group if provided
    if (group) {
      allTeams = allTeams.filter(t => t.group && t.group.name === group);
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

    // ===== Previous-GW snapshot for rank-change indicator (display-only) =====
    // The previousRank / rankDelta we attach below is purely additive: it does
    // NOT influence current standings, sort order, group assignment, zones, or
    // playoff seeding. TVT playoff bracket generation uses its own
    // `getGroupStandings` helper in `src/lib/formats/tvt/playoffs.ts` and is
    // completely independent of this code path.
    let maxPlayedGw = 0;
    for (const t of allTeams) {
      for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
        if (f.result && f.gameweek.number <= leagueStageEnd && (!f.competitionType || f.competitionType === "pl")) {
          if (f.gameweek.number > maxPlayedGw) maxPlayedGw = f.gameweek.number;
        }
      }
    }

    // Chips contributed before the latest GW only.
    const prevChipPointsByTeam = new Map<string, number>();
    for (const chip of allChipsRaw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chipGw = (chip as any).gameweek?.number;
      if (chipGw && chipGw > leagueStageEnd) continue;
      if (chipGw === maxPlayedGw) continue;
      if (chip.isProcessed) {
        const pts = chip.pointsAwarded || 0;
        if (chip.chipType === "C" || pts > 0) {
          prevChipPointsByTeam.set(chip.teamId, (prevChipPointsByTeam.get(chip.teamId) || 0) + pts);
        }
      }
    }

    // Compute previous-GW sort keys per team (leaguePoints, pointsFor, cbpPoints).
    const prevSortKeysByTeam = new Map<string, { leaguePoints: number; pointsFor: number; cbpPoints: number; group: string | null }>();
    if (maxPlayedGw > 0) {
      for (const team of allTeams) {
        let pWins = 0, pDraws = 0, pLosses = 0, pPointsFor = 0;
        let pBonusPtsTotal = 0;
        for (const f of team.homeFixtures) {
          if (f.gameweek.number > leagueStageEnd) continue;
          if (f.gameweek.number === maxPlayedGw) continue;
          if (f.competitionType && f.competitionType !== "pl") continue;
          if (!f.result) continue;
          pPointsFor += f.result.homeScore;
          if (f.result.homeScore > f.result.awayScore) pWins++;
          else if (f.result.homeScore === f.result.awayScore) pDraws++;
          else pLosses++;
          if (f.result.homeGotBonus) pBonusPtsTotal += f.result.homeUsedDoublePointer ? 2 : 1;
        }
        for (const f of team.awayFixtures) {
          if (f.gameweek.number > leagueStageEnd) continue;
          if (f.gameweek.number === maxPlayedGw) continue;
          if (f.competitionType && f.competitionType !== "pl") continue;
          if (!f.result) continue;
          pPointsFor += f.result.awayScore;
          if (f.result.awayScore > f.result.homeScore) pWins++;
          else if (f.result.awayScore === f.result.homeScore) pDraws++;
          else pLosses++;
          if (f.result.awayGotBonus) pBonusPtsTotal += f.result.awayUsedDoublePointer ? 2 : 1;
        }
        void pLosses; // shape parity with current loop
        const pChipPts = prevChipPointsByTeam.get(team.id) || 0;
        const pCbpPts = pChipPts + pBonusPtsTotal;
        let pHitPenaltyTotal = 0;
        for (const player of team.players) {
          const gwHits = playerGwHitsMap.get(player.fplId);
          if (gwHits) {
            for (const [gw, hits] of gwHits.entries()) {
              if (gw === maxPlayedGw) continue;
              if (hits > 12) pHitPenaltyTotal++;
            }
          }
        }
        // Same formula as the current pass below for both TVT and triple-crown
        // (display purposes — triple-crown's stored leaguePoints is for current
        // values only and equivalently derives from W/D minus hits).
        const pLeaguePoints = (pWins * 2) + (pDraws * 1) + pCbpPts - pHitPenaltyTotal;
        prevSortKeysByTeam.set(team.id, {
          leaguePoints: pLeaguePoints,
          pointsFor: pPointsFor,
          cbpPoints: pCbpPts,
          group: team.group?.name ?? null,
        });
      }
    }

    // Sort previous snapshot per group, assign 1-based previous rank.
    const prevRankByTeam = new Map<string, number>();
    if (maxPlayedGw > 1) {
      const prevByGroup = new Map<string | null, { teamId: string; leaguePoints: number; pointsFor: number; cbpPoints: number }[]>();
      for (const [teamId, v] of prevSortKeysByTeam.entries()) {
        const arr = prevByGroup.get(v.group) ?? [];
        arr.push({ teamId, leaguePoints: v.leaguePoints, pointsFor: v.pointsFor, cbpPoints: v.cbpPoints });
        prevByGroup.set(v.group, arr);
      }
      for (const arr of prevByGroup.values()) {
        arr.sort((a, b) => {
          if (a.leaguePoints !== b.leaguePoints) return b.leaguePoints - a.leaguePoints;
          if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;
          return b.cbpPoints - a.cbpPoints;
        });
        arr.forEach((row, idx) => prevRankByTeam.set(row.teamId, idx + 1));
      }
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
        if (fixture.competitionType && fixture.competitionType !== "pl") continue;
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
        if (fixture.competitionType && fixture.competitionType !== "pl") continue;
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

      // For Triple Crown: use the stored leaguePoints (computed by processTripleCrownGameweek)
      // which already includes hit penalties baked in. For TVT: compute from W/D/L + chips - hits.
      const leaguePoints = leagueFormat === "triple-crown"
        ? team.leaguePoints
        : (wins * 2) + (draws * 1) + cbpPts - hitPenaltyTotal;
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
            const oppName: string | undefined = type === "C" && chip.challengedTeamId
              ? (teamNameMap.get(chip.challengedTeamId) ?? undefined)
              : undefined;
            chipTooltipEntries.push({
              label,
              status: chip.isProcessed ? "used" : "pending",
              points: chip.pointsAwarded || 0,
              gameweek: gwNumber,
              opponent: oppName,
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
        group: team.group?.name || null,
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

    // Group standings by group name (exclude cup group names for Triple Crown)
    const groupNames = [...new Set(standings.map(t => t.group).filter((g): g is string => g !== null && !g.toLowerCase().startsWith("cup-")))].sort();
    const groupMap: Record<string, RankedStanding[]> = {};
    for (const gName of groupNames) {
      const groupTeams = standings.filter(t => t.group === gName);
      groupMap[gName] = groupTeams.map((team, index) => {
        const groupRank = index + 1;
        const prevRank = maxPlayedGw > 1 ? prevRankByTeam.get(team.teamId) ?? null : null;
        return {
          ...team,
          rank: groupRank,
          groupRank,
          zone: getQualificationZone(groupRank, leagueTeamSize),
          previousRank: prevRank,
          rankDelta: prevRank != null ? prevRank - groupRank : null,
        };
      });
    }

    // For groupless leagues (8-team, 16-team, Triple Crown), all teams go into groupA
    if (groupNames.length === 0 && standings.length > 0) {
      groupMap["A"] = standings.map((team, index) => {
        const groupRank = index + 1;
        const prevRank = maxPlayedGw > 1 ? prevRankByTeam.get(team.teamId) ?? null : null;
        return {
          ...team,
          rank: groupRank,
          groupRank,
          zone: getQualificationZone(groupRank, leagueTeamSize),
          previousRank: prevRank,
          rankDelta: prevRank != null ? prevRank - groupRank : null,
        };
      });
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
