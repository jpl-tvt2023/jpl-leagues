/**
 * FPL Classic — assembling the public standings page payload.
 *
 * One function builds everything the page needs in one pass: live season standings, the
 * gameweek leaderboard, and the monthly leaderboard. Splitting these into three routes would
 * triple the round trips for a page that shows all three at once, and they share the league
 * lookup and (for the current gameweek) the same live FPL block.
 *
 * The live block is the ONLY part of this that can touch FPL, and only behind a single-flight
 * lock with a bounded call count — see cache.ts. Settled data (gameweek/monthly boards for
 * anything already synced) is pure SQL over `fpl_classic_entry_gws`, which is immutable and
 * indexed, so it costs nothing per read regardless of how many public visitors ask for it.
 */

import { db } from "@/lib/db";
import { fplClassicConfig, fplClassicEntrants, fplClassicEntryGws, fplClassicAwards } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getActiveFplGameweek } from "@/lib/fpl/event-status";
import { fetchClassicLeagueStandings } from "@/lib/fpl/classic-league";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";
import {
  getCachedClassicLive,
  setCachedClassicLive,
  isClassicLiveFresh,
  claimClassicSyncLock,
  releaseClassicSyncLock,
  type ClassicLivePayload,
} from "./cache";
import { monthLabel } from "./months";
import { rankRows, topN, type Rankable } from "./leaderboard";
import { type AwardContext } from "./awards";
import { buildAwardGroups, indexFrozenAwards, type ClassicAwardGroup } from "./award-groups";

/** A live standings row carries the extra fields the season table needs alongside ranking. */
interface LiveRankable extends Rankable {
  total: number;
  eventTotal: number;
}

export interface ClassicStandingsRow {
  entrantId: string;
  fplEntryId: number;
  entryName: string;
  playerName: string;
  rank: number;
  isTied: boolean;
  previousRank: number | null;
  total: number;
  eventTotal: number | null;
  isLive: boolean;
}

export interface ClassicBoardRow {
  entrantId: string;
  entryName: string;
  playerName: string;
  rank: number;
  isTied: boolean;
  netPoints: number;
}

export interface ClassicMonthOption {
  key: string;
  label: string;
  gws: number[];
  isComplete: boolean;
}

export interface ClassicStandingsPayload {
  league: {
    slug: string;
    name: string;
    season: string;
    fplLeagueId: number;
    fplLeagueName: string | null;
    startGameweek: number;
    scoringMetric: "net" | "gross";
    winnerCutPercent: number;
  };
  standings: {
    rows: ClassicStandingsRow[];
    gw: number;
    isLive: boolean;
    source: "fpl" | "db";
    isStale: boolean;
    updatedAt: string;
    lastUpdatedFpl: string | null;
    truncated: boolean;
    winnerCutRank: number;
  };
  gameweekBoard: {
    gw: number;
    isLive: boolean;
    availableGws: number[];
    source: "live" | "settled" | "none";
    rows: ClassicBoardRow[];
  };
  monthlyBoard: {
    monthKey: string | null;
    label: string | null;
    months: ClassicMonthOption[];
    rows: ClassicBoardRow[];
  };
  awards: ClassicAwardGroup[];
  sync: {
    entrantsSyncedAt: string | null;
    settledThroughGw: number;
    lastSyncError: string | null;
  };
}

// Award shapes live in award-groups.ts, which owns the final/provisional/leading distinction.
// Re-exported here so existing importers of this module keep working unchanged.
export type { ClassicAwardWinnerRow, ClassicAwardGroup, ClassicAwardStatus } from "./award-groups";

async function loadConfig(leagueId: string) {
  const [config] = await db
    .select()
    .from(fplClassicConfig)
    .where(eq(fplClassicConfig.leagueId, leagueId))
    .limit(1);
  return config ?? null;
}

/**
 * The live standings block: cache-first, single-flight refresh, DB fallback. Never fetches FPL
 * outside the lock, so N concurrent public visitors trigger at most one sweep.
 */
