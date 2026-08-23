import { db } from "@/lib/db";
import { players, teams, gameweeks } from "@/lib/db/schema";
import { and, asc, eq, lte } from "drizzle-orm";
import { fetchTeamHistory, type FplEntryHistory } from "@/lib/fpl";
import {
  getCachedEntryHistories,
  setCachedEntryHistory,
  claimFplLeagueWarm,
  isFplCacheEnabled,
  CACHE_TTL,
  LIVE_CACHE_TTL,
  type CachedEntryHistory,
} from "@/lib/fpl-cache";
import { getInFlightGameweekNumber } from "@/lib/gameweeks/in-flight";
import { getFinishedGwNumbers } from "@/lib/gameweeks/finished-set";
import { mapWithConcurrency } from "@/lib/concurrency";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";
import { buildFplChipStatus, type FplChipStatus } from "./chips";

/**
 * Player-level FPL standings: every manager in the league, ranked by their
 * official FPL season total.
 *
 * The cost problem, and how this handles it: a 32-team TVT league is 64 FPL
 * entries. Fetching all 64 histories on a cold request would be both a burst
 * big enough to get rate-limited and a real risk of blowing the 60s function
 * ceiling. So instead:
 *
 *   - every entry is cached independently and long-lived,
 *   - a request serves whatever is already cached, immediately,
 *   - and warms at most WARM_BATCH stale entries, behind a single-flight lock.
 *
 * A cold league therefore converges over a handful of page loads instead of
 * one huge burst, and the steady state is zero outbound calls. Rows that are
 * not warm yet render as "—" rather than blocking the page.
 *
 * All of which depends on there being somewhere to cache to. Without Redis
 * nothing survives the request, so each load re-warms the same first WARM_BATCH
 * entries and the rest can never fill in. That is a legitimate degraded mode —
 * a partial table beats an empty one — but it is NOT "still loading", and
 * `cacheEnabled` exists so the page can tell the two apart instead of polling
 * for progress that will never come.
 */

/** Entries refreshed per request. Small on purpose — see above. */
const WARM_BATCH = 12;
/** Parallelism within a batch. */
const WARM_CONCURRENCY = 4;

export interface FplLeagueRow {
  rank: number;
  teamId: string;
  teamName: string;
  playerName: string;
  fplId: string;
  /** Points in the header gameweek. null when not yet known for this entry. */
  gwPoints: number | null;
  gwTransferCost: number;
  totalPoints: number;
  chips: FplChipStatus;
  /** True when this entry has no data yet (cold cache, or its fetch failed). */
  pending?: true;
}

export interface FplLeagueStandings {
  rows: FplLeagueRow[];
  /** The gameweek the points column refers to. */
  gw: number | null;
  /** True when that gameweek is still being played. */
  isLive: boolean;
  /**
   * Entries still without data that a later request could fill in. Always 0
   * when `cacheEnabled` is false, because no later request ever will.
   */
  warming: number;
  /**
   * Whether warming can make progress across requests at all. False means no
   * Redis is configured: the table is as complete as it will get, and the
   * caller must not poll for more.
   */
  cacheEnabled: boolean;
  cachedAt: string;
}

