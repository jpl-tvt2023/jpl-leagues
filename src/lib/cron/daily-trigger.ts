/**
 * Process concluded gameweeks once a day, without a cron.
 *
 * Scoring is triggered by hand from the superadmin Operations tab — `vercel.json` is `{}` and
 * nothing is scheduled — so the league table settles only when somebody remembers to press the
 * button. The live overlay closed the gap during a gameweek; this closes it after one.
 *
 * ## The claim is the schedule
 *
 * There is no timer. Ordinary traffic drives it: every request past 09:00 IST tries to claim
 * `daily-run:claim:{IST date}` with SET NX, and exactly one wins. The winner builds the work
 * queue; subsequent requests each take one item off it. No cron, no new service, nothing to
 * authenticate.
 *
 * The cost is honest and worth stating: it needs a visitor after 09:00 to fire at all. On a
 * dead-quiet morning the run happens at the first visit of the day rather than at nine. If that
 * ever matters, Vercel Hobby allows one cron per day and `advanceDailyRun` would serve it
 * unchanged.
 *
 * ## Why it is chunked
 *
 * Hobby caps a function at 60 seconds and one league-gameweek is ~64 FPL calls, so a whole-estate
 * run in a single invocation would time out partway and leave gameweeks half-scored. Each request
 * does one (league × gameweek) pair, which is exactly how the Operations tab already splits the
 * same work — `computePlan` → `processOneLeagueOneGw` → `finishRun`. Those are called directly
 * here, in-process: `processOneLeagueOneGw` reaches the scoring handler through
 * `callHandlerDirect`, which injects a superadmin session and makes no network call, so there is
 * no internal HTTP to be bounced by Deployment Protection and no credential to manage.
 *
 * ## It can never double-count, and never fights the admin
 *
 * - The gameweek processor skips fixtures that already have a result, and reconciles the group
 *   bonus across the whole gameweek rather than incrementing per pass.
 * - `isScoringActive()` makes this stand down while a manual run holds the lock, and this holds
 *   the same lock while a chunk is in flight.
 * - Only gameweeks FPL has CONCLUDED enter the plan, so it cannot score unfinished football.
 */

import { Redis } from "@upstash/redis";
import type { LeaguePlanItem, LeagueResult, LeagueGwResult } from "@/lib/cron/process-all";
import {
  emptyLeagueResult,
  foldLeagueGwResult,
  finalizeLeagueResult,
} from "@/lib/cron/league-result";
import { isScoringActive, markScoringActive, clearScoringActive } from "@/lib/fpl-cache";
import { istNow } from "@/lib/cron/ist-clock";

export { istNow };

/**
 * The scoring pipeline is imported lazily, at the point a run actually needs it.
 *
 * This module hangs off `after()` on ordinary page requests, and the overwhelming majority of
 * those decide within two Redis reads that there is nothing to do. Importing the whole scoring
 * pipeline — the gameweek processor, the playoff advancer, the auction scorer and the database
 * behind them — into that path would make every request pay for a run that almost never happens.
 *
 * It also keeps this module free of a database import, so the guard logic below can be exercised
 * by the unit lane against a store double.
 */
async function pipeline() {
  return import("@/lib/cron/process-all");
}

/** The hour, in IST, from which a day's run may start. */
const RUN_FROM_HOUR_IST = 9;

/** Day claim: long enough to cover the whole day, short enough to expire well before the next. */
const CLAIM_TTL_SECONDS = 25 * 60 * 60;
/** One chunk at a time. Comfortably longer than a league-gameweek, shorter than a stuck run. */
const CHUNK_LOCK_TTL_SECONDS = 120;

interface QueueItem {
  league: LeaguePlanItem;
  gw: number;
}

interface RunState {
  runId: string;
  dueGws: number[];
  globalErrors: string[];
  /** Per-league aggregates, keyed by league id, built up as chunks complete. */
  results: Record<string, LeagueResult>;
}

/**
 * The Redis surface this module uses. Narrow on purpose: it is the whole contract a test double
 * has to satisfy, and it keeps the orchestration honest about what it actually needs.
 */
export interface DailyRunStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  rpush(key: string, ...values: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lpop<T>(key: string): Promise<T | null>;
}

let redis: DailyRunStore | null = null;
function getRedis(): DailyRunStore | null {
  if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    }) as unknown as DailyRunStore;
  }
  return redis;
}

/** Test seam: run the orchestration against a double instead of a live Redis. */
export function __setDailyTriggerStore(store: DailyRunStore | null): void {
  redis = store;
}

const claimKey = (date: string) => `daily-run:claim:${date}`;
const queueKey = (date: string) => `daily-run:queue:${date}`;
const stateKey = (date: string) => `daily-run:state:${date}`;
const doneKey = (date: string) => `daily-run:done:${date}`;
const chunkKey = (date: string) => `daily-run:chunk:${date}`;

/**
 * Claim today's run and build its work queue, if nobody has yet and it is past 09:00 IST.
 *
 * Safe to call on every request: past the first success of the day it is one Redis SET that
 * fails, and before 09:00 it does nothing at all.
 */