async function resolveLiveBlock(
  leagueId: string,
  fplLeagueId: number,
  gw: number,
  isLive: boolean,
): Promise<{ payload: ClassicLivePayload | null; source: "fpl" | "db"; isStale: boolean; truncated: boolean }> {
  const cached = await getCachedClassicLive(leagueId);
  if (cached && isClassicLiveFresh(cached)) {
    return { payload: cached, source: "fpl", isStale: false, truncated: false };
  }

  const won = await claimClassicSyncLock(leagueId);
  if (!won) {
    // Someone else is refreshing right now. Serve whatever is cached, however stale — never
    // block a reader on another reader's in-flight fetch.
    return { payload: cached, source: cached ? "fpl" : "db", isStale: !!cached, truncated: false };
  }

  try {
    const fresh = await withFplBudget(
      { lane: "background", label: "fpl-classic live", max: 30 },
      () => fetchClassicLeagueStandings(fplLeagueId, { lane: "background" }),
    );
    const payload: ClassicLivePayload = {
      gw,
      isLive,
      rows: fresh.entries.map((e) => ({
        fplEntryId: e.entry,
        entryName: e.entryName,
        playerName: e.playerName,
        total: e.total,
        eventTotal: e.eventTotal,
        rank: e.rank,
        lastRank: e.lastRank,
      })),
      lastUpdatedFpl: fresh.lastUpdatedData,
      cachedAt: new Date().toISOString(),
    };
    await setCachedClassicLive(leagueId, payload);
    return { payload, source: "fpl", isStale: false, truncated: fresh.truncated };
  } catch (err) {
    if (!(err instanceof FplUnavailableError)) throw err;
    // FPL unreachable — serve the stale cache if there is one, else fall through to DB.
    return { payload: cached, source: cached ? "fpl" : "db", isStale: !!cached, truncated: false };
  } finally {
    await releaseClassicSyncLock(leagueId);
  }
}

