import { NextRequest, NextResponse } from "next/server";
import { db, teams, gameweeks, leagues, settings, auctionScores, auctionOwnership } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getCachedStandings, setCachedStandings } from "@/lib/fpl-cache";
import { computeAuctionStandings } from "@/lib/formats/auction/standings";
import { calculateFMV } from "@/lib/formats/auction/economy";
import { getClubOwnershipsByTeam, computeClubResultBonus } from "@/lib/formats/auction/club-auction";
import { backfillClubSummaries } from "@/lib/formats/auction/club-summary-backfill";
import { computeLeagueStageStandings, type LeagueStageRow } from "@/lib/standings/league-stage";
import { isChipDisclosable } from "@/lib/formats/tvt/chip-waste";
import { disclosedGwCount } from "@/lib/gameweeks/disclosure";
import { getActiveFplGameweek } from "@/lib/fpl/event-status";

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
  // Match points (W=2, D=1, L=0) earned vs each opponent — tier 3 of the canonical
  // tiebreaker in src/lib/formats/tvt/scoring.ts.
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
    // Continental Championship runs PL all 38 GWs; TVT league stage ends at playoffStartGw - 1
    const leagueStageEnd = leagueFormat === "continental-championship" ? 38 : playoffStartGw - 1;

    // Deadlines drive chip disclosure in the CP/BP tooltip below, and the disclosure epoch
    // keys the cache. Read fresh and read early: the cached payload embeds the tooltip, so a
    // flat key froze a chip as hidden for the whole TTL after its deadline passed — nothing
    // invalidates when a deadline passes. FPL also moves deadlines, so the cached rows' own
    // copy cannot be trusted either.
    const leagueGwRows = await db
      .select({ number: gameweeks.number, deadline: gameweeks.deadline })
      .from(gameweeks)
      .where(eq(gameweeks.leagueId, leagueId));
    const deadlineByGw = new Map(leagueGwRows.map((g) => [g.number, g.deadline.getTime()]));
    const disclosedGws = disclosedGwCount(leagueGwRows);

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
        const cached = await getCachedStandings(leagueId, disclosedGws);
        if (cached) {
          // The auction payload embeds `currentGwNumber`, which moves every week while
          // this entry lives for 25 hours. Serving it verbatim froze the club tooltip on
          // a stale gameweek for a full day; refresh just that field on the way out.
          if (leagueFormat === "auction" && typeof (cached as { currentGwNumber?: number }).currentGwNumber === "number") {
            const refreshed = await getActiveFplGameweek().catch(() => null);
            if (refreshed?.gw != null) {
              const c = cached as { currentGwNumber: number };
              return NextResponse.json({ ...c, currentGwNumber: Math.max(c.currentGwNumber, refreshed.gw) });
            }
          }
          return NextResponse.json(cached);
        }
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
        // Literal team name, unaffected by the club-auction display rename above — consumers that
        // need to identify the actual team (not its "displays as" club name) read this instead.
        rawTeamName: s.teamName,
        teamLoginId: loginByTeam.get(s.teamId) ?? null,
        gwHistory: s.gwHistory.map((h) => ({
          ...h,
          clubResultSummary: h.clubResultSummary ?? backfilledSummaries.get(`${s.teamId}:${h.gw}`) ?? null,
        })),
      }));

      // Current GW for the multi-GW club tooltip: max of "highest scored GW" and the
      // gameweek FPL is actually on. The tooltip renders rows 1..currentGwNumber so it
      // always reflects in-flight progress.
      //
      // Read from /event-status/ (60s) rather than bootstrap's is_current/is_next, which
      // sat behind a 10-minute cache on top of an ~800KB CDN-fronted payload. This value
      // is also recomputed on every cache hit below — it used to be frozen into the
      // cached blob for its full 25h TTL, so a day-old "current GW" could be served.
      let currentGwNumber = 0;
      try {
        const active = await getActiveFplGameweek();
        const fplCurrent = active.gw ?? 0;
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
      if (!liveBranch) setCachedStandings(leagueId, disclosedGws, responseData).catch(() => {});
      return NextResponse.json(responseData);
    }

    // The canonical ranked table. Every consumer of standings order — this route, the
    // dashboard, playoff seeding, chip eligibility, the Winners page — comes through
    // this one function, so they cannot disagree about who is where.
    const { rows, byGroup, maxPlayedGw } = await computeLeagueStageStandings(leagueId);

    // Team id -> name, for naming a Challenge Chip's target in the CP/BP tooltip.
    const teamNameMap = new Map<string, string>(rows.map((r) => [r.teamId, r.name]));

    // ===== Previous-GW snapshot for the rank-change indicator (display-only) =====
    // previousRank / rankDelta are purely additive: they do NOT influence the current
    // order, group assignment, zones or playoff seeding.
    //
    // Just the same computation cut one gameweek earlier. Deriving it this way is what
    // guarantees the arrows are honest: the hand-rolled snapshot this replaces sorted by
    // a DIFFERENT rule than the live table, so tied teams sprouted phantom movement.
    const prevRankByTeam = new Map<string, number>();
    if (maxPlayedGw > 1) {
      const prev = await computeLeagueStageStandings(leagueId, { throughGw: maxPlayedGw - 1 });
      for (const members of prev.byGroup.values()) {
        for (const row of members) prevRankByTeam.set(row.teamId, row.groupRank);
      }
    }

    // Layer the CP/BP tooltip onto each ranked row. The tooltip is presentation detail
    // that only this route needs, which is why the shared module returns its ingredients
    // (rawChips / bpsEntries / hitPenaltyGws) rather than owning the rendering.
    const chipSetMid = Math.ceil(leagueStageEnd / 2);
    const chipSets: [number, number, number][] = [
      [1, 1, chipSetMid],
      [2, chipSetMid + 1, leagueStageEnd],
    ];
    // Stored chip code -> display name.
    const CHIP_DISPLAY_NAMES: Record<string, string> = { W: "WW", D: "DP", C: "CC", SL: "SL", CB: "CB", UD: "UD" };

    // ⚠️ DISCLOSURE. This tooltip is public and names the chip, its gameweek and the Challenge
    // Chip's target. A gameweek_chips row exists from the moment a chip is DECLARED, so without
    // this gate the standings page told the whole league what their next opponent had lined up,
    // in time to pick a captain against it — the very leak /api/fixtures guards at its own
    // `deadline > now` check. Two rules, same as there: past deadline only, and never a
    // declaration that was rejected and never played.
    //
    // Evaluated here, at read time, rather than inside computeLeagueStageStandings: those rows
    // are cached for hours, and baking a time-dependent verdict into a cache is what hid the
    // fixtures page's chips for a full TTL. Deadlines come from deadlineByGw above, read fresh
    // this request rather than from the cached rows' own stale copy.
    const nowMs = Date.now();
    const isDisclosable = (c: LeagueStageRow["rawChips"][number]): boolean => {
      const gwNumber = c.gameweek?.number;
      if (gwNumber === undefined) return false;
      const deadlineMs = deadlineByGw.get(gwNumber);
      if (deadlineMs === undefined || deadlineMs > nowMs) return false;
      return isChipDisclosable(c);
    };

    const buildCbpTooltip = (row: LeagueStageRow): CbpTooltip => {
      const chipTooltipEntries: ChipTooltipEntry[] = [];
      for (const [set, gwMin, gwMax] of chipSets) {
        for (const type of leagueEnabledChips) {
          const name = CHIP_DISPLAY_NAMES[type] ?? type;
          const label = `${name}${set}`;
          const chip = row.rawChips.find(
            (c) => c.chipType === type && (c.gameweek?.number ?? 0) >= gwMin && (c.gameweek?.number ?? 0) <= gwMax
              && isDisclosable(c),
          );
          if (!chip) {
            chipTooltipEntries.push({ label, status: "available", points: 0 });
          } else {
            const oppName: string | undefined = type === "C" && chip.challengedTeamId
              ? (teamNameMap.get(chip.challengedTeamId) ?? undefined)
              : undefined;
            chipTooltipEntries.push({
              label,
              status: chip.isProcessed ? "used" : "pending",
              points: chip.pointsAwarded || 0,
              gameweek: chip.gameweek?.number,
              opponent: oppName,
            });
          }
        }
      }
      return {
        chips: chipTooltipEntries,
        bps: row.bpsEntries,
        hitPenalty: {
          penaltyGws: row.hitPenaltyGws,
          totalDeduction: row.hitPenaltyTotal,
        },
      };
    };

    type ResponseTeam = Omit<TeamStanding, "headToHeadRecord">;
    type RankedStanding = ResponseTeam & {
      rank: number;
      groupRank: number;
      zone: string;
      previousRank: number | null;
      rankDelta: number | null;
    };

    const toResponseRow = (row: LeagueStageRow): RankedStanding => {
      const prevRank = maxPlayedGw > 1 ? prevRankByTeam.get(row.teamId) ?? null : null;
      return {
        teamId: row.teamId,
        name: row.name,
        group: row.group,
        played: row.played,
        wins: row.wins,
        draws: row.draws,
        losses: row.losses,
        pointsFor: row.pointsFor,
        pointsAgainst: row.pointsAgainst,
        pointsDiff: row.pointsDiff,
        leaguePoints: row.leaguePoints,
        // The stored teams.bonusPoints ledger. Surfaced but never used for ordering —
        // it is a count of bonuses, not points.
        bonusPoints: row.bonusPoints,
        chipPoints: row.chipPoints,
        cbpPoints: row.cbpPoints,
        cbpTooltip: buildCbpTooltip(row),
        players: row.players,
        rank: row.groupRank,
        groupRank: row.groupRank,
        zone: row.zone,
        previousRank: prevRank,
        rankDelta: prevRank != null ? prevRank - row.groupRank : null,
      };
    };

    // A `group` filter narrows what is returned, never how it was ranked.
    const groupMap: Record<string, RankedStanding[]> = {};
    for (const [gName, members] of byGroup.entries()) {
      if (group && gName !== group) continue;
      groupMap[gName] = members.map(toResponseRow);
    }
    const standings = rows;

    // Format-aware legend. The previous hard-coded 8/14/16 keys were wrong for
    // 8-team leagues (no rank 9..14 exists; cutoff is top-4 for playoffs).
    // Match the actual qualification rules in getQualificationZone below.
    // Red-zone wording tracks the stage, not just the rank: during the league stage
    // these teams are in the elimination ZONE and can still climb out of it; only once
    // the stage is complete are they eliminated.
    const leagueStageComplete = maxPlayedGw >= leagueStageEnd;
    const eliminationLabel = leagueStageComplete ? "Eliminated" : "Elimination Zone";
    const legend = leagueTeamSize === 8
      ? {
          top4: "TVT Title Play-offs",
          rank5to8: eliminationLabel,
        }
      : {
          top8: "TVT Title Play-offs",
          rank9to14: "Challenger Series",
          rank15to16: eliminationLabel,
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
      setCachedStandings(leagueId, disclosedGws, responseData).catch(() => {});
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

