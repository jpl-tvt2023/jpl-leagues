// FPL API Cache
// Caches FPL data in Upstash Redis to avoid hitting rate limits
//
// Reads fail soft: a Redis error is a cache miss, never an exception (see redis.ts). Lock/claim
// helpers go through redisClaim, so an outage degrades them to an in-process lock rather than to
// a fake "claimed". What still throws, on purpose, uses the raw client: invalidations (silently
// skipping one is how stale data gets served) and the scoring-only paths — markScoringActive and
// getAllCachedScores — because scoring must fail closed, not score against a missing cache.
// invalidateLeaguePageCache is the exception: it runs after a write has already committed, so a
// refused sweep is recorded for repair rather than thrown (see repairStalePageCaches).

// Type-only: fpl.ts imports this module at runtime, so a value import here would close a cycle.
import type { FPLGameweekPicks } from "./fpl";
import type { FplSeasonChip } from "./fpl-league/chips";
import {
  getRawRedis,
  getRedis,
  redisRead,
  safeRedisWrite,
  cachedGet,
  cachedMget,
  cachedSet,
  redisClaim,
  redisRelease,
  forgetL1,
  noteRedisFailure,
} from "./redis";

/**
 * Whether a cache backend is configured AND answering.
 *
 * Every helper here degrades silently to a no-op without Redis, which is the
 * right default — but a caller that *warms* a cache in batches needs to know,
 * because without somewhere to write to, warming can never make progress and
 * asking the caller to "try again" would loop forever. A Redis that is down
 * counts as no Redis for exactly that reason.
 */
export function isFplCacheEnabled(): boolean {
  return getRedis() !== null;
}

/**
 * Per-instance read-through windows (redis.ts) for the global FPL keys nearly every request
 * reads. Each is far shorter than the key's own TTL, so the extra staleness is noise next to
 * what the key already allows.
 */
const L1_EVENT_STATUS_SECONDS = 15;
const L1_EVENTS_SECONDS = 60;
const L1_BOOTSTRAP_SECONDS = 300;
const L1_CLUBS_SECONDS = 300;
const L1_SEASON_CHIPS_SECONDS = 3600;
const L1_ENTRY_HISTORY_SECONDS = 60;

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
/**
 * TTL for per-element live stats during an in-flight gameweek.
 *
 * Deliberately shorter than LIVE_CACHE_TTL. These stats are an INPUT to the live fixture
 * scores, which are themselves cached for ten minutes, so matching the two would compound
 * to a twenty-minute worst case and leave the Refresh button recomputing new totals from
 * old element points — indistinguishable, to a user, from Refresh doing nothing.
 *
 * 60s is what `fpl:fixtures:all` already uses to drive the same screens. The cost is one
 * ~460KB fetch a minute shared by every reader, not one per reader.
 */
export const ELEMENT_STATS_LIVE_TTL = 60; // 1 minute
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
  const key = getKey(fplId, gameweek, leagueId);
  return redisRead(key, null, async (r) => (await r.get<CachedScore>(key)) || null);
}

/**
 * Set cached score for a team in a gameweek
 */
/**
 * `ttlSeconds` defaults to 24h for the settled case. A caller scoring a gameweek that is
 * still in flight MUST pass LIVE_CACHE_TTL instead: this key holds a running score, and
 * pinning one for a day freezes that manager past the point FPL settles the week.
 */
export async function setCachedScore(
  fplId: string,
  gameweek: number,
  score: { points: number; transferHits: number; netScore: number },
  leagueId?: string | null,
  ttlSeconds: number = CACHE_TTL
): Promise<void> {
  const value: CachedScore = {
    ...score,
    cachedAt: new Date().toISOString(),
  };
  const key = getKey(fplId, gameweek, leagueId);
  await safeRedisWrite(key, (r) => r.set(key, value, { ex: ttlSeconds }));
}

/**
 * Check if all scores for a gameweek are cached
 */
export async function isGameweekFullyCached(
  fplIds: string[],
  gameweek: number,
  leagueId?: string | null
): Promise<boolean> {
  if (fplIds.length === 0) return getRedis() !== null;
  // One EXISTS over every key counts the ones present — one command, not one per manager.
  const keys = fplIds.map((id) => getKey(id, gameweek, leagueId));
  return redisRead(`exists gw${gameweek}`, false, async (r) => (await r.exists(...keys)) === keys.length);
}

/**
 * Get all cached scores for a gameweek (league-scoped)
 * Returns object with keys like "fplId_gwN"
 *
 * ⚠️ A full-keyspace SCAN: one command per 100 keys in the WHOLE database, plus a GET per match.
 * Fine for a scoring run; ruinous on a request path. League standings used to call this once per
 * processed gameweek on every recompute and were the single largest Redis consumer — they now
 * read the same hits from the stored results instead (standings/league-stage.ts).
 *
 * Unlike the reads around it, this one still THROWS when Redis is refusing. Its callers are the
 * scoring processors' carry-forward deductions, and an empty answer there is not a miss: it
 * scores every carried-forward hit as zero and writes that into the league table.
 */
