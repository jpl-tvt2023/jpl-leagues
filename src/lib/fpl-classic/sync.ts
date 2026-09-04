/**
 * FPL Classic — roster sync, the settle sweep, and award freezing.
 *
 * Three operations, all idempotent and safe to call concurrently (each single-flights on its
 * own Redis lock — see cache.ts). None of this runs on a page load: `syncRoster` and
 * `settleGameweeks` are superadmin-triggered only, from the Operations tab. A public standings
 * read only ever touches the cheap live block in standings.ts.
 *
 * The single sharpest correctness rule in this whole feature lives in `settleGameweeks`: the
 * settled cursor must advance ONLY to a gameweek every active entrant actually has a row for.
 * Advancing on a partial sweep would make that gameweek permanently missing — nothing else in
 * the system would ever notice or backfill it — and every board and award downstream would be
 * silently wrong for the rest of the season.
 */

import { db } from "@/lib/db";
import { fplClassicConfig, fplClassicEntrants, fplClassicEntryGws, fplClassicAwards, auditLogs } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getActiveFplGameweek } from "@/lib/fpl/event-status";
import { fetchClassicLeagueStandings } from "@/lib/fpl/classic-league";
import { fetchTeamHistory } from "@/lib/fpl";
import { fetchGameweekDeadlines } from "@/lib/fpl/gw-calendar";
import { getCachedEntryHistories, setCachedEntryHistory, CACHE_TTL } from "@/lib/fpl-cache";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  claimClassicRosterLock, releaseClassicRosterLock,
  claimClassicSettleLock, releaseClassicSettleLock,
} from "./cache";
import { monthKeyFromDeadline } from "./months";
import { AWARD_DEFINITIONS, allScopes, isScopeReady, type AwardContext } from "./awards";

/**
 * Entrants whose history one settle call will fetch.
 *
 * Was 250, which is larger than most leagues — so the cap never engaged and "bounded" meant "the
 * whole league in one invocation". A 237-entrant league then made ~237 FPL calls against a gateway
 * that admits 8.33 request starts/sec (MIN_INTERVAL_MS=120 at concurrency 4), i.e. a 28s pacing
 * floor before latency, plus ~475 sequential libSQL round-trips — comfortably past the Vercel Hobby
 * ceiling of 60s. The function was killed mid-sweep and returned a bare 504.
 *
 * 50 is ~6-10s of fan-out, so a 237-entrant league finishes in ~5 passes of the browser loop
 * (which allows 20).
 */
const ENTRANT_BATCH = 50;

/**
 * Stop admitting new history fetches past this point in a single call.
 *
 * The count cap alone is not enough: the right number depends on FPL latency, which varies between
 * 400ms and 800ms+ and which this code cannot know in advance. A wall-clock deadline is
 * self-correcting — a slow FPL means fewer entrants this pass, not a killed function.
 *
 * Sized against maxDuration=60 with room for the inserts, the cursor update and freezeAwards after
 * the fan-out returns.
 */
const SETTLE_DEADLINE_MS = 40_000;

async function loadConfig(leagueId: string) {
  const [config] = await db.select().from(fplClassicConfig).where(eq(fplClassicConfig.leagueId, leagueId)).limit(1);
  return config ?? null;
}

/**
 * Refresh the entrant roster from FPL: names/totals updated, new joiners inserted with
 * `firstSeenGw` = the gameweek this sync ran in, and anyone absent from the payload marked
 * inactive — never deleted, so their historical rows and any award they already won survive.
 */
