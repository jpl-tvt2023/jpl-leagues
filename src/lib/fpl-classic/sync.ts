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
import { eq, and, inArray, lte, asc, sql } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getActiveFplGameweek, entryHistoryTtl } from "@/lib/fpl/event-status";
import { fetchClassicLeagueStandings } from "@/lib/fpl/classic-league";
import { fetchTeamHistory } from "@/lib/fpl";
import { fetchGameweekDeadlines } from "@/lib/fpl/gw-calendar";
import { getCachedEntryHistories, setCachedEntryHistory } from "@/lib/fpl-cache";
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

/**
 * Rows per INSERT statement. One statement per chunk rather than per entrant: a 50-entrant batch
 * used to cost 50 sequential libSQL round-trips just to write. ~13 bound columns per row keeps a
 * chunk far under SQLite's variable cap.
 */
const ROW_CHUNK = 50;

async function loadConfig(leagueId: string) {
  const [config] = await db.select().from(fplClassicConfig).where(eq(fplClassicConfig.leagueId, leagueId)).limit(1);
  return config ?? null;
}

/** The slice of an FPL entry history a settled row is built from — satisfied by both a fresh fetch and a cached copy. */
interface HistoryLike {
  current: { event: number; points: number; total_points: number; overall_rank: number | null; event_transfers_cost: number; points_on_bench: number }[];
  chips: { name: string; event: number }[];
}

/**
 * One settled row from one gameweek of an entrant's FPL history. Shared by the sweep and the
 * single-gameweek refresh so the two can never map a column differently.
 */
function toEntryGwRow(
  leagueId: string,
  entrantId: string,
  c: HistoryLike["current"][number],
  history: HistoryLike,
  monthKeyByGw: Map<number, string>,
): typeof fplClassicEntryGws.$inferInsert {
  return {
    id: generateId(),
    leagueId,
    entrantId,
    gw: c.event,
    points: c.points,
    transferCost: c.event_transfers_cost,
    netPoints: c.points - c.event_transfers_cost,
    totalPoints: c.total_points,
    overallRank: c.overall_rank,
    benchPoints: c.points_on_bench,
    chip: history.chips.find((chip) => chip.event === c.event)?.name ?? null,
    monthKey: monthKeyByGw.get(c.event) ?? monthKeyFromDeadline(new Date().toISOString()),
  };
}