export async function getAllCachedScores(
  gameweek: number,
  leagueId?: string | null
): Promise<Record<string, CachedScore>> {
  const r = getRawRedis();
  if (!r) return {};
  const prefix = `fpl:${leagueId ?? "global"}:gw${gameweek}:`;
  const result: Record<string, CachedScore> = {};
  let cursor = "0";
  do {
    const res = await r.scan(cursor, { match: `${prefix}*`, count: 100 });
    cursor = res[0];
    const keys = res[1];

    if (keys.length > 0) {
      const values = await r.mget<(CachedScore | null)[]>(...keys);
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
  const r = getRawRedis();
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
  const r = getRawRedis();
  if (!r || fplIds.length === 0) return;
  const keys = fplIds.map((id) => getKey(id, gameweek, leagueId));
  await r.del(...keys);
}

/**
 * Get cache stats scoped to specific FPL IDs (league-scoped)
 *
 * One multi-key EXISTS per gameweek (it returns how many of the keys exist), so a 64-manager
 * league costs 38 commands rather than 38 × 64.
 */
export async function getCacheStatsForIds(
  fplIds: string[],
  leagueId?: string | null
): Promise<{ gameweek: number; entries: number }[]> {
  if (fplIds.length === 0) return [];
  return redisRead("cache stats", [], async (r) => {
    const stats: { gameweek: number; entries: number }[] = [];
    for (let gw = 1; gw <= 38; gw++) {
      const count = await r.exists(...fplIds.map((id) => getKey(id, gw, leagueId)));
      if (count > 0) stats.push({ gameweek: gw, entries: count });
    }
    return stats;
  });
}

/**
 * Get all cached scores for specific FPL IDs in a gameweek (league-scoped)
 *
 * One MGET, not a pipeline of GETs — Upstash bills every command inside a pipeline.
 */
export async function getAllCachedScoresForIds(
  gameweek: number,
  fplIds: string[],
  leagueId?: string | null
): Promise<Record<string, CachedScore>> {
  if (fplIds.length === 0) return {};
  const keys = fplIds.map((id) => getKey(id, gameweek, leagueId));
  return redisRead(`mget gw${gameweek} scores`, {}, async (r) => {
    const values = await r.mget<(CachedScore | null)[]>(...keys);
    const result: Record<string, CachedScore> = {};
    for (let i = 0; i < keys.length; i++) {
      if (values[i]) {
        result[`${fplIds[i]}_gw${gameweek}`] = values[i]!;
      }
    }
    return result;
  });
}

/**
 * Get cache stats (league-scoped)
 */
export async function getCacheStats(leagueId?: string | null): Promise<{ gameweek: number; entries: number }[]> {
  return redisRead("cache stats scan", [], async (r) => {
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
  });
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
  return (await cachedGet<Record<number, number>>(getElementPointsKey(gameweek))) || null;
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
  await cachedSet(getElementPointsKey(gameweek), data, ttlSeconds, { lastGood: true });
}

export async function clearCachedElementPoints(gameweek: number): Promise<void> {
  forgetL1(getElementPointsKey(gameweek), getElementStatsKey(gameweek));
  const r = getRawRedis();
  if (!r) return;
  await r.del(getElementPointsKey(gameweek));
  await r.del(getElementStatsKey(gameweek));
}

/** One PL player's live figures for a gameweek — the subset the live scorer needs. */
export interface CachedElementStat {
  points: number;
  minutes: number;
}

/**
 * Cache key for per-element live stats (points AND minutes) in a gameweek.
 *
 * Deliberately a separate key from `fpl:elements:gw{N}` above rather than widening that
 * one in place: a deploy would otherwise hand an in-flight `Record<number, number>`
 * payload to a reader expecting objects, and every element would silently read as
 * `undefined` — the same shape of failure this whole change exists to remove.
 *
 * `minutes` is what the vice-captain handover gate needs and points alone cannot supply.
 * A captain on 0 points has not necessarily blanked: a substitute who appears and is
 * booked scores exactly 0.
 */
function getElementStatsKey(gameweek: number): string {
  return `fpl:elements:stats:gw${gameweek}`;
}

export async function getCachedElementStats(
  gameweek: number
): Promise<Record<number, CachedElementStat> | null> {
  return (await cachedGet<Record<number, CachedElementStat>>(getElementStatsKey(gameweek))) || null;
}

/**
 * Same TTL contract as `setCachedElementPoints`: a concluded gameweek's stats never move
 * and keep the 24h default, an in-flight one is passed LIVE_CACHE_TTL by the caller.
 */
export async function setCachedElementStats(
  gameweek: number,
  data: Record<number, CachedElementStat>,
  ttlSeconds: number = CACHE_TTL
): Promise<void> {
  await cachedSet(getElementStatsKey(gameweek), data, ttlSeconds, { lastGood: true });
}

/**
 * One PL player's gameweek, in enough detail to explain the points — what the Match Center's
 * per-player breakdown renders.
 *
 * Compact on purpose: one key holds every element that featured, and it is re-read on every
 * Match Center request. `b` is FPL's `explain` summed per scoring identifier across the player's
 * fixtures (a double gameweek folds into one line per identifier):
 * `[identifier, value, points]`, e.g. `["goals_scored", 1, 4]`.
 *
 * Elements that neither played nor scored are omitted entirely; a reader treats absence as
 * 0 points and 0 minutes.
 */
export interface CachedElementDetail {
  p: number;
  m: number;
  b: [string, number, number][];
}

/**
 * Its own key rather than a wider `fpl:elements:stats` payload, for the reason that key gives
 * for not widening `fpl:elements:gw{N}`: a deploy must never hand a reader a shape it does not
 * expect. Written from the same `/event/{gw}/live/` response as the other two, so it costs no
 * extra FPL call.
 */
function getElementDetailKey(gameweek: number): string {
  return `fpl:elements:detail:gw${gameweek}`;
}

export async function getCachedElementDetail(
  gameweek: number
): Promise<Record<number, CachedElementDetail> | null> {
  return (await cachedGet<Record<number, CachedElementDetail>>(getElementDetailKey(gameweek))) || null;
}

/**
 * The newest detail map for a gameweek, kept for a day whatever the fresh key's TTL.
 *
 * The fresh key above lives 60s while a gameweek is in flight, and its reader treats presence
 * as freshness — so the moment FPL starts refusing us it is gone, and the Match Center had
 * nothing to draw. Picks, bootstrap and clubs all outlive an outage; this was the one input
 * that did not. A separate key, so that reader's "present means fresh" contract is untouched.
 */
function getLastGoodElementDetailKey(gameweek: number): string {
  return `fpl:elements:detail:last:gw${gameweek}`;
}

export interface LastGoodElementDetail {
  data: Record<number, CachedElementDetail>;
  /** When the `/event/{gw}/live/` response it came from was fetched. */
  cachedAt: string;
}

export async function getLastGoodElementDetail(gameweek: number): Promise<LastGoodElementDetail | null> {
  const entry = await cachedGet<LastGoodElementDetail>(getLastGoodElementDetailKey(gameweek));
  return entry?.data ? entry : null;
}

export async function setCachedElementDetail(
  gameweek: number,
  data: Record<number, CachedElementDetail>,
  ttlSeconds: number = CACHE_TTL
): Promise<void> {
  const lastGood: LastGoodElementDetail = { data, cachedAt: new Date().toISOString() };
  await Promise.all([
    cachedSet(getElementDetailKey(gameweek), data, ttlSeconds, { lastGood: true }),
    cachedSet(getLastGoodElementDetailKey(gameweek), lastGood, Math.max(ttlSeconds, CACHE_TTL), {
      lastGood: true,
    }),
  ]);
}

/** Drop the fresh detail key, and the last-good copy too when asked. */
export async function clearCachedElementDetail(
  gameweek: number,
  opts: { lastGood?: boolean } = {}
): Promise<void> {
  forgetL1(getElementDetailKey(gameweek));
  if (opts.lastGood) forgetL1(getLastGoodElementDetailKey(gameweek));
  const r = getRawRedis();
  if (!r) return;
  await r.del(getElementDetailKey(gameweek));
  if (opts.lastGood) await r.del(getLastGoodElementDetailKey(gameweek));
}

/** A PL club as bootstrap-static describes it. */
export interface CachedClubInfo {
  id: number;
  name: string;
  short_name: string;
}

const CLUBS_KEY = "fpl:clubs:latest";

export async function getCachedClubs(): Promise<CachedClubInfo[] | null> {
  return (await cachedGet<CachedClubInfo[]>(CLUBS_KEY, { l1Seconds: L1_CLUBS_SECONDS })) || null;
}

export async function setCachedClubs(data: CachedClubInfo[]): Promise<void> {
  await cachedSet(CLUBS_KEY, data, CACHE_TTL, { l1Seconds: L1_CLUBS_SECONDS });
}

/**
 * A manager's raw picks for one gameweek.
 *
 * Picks are fixed at the deadline — the fifteen elements, the armband, the chip and the transfer
 * cost cannot change afterwards. What does change is `entry_history.points` and `automatic_subs`,
 * both filled in when FPL settles the week, so the entry records whether it was taken from a
 * settled gameweek and a reader that needs settled figures refetches an unsettled copy once.
 *
 * The key matches the `fpl:*:gw*` pattern the test stub sweeps on a world change.
 */
export interface CachedPicks {
  picks: FPLGameweekPicks;
  settled: boolean;
  cachedAt: string;
}

function getPicksKey(fplId: string, gameweek: number): string {
  return `fpl:picks:v1:${fplId}:gw${gameweek}`;
}

export async function getCachedPicks(fplId: string, gameweek: number): Promise<CachedPicks | null> {
  return (await cachedGet<CachedPicks>(getPicksKey(fplId, gameweek))) || null;
}

/** Many managers' picks in one round-trip. Absent from the map = not cached. */
export async function getCachedPicksMany(
  fplIds: string[],
  gameweek: number
): Promise<Map<string, CachedPicks>> {
  const out = new Map<string, CachedPicks>();
  if (fplIds.length === 0) return out;
  const values = await cachedMget<CachedPicks>(fplIds.map((id) => getPicksKey(id, gameweek)));
  values.forEach((v, i) => {
    if (v && v.picks) out.set(fplIds[i], v);
  });
  return out;
}

export async function setCachedPicks(
  fplId: string,
  gameweek: number,
  data: CachedPicks,
  ttlSeconds: number
): Promise<void> {
  await cachedSet(getPicksKey(fplId, gameweek), data, ttlSeconds, { lastGood: true });
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
  return (await cachedGet<CachedElementInfo[]>(getBootstrapKey(), { l1Seconds: L1_BOOTSTRAP_SECONDS })) || null;
}

export async function setCachedBootstrap(data: CachedElementInfo[]): Promise<void> {
  await cachedSet(getBootstrapKey(), data, CACHE_TTL, { l1Seconds: L1_BOOTSTRAP_SECONDS });
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
  return (await cachedGet<FplEventStatus[]>(getEventStatusKey(), { l1Seconds: L1_EVENTS_SECONDS })) || null;
}

export async function setCachedEventStatus(data: FplEventStatus[]): Promise<void> {
  await cachedSet(getEventStatusKey(), data, LIVE_CACHE_TTL, { l1Seconds: L1_EVENTS_SECONDS });
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
  return (
    (await cachedGet<FplEventStatusPayload>(getLiveEventStatusKey(), { l1Seconds: L1_EVENT_STATUS_SECONDS })) ||
    null
  );
}

export async function setCachedLiveEventStatus(data: FplEventStatusPayload): Promise<void> {
  await cachedSet(getLiveEventStatusKey(), data, EVENT_STATUS_TTL, { l1Seconds: L1_EVENT_STATUS_SECONDS });
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
 * behavior) rather than silently disabling the sync. If it is configured but
 * down, the claim is held in-process instead, so an outage does not turn into
 * a bootstrap-static fetch on every dashboard request.
 */
export async function shouldSyncDeadlines(leagueId: string): Promise<boolean> {
  const key = getDeadlineSyncKey(leagueId);
  return redisClaim(key, DEADLINE_SYNC_TTL, async (r) =>
    (await r.set(key, "1", { ex: DEADLINE_SYNC_TTL, nx: true })) !== null
  );
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
  return cachedGet<CachedEntryHistory>(getEntryHistoryKey(fplId), { l1Seconds: L1_ENTRY_HISTORY_SECONDS });
}

export async function setCachedEntryHistory(
  fplId: string,
  data: Omit<CachedEntryHistory, "cachedAt">,
  ttlSeconds: number
): Promise<void> {
  await cachedSet(
    getEntryHistoryKey(fplId),
    { ...data, cachedAt: new Date().toISOString() },
    ttlSeconds,
    { l1Seconds: L1_ENTRY_HISTORY_SECONDS, lastGood: true }
  );
}

/**
 * Bulk read, so a page can serve whatever is already warm without N round trips.
 *
 * Every fixtures, Match Center and dashboard request reads a whole league's histories through
 * this — about 64 sizeable values — which is why it goes through the L1 per id.
 */
export async function getCachedEntryHistories(
  fplIds: string[]
): Promise<Map<string, CachedEntryHistory>> {
  const out = new Map<string, CachedEntryHistory>();
  if (fplIds.length === 0) return out;
  const values = await cachedMget<CachedEntryHistory>(fplIds.map(getEntryHistoryKey), {
    l1Seconds: L1_ENTRY_HISTORY_SECONDS,
  });
  fplIds.forEach((id, i) => {
    const v = values[i];
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
  const key = `fpl-league:warm:${leagueId}`;
  return redisClaim(key, FPL_LEAGUE_WARM_TTL, async (r) =>
    (await r.set(key, "1", { ex: FPL_LEAGUE_WARM_TTL, nx: true })) !== null
  );
}

// ============================================
// Refresh Single-Flight
// The forced-refresh route recomputes an entire gameweek from FPL. Without a
// gate, N members clicking Refresh at kickoff means N full sweeps. One caller
// computes; everyone else inside the window serves the cached result.
// ============================================

const REFRESH_LOCK_TTL = 120; // seconds — outlives a slow sweep
/**
 * Cooldown held after a sweep finishes, so a burst of near-simultaneous clicks
 * coalesces onto the result the first one just produced.
 *
 * Was 60s — far longer than the burst it exists to absorb, and long enough to span an
 * entire human interaction. The effect: for a minute after ANY sweep, including the
 * automatic background one the fixtures page fires on a stale poll, a manual Refresh
 * lost the claim and got the same cached payload back. Because the client treated
 * `stale: true` as success, it rendered that as a completed forced refresh. That is
 * the "clicking refresh does nothing" report.
 *
 * 10s still coalesces a double-click and the tail of a concurrent burst, while a
 * reader who looks at the numbers and clicks again always gets a real sweep. The
 * client now also states when a refresh was coalesced instead of silently succeeding.
 */
const REFRESH_RESULT_TTL = 10;

function getRefreshLockKey(gameweek: number, leagueId?: string | null): string {
  return `live:refresh:lock:gw${gameweek}:${leagueId ?? "all"}`;
}

/**
 * Claim the right to perform a forced refresh. Returns true only for the
 * caller that wins the race; losers should serve cached data instead.
 * Falls back to true when Redis is absent (local dev / tests) so the route
 * still works, just without the stampede guard; while Redis is down the guard
 * is held in-process instead.
 */
export async function claimRefreshSlot(
  gameweek: number,
  leagueId?: string | null
): Promise<boolean> {
  const key = getRefreshLockKey(gameweek, leagueId);
  return redisClaim(key, REFRESH_LOCK_TTL, async (r) =>
    (await r.set(key, "1", { ex: REFRESH_LOCK_TTL, nx: true })) !== null
  );
}

/** Release the refresh claim, leaving REFRESH_RESULT_TTL of cooldown behind it. */
export async function releaseRefreshSlot(
  gameweek: number,
  leagueId?: string | null
): Promise<void> {
  const key = getRefreshLockKey(gameweek, leagueId);
  await redisRelease(key, (r) => r.set(key, "1", { ex: REFRESH_RESULT_TTL }), REFRESH_RESULT_TTL);
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

/**
 * Mark a scoring run as in progress. Safe to call repeatedly to extend.
 *
 * Throws when Redis is configured but refusing, on purpose: that stops the run at its first line,
 * before it writes anything. Scoring fails CLOSED during an outage (see redisWritable).
 */
export async function markScoringActive(): Promise<void> {
  const r = getRawRedis();
  if (!r) return;
  await r.set(SCORING_LOCK_KEY, "1", { ex: SCORING_LOCK_TTL });
}

/**
 * Clear the scoring lock. Call in a finally block. Never throws: throwing from a `finally` masks
 * the run's own outcome, and the lock's TTL is the backstop.
 */
export async function clearScoringActive(): Promise<void> {
  const r = getRawRedis();
  if (!r) return;
  try {
    await r.del(SCORING_LOCK_KEY);
  } catch (e) {
    console.warn("[fpl-cache] could not clear the scoring lock; it lapses on its TTL", e);
  }
}

/**
 * True while a scoring run holds the lock. Returns false when Redis is absent
 * (local dev / tests) or down, so the gateway does not refuse everything by default.
 */
export async function isScoringActive(): Promise<boolean> {
  return redisRead(SCORING_LOCK_KEY, false, async (r) => (await r.get(SCORING_LOCK_KEY)) !== null);
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
  return (await cachedGet<LiveGameweekData>(getLiveKey(gameweek, leagueId))) || null;
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
  // lastGood: this is the copy an outage serves. Without it every poll during one re-sweeps
  // the whole gameweek from FPL.
  await cachedSet(getLiveKey(gameweek, leagueId), data, LIVE_CACHE_STALE_TTL, { lastGood: true });
}

/**
 * Clear live cache for a specific gameweek
 */
export async function clearLiveCache(gameweek: number, leagueId?: string | null): Promise<void> {
  forgetL1(getLiveKey(gameweek, leagueId));
  const r = getRawRedis();
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
const STANDINGS_CACHE_VERSION = 3;
/**
 * Keyed by the disclosure epoch as well as the league — same reason as the fixtures payload.
 *
 * The response embeds each team's CP/BP tooltip, which only names a chip once that gameweek's
 * deadline has passed. That verdict is computed per request, but caching the finished payload
 * froze it: a chip stayed hidden for the full TTL after its deadline, because nothing
 * invalidates when a deadline passes.
 */
const standingsKey = (leagueId: string, disclosedGwCount: number) =>
  `standings:v${STANDINGS_CACHE_VERSION}:${leagueId}:d${disclosedGwCount}`;

// The page blobs below are read through redisRead, never the L1: a miss recomputes from the
// database, which is cheap and correct, whereas an instance-local copy could outlive an admin
// write whose invalidation it never saw.

// ── Page caches an outage kept from being invalidated ──
//
// invalidateLeaguePageCache records a league when Upstash refuses its sweep, and every page-blob
// getter first sweeps whatever is recorded, so no blob from before an admin save is served after
// Upstash recovers. stale-page-caches.ts has the why.

/** The stale-page record (stale-page-caches.ts), behind an interface so unit tests can swap it. */
export interface StalePageCacheStore {
  mark(leagueId: string): Promise<void>;
  list(): Promise<{ leagueId: string; markedAt: string }[]>;
  clear(leagueId: string, markedAt: string): Promise<void>;
}

let staleStoreOverride: StalePageCacheStore | null = null;

async function staleStore(): Promise<StalePageCacheStore> {
  if (staleStoreOverride) return staleStoreOverride;
  // Imported lazily: this module is otherwise database-free, and the unit tests that load it
  // (daily-run.test.ts, through cron/daily-trigger.ts) have no database to connect to.
  const m = await import("./stale-page-caches");
  return { mark: m.markPageCacheStale, list: m.listStalePageCaches, clear: m.clearPageCacheStale };
}

/** How often an instance asks the database whether an outage left a league owing a sweep. */
const STALE_PAGE_CHECK_MS = 60_000;
let nextStalePageCheck = 0;
let staleRepair: Promise<void> | null = null;

/**
 * Sweep every league whose invalidation an outage refused, before a page blob is read.
 *
 * Runs from the getters rather than from the instance that took the admin save, because that
 * instance is usually long gone by the time an outage ends: whichever instance first reads a page
 * after recovery pays the debt before serving anything. At most one indexed database read a minute
 * per instance, none while Redis is absent or the breaker is open, and no Redis commands unless a
 * league is owed. Concurrent readers wait on the pass in flight instead of reading past it.
 */
async function repairStalePageCaches(): Promise<void> {
  if (staleRepair) return staleRepair;
  if (!getRedis() || Date.now() < nextStalePageCheck) return;
  nextStalePageCheck = Date.now() + STALE_PAGE_CHECK_MS;
  staleRepair = sweepOwedPageCaches().finally(() => {
    staleRepair = null;
  });
  return staleRepair;
}

async function sweepOwedPageCaches(): Promise<void> {
  let store: StalePageCacheStore;
  let owed: { leagueId: string; markedAt: string }[];
  try {
    store = await staleStore();
    owed = await store.list();
  } catch (e) {
    console.error("[fpl-cache] could not read the stale page-cache record:", e);
    return;
  }
  for (const { leagueId, markedAt } of owed) {
    try {
      await sweepLeaguePageCache(leagueId);
    } catch (e) {
      noteRedisFailure(`page-cache repair ${leagueId}`, e);
      return; // the rest stay recorded until Redis answers again
    }
    try {
      await store.clear(leagueId, markedAt);
    } catch (e) {
      // Swept already; a row left behind only costs one more sweep on the next pass.
      console.error(`[fpl-cache] swept league ${leagueId}'s page cache but could not clear its record:`, e);
    }
  }
}

/** Test seam: swap the stale-page record and forget when it was last checked. */
export function __setStalePageCacheStoreForTests(store: StalePageCacheStore | null): void {
  staleStoreOverride = store;
  nextStalePageCheck = 0;
  staleRepair = null;
}

export async function getCachedStandings(
  leagueId: string,
  disclosedGwCount: number,
): Promise<unknown | null> {
  await repairStalePageCaches();
  const key = standingsKey(leagueId, disclosedGwCount);
  return redisRead(key, null, (r) => r.get(key));
}

export async function setCachedStandings(
  leagueId: string,
  disclosedGwCount: number,
  data: unknown,
): Promise<void> {
  const key = standingsKey(leagueId, disclosedGwCount);
  await safeRedisWrite(key, (r) => r.set(key, data, { ex: PAGE_CACHE_TTL }));
}

/** Every epoch of a league's standings payload. Must be swept, not deleted by name. */
export async function invalidateStandings(leagueId: string): Promise<void> {
  const r = getRawRedis();
  if (!r) return;
  const keys = await r.keys(`standings:v${STANDINGS_CACHE_VERSION}:${leagueId}:*`);
  if (keys.length > 0) await r.del(...keys);
}

/**
 * Keyed by the disclosure epoch as well as the league.
 *
 * The payload embeds `chipsByGameweek`, which is gated on each gameweek's deadline having
 * passed. That verdict is computed at write time, and nothing invalidates when a deadline
 * passes — a deadline is not a write, and there is no cron. So a flat key served chip-less
 * payloads for the full 25h TTL after a gameweek went live. `disclosedGwCount` changes the
 * moment a deadline passes, which misses the old key and forces a recompute.
 */
function fixturesKey(leagueId: string, disclosedGwCount: number): string {
  return `fixtures:${leagueId}:d${disclosedGwCount}`;
}

export async function getCachedFixtures(
  leagueId: string,
  disclosedGwCount: number,
): Promise<unknown | null> {
  await repairStalePageCaches();
  const key = fixturesKey(leagueId, disclosedGwCount);
  return redisRead(key, null, (r) => r.get(key));
}

export async function setCachedFixtures(
  leagueId: string,
  disclosedGwCount: number,
  data: unknown,
): Promise<void> {
  const key = fixturesKey(leagueId, disclosedGwCount);
  await safeRedisWrite(key, (r) => r.set(key, data, { ex: PAGE_CACHE_TTL }));
}

/** Every epoch of a league's fixtures payload. Must be swept, not deleted by name. */
export async function invalidateFixtures(leagueId: string): Promise<void> {
  const r = getRawRedis();
  if (!r) return;
  const keys = await r.keys(`fixtures:${leagueId}:*`);
  if (keys.length > 0) await r.del(...keys);
}

export async function getCachedPlayoffBracket(leagueId: string): Promise<unknown | null> {
  await repairStalePageCaches();
  const key = `playoffs:${leagueId}`;
  return redisRead(key, null, (r) => r.get(key));
}

export async function setCachedPlayoffBracket(leagueId: string, data: unknown): Promise<void> {
  const key = `playoffs:${leagueId}`;
  await safeRedisWrite(key, (r) => r.set(key, data, { ex: PAGE_CACHE_TTL }));
}

/**
 * Delete standings, fixtures, and playoffs cache keys for a league.
 * Call this after any admin write that changes displayed data.
 * The next page request will fall back to DB and repopulate the cache.
 *
 * Never throws. It runs after the write has committed, so a refused sweep used to turn a save
 * that had happened into a 500: through the Oct 2026 quota outage, superadmin Activate/Deactivate
 * said "Failed to update league" while the league changed anyway. Throwing never protected the
 * cache either — the stale blob stayed, the admin just stopped trusting the save. A refused sweep
 * is now recorded in the database and repairStalePageCaches runs it once Redis answers again.
 */
export async function invalidateLeaguePageCache(leagueId: string): Promise<void> {
  try {
    await sweepLeaguePageCache(leagueId);
  } catch (e) {
    noteRedisFailure(`invalidate page cache ${leagueId}`, e);
    try {
      await (await staleStore()).mark(leagueId);
      console.warn(`[fpl-cache] page cache for league ${leagueId} not invalidated; queued for repair`);
    } catch (markErr) {
      console.error(
        `[fpl-cache] page cache for league ${leagueId} not invalidated, and could not be queued for repair:`,
        markErr
      );
    }
  }
}

/** The sweep behind invalidateLeaguePageCache and the repair. Throws when Upstash refuses. */
async function sweepLeaguePageCache(leagueId: string): Promise<void> {
  const r = getRawRedis();
  if (!r) return;
  // Must match the versioned key getCachedStandings/setCachedStandings actually use — an earlier,
  // unversioned `standings:{leagueId}` here silently deleted a key nothing reads or writes, leaving
  // every caller's invalidation a no-op for the standings cache.
  await r.del(`playoffs:${leagueId}`);
  await invalidateStandings(leagueId);
  // Computed standings rows are keyed per (league, throughGw) — one entry per historical
  // cut, so they must be swept by pattern rather than deleted by name. The fixtures payload
  // is now keyed per disclosure epoch for the same reason and needs the same treatment: a
  // `del("fixtures:{id}")` here would silently stop invalidating anything at all.
  await invalidateFixtures(leagueId);
  await invalidateLeagueStageRows(leagueId);
}

// ============================================
// Computed league-stage standings rows
// Keyed per (leagueId, throughGw): chip eligibility asks for historical cuts
// ("the table before GW n"), so one key per league is not enough.
// ============================================

/**
 * Short TTL on purpose. Unlike the rendered standings page (25h), these rows back the
 * dashboard AND chip eligibility, and a stale rank there decides whether a chip
 * submission is accepted. 10 minutes bounds the damage if an invalidation is ever missed;
 * admin writes still bust it explicitly via invalidateLeaguePageCache.
 */
const LEAGUE_STAGE_ROWS_TTL = 60 * 10;

/**
 * Bump on every change to the cached row SHAPE, same convention as
 * STANDINGS_CACHE_VERSION above. v2: RawChip.gameweek widened from a bare number to
 * { number, deadline? } so read-time disclosure can be evaluated per request. v3: rows gained
 * `fplNetScore` (tiebreaker tier 6). That bump is load-bearing, not hygiene: the cached path
 * returns rows without re-sorting, but the live overlay DOES re-sort them, and a v2 row has no
 * `fplNetScore`, so `b.fplNetScore - a.fplNetScore` would yield NaN. Array.sort treats NaN as
 * "equal" rather than throwing, so the damage would have been a quietly mis-ordered live table
 * for the whole TTL.
 */
const LEAGUE_STAGE_ROWS_VERSION = 3;

function leagueStageRowsKey(leagueId: string, throughGw: number): string {
  return `standings:rows:v${LEAGUE_STAGE_ROWS_VERSION}:${leagueId}:${throughGw}`;
}

export async function getCachedLeagueStageRows(leagueId: string, throughGw: number): Promise<unknown | null> {
  await repairStalePageCaches();
  const key = leagueStageRowsKey(leagueId, throughGw);
  return redisRead(key, null, async (r) => (await r.get(key)) ?? null);
}

export async function setCachedLeagueStageRows(leagueId: string, throughGw: number, data: unknown): Promise<void> {
  const key = leagueStageRowsKey(leagueId, throughGw);
  await safeRedisWrite(key, (r) => r.set(key, data, { ex: LEAGUE_STAGE_ROWS_TTL }));
}

export async function invalidateLeagueStageRows(leagueId: string): Promise<void> {
  const r = getRawRedis();
  if (!r) return;
  const keys = await r.keys(`standings:rows:v${LEAGUE_STAGE_ROWS_VERSION}:${leagueId}:*`);
  if (keys.length > 0) await r.del(...keys);
}

// ============================================
// Transfers + fixtures-page GW stats
// ============================================

/** One transfer as FPL's `entry/{id}/transfers/` lists it. */
export interface CachedTransfer {
  element_in: number;
  element_out: number;
  event: number;
}

/**
 * A manager's whole season of transfers, and when it was read.
 *
 * Transfers for gameweek N are final once N's deadline has passed, so a copy fetched after that
 * deadline answers every question about N and earlier forever. The reader decides validity from
 * `fetchedAt` against the deadline it cares about; the TTL only bounds storage.
 */
export interface CachedTransfers {
  fetchedAt: string;
  transfers: CachedTransfer[];
}

export const TRANSFERS_TTL = 60 * 60 * 24 * 7;

function getTransfersKey(fplId: string): string {
  return `fpl:transfers:v1:${fplId}`;
}

export async function getCachedTransfersMany(fplIds: string[]): Promise<Map<string, CachedTransfers>> {
  const out = new Map<string, CachedTransfers>();
  if (fplIds.length === 0) return out;
  const values = await cachedMget<CachedTransfers>(fplIds.map(getTransfersKey));
  values.forEach((v, i) => {
    if (v && Array.isArray(v.transfers)) out.set(fplIds[i], v);
  });
  return out;
}

export async function setCachedTransfers(fplId: string, data: CachedTransfers): Promise<void> {
  await cachedSet(getTransfersKey(fplId), data, TRANSFERS_TTL, { lastGood: true });
}

/** The fixtures-page stats payload for one league gameweek. Shape owned by api/fixtures/stats. */
function getGwStatsKey(leagueId: string, gameweek: number): string {
  return `fx-stats:v1:${leagueId}:gw${gameweek}`;
}

export async function getCachedGwStats<T>(leagueId: string, gameweek: number): Promise<T | null> {
  return cachedGet<T>(getGwStatsKey(leagueId, gameweek));
}

export async function setCachedGwStats(leagueId: string, gameweek: number, data: unknown, ttlSeconds: number): Promise<void> {
  await cachedSet(getGwStatsKey(leagueId, gameweek), data, ttlSeconds, { lastGood: true });
}

/**
 * Claim the right to BUILD a league gameweek's stats. A cold build can cost one transfers fetch
 * per manager, so a burst of readers must not each start one. Losers get `pending` and retry.
 * Like claimRefreshSlot, true when Redis is absent so local dev still works.
 */
export async function claimGwStatsBuild(leagueId: string, gameweek: number): Promise<boolean> {
  const key = `fx-stats:lock:${leagueId}:gw${gameweek}`;
  return redisClaim(key, 90, async (r) => (await r.set(key, "1", { ex: 90, nx: true })) !== null);
}

export async function releaseGwStatsBuild(leagueId: string, gameweek: number): Promise<void> {
  const key = `fx-stats:lock:${leagueId}:gw${gameweek}`;
  await redisRelease(key, (r) => r.del(key));
}

// ============================================
// Season chip list
// ============================================

/**
 * bootstrap-static's `chips` — which FPL chips exist this season and when each can be played.
 * Written whenever bootstrap is fetched anyway (element info, clubs), so reading it never costs
 * an FPL call. It only changes pre-season, hence the week-long TTL.
 */
const SEASON_CHIPS_KEY = "fpl:chips:season";

export async function getCachedSeasonChips(): Promise<FplSeasonChip[] | null> {
  const data = await cachedGet<FplSeasonChip[]>(SEASON_CHIPS_KEY, { l1Seconds: L1_SEASON_CHIPS_SECONDS });
  return Array.isArray(data) && data.length > 0 ? data : null;
}

export async function setCachedSeasonChips(data: FplSeasonChip[]): Promise<void> {
  await cachedSet(SEASON_CHIPS_KEY, data, CACHE_TTL * 7, { l1Seconds: L1_SEASON_CHIPS_SECONDS });
}