export async function syncRoster(leagueId: string): Promise<{ ok: boolean; entrantCount?: number; error?: string }> {
  const config = await loadConfig(leagueId);
  if (!config) return { ok: false, error: "League configuration not found" };

  const won = await claimClassicRosterLock(leagueId);
  if (!won) return { ok: false, error: "A roster sync is already in progress for this league" };

  try {
    const active = await getActiveFplGameweek().catch(() => null);
    const currentGw = active?.gw ?? active?.lastConcludedGw ?? config.settledThroughGw ?? config.startGameweek;

    const fresh = await withFplBudget(
      { lane: "background", label: "fpl-classic roster sync", max: 30 },
      () => fetchClassicLeagueStandings(config.fplLeagueId, { lane: "background" }),
    );

    const existing = await db.select().from(fplClassicEntrants).where(eq(fplClassicEntrants.leagueId, leagueId));
    const existingByFplId = new Map(existing.map((e) => [e.fplEntryId, e]));
    const seenFplIds = new Set<number>();

    // One round-trip per CHANGED entrant, not per entrant. The settle sweep calls this on every
    // pass, so on a 237-entrant league the old shape spent ~237 sequential libSQL round-trips
    // re-writing identical rows before any real work began — a large slice of a 60s budget, paid
    // five times over. Inserts are batched; updates only fire where a field actually moved.
    const toInsert: (typeof fplClassicEntrants.$inferInsert)[] = [];

    for (const entry of fresh.entries) {
      seenFplIds.add(entry.entry);
      const row = existingByFplId.get(entry.entry);
      if (!row) {
        toInsert.push({
          id: generateId(),
          leagueId,
          fplEntryId: entry.entry,
          entryName: entry.entryName,
          playerName: entry.playerName,
          firstSeenGw: currentGw,
          totalPoints: entry.total,
          lastRank: entry.rank,
          isActive: true,
        });
        continue;
      }
      const unchanged =
        row.entryName === entry.entryName &&
        row.playerName === entry.playerName &&
        row.totalPoints === entry.total &&
        row.lastRank === entry.rank &&
        row.isActive;
      if (unchanged) continue;
      await db.update(fplClassicEntrants)
        .set({ entryName: entry.entryName, playerName: entry.playerName, totalPoints: entry.total, lastRank: entry.rank, isActive: true, updatedAt: new Date() })
        .where(eq(fplClassicEntrants.id, row.id));
    }

    // Chunked: SQLite caps bound variables per statement, and these rows carry ~9 columns each.
    for (let i = 0; i < toInsert.length; i += 50) {
      await db.insert(fplClassicEntrants).values(toInsert.slice(i, i + 50));
    }

    // Present before, absent now — soft-deactivate. Never delete: their settled rows and any
    // award already won must outlive their membership.
    for (const row of existing) {
      if (!seenFplIds.has(row.fplEntryId) && row.isActive) {
        await db.update(fplClassicEntrants).set({ isActive: false, updatedAt: new Date() }).where(eq(fplClassicEntrants.id, row.id));
      }
    }

    await db.update(fplClassicConfig)
      .set({ entrantsSyncedAt: new Date(), entrantCount: fresh.entries.length, lastSyncError: null, updatedAt: new Date() })
      .where(eq(fplClassicConfig.leagueId, leagueId));

    return { ok: true, entrantCount: fresh.entries.length };
  } catch (err) {
    const message = err instanceof FplUnavailableError ? err.message : err instanceof Error ? err.message : String(err);
    await db.update(fplClassicConfig).set({ lastSyncError: message, updatedAt: new Date() }).where(eq(fplClassicConfig.leagueId, leagueId));
    return { ok: false, error: message };
  } finally {
    await releaseClassicRosterLock(leagueId);
  }
}

export interface SettleResult {
  ok: boolean;
  done: boolean;
  settledThroughGw: number;
  remainingEntrants: number;
  error?: string;
}

/**
 * Settle as many concluded gameweeks as fit in one call (bounded to ENTRANT_BATCH entrants'
 * histories). Call repeatedly until `done` — the same browser-loop pattern the existing
 * Operations tab already uses for the shared scoring orchestrator.
 */
