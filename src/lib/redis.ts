/**
 * The one Upstash client, and what the app does when Upstash stops answering.
 *
 * Every cache module used to build its own client and call it bare. That held until the free
 * tier's monthly command quota ran out (Oct 2026): from then on every command threw, and because
 * most reads sat outside any try, the fixtures page rendered empty and the live routes returned
 * 500 — while every number they needed was in the database or one FPL call away.
 *
 * ## Three states
 *
 * - **Absent** — no Upstash env (local dev, the default e2e suite). Every helper behaves exactly
 *   as the old `if (!r)` branches did: reads miss, writes no-op, claims succeed.
 * - **Up** — commands go to Upstash as before.
 * - **Down** — a read or claim failed. For BREAKER_OPEN_MS this instance sends no commands at all
 *   (a refused quota does not recover in seconds, and every failing call still costs a round
 *   trip), then tries again. Reads miss, writes are dropped, claims fall back to an in-process
 *   lock so single-flight still holds within the instance.
 *
 * Writes never trip the breaker. A write can fail for reasons that say nothing about reads — an
 * oversized value is refused while everything else works — and tripping on it would take the
 * whole cache offline for a minute every time that one value was refreshed.
 *
 * ## The in-process L1
 *
 * Two jobs, both per instance:
 *
 * 1. Read-through for the few global FPL keys that nearly every request reads (`fpl:fixtures:all`,
 *    bootstrap, event status…). Reusing one copy for a few seconds turns a GET per request into a
 *    GET per window. Opt-in per call via `l1Seconds`.
 * 2. Last-good while Down. A value this instance wrote is kept for exactly its Redis TTL, so an
 *    outage serves what Redis itself would have served, never something older. Without it an
 *    outage becomes an FPL stampede: every live poll misses and re-sweeps the whole gameweek.
 *
 * Off when Redis is absent (nothing to fall back from) and under TEST_FPL_STUB, whose specs change
 * the simulated FPL world between requests and sweep Redis to match — a per-process copy would
 * keep serving the old world. Same flag, same reason, as the guard in cron/daily-tick.ts.
 *
 * ## What deliberately bypasses all of this
 *
 * Invalidations use `getRawRedis()` and still throw. They exist to stop stale data being served,
 * and quietly skipping one during an outage would leave a 25h page blob wrong after recovery.
 *
 * Scoring fails CLOSED. Pages may read through an outage; nothing may write league results
 * through one (see `redisWritable`, and `markScoringActive` / `getAllCachedScores` in
 * fpl-cache.ts, which keep throwing).
 */

import { Redis } from "@upstash/redis";

let client: Redis | null = null;

/** The configured client, breaker or not. Null only when Upstash is not configured. */
export function getRawRedis(): Redis | null {
  if (!client && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return client;
}

// ============================================
// Breaker
// ============================================

export const BREAKER_OPEN_MS = 60_000;
let openUntil = 0;

/** True while a recent failure has this instance treating Redis as unavailable. */
export function isRedisDown(): boolean {
  return Date.now() < openUntil;
}

/** Open (or hold open) the breaker. Logs once per trip, not once per failed call. */
export function noteRedisFailure(label: string, e: unknown): void {
  const alreadyOpen = isRedisDown();
  openUntil = Date.now() + BREAKER_OPEN_MS;
  if (!alreadyOpen) {
    console.warn(
      `[redis] unavailable (${label}); serving without the cache for ${BREAKER_OPEN_MS / 1000}s:`,
      e instanceof Error ? e.message : e
    );
  }
}

/** The client for ordinary cache traffic: null when Upstash is absent OR down. */
export function getRedis(): Redis | null {
  return isRedisDown() ? null : getRawRedis();
}

/** Run a read; any failure trips the breaker and yields `fallback`, exactly like a miss. */
export async function redisRead<T>(
  label: string,
  fallback: T,
  read: (r: Redis) => Promise<T>
): Promise<T> {
  const r = getRedis();
  if (!r) return fallback;
  try {
    return await read(r);
  } catch (e) {
    noteRedisFailure(label, e);
    return fallback;
  }
}

/**
 * Run a cache WRITE, swallowing any backend failure.
 *
 * A write-through cache must never fail the read that populated it. These writes land straight
 * after an expensive FPL fetch that has already succeeded, so letting Upstash throw discards good
 * data and takes the caller down with it — `fetchElementGameweekStats` writes two keys straight
 * after fetching `/event/{gw}/live/`, and an exception there propagated out through
 * `buildManagerPointsContext` and blanked live scores for an entire league.
 */
export async function safeRedisWrite(
  label: string,
  write: (r: Redis) => Promise<unknown>
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await write(r);
  } catch (e) {
    console.warn(`[redis] write failed for ${label}`, e);
  }
}

