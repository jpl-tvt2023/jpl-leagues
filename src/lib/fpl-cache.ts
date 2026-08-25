// FPL API Cache
// Caches FPL data in Upstash Redis to avoid hitting rate limits

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

/**
 * Whether a cache backend is actually configured.
 *
 * Every helper here degrades silently to a no-op without Redis, which is the
 * right default — but a caller that *warms* a cache in batches needs to know,
 * because without somewhere to write to, warming can never make progress and
 * asking the caller to "try again" would loop forever.
 */
export function isFplCacheEnabled(): boolean {
  return getRedis() !== null;
}

export const CACHE_TTL = 60 * 60 * 24; // 24 hours
/** How long a live payload is considered FRESH. */
export const LIVE_CACHE_TTL = 60 * 10; // 10 minutes
/**
 * How long it is RETAINED after that.
 *
 * Past LIVE_CACHE_TTL the numbers are stale but still worth showing: a whole
 * gameweek costs ~65 FPL calls, which the gateway's rate cap stretches to about
 * ten seconds, and with a hard 10-minute expiry the first visitor after each
 * lapse paid that in full while the page sat there. Keeping the last copy for an
 * hour means it can be served instantly and refreshed behind the reader.
 */
export const LIVE_CACHE_STALE_TTL = 60 * 60; // 1 hour
const PAGE_CACHE_TTL = 60 * 60 * 25; // 25 hours (slightly longer than daily cron interval)

interface CachedScore {
  points: number;
  transferHits: number;
  netScore: number;
  cachedAt: string;
}

/**
 * Get Redis key for a team's gameweek score (league-namespaced)
 */
function getKey(fplId: string, gameweek: number, leagueId?: string | null): string {
  return `fpl:${leagueId ?? "global"}:gw${gameweek}:${fplId}`;
}

/**
 * Get cached score for a team in a gameweek
 */
export async function getCachedScore(
  fplId: string,
  gameweek: number,
  leagueId?: string | null
): Promise<CachedScore | null> {
  const r = getRedis();
  if (!r) return null;
  const data = await r.get<CachedScore>(getKey(fplId, gameweek, leagueId));
  return data || null;
}

/**
 * Set cached score for a team in a gameweek
 */
export async function setCachedScore(
  fplId: string,
  gameweek: number,
  score: { points: number; transferHits: number; netScore: number },
  leagueId?: string | null
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const value: CachedScore = {
    ...score,
    cachedAt: new Date().toISOString(),
  };
  await r.set(getKey(fplId, gameweek, leagueId), value, { ex: CACHE_TTL });
}

/**
 * Check if all scores for a gameweek are cached
 */
export async function isGameweekFullyCached(
  fplIds: string[],
  gameweek: number,
  leagueId?: string | null
): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  if (fplIds.length === 0) return true;
  const keys = fplIds.map((id) => getKey(id, gameweek, leagueId));
  const pipeline = r.pipeline();
  for (const key of keys) {
    pipeline.exists(key);
  }
  const results = await pipeline.exec<number[]>();
  return results.every((exists) => exists === 1);
}

/**
 * Get all cached scores for a gameweek (league-scoped)
 * Returns object with keys like "fplId_gwN"
 */
export async function getAllCachedScores(
  gameweek: number,
  leagueId?: string | null
): Promise<Record<string, CachedScore>> {
  const r = getRedis();
  if (!r) return {};
  const prefix = `fpl:${leagueId ?? "global"}:gw${gameweek}:`;
  const result: Record<string, CachedScore> = {};

  let cursor = "0";
  do {
    const res = await r.scan(cursor, { match: `${prefix}*`, count: 100 });
    cursor = res[0];
    const keys = res[1];

    if (keys.length > 0) {
      const pipeline = r.pipeline();
      for (const key of keys) {
        pipeline.get(key);
      }
      const values = await pipeline.exec<(CachedScore | null)[]>();
      for (let i = 0; i < keys.length; i++) {
        if (values[i]) {
          const fplId = keys[i].slice(prefix.length);
          result[`${fplId}_gw${gameweek}`] = values[i]!;
        }
      }
    }
  } while (cursor !== "0");

  return result;
}