export async function settleGameweeks(leagueId: string): Promise<SettleResult> {
  const config = await loadConfig(leagueId);
  if (!config) return { ok: false, done: true, settledThroughGw: 0, remainingEntrants: 0, error: "League configuration not found" };

  const active = await getActiveFplGameweek().catch(() => null);
  const lastConcludedGw = active?.lastConcludedGw ?? 0;

  if (config.settledThroughGw >= lastConcludedGw) {
    // Steady state — nothing new to settle. Not an error; this is the common case.
    return { ok: true, done: true, settledThroughGw: config.settledThroughGw, remainingEntrants: 0 };
  }

  const won = await claimClassicSettleLock(leagueId);
  if (!won) {
    return { ok: false, done: false, settledThroughGw: config.settledThroughGw, remainingEntrants: -1, error: "A settle sweep is already in progress for this league" };
  }

  // Clock starts once we hold the lock — everything before it is a couple of cheap queries.
  const settleStartedAt = Date.now();

  try {
    const allActive = await db
      .select()
      .from(fplClassicEntrants)
      .where(and(eq(fplClassicEntrants.leagueId, leagueId), eq(fplClassicEntrants.isActive, true)));
    if (allActive.length === 0) {
      return { ok: true, done: true, settledThroughGw: config.settledThroughGw, remainingEntrants: 0 };
    }

    // Which entrants already have a row for every settled+1..lastConcluded gameweek? Only those
    // still missing rows need a history fetch this pass.
    const existingRows = await db
      .select({ entrantId: fplClassicEntryGws.entrantId, gw: fplClassicEntryGws.gw })
      .from(fplClassicEntryGws)
      .where(inArray(fplClassicEntryGws.entrantId, allActive.map((e) => e.id)));
    const settledGwsByEntrant = new Map<string, Set<number>>();
    for (const r of existingRows) {
      const set = settledGwsByEntrant.get(r.entrantId) ?? new Set<number>();
      set.add(r.gw);
      settledGwsByEntrant.set(r.entrantId, set);
    }
    const neededGwsFor = (entrant: typeof allActive[number]) => {
      const have = settledGwsByEntrant.get(entrant.id) ?? new Set<number>();
      const from = Math.max(entrant.firstSeenGw, config.settledThroughGw + 1);
      const gws: number[] = [];
      for (let gw = from; gw <= lastConcludedGw; gw++) if (!have.has(gw)) gws.push(gw);
      return gws;
    };
    const pending = allActive.filter((e) => neededGwsFor(e).length > 0);

    if (pending.length === 0) {
      // Every active entrant already has every settled row up to lastConcludedGw — just the
      // cursor needs to catch up (e.g. after a roster change).
      const newCursor = computeCursor(allActive, settledGwsByEntrant, config.settledThroughGw, lastConcludedGw);
      await db.update(fplClassicConfig).set({ settledThroughGw: newCursor, lastSyncError: null, updatedAt: new Date() }).where(eq(fplClassicConfig.leagueId, leagueId));
      return { ok: true, done: true, settledThroughGw: newCursor, remainingEntrants: 0 };
    }

    const batch = pending.slice(0, ENTRANT_BATCH);
    const fplIds = batch.map((e) => String(e.fplEntryId));
    const cached = await getCachedEntryHistories(fplIds);

    const deadlines = await fetchGameweekDeadlines("background").catch(() => []);
    const monthKeyByGw = new Map(deadlines.map((d) => [d.gw, monthKeyFromDeadline(d.deadlineTime)]));

    const missingIds = fplIds.filter((id) => !cached.has(id));
    if (missingIds.length > 0) {
      await withFplBudget(
        { lane: "background", label: "fpl-classic settle", max: missingIds.length },
        () => mapWithConcurrency(missingIds, 4, async (fplId) => {
          // Past the deadline we stop fetching rather than risk the platform killing us. A kill is
          // strictly worse than a short pass: it skips the `finally` below, so the settle lock is
          // never released and every retry for the next SETTLE_LOCK_SECONDS silently no-ops.
          // Whoever we skip simply stays pending for the next call.
          if (Date.now() - settleStartedAt > SETTLE_DEADLINE_MS) return;
          try {
            const history = await fetchTeamHistory(fplId, "background");
            await setCachedEntryHistory(fplId, history, CACHE_TTL);
            cached.set(fplId, { ...history, cachedAt: new Date().toISOString() });
          } catch {
            // One unreadable manager must not fail the whole batch — they simply stay pending
            // for the next call, same as anyone this call never got to.
          }
        }),
      ).catch((err) => {
        if (!(err instanceof FplUnavailableError)) throw err;
        // Budget exhausted or breaker open — whatever landed in `cached` up to this point is
        // still used below; the rest stay pending for the next call.
      });
    }

    for (const entrant of batch) {
      const history = cached.get(String(entrant.fplEntryId));
      if (!history) continue;
      const needed = new Set(neededGwsFor(entrant));
      const rows = history.current
        .filter((c) => needed.has(c.event))
        .map((c) => ({
          id: generateId(),
          leagueId,
          entrantId: entrant.id,
          gw: c.event,
          points: c.points,
          transferCost: c.event_transfers_cost,
          netPoints: c.points - c.event_transfers_cost,
          totalPoints: c.total_points,
          overallRank: c.overall_rank,
          benchPoints: c.points_on_bench,
          chip: history.chips.find((chip) => chip.event === c.event)?.name ?? null,
          monthKey: monthKeyByGw.get(c.event) ?? monthKeyFromDeadline(new Date().toISOString()),
        }));
      if (rows.length > 0) {
        await db.insert(fplClassicEntryGws).values(rows).onConflictDoNothing();
        const set = settledGwsByEntrant.get(entrant.id) ?? new Set<number>();
        for (const r of rows) set.add(r.gw);
        settledGwsByEntrant.set(entrant.id, set);
      }
    }

    const newCursor = computeCursor(allActive, settledGwsByEntrant, config.settledThroughGw, lastConcludedGw);
    await db.update(fplClassicConfig).set({ settledThroughGw: newCursor, lastSyncError: null, updatedAt: new Date() }).where(eq(fplClassicConfig.leagueId, leagueId));

    const stillPending = allActive.filter((e) => neededGwsFor(e).length > 0 && !batch.includes(e)).length
      + batch.filter((e) => neededGwsFor(e).length > 0).length;

    return { ok: true, done: stillPending === 0 && newCursor >= lastConcludedGw, settledThroughGw: newCursor, remainingEntrants: stillPending };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(fplClassicConfig).set({ lastSyncError: message, updatedAt: new Date() }).where(eq(fplClassicConfig.leagueId, leagueId));
    return { ok: false, done: false, settledThroughGw: config.settledThroughGw, remainingEntrants: -1, error: message };
  } finally {
    await releaseClassicSettleLock(leagueId);
  }
}

