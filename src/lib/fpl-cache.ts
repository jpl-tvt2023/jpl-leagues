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

interface CachedScore {
  points: number;
  transferHits: number;
  netScore: number;
  cachedAt: string;
}

/**
 * Get Redis key for a team's gameweek score
 */
function getKey(fplId: string, gameweek: number): string {
  return `fpl:gw${gameweek}:${fplId}`;
}

/**
 * Get cached score for a team in a gameweek
 */
export async function getCachedScore(
  fplId: string,
  gameweek: number
): Promise<CachedScore | null> {
  const r = getRedis();
  if (!r) return null;
  const data = await r.get<CachedScore>(getKey(fplId, gameweek));
  return data || null;
}

/**
 * Set cached score for a team in a gameweek
 */
export async function setCachedScore(
  fplId: string,
  gameweek: number,
  score: { points: number; transferHits: number; netScore: number }
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const value: CachedScore = {
    ...score,
    cachedAt: new Date().toISOString(),
  };
  await r.set(getKey(fplId, gameweek), value, { ex: CACHE_TTL });
}

/**
 * Check if all scores for a gameweek are cached
 */
export async function isGameweekFullyCached(
  fplIds: string[],
  gameweek: number
): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  if (fplIds.length === 0) return true;
  const keys = fplIds.map((id) => getKey(id, gameweek));
  const pipeline = r.pipeline();
  for (const key of keys) {
    pipeline.exists(key);
  }
  const results = await pipeline.exec<number[]>();
  return results.every((exists) => exists === 1);
}

/**
 * Get all cached scores for a gameweek
 * Returns object with keys like "fplId_gwN" for backwards compatibility
 */
export async function getAllCachedScores(
  gameweek: number
): Promise<Record<string, CachedScore>> {
  const r = getRedis();
  if (!r) return {};
  const prefix = `fpl:gw${gameweek}:`;
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
 * Clear cache for a specific gameweek (for re-fetching)
 */
export async function clearGameweekCache(gameweek: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const prefix = `fpl:gw${gameweek}:`;
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
 * Get cache stats
 */
export async function getCacheStats(): Promise<{ gameweek: number; entries: number }[]> {
  const r = getRedis();
  if (!r) return [];
  const stats: { gameweek: number; entries: number }[] = [];

  for (let gw = 1; gw <= 38; gw++) {
    const prefix = `fpl:gw${gw}:`;
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
// Live Score Cache (10-minute TTL)
// ============================================

export interface LiveFixtureScore {
  fixtureId: string;
  gameweek: number;          // Track which GW this score is from
  homeTeamName: string;
  awayTeamName: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  homeScore: number;
  awayScore: number;
  homePlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
  awayPlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
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