/**
 * Clear cache for a specific gameweek (league-scoped)
 */
export async function clearGameweekCache(gameweek: number, leagueId?: string | null): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const prefix = `fpl:${leagueId ?? "global"}:gw${gameweek}:`;
  let cursor = "0";
  do {
    const res = await r.scan(cursor, { match: `${prefix}*`, count: 100 });
    cursor = res[0];
    const keys = res[1];
    if (keys.length > 0) {
      const pipeline = r.pipeline();
      for (const key of keys) {
        pipeline.del(key);
      }
      await pipeline.exec();
    }
  } while (cursor !== "0");
}

/**
 * Clear cache for specific FPL IDs in a gameweek (league-scoped)
 */
export async function clearGameweekCacheForIds(gameweek: number, fplIds: string[], leagueId?: string | null): Promise<void> {
  const r = getRedis();
  if (!r || fplIds.length === 0) return;
  const keys = fplIds.map((id) => getKey(id, gameweek, leagueId));
  const pipeline = r.pipeline();
  for (const key of keys) pipeline.del(key);
  await pipeline.exec();
}

/**
 * Get cache stats scoped to specific FPL IDs (league-scoped)
 */
export async function getCacheStatsForIds(
  fplIds: string[],
  leagueId?: string | null
): Promise<{ gameweek: number; entries: number }[]> {
  const r = getRedis();
  if (!r || fplIds.length === 0) return [];
  const stats: { gameweek: number; entries: number }[] = [];

  for (let gw = 1; gw <= 38; gw++) {
    const keys = fplIds.map((id) => getKey(id, gw, leagueId));
    const pipeline = r.pipeline();
    for (const key of keys) pipeline.exists(key);
    const results = await pipeline.exec<number[]>();
    const count = results.filter((v) => v === 1).length;
    if (count > 0) stats.push({ gameweek: gw, entries: count });
  }

  return stats;
}

/**
 * Get all cached scores for specific FPL IDs in a gameweek (league-scoped)
 */
export async function getAllCachedScoresForIds(
  gameweek: number,
  fplIds: string[],
  leagueId?: string | null
): Promise<Record<string, CachedScore>> {
  const r = getRedis();
  if (!r || fplIds.length === 0) return {};
  const keys = fplIds.map((id) => getKey(id, gameweek, leagueId));
  const pipeline = r.pipeline();
  for (const key of keys) pipeline.get(key);
  const values = await pipeline.exec<(CachedScore | null)[]>();
  const result: Record<string, CachedScore> = {};
  for (let i = 0; i < keys.length; i++) {
    if (values[i]) {
      result[`${fplIds[i]}_gw${gameweek}`] = values[i]!;
    }
  }
  return result;
}

/**
 * Get cache stats (league-scoped)
 */
export async function getCacheStats(leagueId?: string | null): Promise<{ gameweek: number; entries: number }[]> {
  const r = getRedis();
  if (!r) return [];
  const stats: { gameweek: number; entries: number }[] = [];

  for (let gw = 1; gw <= 38; gw++) {
    const prefix = `fpl:${leagueId ?? "global"}:gw${gw}:`;
    let count = 0;
    let cursor = "0";
    do {
      const res = await r.scan(cursor, { match: `${prefix}*`, count: 100 });
      cursor = res[0];
      count += res[1].length;
    } while (cursor !== "0");

    if (count > 0) {
      stats.push({ gameweek: gw, entries: count });
    }
  }

  return stats;
}

// ============================================
// JPL Auction: Element-Level Cache (individual PL player points)
// ============================================

/**
 * Cache key for all PL player element points in a gameweek.
 * One API call to /event/{gw}/live/ returns all ~700 players.
 * We cache the entire Map<elementId, points> as a single JSON object.
 */