/**
 * The highest gameweek every ACTIVE entrant now has a row for, never above lastConcludedGw, and
 * never below where the cursor already was. This is the one calculation that must never advance
 * on a partial sweep — see the module docblock.
 */
function computeCursor(
  entrants: { id: string; firstSeenGw: number }[],
  settledGwsByEntrant: Map<string, Set<number>>,
  previousCursor: number,
  lastConcludedGw: number,
): number {
  let cursor = lastConcludedGw;
  for (const entrant of entrants) {
    const have = settledGwsByEntrant.get(entrant.id) ?? new Set<number>();
    // An entrant is only required to have rows from their OWN firstSeenGw onward.
    for (let gw = Math.max(entrant.firstSeenGw, 1); gw <= lastConcludedGw; gw++) {
      if (!have.has(gw)) {
        cursor = Math.min(cursor, gw - 1);
        break;
      }
    }
  }
  return Math.max(previousCursor, Math.min(cursor, lastConcludedGw));
}

export interface FreezeResult {
  ok: boolean;
  frozen: string[];
  error?: string;
}

/**
 * Freeze every award scope that is fully settled and not yet frozen (or, with `force`, re-freeze
 * everything and log the previous winners). Pure computation over already-persisted rows — no
 * FPL calls, so this never needs a lock beyond the DB writes themselves.
 */
