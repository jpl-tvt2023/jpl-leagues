import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auctionScores, auctionOwnership, gameweeks, leagues, teams } from "@/lib/db/schema";
import { and, eq, lte } from "drizzle-orm";
import { calculateAuctionTeamScore } from "@/lib/formats/auction/scoring";
import { assignRanksAndPayouts } from "@/lib/formats/auction/economy";
import { countPlayersLeftToPlay } from "@/lib/fpl-live/players-left";
import { getInFlightGameweekNumber } from "@/lib/gameweeks/in-flight";
import { fetchElementInfo, fetchBootstrapData } from "@/lib/fpl";
import { getClubOwnershipsByTeam } from "@/lib/formats/auction/club-auction";
import { backfillClubSummaries } from "@/lib/formats/auction/club-summary-backfill";

/**
 * GET /api/auction/gw-summary?leagueSlug=xxx&gw=N
 *
 * Returns per-team scoring data for a single processed gameweek in an auction
 * league: each team's GW points, rank, payout, and the contributing players.
 * Also returns the list of processed gameweeks so the client can build a GW picker.
 *
 * Publicly readable — same visibility as Standings.
 */
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("leagueSlug");
  const gwParam = request.nextUrl.searchParams.get("gw");

  if (!slug) {
    return NextResponse.json({ error: "leagueSlug is required" }, { status: 400 });
  }

  const [league] = await db.select().from(leagues).where(eq(leagues.slug, slug)).limit(1);
  if (!league) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }
  if (league.format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  const now = new Date();
  const gws = await db
    .select({ id: gameweeks.id, number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, league.id), lte(gameweeks.deadline, now)));

  const liveGameweek = await getInFlightGameweekNumber(league.id);

  if (gws.length === 0) {
    return NextResponse.json({
      leagueId: league.id,
      processedGameweeks: [],
      liveGameweek,
      selectedGw: null,
      rows: [],
      isLive: false,
    });
  }

  const allScores = await db
    .select({
      teamId: auctionScores.teamId,
      gameweekId: auctionScores.gameweekId,
      totalPoints: auctionScores.totalPoints,
      rawPoints: auctionScores.rawPoints,
      synergyBonus: auctionScores.synergyBonus,
      clubResultBonus: auctionScores.clubResultBonus,
      clubResultSummary: auctionScores.clubResultSummary,
      rank: auctionScores.rank,
      payout: auctionScores.payout,
      playerBreakdown: auctionScores.playerBreakdown,
    })
    .from(auctionScores)
    .where(eq(auctionScores.leagueId, league.id));

  const scoredGwIds = new Set(allScores.map((s) => s.gameweekId));
  const processedGameweeks = gws
    .filter((g) => scoredGwIds.has(g.id))
    .map((g) => g.number)
    .sort((a, b) => a - b);

  // Selectable gameweeks include processed ones plus the in-flight GW (if any).
  // The client uses this to decide which gameweeks to render in the picker.
  const selectableGameweeks: number[] = [...processedGameweeks];
  if (liveGameweek != null && !selectableGameweeks.includes(liveGameweek)) {
    selectableGameweeks.push(liveGameweek);
    selectableGameweeks.sort((a, b) => a - b);
  }

  if (selectableGameweeks.length === 0) {
    return NextResponse.json({
      leagueId: league.id,
      processedGameweeks: [],
      liveGameweek,
      selectedGw: null,
      rows: [],
      isLive: false,
    });
  }

  const requestedGw = gwParam ? parseInt(gwParam, 10) : NaN;
  const selectedGw = Number.isFinite(requestedGw) && selectableGameweeks.includes(requestedGw)
    ? requestedGw
    : selectableGameweeks[selectableGameweeks.length - 1];

  const targetGameweek = gws.find((g) => g.number === selectedGw);
  if (!targetGameweek) {
    return NextResponse.json({
      leagueId: league.id,
      processedGameweeks,
      liveGameweek,
      selectedGw,
      rows: [],
      isLive: false,
    });
  }

  const isLive = selectedGw === liveGameweek;

  const teamRows = await db
    .select({ id: teams.id, name: teams.name, teamLoginId: teams.teamLoginId })
    .from(teams)
    .where(eq(teams.leagueId, league.id));

  // PL Club Auction: per-team owned club (drives team-rename + tier chip on UI). Fetch first so
  // we can rename `teamNameMap` entries in-place — downstream `teamName` reads pick the rename up.
  const clubByTeamId = await getClubOwnershipsByTeam(league.id);
  const teamNameMap = new Map(teamRows.map((t) => [t.id, clubByTeamId[t.id]?.plTeamName ?? t.name]));
  // Username per team for the hover tooltip on the (club) name.
  const teamLoginMap = new Map(teamRows.map((t) => [t.id, t.teamLoginId]));

  // Build elementId → elementType map from ownership. A player's position is
  // immutable, so a single map covers every gameweek even when ownership
  // changes hands across the season.
  const ownershipRows = await db
    .select({
      fplElementId: auctionOwnership.fplElementId,
      elementType: auctionOwnership.elementType,
    })
    .from(auctionOwnership)
    .where(eq(auctionOwnership.leagueId, league.id));
  const elementTypeMap = new Map<number, number | null>();
  for (const o of ownershipRows) {
    if (!elementTypeMap.has(o.fplElementId)) {
      elementTypeMap.set(o.fplElementId, o.elementType ?? null);
    }
  }

  // Build elementId → PL club short_name lookup from FPL caches.
  // Best-effort: on FPL outage we leave the map empty and players render
  // without the club suffix.
  const plTeamShortByElement = new Map<number, string>();
  try {
    const [elements, bootstrap] = await Promise.all([fetchElementInfo(), fetchBootstrapData()]);
    const plTeamShortById = new Map<number, string>();
    for (const t of (bootstrap.teams ?? []) as { id: number; short_name: string }[]) {
      plTeamShortById.set(t.id, t.short_name);
    }
    for (const el of elements) {
      const short = plTeamShortById.get(el.team);
      if (short) plTeamShortByElement.set(el.id, short);
    }
  } catch {
    // ignore
  }

  // Compute cumulative league standings at the end of a given GW number.
  // Returns a Map<teamId, rank> where rank is 1-based, ties broken by raw
  // cumulative points (Drizzle SQLite has no stable secondary key here, but
  // ties are vanishingly rare for cumulative totals).
  const gwNumberById = new Map(gws.map((g) => [g.id, g.number]));
  function leagueRanksAfter(gwNumber: number): Map<string, number> {
    const cumulative = new Map<string, number>();
    for (const s of allScores) {
      const num = gwNumberById.get(s.gameweekId);
      if (num == null || num > gwNumber) continue;
      cumulative.set(s.teamId, (cumulative.get(s.teamId) ?? 0) + s.totalPoints);
    }
    const ordered = [...cumulative.entries()].sort((a, b) => b[1] - a[1]);
    const ranks = new Map<string, number>();
    ordered.forEach(([teamId], idx) => ranks.set(teamId, idx + 1));
    return ranks;
  }

  // ===========================================================================
  // LIVE MODE — selected GW is in flight (deadline passed, no auctionScores yet)
  // ===========================================================================
  if (isLive) {
    // Cumulative ranks through (selectedGw − 1) from persisted scores. This
    // is the baseline; we'll add live current-GW points to derive live ranks.
    const baselineCumulative = new Map<string, number>();
    for (const s of allScores) {
      const num = gwNumberById.get(s.gameweekId);
      if (num == null || num >= selectedGw) continue;
      baselineCumulative.set(s.teamId, (baselineCumulative.get(s.teamId) ?? 0) + s.totalPoints);
    }

    // Compute live points + active element IDs per team.
    type LivePlayer = {
      elementId: number;
      name: string;
      points: number;          // alias for rawPoints (kept for back-compat — older UI consumers read `points`)
      rawPoints: number;
      synergyBonus: number;
      plTeamId: number | null;
      elementType: number | null;
      plTeamShort: string | null;
    };
    type LiveRow = {
      teamId: string;
      teamName: string;
      teamLoginId: string | null;
      totalPoints: number;
      rawPoints: number;
      synergyBonus: number;
      clubResultBonus: number;
      clubResultSummary: string | null;
      payout: number;
      gwRank: number;
      leagueRank: number | null;
      prevLeagueRank: number | null;
      rankDelta: number | null;
      players: LivePlayer[];
      playersLeftToPlay: number | null;
    };

    // Active ownership rows for everyone in the league (active during selectedGw).
    const activeOwnership = await db
      .select({
        teamId: auctionOwnership.teamId,
        fplElementId: auctionOwnership.fplElementId,
      })
      .from(auctionOwnership)
      .where(eq(auctionOwnership.leagueId, league.id));
    // Filter by selectedGw acquisition/release window (mirrors calculateAuctionTeamScore).
    const ownershipByTeam = new Map<string, number[]>();
    for (const o of activeOwnership) {
      const arr = ownershipByTeam.get(o.teamId) ?? [];
      arr.push(o.fplElementId);
      ownershipByTeam.set(o.teamId, arr);
    }

    type LiveScoreEntry = Awaited<ReturnType<typeof calculateAuctionTeamScore>>;
    const liveScoresByTeam = new Map<string, LiveScoreEntry>();
    for (const t of teamRows) {
      const score = await calculateAuctionTeamScore(league.id, t.id, selectedGw);
      liveScoresByTeam.set(t.id, score);
    }

    // Assign GW ranks based on live GW points (desc).
    const gwSorted = [...teamRows]
      .map((t) => ({ teamId: t.id, totalPoints: liveScoresByTeam.get(t.id)?.totalPoints ?? 0 }))
      .sort((a, b) => b.totalPoints - a.totalPoints);
    // Same tie rule as a scored GW (see assignRanksAndPayouts): teams level on live points share
    // a rank and split the pot, so this in-progress preview matches what processing will persist.
    const gwRankByTeam = new Map<string, number>();
    const gwPayoutByTeam = new Map<string, number>();
    for (const { item, rank, payout } of assignRanksAndPayouts(gwSorted, (r) => r.totalPoints)) {
      gwRankByTeam.set(item.teamId, rank);
      gwPayoutByTeam.set(item.teamId, payout);
    }

    // League rank = baseline cumulative (through selectedGw − 1) + live current points.
    const liveCumulative = new Map<string, number>();
    for (const t of teamRows) {
      const base = baselineCumulative.get(t.id) ?? 0;
      const live = liveScoresByTeam.get(t.id)?.totalPoints ?? 0;
      liveCumulative.set(t.id, base + live);
    }
    const leagueSorted = [...liveCumulative.entries()].sort((a, b) => b[1] - a[1]);
    const leagueRankByTeam = new Map<string, number>();
    leagueSorted.forEach(([teamId], idx) => leagueRankByTeam.set(teamId, idx + 1));

    // Previous league rank = persisted cumulative through (selectedGw − 1).
    // Only meaningful if at least one prior GW is processed.
    const prevRanks = processedGameweeks.length > 0 && processedGameweeks.some((n) => n < selectedGw)
      ? leagueRanksAfter(selectedGw - 1)
      : null;

    // Players left to play per team (best-effort; null on FPL outage).
    const playersLeftByTeam = new Map<string, number | null>();
    await Promise.all(
      teamRows.map(async (t) => {
        const elementIds = ownershipByTeam.get(t.id) ?? [];
        try {
          const result = await countPlayersLeftToPlay(elementIds, selectedGw);
          playersLeftByTeam.set(t.id, result?.leftToPlay ?? null);
        } catch {
          playersLeftByTeam.set(t.id, null);
        }
      }),
    );

    const liveRows: LiveRow[] = teamRows.map((t) => {
      const live = liveScoresByTeam.get(t.id);
      const gwRank = gwRankByTeam.get(t.id) ?? 0;
      const leagueRank = leagueRankByTeam.get(t.id) ?? null;
      const prevLeagueRank = prevRanks ? prevRanks.get(t.id) ?? null : null;
      const rankDelta = leagueRank != null && prevLeagueRank != null ? prevLeagueRank - leagueRank : null;
      return {
        teamId: t.id,
        // teamNameMap was already renamed above to reflect PL Club Auction ownership.
        teamName: teamNameMap.get(t.id) ?? t.name,
        teamLoginId: teamLoginMap.get(t.id) ?? null,
        totalPoints: live?.totalPoints ?? 0,
        rawPoints: live?.rawPoints ?? 0,
        synergyBonus: live?.synergyBonus ?? 0,
        clubResultBonus: live?.clubResultBonus ?? 0,
        clubResultSummary: live?.clubResultSummary ?? null,
        payout: gwPayoutByTeam.get(t.id) ?? 0,
        gwRank,
        leagueRank,
        prevLeagueRank,
        rankDelta,
        players: (live?.playerBreakdown ?? [])
          .map((p) => ({
            elementId: p.elementId,
            name: p.name,
            points: p.rawPoints,        // back-compat alias
            rawPoints: p.rawPoints,
            synergyBonus: p.synergyBonus,
            plTeamId: p.plTeamId,
            elementType: elementTypeMap.get(p.elementId) ?? null,
            plTeamShort: plTeamShortByElement.get(p.elementId) ?? null,
          }))
          .sort((a, b) => b.rawPoints + b.synergyBonus - (a.rawPoints + a.synergyBonus)),
        playersLeftToPlay: playersLeftByTeam.get(t.id) ?? null,
      };
    });

    // Sort response by GW rank for consistency with the historical path.
    liveRows.sort((a, b) => a.gwRank - b.gwRank);

    return NextResponse.json({
      leagueId: league.id,
      processedGameweeks,
      liveGameweek,
      selectedGw,
      isLive: true,
      clubByTeamId,
      rows: liveRows.map((r) => ({
        teamId: r.teamId,
        teamName: r.teamName,
        teamLoginId: r.teamLoginId,
        totalPoints: r.totalPoints,
        rawPoints: r.rawPoints,
        synergyBonus: r.synergyBonus,
        clubResultBonus: r.clubResultBonus,
        clubResultSummary: r.clubResultSummary,
        rank: r.gwRank,
        payout: r.payout,
        leagueRank: r.leagueRank,
        prevLeagueRank: r.prevLeagueRank,
        rankDelta: r.rankDelta,
        players: r.players,
        playersLeftToPlay: r.playersLeftToPlay,
      })),
    });
  }

  // ===========================================================================
  // HISTORICAL MODE — persisted scores
  // ===========================================================================
  const currentRanks = leagueRanksAfter(selectedGw);
  const previousRanks = selectedGw > processedGameweeks[0]
    ? leagueRanksAfter(selectedGw - 1)
    : null;

  // Historical breakdown rows: post-club-auction rows carry rawPoints/synergyBonus/plTeamId.
  // Legacy rows (pre-club-auction) just have `points`. We tolerate both at read.
  type BreakdownPlayer = {
    elementId: number;
    name: string;
    points?: number;
    rawPoints?: number;
    synergyBonus?: number;
    plTeamId?: number | null;
  };

  // Players left to play in historical mode is normally 0 (GW finished), but
  // some fixtures may still be live if admin processed early. Cheap to compute.
  const ownershipByTeamHistorical = new Map<string, number[]>();
  {
    const own = await db
      .select({ teamId: auctionOwnership.teamId, fplElementId: auctionOwnership.fplElementId })
      .from(auctionOwnership)
      .where(eq(auctionOwnership.leagueId, league.id));
    for (const o of own) {
      const arr = ownershipByTeamHistorical.get(o.teamId) ?? [];
      arr.push(o.fplElementId);
      ownershipByTeamHistorical.set(o.teamId, arr);
    }
  }
  const playersLeftByTeamHistorical = new Map<string, number | null>();
  await Promise.all(
    teamRows.map(async (t) => {
      const ids = ownershipByTeamHistorical.get(t.id) ?? [];
      try {
        const result = await countPlayersLeftToPlay(ids, selectedGw);
        playersLeftByTeamHistorical.set(t.id, result?.leftToPlay ?? null);
      } catch {
        playersLeftByTeamHistorical.set(t.id, null);
      }
    }),
  );

  // Backfill clubResultSummary on the fly for rows scored BEFORE the `club_result_summary` column
  // existed (legacy rows have null + clubResultBonus > 0). Shared helper — same logic powers the
  // /api/standings tooltip.
  const scoredThisGw = allScores.filter((s) => s.gameweekId === targetGameweek.id);
  const backfilled = await backfillClubSummaries(
    scoredThisGw.map((s) => ({
      teamId: s.teamId,
      gameweek: selectedGw,
      clubResultBonus: s.clubResultBonus ?? 0,
      clubResultSummary: s.clubResultSummary,
    })),
    clubByTeamId,
  );
  const fallbackSummaryByTeam = new Map<string, string>();
  for (const [key, value] of backfilled) {
    const [teamId] = key.split(":");
    fallbackSummaryByTeam.set(teamId, value);
  }

  const rows = scoredThisGw
    .map((s) => {
      let players: BreakdownPlayer[] = [];
      try {
        const parsed = JSON.parse(s.playerBreakdown) as BreakdownPlayer[];
        if (Array.isArray(parsed)) players = parsed;
      } catch {
        // Malformed JSON in playerBreakdown — skip the per-player view but keep the row.
      }
      const enrichedPlayers = players.map((p) => {
        const rawPoints = p.rawPoints ?? p.points ?? 0;
        const synergyBonus = p.synergyBonus ?? 0;
        return {
          elementId: p.elementId,
          name: p.name,
          points: rawPoints,        // back-compat
          rawPoints,
          synergyBonus,
          plTeamId: p.plTeamId ?? null,
          elementType: elementTypeMap.get(p.elementId) ?? null,
          plTeamShort: plTeamShortByElement.get(p.elementId) ?? null,
        };
      });
      const leagueRank = currentRanks.get(s.teamId) ?? null;
      const prevLeagueRank = previousRanks ? previousRanks.get(s.teamId) ?? null : null;
      const rankDelta = leagueRank != null && prevLeagueRank != null ? prevLeagueRank - leagueRank : null;
      return {
        teamId: s.teamId,
        teamName: teamNameMap.get(s.teamId) ?? "Unknown",
        teamLoginId: teamLoginMap.get(s.teamId) ?? null,
        totalPoints: s.totalPoints,
        rawPoints: s.rawPoints ?? 0,
        synergyBonus: s.synergyBonus ?? 0,
        clubResultBonus: s.clubResultBonus ?? 0,
        // Persisted by process-gameweek for new rows; backfilled above for legacy rows that pre-date
        // the persisted column. Falls back to null only when FPL fixtures are unreachable.
        clubResultSummary: s.clubResultSummary ?? fallbackSummaryByTeam.get(s.teamId) ?? null,
        rank: s.rank ?? 0,
        payout: s.payout,
        leagueRank,
        prevLeagueRank,
        rankDelta,
        players: enrichedPlayers.sort((a, b) => (b.rawPoints + b.synergyBonus) - (a.rawPoints + a.synergyBonus)),
        playersLeftToPlay: playersLeftByTeamHistorical.get(s.teamId) ?? null,
      };
    })
    .sort((a, b) => {
      if (a.rank && b.rank && a.rank !== b.rank) return a.rank - b.rank;
      return b.totalPoints - a.totalPoints;
    });

  return NextResponse.json({
    leagueId: league.id,
    processedGameweeks,
    liveGameweek,
    selectedGw,
    isLive: false,
    clubByTeamId,
    rows,
  });
}
