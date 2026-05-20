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

const CACHE_TTL = 60 * 60 * 24; // 24 hours
const LIVE_CACHE_TTL = 60 * 10; // 10 minutes
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

export async function setCachedElementPoints(gameweek: number, data: Record<number, number>): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(getElementPointsKey(gameweek), data, { ex: CACHE_TTL });
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
}

export interface LiveGameweekData {
  gameweek: number;
  fixtures: LiveFixtureScore[];
  cachedAt: string;
}

function getLiveKey(gameweek: number, leagueId?: string | null): string {
  return `live:gw${gameweek}:${leagueId ?? "all"}`;
}

/**
 * Get cached live scores for a gameweek
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
 * Set cached live scores for a gameweek (10-min TTL)
 */
export async function setLiveCachedScores(
  gameweek: number,
  data: LiveGameweekData,
  leagueId?: string | null
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(getLiveKey(gameweek, leagueId), data, { ex: LIVE_CACHE_TTL });
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
  await r.del(`standings:${leagueId}`, `fixtures:${leagueId}`, `playoffs:${leagueId}`);
}