function getElementPointsKey(gameweek: number): string {
  return `fpl:elements:gw${gameweek}`;
}

export async function getCachedElementPoints(gameweek: number): Promise<Record<number, number> | null> {
  const r = getRedis();
  if (!r) return null;
  const data = await r.get<Record<number, number>>(getElementPointsKey(gameweek));
  return data || null;
}

/**
 * `ttlSeconds` defaults to the 24h CACHE_TTL so existing callers are unchanged. Callers that know
 * the gameweek is still in progress pass LIVE_CACHE_TTL instead — a finished GW's points never
 * move, an in-flight GW's change every few minutes.
 */
export async function setCachedElementPoints(
  gameweek: number,
  data: Record<number, number>,
  ttlSeconds: number = CACHE_TTL
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(getElementPointsKey(gameweek), data, { ex: ttlSeconds });
}

export async function clearCachedElementPoints(gameweek: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(getElementPointsKey(gameweek));
}

/**
 * Cache key for FPL bootstrap data (player metadata: name, team, position, status, cost).
 * Updated once per day by FPL.
 */
function getBootstrapKey(): string {
  return "fpl:bootstrap:latest";
}

export interface CachedElementInfo {
  id: number;
  web_name: string;
  team: number;
  element_type: number; // 1=GKP, 2=DEF, 3=MID, 4=FWD
  now_cost: number;
  total_points: number;
  status: string; // "a"=available, "i"=injured, "s"=suspended, "u"=unavailable
  minutes: number; // total minutes played this season
}

export async function getCachedBootstrap(): Promise<CachedElementInfo[] | null> {
  const r = getRedis();
  if (!r) return null;
  const data = await r.get<CachedElementInfo[]>(getBootstrapKey());
  return data || null;
}