/**
 * Whether a writer that must invalidate caches afterwards may start: true when Redis is absent
 * (nothing to invalidate) or answers a PING right now, false when it is configured but refusing.
 *
 * For scoring. Reads fail open, writes of results must fail CLOSED: a scoring run commits rows
 * and then invalidates the page blobs built from them, and doing the first without the second
 * leaves a half-processed gameweek plus pre-outage pages that would be served after recovery.
 * Checked with the raw client so a breaker opened by an earlier blip never blocks a run on its
 * own say-so.
 */
export async function redisWritable(): Promise<boolean> {
  const r = getRawRedis();
  if (!r) return true;
  try {
    await r.ping();
    return true;
  } catch (e) {
    noteRedisFailure("ping", e);
    return false;
  }
}

// ============================================
// L1 (per-instance)
// ============================================

interface L1Entry {
  value: unknown;
  /** Served instead of asking Redis until this instant (read-through). */
  freshUntil: number;
  /** Served as last-good while Redis is down until this instant. */
  keepUntil: number;
}

const l1 = new Map<string, L1Entry>();
/** Bounds memory: the hot keys plus a league's worth of picks and histories fit comfortably. */
const L1_MAX_ENTRIES = 300;

export interface L1Options {
  /** Read-through window. Omit for keys that must always be read from Redis while it answers. */
  l1Seconds?: number;
  /** Keep this instance's own write as a fallback for while Redis is down, for its full TTL. */
  lastGood?: boolean;
}

function l1Enabled(): boolean {
  return getRawRedis() !== null && process.env.TEST_FPL_STUB !== "1";
}

function l1Store(key: string, entry: L1Entry): void {
  l1.delete(key); // re-insert so Map order tracks recency
  l1.set(key, entry);
  while (l1.size > L1_MAX_ENTRIES) {
    const oldest = l1.keys().next().value;
    if (oldest === undefined) break;
    l1.delete(oldest);
  }
}

function l1Fresh<T>(key: string): T | undefined {
  if (!l1Enabled()) return undefined;
  const e = l1.get(key);
  return e && e.freshUntil > Date.now() ? (e.value as T) : undefined;
}

function l1LastGood<T>(key: string): T | null {
  if (!l1Enabled()) return null;
  const e = l1.get(key);
  if (!e) return null;
  if (e.keepUntil <= Date.now()) {
    l1.delete(key);
    return null;
  }
  return e.value as T;
}

/**
 * Record what Redis just answered for `key`.
 *
 * While Redis answers it is the truth: a miss drops any copy held here, so a key deleted
 * elsewhere is never resurrected from this instance during a later outage. A newer value
 * replaces ours but keeps our expiry — it was written after ours, so its real TTL ends later,
 * and holding it no longer than our own copy can only err towards forgetting.
 */
function l1Observe(key: string, value: unknown, l1Seconds = 0): void {
  if (!l1Enabled()) return;
  if (value == null) {
    l1.delete(key);
    return;
  }
  const existing = l1.get(key);
  if (!l1Seconds && !existing) return; // not a key this instance keeps
  const now = Date.now();
  l1Store(key, {
    value,
    freshUntil: now + l1Seconds * 1000,
    keepUntil: Math.max(existing?.keepUntil ?? 0, now + l1Seconds * 1000),
  });
}

/** Drop keys from this instance's L1 — for invalidations, which must not leave a copy behind. */
export function forgetL1(...keys: string[]): void {
  for (const k of keys) l1.delete(k);
}

/** GET one key through the L1. Null on a miss, when absent, or when down with nothing kept. */
export async function cachedGet<T>(key: string, opts: L1Options = {}): Promise<T | null> {
  if (!getRawRedis()) return null;
  const hit = l1Fresh<T>(key);
  if (hit !== undefined) return hit;
  const r = getRedis();
  if (!r) return l1LastGood<T>(key);
  try {
    const value = await r.get<T>(key);
    l1Observe(key, value, opts.l1Seconds);
    return value ?? null;
  } catch (e) {
    noteRedisFailure(key, e);
    return l1LastGood<T>(key);
  }
}

