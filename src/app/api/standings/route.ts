import { NextRequest, NextResponse } from "next/server";
import { db, teams, groups, players, fixtures, results, gameweekChips, gameweeks, leagues, settings, auctionScores, auctionOwnership, type Team, type Group, type Player, type Fixture, type Result, type Gameweek } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getAllCachedScores, getCachedStandings, setCachedStandings } from "@/lib/fpl-cache";
import { calculateTeamGameweekScore } from "@/lib/fpl";
import { computeAuctionStandings } from "@/lib/formats/auction/standings";
import { calculateFMV } from "@/lib/formats/auction/economy";
import { getClubOwnershipsByTeam, computeClubResultBonus } from "@/lib/formats/auction/club-auction";
import { fetchBootstrapData } from "@/lib/fpl";
import { backfillClubSummaries } from "@/lib/formats/auction/club-summary-backfill";

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
  // Single source of truth: the stored ledger from teams.bonusPoints.
  // A previously-included recomputed `calculatedBonus` was dropped to prevent
  // consumer drift when the GW processor missed an update (DEF-STAND-005).
  bonusPoints: number;
  chipPoints: number;
  cbpPoints: number;
  cbpTooltip: CbpTooltip;
  // Match points (W=2, D=1, L=0) earned vs each opponent — used by the
  // canonical 4-tier tiebreaker (Overall Points → Wins → Head-to-Head → Bonus).
  // Internal-only; stripped before responding to the client (see toResponseRow).
  headToHeadRecord: Record<string, number>;
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
    const leagueStageEnd = leagueFormat === "continental-championship" ? 38 : playoffStartGw - 1;

    // Check if groups have been revealed to teams
    const groupsRevealedRows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.leagueId, leagueId), eq(settings.key, "groupsRevealed")));
    const groupsRevealed = groupsRevealedRows[0]?.value === "true";

    // Return cached standings if available (populated by cron or previous request).
    // Skip the cache when a `group` filter is present: the cache stores the full
    // (unfiltered) payload, so returning it verbatim to a group-filtered request
    // would leak the other group's teams (DEF-STAND-003). Writes are gated below
    // for the same reason — a group-filtered response must not poison the slot.
    if (!group) {
      try {
        const cached = await getCachedStandings(leagueId);
        if (cached) return NextResponse.json(cached);
      } catch {
        // Cache miss or Redis error — fall through to DB computation
      }
    }

    // ============================================
    // JPL AUCTION FORMAT — separate standings computation
    // ============================================
    if (leagueFormat === "auction") {
      const leagueTeams = await db
        .select({ id: teams.id, name: teams.name, teamLoginId: teams.teamLoginId, purse: teams.purse })
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

      // On-the-fly backfill for legacy rows where clubResultBonus > 0 but clubResultSummary is null
      // (rows scored before migration 0007 added the column). Recomputes the scoreline via FPL data
      // so the standings tooltip shows the actual fixture rather than "—".
      const backfillRows = standings.flatMap((s) =>
        s.gwHistory.map((h) => ({
          teamId: s.teamId,
          gameweek: h.gw,
          clubResultBonus: h.clubResultBonus,
          clubResultSummary: h.clubResultSummary,
        }))
      );
      const backfilledSummaries = await backfillClubSummaries(backfillRows, clubByTeamId);

      // Apply PL Club Auction rename to each standings row's `teamName` + backfill missing
      // clubResultSummary entries in gwHistory.
      const loginByTeam = new Map(leagueTeams.map((t) => [t.id, t.teamLoginId]));
      const renamedStandings = standings.map((s) => ({
        ...s,
        teamName: clubByTeamId[s.teamId]?.plTeamName ?? s.teamName,
        teamLoginId: loginByTeam.get(s.teamId) ?? null,
        gwHistory: s.gwHistory.map((h) => ({
          ...h,
          clubResultSummary: h.clubResultSummary ?? backfilledSummaries.get(`${s.teamId}:${h.gw}`) ?? null,
        })),
      }));

      // Current GW for the multi-GW club tooltip: max of "highest scored GW" and "FPL is_current/is_next".
      // The tooltip renders rows 1..currentGwNumber so it always reflects in-flight progress.
      let currentGwNumber = 0;
      try {
        const bootstrap = await fetchBootstrapData();
        const events = (bootstrap.events ?? []) as Array<{ id: number; is_current?: boolean; is_next?: boolean }>;
        const fplCurrent = events.find((e) => e.is_current)?.id ?? events.find((e) => e.is_next)?.id ?? 0;
        const maxScoredGw = scores.reduce((m, s) => Math.max(m, gwNumbers.get(s.gameweekId) ?? 0), 0);
        currentGwNumber = Math.max(maxScoredGw, fplCurrent);
      } catch {
        // FPL outage — currentGwNumber stays 0 and the tooltip falls back to scored history only.
      }

      // When the current GW hasn't been scored by admin yet, compute the live owned-club result for
      // each team so the tooltip can show the in-progress scoreline. One FPL fixtures fetch (cached
      // inside computeClubResultBonus) covers all 14 teams.
      const maxScoredGw = scores.reduce((m, s) => Math.max(m, gwNumbers.get(s.gameweekId) ?? 0), 0);
      const liveClubResultByTeam: Record<string, { summary: string; bonus: number } | null> = {};
      const liveBranch = currentGwNumber > maxScoredGw && currentGwNumber > 0;
      if (liveBranch) {
        for (const [teamId, owned] of Object.entries(clubByTeamId)) {
          liveClubResultByTeam[teamId] = await computeClubResultBonus(owned.plTeamId, owned.tier, currentGwNumber);
        }
      }

      const responseData = {
        format: "auction" as const,
        standings: renamedStandings,
        totalTeams: leagueTeams.length,
        clubByTeamId,
        currentGwNumber,
        liveClubResultByTeam,
      };

      // Skip cache write during the live in-progress branch — TTL would make the live scoreline stale.
      if (!liveBranch) setCachedStandings(leagueId, responseData).catch(() => {});
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
    if (leagueFormat !== "continental-championship") {
      // Wrap the whole hit-penalty fetch in try/catch — if FPL is down or rate-limited,
      // we skip the deduction this run rather than 500ing the entire standings response.
      // The standings remain useful (chip + bonus points still computed); the hit penalty
      // is a small correction that the next request can populate once FPL recovers.
      try {
        for (const t of allTeamsUnfiltered) {
          for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
            if (f.result && f.gameweek.number <= leagueStageEnd && (!f.competitionType || f.competitionType === "jpl")) {
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
        if (f.result && f.gameweek.number <= leagueStageEnd && (!f.competitionType || f.competitionType === "jpl")) {
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
          if (f.competitionType && f.competitionType !== "jpl") continue;
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
          if (f.competitionType && f.competitionType !== "jpl") continue;
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
      // Match points (W=2, D=1, L=0) earned against each opponent — used as the
      // 3rd-tier tiebreaker per src/lib/formats/tvt/scoring.ts:215-246. When two
      // teams are level on Overall Points and Wins, the team that has earned
      // more match points head-to-head ranks higher.
      const headToHeadRecord: Record<string, number> = {};

      // Process home fixtures (league stage only)
      for (const fixture of team.homeFixtures) {
        if (fixture.gameweek.number > leagueStageEnd) continue;
        if (fixture.competitionType && fixture.competitionType !== "jpl") continue;
        if (fixture.result) {
          pointsFor += fixture.result.homeScore;
          pointsAgainst += fixture.result.awayScore;

          // W/D/L based on raw FPL scores (not chip-adjusted match points)
          let matchPts = 0;
          if (fixture.result.homeScore > fixture.result.awayScore) { wins++; matchPts = 2; }
          else if (fixture.result.homeScore === fixture.result.awayScore) { draws++; matchPts = 1; }
          else losses++;
          headToHeadRecord[fixture.awayTeamId] = (headToHeadRecord[fixture.awayTeamId] ?? 0) + matchPts;

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
        if (fixture.competitionType && fixture.competitionType !== "jpl") continue;
        if (fixture.result) {
          pointsFor += fixture.result.awayScore;
          pointsAgainst += fixture.result.homeScore;

          // W/D/L based on raw FPL scores (not chip-adjusted match points)
          let matchPts = 0;
          if (fixture.result.awayScore > fixture.result.homeScore) { wins++; matchPts = 2; }
          else if (fixture.result.awayScore === fixture.result.homeScore) { draws++; matchPts = 1; }
          else losses++;
          headToHeadRecord[fixture.homeTeamId] = (headToHeadRecord[fixture.homeTeamId] ?? 0) + matchPts;

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
      const leaguePoints = leagueFormat === "continental-championship"
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
        // Single source of truth: only the stored teams.bonusPoints column is
        // surfaced. Exposing both `bonusPoints` and a recomputed `calculatedBonus`
        // invited consumer drift when the GW processor missed an update — the
        // recomputed value would silently disagree with the stored ledger.
        bonusPoints: team.bonusPoints,
        chipPoints: chipPts,
        cbpPoints: cbpPts,
        cbpTooltip,
        headToHeadRecord,
        players: team.players.map((p: Player) => ({
          name: p.name,
          fplId: p.fplId,
          captaincyChipsUsed: p.captaincyChipsUsed,
        })),
      };
    });

    // Canonical TVT league-stage tiebreaker (src/lib/formats/tvt/scoring.ts:215-246):
    //   1) Overall Points (leaguePoints) DESC
    //   2) Max Wins DESC
    //   3) Head-to-Head match points DESC (each team's points earned vs the other)
    //   4) Bonus Points DESC
    // Previously the route used (leaguePoints, pointsFor, cbpPoints) which mismatched
    // the documented rule and could resolve ties incorrectly.
    standings.sort((a: TeamStanding, b: TeamStanding) => {
      if (a.leaguePoints !== b.leaguePoints) return b.leaguePoints - a.leaguePoints;
      if (a.wins !== b.wins) return b.wins - a.wins;
      const aH2H = a.headToHeadRecord[b.teamId] ?? 0;
      const bH2H = b.headToHeadRecord[a.teamId] ?? 0;
      if (aH2H !== bH2H) return bH2H - aH2H;
      return b.bonusPoints - a.bonusPoints;
    });

    // Strip internal-only fields from the public team row.
    type ResponseTeam = Omit<TeamStanding, "headToHeadRecord">;
    const toResponseRow = (team: TeamStanding): ResponseTeam => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { headToHeadRecord, ...rest } = team;
      return rest;
    };

    type RankedStanding = ResponseTeam & { rank: number; zone: string };

    // Group standings by group name (exclude cup group names for Triple Crown)
    const groupNames = [...new Set(standings.map(t => t.group).filter((g): g is string => g !== null && !g.toLowerCase().startsWith("cup-")))].sort();
    const groupMap: Record<string, RankedStanding[]> = {};
    for (const gName of groupNames) {
      const groupTeams = standings.filter(t => t.group === gName);
      groupMap[gName] = groupTeams.map((team, index) => {
        const groupRank = index + 1;
        const prevRank = maxPlayedGw > 1 ? prevRankByTeam.get(team.teamId) ?? null : null;
        return {
          ...toResponseRow(team),
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
          ...toResponseRow(team),
          rank: groupRank,
          groupRank,
          zone: getQualificationZone(groupRank, leagueTeamSize),
          previousRank: prevRank,
          rankDelta: prevRank != null ? prevRank - groupRank : null,
        };
      });
    }

    // Format-aware legend. The previous hard-coded 8/14/16 keys were wrong for
    // 8-team leagues (no rank 9..14 exists; cutoff is top-4 for playoffs).
    // Match the actual qualification rules in getQualificationZone below.
    const legend = leagueTeamSize === 8
      ? {
          top4: "TVT Title Play-offs",
          rank5to8: "Eliminated",
        }
      : {
          top8: "TVT Title Play-offs",
          rank9to14: "Challenger Series",
          rank15to16: "Eliminated",
        };

    const responseData = {
      groupA: groupMap["A"] ?? [],
      groupB: groupMap["B"] ?? [],
      totalTeams: standings.length,
      enabledChips: leagueEnabledChips,
      leagueStageEnd,
      teamSize: leagueTeamSize,
      groupsRevealed,
      legend,
    };

    // Fire-and-forget cache write — must not block or break the response.
    // Skip the write when a `group` filter is active: caching a filtered payload
    // under the unfiltered key would leak group-A teams to group-B callers
    // (mirror of the read-side guard above for DEF-STAND-003).
    if (leagueId && !group) {
      setCachedStandings(leagueId, responseData).catch(() => {});
    }

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Error fetching standings:", error);
    // Surface real failures as 500 so clients + monitoring can distinguish a
    // server fault from an empty league. The "no fixtures yet" / "no teams yet"
    // states are handled organically by the happy path above — an empty league
    // produces empty `groupA`/`groupB` with the league's real teamSize and
    // leagueStageEnd, not the magic 32/30 stub this catch used to return.
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to compute standings", detail: message },
      { status: 500 }
    );
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