export async function setCachedBootstrap(data: CachedElementInfo[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(getBootstrapKey(), data, { ex: CACHE_TTL });
}

/**
 * FPL event (gameweek) status — drives how long we may cache a GW's element points.
 *
 * Kept under its own short-lived key rather than folded into `fpl:bootstrap:latest`: that entry
 * is typed `CachedElementInfo[]` and reshaping it would need a key-version bump plus churn across
 * its callers. It also needs a much shorter TTL than the 24h bootstrap — the `finished` /
 * `data_checked` flags flip mid-weekend and a day-stale copy would keep a finished GW on the
 * short TTL far longer than necessary.
 */
export interface FplEventStatus {
  id: number;
  finished: boolean;
  data_checked: boolean;
}

function getEventStatusKey(): string {
  return "fpl:events:latest";
}

export async function getCachedEventStatus(): Promise<FplEventStatus[] | null> {
  const r = getRedis();
  if (!r) return null;
  const data = await r.get<FplEventStatus[]>(getEventStatusKey());
  return data || null;
}

export async function setCachedEventStatus(data: FplEventStatus[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(getEventStatusKey(), data, { ex: LIVE_CACHE_TTL });
}

// ============================================
// FPL /event-status/ Cache (60-second TTL)
// The purpose-built endpoint: ~1KB against bootstrap-static's ~800KB, and it is
// not fronted by the same long-lived Cloudflare cache, so `bonus_added` flips
// here minutes before `events[].finished` moves in the bootstrap payload.
//
// 60s rather than the 10 minutes above: this is the signal that decides whether
// a gameweek has concluded (and therefore whether auto-processing may run and
// which GW is "current"). A ten-minute-stale answer to that question is exactly
// the problem this cache tier exists to remove.
// ============================================

const EVENT_STATUS_TTL = 60; // 60 seconds

/** One row of FPL's /event-status/ `status` array. */
export interface FplEventStatusRow {
  event: number;
  bonus_added: boolean;
  /** "r" = raw, "p" = provisional, "c" = confirmed. */
  points: string;
  date: string;
}

export interface FplEventStatusPayload {
  status: FplEventStatusRow[];
  /** "Updated" once FPL has finished recalculating league tables for the GW. */
  leagues: string;
}

function getLiveEventStatusKey(): string {
  return "fpl:event-status:latest";
}

export async function getCachedLiveEventStatus(): Promise<FplEventStatusPayload | null> {
  const r = getRedis();
  if (!r) return null;
  const data = await r.get<FplEventStatusPayload>(getLiveEventStatusKey());
  return data || null;
}

export async function setCachedLiveEventStatus(data: FplEventStatusPayload): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(getLiveEventStatusKey(), data, { ex: EVENT_STATUS_TTL });
}

// ============================================
// Deadline Sync Gate (30-minute TTL)
// FPL gameweek deadlines almost never change once published, but the
// dashboard route used to re-fetch bootstrap-static and rewrite every
// gameweek's deadline on every single request. This gate lets at most one
// request per league claim the sync every 30 minutes; everyone else skips
// it entirely.
// ============================================

const DEADLINE_SYNC_TTL = 60 * 30; // 30 minutes

function getDeadlineSyncKey(leagueId: string): string {
  return `fpl:deadline-sync:${leagueId}`;
}

/**
 * Atomically claims the right to sync FPL deadlines for a league.
 * Returns true only if no other request has claimed it in the last 30
 * minutes (i.e. this call should proceed with the sync); false otherwise.
 * If Redis isn't configured, falls back to true (today's always-sync
 * behavior) rather than silently disabling the sync.
 */
export async function shouldSyncDeadlines(leagueId: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  const claimed = await r.set(getDeadlineSyncKey(leagueId), "1", { ex: DEADLINE_SYNC_TTL, nx: true });
  return claimed !== null;
}

// ============================================
// Entry History Cache
// /entry/{id}/history/ returns a manager's whole season in one call: per-GW
// points, the official season total, and every chip they have played. One key
// per entry, so a 32-team TVT league is 64 keys.
// ============================================

export interface CachedEntryHistory {
  current: {
    event: number;
    points: number;
    total_points: number;
    rank: number | null;
    overall_rank: number | null;
    event_transfers: number;
    event_transfers_cost: number;
    points_on_bench: number;
    value: number;
    bank: number;
  }[];
  past: { season_name: string; total_points: number; rank: number }[];
  chips: { name: string; time: string; event: number }[];
  cachedAt: string;
}

function getEntryHistoryKey(fplId: string): string {
  return `fpl:history:${fplId}`;
}

export async function getCachedEntryHistory(fplId: string): Promise<CachedEntryHistory | null> {
  const r = getRedis();
  if (!r) return null;
  return (await r.get<CachedEntryHistory>(getEntryHistoryKey(fplId))) ?? null;
}

export async function setCachedEntryHistory(
  fplId: string,
  data: Omit<CachedEntryHistory, "cachedAt">,
  ttlSeconds: number
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(
    getEntryHistoryKey(fplId),
    { ...data, cachedAt: new Date().toISOString() },
    { ex: ttlSeconds }
  );
}

/** Bulk read, so a page can serve whatever is already warm without N round trips. */
export async function getCachedEntryHistories(
  fplIds: string[]
): Promise<Map<string, CachedEntryHistory>> {
  const out = new Map<string, CachedEntryHistory>();
  const r = getRedis();
  if (!r || fplIds.length === 0) return out;
  const values = await r.mget<(CachedEntryHistory | null)[]>(
    ...fplIds.map(getEntryHistoryKey)
  );
  fplIds.forEach((id, i) => {
    const v = values?.[i];
    if (v) out.set(id, v);
  });
  return out;
}

// ============================================
// FPL League Page Single-Flight
// The page warms a few stale entries per request. Without a gate, concurrent
// visitors each warm their own batch and multiply the outbound calls.
// ============================================

/**
 * How long one warm claim blocks the next.
 *
 * This is a DEDUPE window, not a rate limit: it exists so that visitors
 * arriving at the same moment do not each warm their own batch. It only needs
 * to outlast a single batch (12 entries at concurrency 4).
 *
 * It must stay well under the page's poll interval budget, because a cold
 * league only converges by warming repeatedly: 64 managers at WARM_BATCH=12
 * is 6 rounds, and at the previous 30s every one of those rounds cost half a
 * minute -- three minutes to fill a table, far longer than anyone waits. The
 * page polls every 4s, so 10s lets roughly every third poll make progress.
 */
const FPL_LEAGUE_WARM_TTL = 10; // seconds

export async function claimFplLeagueWarm(leagueId: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  const claimed = await r.set(`fpl-league:warm:${leagueId}`, "1", {
    ex: FPL_LEAGUE_WARM_TTL,
    nx: true,
  });
  return claimed !== null;
}

// ============================================
// Refresh Single-Flight
// The forced-refresh route recomputes an entire gameweek from FPL. Without a
// gate, N members clicking Refresh at kickoff means N full sweeps. One caller
// computes; everyone else inside the window serves the cached result.
// ============================================

const REFRESH_LOCK_TTL = 120; // seconds — outlives a slow sweep
const REFRESH_RESULT_TTL = 60;

function getRefreshLockKey(gameweek: number, leagueId?: string | null): string {
  return `live:refresh:lock:gw${gameweek}:${leagueId ?? "all"}`;
}

/**
 * Claim the right to perform a forced refresh. Returns true only for the
 * caller that wins the race; losers should serve cached data instead.
 * Falls back to true when Redis is absent (local dev / tests) so the route
 * still works, just without the stampede guard.
 */
export async function claimRefreshSlot(
  gameweek: number,
  leagueId?: string | null
): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  const claimed = await r.set(getRefreshLockKey(gameweek, leagueId), "1", {
    ex: REFRESH_LOCK_TTL,
    nx: true,
  });
  return claimed !== null;
}