async function loadMonthKeyByGw(): Promise<Map<number, string>> {
  const deadlines = await fetchGameweekDeadlines("background").catch(() => []);
  return new Map(deadlines.map((d) => [d.gw, monthKeyFromDeadline(d.deadlineTime)]));
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

    const monthKeyByGw = await loadMonthKeyByGw();

    const missingIds = fplIds.filter((id) => !cached.has(id));
    if (missingIds.length > 0) {
      // Shared key: a 24h write here also pins the live gameweek's points for the
      // TVT FPL League table and the PL fixture card, which read the same entries.
      const historyTtl = await entryHistoryTtl("background");
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
            await setCachedEntryHistory(fplId, history, historyTtl);
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

    const newRows: (typeof fplClassicEntryGws.$inferInsert)[] = [];
    for (const entrant of batch) {
      const history = cached.get(String(entrant.fplEntryId));
      if (!history) continue;
      const needed = new Set(neededGwsFor(entrant));
      const rows = history.current
        .filter((c) => needed.has(c.event))
        .map((c) => toEntryGwRow(leagueId, entrant.id, c, history, monthKeyByGw));
      if (rows.length === 0) continue;
      newRows.push(...rows);
      const set = settledGwsByEntrant.get(entrant.id) ?? new Set<number>();
      for (const r of rows) set.add(r.gw);
      settledGwsByEntrant.set(entrant.id, set);
    }
    // If a chunk throws, the catch below returns before the cursor moves, so the in-memory sets
    // being ahead of the DB here cannot advance it past rows that were never written.
    for (let i = 0; i < newRows.length; i += ROW_CHUNK) {
      await db.insert(fplClassicEntryGws).values(newRows.slice(i, i + ROW_CHUNK)).onConflictDoNothing();
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

export interface RefreshResult {
  ok: boolean;
  done: boolean;
  gw: number;
  /** Entrants this gameweek applies to: active, and in the league by `gw`. */
  total: number;
  /** Where the next call resumes. Reaches `total` on the final pass. */
  nextOffset: number;
  /** Rows written (inserted or overwritten) by this call. */
  refreshed: number;
  /** Of those, how many differ from what was stored — 0 means FPL had nothing new. */
  changed: number;
  /** Entrants FPL would not return a history for. Their stored row, if any, is left as it was. */
  failed: number;
  settledThroughGw: number;
  /** The request itself is wrong (gameweek out of range) — retrying will not help. The route maps it to 400. */
  invalid?: boolean;
  error?: string;
}

/**
 * Re-fetch ONE gameweek for every entrant it applies to and overwrite the stored rows — the
 * Operations tab's "Process GWn". The sweep above can only fill gaps (`onConflictDoNothing`), so
 * without this an FPL correction to a settled gameweek could never reach the boards.
 *
 * Paged by `offset` over a stable entrant order rather than by "who is missing", because when
 * overwriting, every entrant already has a row and presence says nothing about progress. Bounded
 * the same way as the sweep: ENTRANT_BATCH entrants and the SETTLE_DEADLINE_MS admission check.
 *
 * Always fetches fresh — a cached history is exactly the stale data a refresh exists to replace —
 * and writes the result back to the shared cache. Never touches frozen awards; the caller decides
 * whether to recompute them.
 */
export async function refreshGameweek(leagueId: string, gw: number, opts?: { offset?: number }): Promise<RefreshResult> {
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const empty = { gw, total: 0, nextOffset: offset, refreshed: 0, changed: 0, failed: 0 };

  const config = await loadConfig(leagueId);
  if (!config) return { ...empty, ok: false, done: true, settledThroughGw: 0, invalid: true, error: "League configuration not found" };

  const active = await getActiveFplGameweek().catch(() => null);
  const lastConcludedGw = active?.lastConcludedGw ?? 0;
  if (!Number.isInteger(gw) || gw < config.startGameweek || gw > lastConcludedGw) {
    return {
      ...empty, ok: false, done: true, settledThroughGw: config.settledThroughGw, invalid: true,
      error: lastConcludedGw < config.startGameweek
        ? "No gameweek has concluded yet for this league"
        : `Gameweek must be between GW${config.startGameweek} and GW${lastConcludedGw}`,
    };
  }

  // The same lock as the sweep: both write rows and move the cursor, so they must never overlap.
  const won = await claimClassicSettleLock(leagueId);
  if (!won) {
    return { ...empty, ok: false, done: false, settledThroughGw: config.settledThroughGw, error: "A settle sweep is already in progress for this league" };
  }

  const startedAt = Date.now();

  try {
    const eligible = await db
      .select()
      .from(fplClassicEntrants)
      .where(and(eq(fplClassicEntrants.leagueId, leagueId), eq(fplClassicEntrants.isActive, true), lte(fplClassicEntrants.firstSeenGw, gw)))
      .orderBy(asc(fplClassicEntrants.fplEntryId));
    const batch = eligible.slice(offset, offset + ENTRANT_BATCH);

    const monthKeyByGw = await loadMonthKeyByGw();
    const historyTtl = await entryHistoryTtl("background");

    // "skipped" = never fetched (past the deadline, or the gateway refused). Only a skip stops the
    // offset; a per-entrant failure is reported and passed over, or one bad entry would wedge the run.
    const outcomes: ("ok" | "failed" | "skipped")[] = batch.map(() => "skipped");
    const histories = new Map<string, HistoryLike>();
    const refusal = { reason: null as string | null };

    if (batch.length > 0) {
      await withFplBudget(
        { lane: "background", label: "fpl-classic refresh gw", max: batch.length },
        () => mapWithConcurrency(batch, 4, async (entrant, i) => {
          if (refusal.reason || Date.now() - startedAt > SETTLE_DEADLINE_MS) return;
          try {
            const history = await fetchTeamHistory(String(entrant.fplEntryId), "background");
            histories.set(entrant.id, history);
            outcomes[i] = "ok";
            await setCachedEntryHistory(String(entrant.fplEntryId), history, historyTtl);
          } catch (err) {
            if (err instanceof FplUnavailableError) refusal.reason = err.message;
            else outcomes[i] = "failed";
          }
        }),
      );
    }

    // Admission is in index order, so skips form a tail — except a gateway refusal, which can land
    // mid-batch while earlier calls are still in flight. Advance only past the leading run of
    // finished entrants; anything after the first skip is re-fetched next pass, which is harmless.
    let finished = 0;
    while (finished < outcomes.length && outcomes[finished] !== "skipped") finished++;
    if (batch.length > 0 && finished === 0) {
      return {
        ...empty, total: eligible.length, ok: false, done: false, settledThroughGw: config.settledThroughGw,
        error: refusal.reason ? `FPL unavailable: ${refusal.reason}` : "FPL did not answer before the deadline",
      };
    }

    const fresh: (typeof fplClassicEntryGws.$inferInsert)[] = [];
    let failed = 0;
    for (let i = 0; i < finished; i++) {
      if (outcomes[i] === "failed") { failed++; continue; }
      const history = histories.get(batch[i].id);
      // No row for this gameweek means the FPL team did not exist yet — nothing to write.
      const c = history?.current.find((row) => row.event === gw);
      if (history && c) fresh.push(toEntryGwRow(leagueId, batch[i].id, c, history, monthKeyByGw));
    }

    const stored = fresh.length > 0
      ? await db
        .select()
        .from(fplClassicEntryGws)
        .where(and(eq(fplClassicEntryGws.gw, gw), inArray(fplClassicEntryGws.entrantId, fresh.map((r) => r.entrantId))))
      : [];
    const storedByEntrant = new Map(stored.map((r) => [r.entrantId, r]));
    const changed = fresh.filter((r) => {
      const s = storedByEntrant.get(r.entrantId);
      return !s
        || s.points !== r.points || s.transferCost !== r.transferCost || s.netPoints !== r.netPoints
        || s.totalPoints !== r.totalPoints || s.overallRank !== (r.overallRank ?? null)
        || s.benchPoints !== r.benchPoints || s.chip !== (r.chip ?? null);
    }).length;

    for (let i = 0; i < fresh.length; i += ROW_CHUNK) {
      await db.insert(fplClassicEntryGws).values(fresh.slice(i, i + ROW_CHUNK)).onConflictDoUpdate({
        target: [fplClassicEntryGws.entrantId, fplClassicEntryGws.gw],
        // monthKey deliberately absent: a settled row keeps the month it was frozen with (see the
        // schema). Only a row this call inserts takes the freshly derived one.
        set: {
          points: sql`excluded.points`,
          transferCost: sql`excluded.transfer_cost`,
          netPoints: sql`excluded.net_points`,
          totalPoints: sql`excluded.total_points`,
          overallRank: sql`excluded.overall_rank`,
          benchPoints: sql`excluded.bench_points`,
          chip: sql`excluded.chip`,
        },
      });
    }

    const nextOffset = offset + finished;
    const done = nextOffset >= eligible.length;

    let settledThroughGw = config.settledThroughGw;
    if (done) {
      // Refreshing a pending gameweek may have filled the gap right after the cursor. computeCursor
      // only ever advances it, and only to a gameweek every active entrant has a row for.
      const allActive = await db
        .select({ id: fplClassicEntrants.id, firstSeenGw: fplClassicEntrants.firstSeenGw })
        .from(fplClassicEntrants)
        .where(and(eq(fplClassicEntrants.leagueId, leagueId), eq(fplClassicEntrants.isActive, true)));
      const rows = await db
        .select({ entrantId: fplClassicEntryGws.entrantId, gw: fplClassicEntryGws.gw })
        .from(fplClassicEntryGws)
        .where(eq(fplClassicEntryGws.leagueId, leagueId));
      const gwsByEntrant = new Map<string, Set<number>>();
      for (const r of rows) {
        const set = gwsByEntrant.get(r.entrantId) ?? new Set<number>();
        set.add(r.gw);
        gwsByEntrant.set(r.entrantId, set);
      }
      settledThroughGw = computeCursor(allActive, gwsByEntrant, config.settledThroughGw, lastConcludedGw);
      await db.update(fplClassicConfig).set({ settledThroughGw, lastSyncError: null, updatedAt: new Date() }).where(eq(fplClassicConfig.leagueId, leagueId));
    }

    return { ok: true, done, gw, total: eligible.length, nextOffset, refreshed: fresh.length, changed, failed, settledThroughGw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(fplClassicConfig).set({ lastSyncError: message, updatedAt: new Date() }).where(eq(fplClassicConfig.leagueId, leagueId));
    return { ...empty, ok: false, done: false, settledThroughGw: config.settledThroughGw, error: message };
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