/** MGET through the L1, per key. Always returns an array aligned with `keys`. */
export async function cachedMget<T>(keys: string[], opts: L1Options = {}): Promise<(T | null)[]> {
  const out: (T | null)[] = keys.map(() => null);
  if (!getRawRedis() || keys.length === 0) return out;

  const missing: number[] = [];
  keys.forEach((k, i) => {
    const hit = l1Fresh<T>(k);
    if (hit !== undefined) out[i] = hit;
    else missing.push(i);
  });
  if (missing.length === 0) return out;

  const lastGood = () => {
    for (const i of missing) out[i] = l1LastGood<T>(keys[i]);
  };
  const r = getRedis();
  if (!r) {
    lastGood();
    return out;
  }
  try {
    const values = await r.mget<(T | null)[]>(...missing.map((i) => keys[i]));
    missing.forEach((i, j) => {
      const v = values?.[j] ?? null;
      out[i] = v;
      l1Observe(keys[i], v, opts.l1Seconds);
    });
  } catch (e) {
    noteRedisFailure(`mget ${keys.length} keys`, e);
    lastGood();
  }
  return out;
}

/** SET one key with a TTL, never throwing, keeping an L1 copy when asked. */
export async function cachedSet(
  key: string,
  value: unknown,
  exSeconds: number,
  opts: L1Options = {}
): Promise<void> {
  if (!getRawRedis()) return;
  if (l1Enabled() && value != null && (opts.l1Seconds || opts.lastGood)) {
    const now = Date.now();
    l1Store(key, {
      value,
      freshUntil: now + Math.min(opts.l1Seconds ?? 0, exSeconds) * 1000,
      keepUntil: now + exSeconds * 1000,
    });
  }
  await safeRedisWrite(key, (r) => r.set(key, value, { ex: exSeconds }));
}

// ============================================
// Claims
// ============================================

/** key → held until (ms). Only consulted while Redis is down. */
const localClaims = new Map<string, number>();

function localClaim(key: string, ttlSeconds: number): boolean {
  const now = Date.now();
  if ((localClaims.get(key) ?? 0) > now) return false;
  if (localClaims.size > 200) {
    for (const [k, until] of localClaims) if (until <= now) localClaims.delete(k);
  }
  localClaims.set(key, now + ttlSeconds * 1000);
  return true;
}

/**
 * A single-flight claim.
 *
 * Absent: true, as every claim helper always returned without Redis. Down: an in-process claim
 * with the same TTL — it no longer coordinates across instances, but one instance still cannot
 * stampede itself, which is the difference between a handful of duplicate FPL sweeps and one per
 * request.
 */
export async function redisClaim(
  key: string,
  ttlSeconds: number,
  claim: (r: Redis) => Promise<boolean>
): Promise<boolean> {
  if (!getRawRedis()) return true;
  const r = getRedis();
  if (!r) return localClaim(key, ttlSeconds);
  try {
    return await claim(r);
  } catch (e) {
    noteRedisFailure(key, e);
    return localClaim(key, ttlSeconds);
  }
}

/**
 * Release a claim, optionally leaving a cooldown behind. Never throws: every claim carries its
 * own TTL, so a release that fails only means the lock lapses on its own — whereas throwing from
 * the `finally` it runs in turned a sweep that had already succeeded into a 500.
 */
export async function redisRelease(
  key: string,
  release: (r: Redis) => Promise<unknown>,
  cooldownSeconds = 0
): Promise<void> {
  if (cooldownSeconds > 0) localClaims.set(key, Date.now() + cooldownSeconds * 1000);
  else localClaims.delete(key);
  const r = getRedis();
  if (!r) return;
  try {
    await release(r);
  } catch (e) {
    console.warn(`[redis] release failed for ${key}`, e);
  }
}

/** Test seam: swap the client (or a double for it) and forget every piece of instance state. */
export function __resetRedisForTests(fake: unknown = null): void {
  client = fake as Redis | null;
  openUntil = 0;
  l1.clear();
  localClaims.clear();
}