/** Release the refresh claim early once the sweep finishes. */
export async function releaseRefreshSlot(
  gameweek: number,
  leagueId?: string | null
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  // Keep a short cooldown rather than deleting outright, so a burst of clicks
  // right after a sweep still coalesces onto the fresh cached result.
  await r.set(getRefreshLockKey(gameweek, leagueId), "1", { ex: REFRESH_RESULT_TTL });
}

// ============================================
// Scoring Lock
// While the scoring pipeline (processAllLeagues) is running, every
// user-facing FPL call is refused by the gateway so the run gets the whole
// budget. Scoring failures write wrong league tables; a user-facing page
// showing stale numbers for two minutes does not.
// ============================================

const SCORING_LOCK_KEY = "fpl:scoring-active";
/** Long enough to outlive a slow batch, short enough to self-heal on crash. */
const SCORING_LOCK_TTL = 120; // seconds

/** Mark a scoring run as in progress. Safe to call repeatedly to extend. */
export async function markScoringActive(): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(SCORING_LOCK_KEY, "1", { ex: SCORING_LOCK_TTL });
}

/** Clear the scoring lock. Call in a finally block. */
export async function clearScoringActive(): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(SCORING_LOCK_KEY);
}

/**
 * True while a scoring run holds the lock. Returns false when Redis is absent
 * (local dev / tests) so the gateway does not refuse everything by default.
 */
export async function isScoringActive(): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  return (await r.get(SCORING_LOCK_KEY)) !== null;
}

// ============================================
// Live Score Cache (10-minute TTL)
// ============================================

export interface LiveFixtureScore {
  fixtureId: string;
  gameweek: number;          // Track which GW this score is from
  homeTeamName: string;
  awayTeamName: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homePlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
  awayPlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
  // Fixtures still to play across the side's active XI (both managers combined).
  // Optional on purpose: payloads already sitting in Redis under the previous
  // shape keep deserialising and render "—" instead of crashing, so no cache
  // key bump or invalidation is needed. null means FPL was unreachable.
  homePlayersLeft?: { leftToPlay: number; total: number } | null;
  awayPlayersLeft?: { leftToPlay: number; total: number } | null;
}

