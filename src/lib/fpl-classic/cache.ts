/**
 * FPL Classic — Redis cache and single-flight locks for the live standings block.
 *
 * Own private Redis client (same pattern as fpl-live/players-left.ts and fpl/gw-calendar.ts) so
 * this feature needs zero edits to fpl-cache.ts. The `fplc:` prefix is disjoint from `fpl:`,
 * `live:`, `standings:`, `fixtures:`, `playoffs:`, `rl:` — `invalidateLeaguePageCache` can never
 * touch these keys, and nothing here can touch its.
 *
 * Only the live (current-gameweek) block is cached here. The gameweek and monthly leaderboards
 * read `fpl_classic_entry_gws`, which is immutable once written and already indexed — caching
 * them would add staleness for no gain.
 */

import { Redis } from "@upstash/redis";

let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

/** Fresh window while a gameweek is in flight. */
export const CLASSIC_LIVE_FRESH_SECONDS = 300; // 5 min
/** Fresh window once the gameweek has concluded — numbers no longer move. */
export const CLASSIC_SETTLED_FRESH_SECONDS = 6 * 3600;
/** Key retention. Freshness is judged from the payload's own cachedAt, so a lapsed entry
 *  degrades to "stale but serveable" instead of vanishing — same discipline as
 *  setLiveCachedScores/isLiveCacheFresh in fpl-cache.ts. */
const CLASSIC_RETENTION_SECONDS = 25 * 3600;

const SYNC_LOCK_SECONDS = 60;
/** The roster/settle sweep can run for tens of seconds; the lock must outlive one call. */
const ROSTER_LOCK_SECONDS = 300;
const SETTLE_LOCK_SECONDS = 300;

function liveKey(leagueId: string): string {
  return `fplc:live:v1:${leagueId}`;
}
function syncLockKey(leagueId: string): string {
  return `fplc:sync:lock:${leagueId}`;
}
function rosterLockKey(leagueId: string): string {
  return `fplc:roster:lock:${leagueId}`;
}
function settleLockKey(leagueId: string): string {
  return `fplc:settle:lock:${leagueId}`;
}

/** Generic single-flight claim: true if the caller won and must do the work + release. */
async function claimLock(key: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true; // No Redis configured — nothing to coalesce against.
  const result = await r.set(key, "1", { nx: true, ex: ttlSeconds });
  return result === "OK";
}
async function releaseLock(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(key);
}

export interface ClassicLivePayload {
  gw: number;
  isLive: boolean;
  rows: { fplEntryId: number; entryName: string; playerName: string; total: number; eventTotal: number; rank: number; lastRank: number }[];
  lastUpdatedFpl: string | null;
  cachedAt: string;
}

export async function getCachedClassicLive(leagueId: string): Promise<ClassicLivePayload | null> {
  const r = getRedis();
  if (!r) return null;
  return (await r.get<ClassicLivePayload>(liveKey(leagueId))) ?? null;
}

export async function setCachedClassicLive(leagueId: string, data: ClassicLivePayload): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(liveKey(leagueId), data, { ex: CLASSIC_RETENTION_SECONDS });
}

/** True when `data.cachedAt` is within the fresh window for its live/settled state. */
export function isClassicLiveFresh(data: ClassicLivePayload): boolean {
  const ageSeconds = (Date.now() - new Date(data.cachedAt).getTime()) / 1000;
  const freshFor = data.isLive ? CLASSIC_LIVE_FRESH_SECONDS : CLASSIC_SETTLED_FRESH_SECONDS;
  return ageSeconds < freshFor;
}

/**
 * Single-flight claim for refreshing the live block. Returns true if THIS caller won the lock
 * (and must refresh + release), false if someone else already holds it (caller should serve
 * whatever is cached, stale or not).
 */
export async function claimClassicSyncLock(leagueId: string): Promise<boolean> {
  return claimLock(syncLockKey(leagueId), SYNC_LOCK_SECONDS);
}
export async function releaseClassicSyncLock(leagueId: string): Promise<void> {
  return releaseLock(syncLockKey(leagueId));
}

/**
 * Single-flight for the roster refresh (~4 FPL calls). Superadmin-triggered only — see
 * lib/fpl-classic/sync.ts — but still locked so two concurrent "Process" clicks don't double up.
 */
export async function claimClassicRosterLock(leagueId: string): Promise<boolean> {
  return claimLock(rosterLockKey(leagueId), ROSTER_LOCK_SECONDS);
}
export async function releaseClassicRosterLock(leagueId: string): Promise<void> {
  return releaseLock(rosterLockKey(leagueId));
}

/**
 * Single-flight for the settle sweep — the expensive, per-entrant path. This is the lock that
 * matters most: without it, two superadmins (or one superadmin's browser retrying a slow
 * response) could run two overlapping 250-entrant sweeps against the same league.
 */
export async function claimClassicSettleLock(leagueId: string): Promise<boolean> {
  return claimLock(settleLockKey(leagueId), SETTLE_LOCK_SECONDS);
}
export async function releaseClassicSettleLock(leagueId: string): Promise<void> {
  return releaseLock(settleLockKey(leagueId));
}

export function isFplClassicCacheEnabled(): boolean {
  return getRedis() !== null;
}