export async function freezeAwards(leagueId: string, opts?: { force?: boolean }): Promise<FreezeResult> {
  const config = await loadConfig(leagueId);
  if (!config) return { ok: false, frozen: [], error: "League configuration not found" };

  const entrants = await db.select().from(fplClassicEntrants).where(and(eq(fplClassicEntrants.leagueId, leagueId), eq(fplClassicEntrants.isActive, true)));
  const rows = config.settledThroughGw > 0
    ? await db.select().from(fplClassicEntryGws).where(and(eq(fplClassicEntryGws.leagueId, leagueId), inArray(fplClassicEntryGws.entrantId, entrants.map((e) => e.id))))
    : [];

  // Buckets built directly from each row's own FROZEN monthKey, not re-derived from a deadline —
  // buildMonthBuckets exists for the live standings read path, where deadlines are on hand and
  // the month has to be computed fresh; here the month was already decided at settle time and
  // must never move, so re-deriving it from "now" would risk disagreeing with what was frozen.
  const gwsByMonth = new Map<string, number[]>();
  for (const r of rows) {
    const list = gwsByMonth.get(r.monthKey) ?? [];
    if (!list.includes(r.gw)) list.push(r.gw);
    gwsByMonth.set(r.monthKey, list);
  }
  const monthBuckets = [...gwsByMonth.entries()].map(([key, gws]) => ({ key, label: key, gws: gws.sort((a, b) => a - b) }));

  const ctx: AwardContext = {
    entrants: entrants.map((e) => ({ id: e.id, playerName: e.playerName, entryName: e.entryName, firstSeenGw: e.firstSeenGw })),
    rows: rows.map((r) => ({ entrantId: r.entrantId, gw: r.gw, points: r.points, netPoints: r.netPoints, benchPoints: r.benchPoints, monthKey: r.monthKey })),
    months: monthBuckets,
    startGameweek: config.startGameweek,
    settledThroughGw: config.settledThroughGw,
    metric: config.scoringMetric as "net" | "gross",
    winnerCutPercent: config.winnerCutPercent,
  };

  const frozen: string[] = [];
  for (const { award, scopeKey } of allScopes(ctx)) {
    if (!isScopeReady(ctx, award, scopeKey)) continue;

    const existingRows = await db
      .select()
      .from(fplClassicAwards)
      .where(and(eq(fplClassicAwards.leagueId, leagueId), eq(fplClassicAwards.awardType, award.key), eq(fplClassicAwards.scopeKey, scopeKey)));

    if (existingRows.length > 0 && !opts?.force) continue; // already frozen, not forcing — leave it alone

    const result = award.compute(ctx, scopeKey);
    if (!result) continue;

    if (existingRows.length > 0 && opts?.force) {
      // Log what is about to be overwritten before touching it.
      await db.insert(auditLogs).values({
        id: generateId(),
        type: "FPL_CLASSIC_AWARD_RECOMPUTE",
        description: JSON.stringify({ leagueId, awardType: award.key, scopeKey, previousWinners: existingRows.map((r) => ({ entrantId: r.entrantId, position: r.position, value: r.value })) }),
        pointsAffected: 0,
      });
      await db.delete(fplClassicAwards).where(and(eq(fplClassicAwards.leagueId, leagueId), eq(fplClassicAwards.awardType, award.key), eq(fplClassicAwards.scopeKey, scopeKey)));
    }

    const recomputeCount = existingRows.length > 0 ? Math.max(...existingRows.map((r) => r.recomputeCount)) + 1 : 0;
    const newRows = result.winners.map((w) => ({
      id: generateId(),
      leagueId,
      awardType: award.key,
      scopeKey,
      position: w.position,
      entrantId: w.entrantId,
      value: w.value,
      isTied: w.isTied,
      detail: w.detail ? JSON.stringify(w.detail) : null,
      computedThroughGw: config.settledThroughGw,
      recomputeCount,
    }));
    if (newRows.length > 0) {
      await db.insert(fplClassicAwards).values(newRows).onConflictDoNothing();
      frozen.push(scopeKey);
    }
  }

  return { ok: true, frozen };
}