export async function buildFplLeagueStandings(
  leagueId: string,
  opts?: { gw?: number }
): Promise<FplLeagueStandings> {
  // players has no leagueId — reach it through teams.
  const rows = await db
    .select({
      playerId: players.id,
      playerName: players.name,
      fplId: players.fplId,
      teamId: teams.id,
      teamName: teams.name,
    })
    .from(players)
    .innerJoin(teams, eq(players.teamId, teams.id))
    .where(eq(teams.leagueId, leagueId));

  const { gw: headerGw, isLive } = await resolveHeaderGw(leagueId, opts?.gw);

  const fplIds = [...new Set(rows.map((r) => r.fplId))];
  const cacheEnabled = isFplCacheEnabled();
  const cached = await getCachedEntryHistories(fplIds);

  // Warm a small slice of whatever is missing, if nobody else already is.
  const missing = fplIds.filter((id) => !cached.has(id));
  if (missing.length > 0 && (await claimFplLeagueWarm(leagueId))) {
    const batch = missing.slice(0, WARM_BATCH);
    const ttl = isLive ? LIVE_CACHE_TTL : CACHE_TTL;
    try {
      await withFplBudget(
        { lane: "background", label: "fpl-league warm", max: WARM_BATCH },
        async () => {
          await mapWithConcurrency(batch, WARM_CONCURRENCY, async (fplId) => {
            try {
              const history = await fetchTeamHistory(fplId);
              await setCachedEntryHistory(fplId, history, ttl);
              cached.set(fplId, { ...history, cachedAt: new Date().toISOString() });
            } catch (err) {
              // One bad entry id must never fail the page. Leave it pending;
              // the next request will try again.
              if (err instanceof FplUnavailableError) throw err;
              console.warn(`[fpl-league] history failed for entry ${fplId}`, err);
            }
          });
        }
      );
    } catch (err) {
      // Breaker open or a scoring run holds the lock — serve what we have.
      if (!(err instanceof FplUnavailableError)) throw err;
    }
  }

  const built = rows.map((r) => {
    const history = cached.get(r.fplId);
    const gwRow =
      headerGw != null ? history?.current.find((c) => c.event === headerGw) : undefined;

    return {
      teamId: r.teamId,
      teamName: r.teamName,
      playerName: r.playerName,
      fplId: r.fplId,
      gwPoints: gwRow?.points ?? null,
      gwTransferCost: gwRow?.event_transfers_cost ?? 0,
      totalPoints: latestTotal(history),
      chips: buildFplChipStatus(history?.chips ?? []),
      overallRank: latestOverallRank(history),
      pending: history ? undefined : (true as const),
    };
  });

  // Official FPL total, then FPL's own tiebreak (overall rank), then name so
  // the order is stable across requests.
  built.sort(
    (a, b) =>
      b.totalPoints - a.totalPoints ||
      (a.overallRank ?? Number.MAX_SAFE_INTEGER) - (b.overallRank ?? Number.MAX_SAFE_INTEGER) ||
      a.playerName.localeCompare(b.playerName)
  );

  // Competition ranking: equal totals share a rank, and the next rank skips.
  let lastTotal: number | null = null;
  let lastRank = 0;
  const ranked: FplLeagueRow[] = built.map((row, i) => {
    if (lastTotal === null || row.totalPoints !== lastTotal) {
      lastRank = i + 1;
      lastTotal = row.totalPoints;
    }
    // overallRank is a sort input only; it does not belong in the payload.
    const rest = { ...row } as Omit<typeof row, "overallRank"> & { overallRank?: number | null };
    delete rest.overallRank;
    return { ...(rest as Omit<typeof row, "overallRank">), rank: lastRank };
  });

  return {
    rows: ranked,
    gw: headerGw,
    isLive,
    // Only report rows a *subsequent* request could still fill in. Without a
    // cache the next request starts from nothing and re-warms this same batch,
    // so the pending rows are permanent, not in progress — reporting them as
    // "warming" is what made the page poll forever.
    warming: cacheEnabled ? ranked.filter((r) => r.pending).length : 0,
    cacheEnabled,
    cachedAt: new Date().toISOString(),
  };
}

/**
 * Which gameweek the points column refers to, and whether it is still being
 * played.
 *
 * "In flight" from getInFlightGameweekNumber means *our* results are not in
 * yet — which covers both "matches are still being played" and "matches
 * finished days ago but nobody has processed them". Only the first of those
 * is live, so FPL's finished flag decides the badge. Getting this wrong would
 * leave a LIVE pill pulsing on a gameweek that ended last Sunday.
 */
async function resolveHeaderGw(
  leagueId: string,
  explicit?: number
): Promise<{ gw: number | null; isLive: boolean }> {
  const inFlight = await getInFlightGameweekNumber(leagueId);
  const finished = await getFinishedGwNumbers();
  const isLive = inFlight != null && !(finished?.has(inFlight) ?? false);

  if (explicit && explicit >= 1 && explicit <= 38) {
    return { gw: explicit, isLive: isLive && inFlight === explicit };
  }
  if (inFlight != null) return { gw: inFlight, isLive };

  if (finished && finished.size > 0) {
    // Only count gameweeks this league actually has, and only ones whose
    // deadline has genuinely passed for us.
    const leagueGws = await db
      .select({ number: gameweeks.number })
      .from(gameweeks)
      .where(and(eq(gameweeks.leagueId, leagueId), lte(gameweeks.deadline, new Date())))
      .orderBy(asc(gameweeks.number));
    const owned = leagueGws.map((g) => g.number).filter((n) => finished.has(n));
    if (owned.length > 0) return { gw: Math.max(...owned), isLive: false };
  }

  return { gw: null, isLive: false };
}

/** The running season total, taken from the newest gameweek row FPL returned. */
function latestTotal(history: CachedEntryHistory | FplEntryHistory | undefined): number {
  if (!history || history.current.length === 0) return 0;
  return history.current[history.current.length - 1].total_points ?? 0;
}

function latestOverallRank(
  history: CachedEntryHistory | FplEntryHistory | undefined
): number | null {
  if (!history || history.current.length === 0) return null;
  return history.current[history.current.length - 1].overall_rank ?? null;
}