export async function buildClassicStandingsPayload(opts: {
  leagueId: string;
  leagueSlug: string;
  leagueName: string;
  season: string;
  requestedGw?: number | null;
  requestedMonthKey?: string | null;
}): Promise<ClassicStandingsPayload | null> {
  const config = await loadConfig(opts.leagueId);
  if (!config) return null;

  // `gw` is the lowest gameweek FPL has not yet concluded — the same "current gameweek"
  // definition getCurrentGameweekNumber uses for the TVT dashboard (lib/gameweeks/current-gw.ts),
  // which this format cannot call directly: it reads OUR `gameweeks` table, and fpl-classic
  // deliberately creates no rows there. `gw !== null` means there is still a gameweek in progress
  // (started or not) worth treating as "live"; null means the whole season has concluded.
  const active = await getActiveFplGameweek().catch(() => null);
  const currentGw = active?.gw ?? active?.lastConcludedGw ?? config.settledThroughGw ?? config.startGameweek;
  const isCurrentGwLive = active?.gw != null;

  const entrants = await db
    .select()
    .from(fplClassicEntrants)
    .where(and(eq(fplClassicEntrants.leagueId, opts.leagueId), eq(fplClassicEntrants.isActive, true)));
  const entrantByFplId = new Map(entrants.map((e) => [e.fplEntryId, e]));
  const entrantById = new Map(entrants.map((e) => [e.id, e]));

  // ── Live standings ───────────────────────────────────────────────────────
  const live = await resolveLiveBlock(opts.leagueId, config.fplLeagueId, currentGw, isCurrentGwLive);

  let standingsRows: ClassicStandingsRow[];
  if (live.payload) {
    const rankable: LiveRankable[] = live.payload.rows
      .filter((r) => entrantByFplId.has(r.fplEntryId))
      .map((r) => ({
        entrantId: entrantByFplId.get(r.fplEntryId)!.id,
        value: r.total,
        total: r.total,
        eventTotal: r.eventTotal,
        tieBreak: null,
        name: r.playerName,
      }));
    const ranked = rankRows(rankable);
    standingsRows = ranked.map((r) => {
      const entrant = entrantById.get(r.entrantId)!;
      return {
        entrantId: entrant.id,
        fplEntryId: entrant.fplEntryId,
        entryName: entrant.entryName,
        playerName: entrant.playerName,
        rank: r.rank,
        isTied: r.isTied,
        previousRank: entrant.lastRank,
        total: r.total,
        eventTotal: r.eventTotal,
        isLive: live.source === "fpl" && isCurrentGwLive,
      };
    });
  } else {
    // FPL unreachable and nothing cached — degrade to the denormalised DB snapshot rather than
    // an error. Numbers may be a little stale; the page must still render.
    const rankable = entrants.map((e) => ({
      entrantId: e.id,
      value: e.totalPoints,
      tieBreak: null,
      name: e.playerName,
    }));
    const ranked = rankRows(rankable);
    standingsRows = ranked.map((r) => {
      const entrant = entrantById.get(r.entrantId)!;
      return {
        entrantId: entrant.id,
        fplEntryId: entrant.fplEntryId,
        entryName: entrant.entryName,
        playerName: entrant.playerName,
        rank: r.rank,
        isTied: r.isTied,
        previousRank: entrant.lastRank,
        total: entrant.totalPoints,
        eventTotal: null,
        isLive: false,
      };
    });
  }

  const winnerCutRank = Math.max(1, Math.ceil((standingsRows.length * config.winnerCutPercent) / 100));

  // ── Settled gameweek/monthly data ───────────────────────────────────────
  const settledRows = config.settledThroughGw > 0
    ? await db
        .select()
        .from(fplClassicEntryGws)
        .where(and(
          eq(fplClassicEntryGws.leagueId, opts.leagueId),
          inArray(fplClassicEntryGws.entrantId, entrants.map((e) => e.id)),
        ))
    : [];

  const monthKeyByGw = new Map<number, { key: string; label: string }>();
  for (const row of settledRows) {
    if (!monthKeyByGw.has(row.gw)) monthKeyByGw.set(row.gw, { key: row.monthKey, label: monthLabel(row.monthKey) });
  }
  const gwsByMonth = new Map<string, number[]>();
  for (const [gw, m] of monthKeyByGw) {
    const list = gwsByMonth.get(m.key) ?? [];
    list.push(gw);
    gwsByMonth.set(m.key, list);
  }
  const settledThroughGw = config.settledThroughGw;
  const months: ClassicMonthOption[] = [...gwsByMonth.entries()]
    .map(([key, gws]) => ({
      key,
      label: monthLabel(key),
      gws: [...gws].sort((a, b) => a - b),
      // "Complete" here means every gameweek FPL has scheduled for this month is already
      // settled — approximated as "no gameweek in this bucket is above the settled cursor",
      // which is exact once the season calendar is fully known.
      isComplete: gws.every((g) => g <= settledThroughGw),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const eligible = (entrantId: string, gw: number) => {
    const e = entrantById.get(entrantId);
    return !!e && e.firstSeenGw <= gw;
  };

  const buildGwRows = (gw: number): ClassicBoardRow[] => {
    const rows = settledRows.filter((r) => r.gw === gw && eligible(r.entrantId, gw));
    const metric = config.scoringMetric === "gross" ? "points" : "netPoints";
    const rankable = rows.map((r) => ({
      entrantId: r.entrantId,
      value: metric === "points" ? r.points : r.netPoints,
      tieBreak: r.overallRank,
      name: entrantById.get(r.entrantId)!.playerName,
    }));
    return topN(rankable, 10).map((r) => {
      const e = entrantById.get(r.entrantId)!;
      return { entrantId: r.entrantId, entryName: e.entryName, playerName: e.playerName, rank: r.rank, isTied: r.isTied, netPoints: r.value };
    });
  };

  const buildMonthRows = (monthKey: string): ClassicBoardRow[] => {
    const gws = gwsByMonth.get(monthKey) ?? [];
    const metric = config.scoringMetric === "gross" ? "points" : "netPoints";
    const totals = new Map<string, number>();
    for (const row of settledRows) {
      if (!gws.includes(row.gw)) continue;
      const entrant = entrantById.get(row.entrantId);
      if (!entrant || entrant.firstSeenGw > Math.min(...gws)) continue; // must be present for the WHOLE month
      const val = metric === "points" ? row.points : row.netPoints;
      totals.set(row.entrantId, (totals.get(row.entrantId) ?? 0) + val);
    }
    const rankable = [...totals.entries()].map(([entrantId, value]) => ({
      entrantId,
      value,
      tieBreak: null,
      name: entrantById.get(entrantId)!.playerName,
    }));
    return topN(rankable, 10).map((r) => {
      const e = entrantById.get(r.entrantId)!;
      return { entrantId: r.entrantId, entryName: e.entryName, playerName: e.playerName, rank: r.rank, isTied: r.isTied, netPoints: r.value };
    });
  };

  // ── Gameweek board default + selection ──────────────────────────────────
  const requestedGw = opts.requestedGw ?? currentGw;
  const isRequestedGwLive = requestedGw === currentGw && isCurrentGwLive;

  let gameweekBoard: ClassicStandingsPayload["gameweekBoard"];
  if (isRequestedGwLive) {
    // Live board: ranked by the live block's `eventTotal` directly, never persisted. FPL's
    // classic-standings endpoint exposes only one live gameweek figure — already net of transfer
    // hits — so `scoringMetric: "gross"` has nothing live to rank by and applies only to
    // SETTLED boards below, where entry/history gives both `points` and `event_transfers_cost`.
    const rankable = standingsRows
      .filter((r) => r.eventTotal !== null && entrantById.get(r.entrantId)!.firstSeenGw <= requestedGw)
      .map((r) => ({ entrantId: r.entrantId, value: r.eventTotal!, tieBreak: null, name: r.playerName }));
    const rows = topN(rankable, 10).map((r) => {
      const e = entrantById.get(r.entrantId)!;
      return { entrantId: r.entrantId, entryName: e.entryName, playerName: e.playerName, rank: r.rank, isTied: r.isTied, netPoints: r.value };
    });
    const availableGws = [...new Set([...monthKeyByGw.keys(), requestedGw])].sort((a, b) => a - b);
    gameweekBoard = { gw: requestedGw, isLive: true, availableGws, source: "live", rows };
  } else if (monthKeyByGw.has(requestedGw)) {
    gameweekBoard = {
      gw: requestedGw,
      isLive: false,
      availableGws: [...monthKeyByGw.keys()].sort((a, b) => a - b),
      source: "settled",
      rows: buildGwRows(requestedGw),
    };
  } else {
    gameweekBoard = {
      gw: requestedGw,
      isLive: false,
      availableGws: [...monthKeyByGw.keys()].sort((a, b) => a - b),
      source: "none",
      rows: [],
    };
  }

  // ── Monthly board default + selection ───────────────────────────────────
  const defaultMonth = months.find((m) => m.gws.includes(currentGw))?.key ?? (months.length > 0 ? months[months.length - 1].key : null);
  const selectedMonthKey = opts.requestedMonthKey ?? defaultMonth;
  const monthlyBoard: ClassicStandingsPayload["monthlyBoard"] = {
    monthKey: selectedMonthKey,
    label: selectedMonthKey ? monthLabel(selectedMonthKey) : null,
    months,
    rows: selectedMonthKey ? buildMonthRows(selectedMonthKey) : [],
  };

  // ── Awards: frozen rows read verbatim; unfrozen-but-ready scopes computed live ──────────────
  const awardCtx: AwardContext = {
    entrants: entrants.map((e) => ({ id: e.id, playerName: e.playerName, entryName: e.entryName, firstSeenGw: e.firstSeenGw })),
    rows: settledRows.map((r) => ({ entrantId: r.entrantId, gw: r.gw, points: r.points, netPoints: r.netPoints, benchPoints: r.benchPoints, monthKey: r.monthKey })),
    months: months.map((m) => ({ key: m.key, label: m.label, gws: m.gws })),
    startGameweek: config.startGameweek,
    settledThroughGw,
    metric: config.scoringMetric as "net" | "gross",
    winnerCutPercent: config.winnerCutPercent,
  };
  const frozenAwardRows = settledThroughGw > 0
    ? await db.select().from(fplClassicAwards).where(eq(fplClassicAwards.leagueId, opts.leagueId))
    : [];

  // Standings shows decided awards only; "who is currently leading" lives on the winners page,
  // which calls the same builder with includeLeading: true.
  const awards = buildAwardGroups(
    awardCtx,
    indexFrozenAwards(frozenAwardRows),
    new Map(entrants.map((e) => [e.id, { entryName: e.entryName, playerName: e.playerName }])),
    { includeLeading: false },
  );

  return {
    league: {
      slug: opts.leagueSlug,
      name: opts.leagueName,
      season: opts.season,
      fplLeagueId: config.fplLeagueId,
      fplLeagueName: config.fplLeagueName,
      startGameweek: config.startGameweek,
      scoringMetric: config.scoringMetric as "net" | "gross",
      winnerCutPercent: config.winnerCutPercent,
    },
    standings: {
      rows: standingsRows,
      gw: currentGw,
      isLive: isCurrentGwLive,
      source: live.source,
      isStale: live.isStale,
      updatedAt: live.payload?.cachedAt ?? new Date().toISOString(),
      lastUpdatedFpl: live.payload?.lastUpdatedFpl ?? null,
      truncated: live.truncated,
      winnerCutRank,
    },
    gameweekBoard,
    monthlyBoard,
    awards,
    sync: {
      entrantsSyncedAt: config.entrantsSyncedAt ? config.entrantsSyncedAt.toISOString() : null,
      settledThroughGw: config.settledThroughGw,
      lastSyncError: config.lastSyncError,
    },
  };
}