export interface LiveGameweekData {
  gameweek: number;
  fixtures: LiveFixtureScore[];
  cachedAt: string;
}

function getLiveKey(gameweek: number, leagueId?: string | null): string {
  return `live:gw${gameweek}:${leagueId ?? "all"}`;
}

/** Whether a cached live payload is still within its fresh window. */
export function isLiveCacheFresh(data: { cachedAt?: string } | null | undefined): boolean {
  if (!data?.cachedAt) return false;
  const age = Date.now() - new Date(data.cachedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < LIVE_CACHE_TTL * 1000;
}

/**
 * Get cached live scores for a gameweek, fresh or stale.
 *
 * Callers decide what to do with an entry older than LIVE_CACHE_TTL — see
 * isLiveCacheFresh.
 */
export async function getLiveCachedScores(
  gameweek: number,
  leagueId?: string | null
): Promise<LiveGameweekData | null> {
  const r = getRedis();
  if (!r) return null;
  const data = await r.get<LiveGameweekData>(getLiveKey(gameweek, leagueId));
  return data || null;
}

/**
 * Set cached live scores for a gameweek.
 *
 * Stored for LIVE_CACHE_STALE_TTL; freshness is judged from `cachedAt` in the
 * payload rather than by the key expiring, so a lapsed entry degrades to
 * "stale but serveable" instead of vanishing.
 */
export async function setLiveCachedScores(
  gameweek: number,
  data: LiveGameweekData,
  leagueId?: string | null
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(getLiveKey(gameweek, leagueId), data, { ex: LIVE_CACHE_STALE_TTL });
}

/**
 * Clear live cache for a specific gameweek
 */
export async function clearLiveCache(gameweek: number, leagueId?: string | null): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.del(getLiveKey(gameweek, leagueId));
}

// ============================================
// Page Data Cache (25-hour TTL, league-scoped by leagueId UUID)
// Written by: cron (pre-warm) and API routes (on cache miss)
// Invalidated by: any admin write that affects displayed data
// ============================================

// Bump when the standings response shape or values change so the next deploy invalidates the cache
// automatically (old `standings:` entries become orphaned and expire on TTL).
const STANDINGS_CACHE_VERSION = 2;
const standingsKey = (leagueId: string) => `standings:v${STANDINGS_CACHE_VERSION}:${leagueId}`;

export async function getCachedStandings(leagueId: string): Promise<unknown | null> {
  const r = getRedis();
  if (!r) return null;
  return await r.get(standingsKey(leagueId));
}

export async function setCachedStandings(leagueId: string, data: unknown): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(standingsKey(leagueId), data, { ex: PAGE_CACHE_TTL });
}

export async function getCachedFixtures(leagueId: string): Promise<unknown | null> {
  const r = getRedis();
  if (!r) return null;
  return await r.get(`fixtures:${leagueId}`);
}

export async function setCachedFixtures(leagueId: string, data: unknown): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(`fixtures:${leagueId}`, data, { ex: PAGE_CACHE_TTL });
}

export async function getCachedPlayoffBracket(leagueId: string): Promise<unknown | null> {
  const r = getRedis();
  if (!r) return null;
  return await r.get(`playoffs:${leagueId}`);
}

export async function setCachedPlayoffBracket(leagueId: string, data: unknown): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(`playoffs:${leagueId}`, data, { ex: PAGE_CACHE_TTL });
}

/**
 * Delete standings, fixtures, and playoffs cache keys for a league.
 * Call this after any admin write that changes displayed data.
 * The next page request will fall back to DB and repopulate the cache.
 */
export async function invalidateLeaguePageCache(leagueId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  // Must match the versioned key getCachedStandings/setCachedStandings actually use — an earlier,
  // unversioned `standings:{leagueId}` here silently deleted a key nothing reads or writes, leaving
  // every caller's invalidation a no-op for the standings cache.
  await r.del(standingsKey(leagueId), `fixtures:${leagueId}`, `playoffs:${leagueId}`);
}