export async function maybeStartDailyRun(now: Date = new Date()): Promise<boolean> {
  const r = getRedis();
  // Without Redis there is nothing to coordinate through, and an unguarded run on every request
  // would be far worse than no automation.
  if (!r) return false;

  const { date, hour } = istNow(now);
  if (hour < RUN_FROM_HOUR_IST) return false;

  const claimed = await r.set(claimKey(date), "1", { ex: CLAIM_TTL_SECONDS, nx: true });
  if (claimed === null) return false;

  try {
    const { computePlan } = await pipeline();
    const plan = await computePlan();
    const items: QueueItem[] = [];
    for (const league of plan.leagues) {
      for (const gw of plan.dueGws) items.push({ league, gw });
    }

    const state: RunState = {
      runId: plan.runId,
      dueGws: plan.dueGws,
      globalErrors: plan.globalErrors,
      results: {},
    };
    await r.set(stateKey(date), state, { ex: CLAIM_TTL_SECONDS });

    if (items.length === 0) {
      // Nothing due. Mark the day finished so no later request keeps checking an empty queue.
      await r.set(doneKey(date), "1", { ex: CLAIM_TTL_SECONDS });
      return true;
    }

    await r.rpush(queueKey(date), ...items.map((i) => JSON.stringify(i)));
    await r.expire(queueKey(date), CLAIM_TTL_SECONDS);
    return true;
  } catch (e) {
    // Leave the claim in place rather than retrying all day on a broken plan: a failed plan is
    // an operator problem, and hammering computePlan on every request would make it worse.
    console.error("[daily-run] plan failed", e);
    await r.set(doneKey(date), "1", { ex: CLAIM_TTL_SECONDS });
    return false;
  }
}

/**
 * Process at most one (league × gameweek) pair from today's queue, or finish the run.
 *
 * Returns what it did, which is mostly for tests and logs — callers fire and forget.
 */
export async function advanceDailyRun(
  baseUrl: string,
  now: Date = new Date(),
): Promise<"idle" | "processed" | "finished"> {
  const r = getRedis();
  if (!r) return "idle";

  const { date } = istNow(now);
  if ((await r.get(claimKey(date))) === null) return "idle";
  if ((await r.get(doneKey(date))) !== null) return "idle";

  // A manual run from Operations has the floor. Standing down here is what keeps the two from
  // interleaving writes into the same gameweek.
  if (await isScoringActive()) return "idle";

  const gotChunk = await r.set(chunkKey(date), "1", { ex: CHUNK_LOCK_TTL_SECONDS, nx: true });
  if (gotChunk === null) return "idle";

  try {
    const raw = await r.lpop<string>(queueKey(date));

    if (raw == null) {
      await finishDailyRun(r, date, baseUrl);
      return "finished";
    }

    const item = parseQueueItem(raw);
    if (!item) return "processed"; // Malformed entry: drop it and move on.

    const state = await r.get<RunState>(stateKey(date));
    if (!state) return "processed";

    // Hold the scoring lock for the chunk, so user-facing FPL calls stand down and the
    // Operations tab shows a run in progress.
    await markScoringActive();
    let outcome: { result?: LeagueGwResult | null; error?: string };
    try {
      const { processOneLeagueOneGw } = await pipeline();
      outcome = { result: await processOneLeagueOneGw(item.league, item.gw, { baseUrl }) };
    } catch (e) {
      outcome = { error: e instanceof Error ? e.message : "unknown error" };
    } finally {
      await clearScoringActive();
    }

    const agg = state.results[item.league.id] ?? emptyLeagueResult(item.league);
    foldLeagueGwResult(agg, item.gw, outcome);
    state.results[item.league.id] = agg;
    await r.set(stateKey(date), state, { ex: CLAIM_TTL_SECONDS });

    return "processed";
  } finally {
    await r.del(chunkKey(date));
  }
}

/** Write the audit row and warm what the run invalidated, then close the day out. */
async function finishDailyRun(r: DailyRunStore, date: string, baseUrl: string): Promise<void> {
  const state = await r.get<RunState>(stateKey(date));
  // Mark done first: finishRun is best-effort, and a failure there must not leave the queue
  // being polled for the rest of the day.
  await r.set(doneKey(date), "1", { ex: CLAIM_TTL_SECONDS });
  if (!state) return;

  const results = Object.values(state.results).map(finalizeLeagueResult);
  try {
    const { finishRun } = await pipeline();
    await finishRun(state.runId, state.dueGws, results, state.globalErrors, { baseUrl });
  } catch (e) {
    console.error("[daily-run] finish failed", e);
  }
}

function parseQueueItem(raw: string | QueueItem): QueueItem | null {
  try {
    // Upstash deserializes JSON payloads on the way out, so this may already be an object.
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as QueueItem) : raw;
    if (!parsed?.league?.id || typeof parsed.gw !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Test seam: forget the memoised client so a spec can point it at a different Redis. */
export function __resetDailyTriggerRedis(): void {
  redis = null;
}
