/**
 * Gameweek finality detection.
 *
 * "Has GW N concluded, and which gameweek is FPL actually on right now?"
 *
 * The app used to answer this from `bootstrap-static/`'s `events[].finished`. That
 * field is correct but slow to arrive: bootstrap-static is an ~800KB payload behind
 * FPL's Cloudflare edge, and we cached it a further 10 minutes in Redis. After GW1
 * concluded there was no way to learn that GW2 was now the active gameweek without
 * waiting out both caches.
 *
 * Two lighter, faster-moving sources replace it:
 *
 *   GET /api/event-status/   (~1KB)   bonus_added + points ("r"|"p"|"c") + leagues
 *   GET /api/fixtures/       (cached) per-fixture `finished`
 *
 * A gameweek is concluded when BOTH agree:
 *   - every PL fixture in the gameweek has finished, and
 *   - FPL has added bonus points and finished updating league tables.
 *
 * Requiring both matters. `finished` on the fixtures flips as soon as the last
 * whistle goes, but bonus points are still provisional for a while afterwards —
 * scoring on that signal alone would bake in points that FPL then moves.
 *
 * Every read is best-effort and degrades in a stated order:
 *   event-status + fixtures  ->  bootstrap `events[].finished`  ->  unavailable.
 * "Unavailable" always resolves to "not concluded", never to "concluded" — being
 * late to process a gameweek is recoverable, processing an unfinished one is not.
 */

import { fplRequest, FPL_BASE_URL, FplUnavailableError, type FplLane } from "./gateway";
import {
  getCachedLiveEventStatus,
  setCachedLiveEventStatus,
  type FplEventStatusPayload,
  type FplEventStatusRow,
} from "@/lib/fpl-cache";
import { getFplFixturesForGw, getAllFplFixtures } from "@/lib/fpl-live/players-left";
import { fetchBootstrapEventFlags } from "@/lib/fpl";

export type GwStatusSource = "event-status" | "bootstrap-fallback" | "unavailable";

export interface GameweekConclusion {
  gw: number;
  concluded: boolean;
  /** Where the answer came from — surfaced in the UI so a degraded read is visible. */
  source: GwStatusSource;
  /** Human-readable detail for operator-facing screens and skip reasons. */
  detail: string;
}

export interface ActiveGameweek {
  /** Lowest gameweek that has NOT concluded — i.e. the one FPL is on now. */
  gw: number | null;
  /** Highest gameweek known to have concluded, or null if none have. */
  lastConcludedGw: number | null;
  source: GwStatusSource;
  detail: string;
}

const MAX_GW = 38;

/**
 * Fetch FPL's /event-status/ payload (60s Redis cache).
 *
 * Returns null on any failure — a refused gateway call, non-2xx, or an
 * unexpected body shape. Callers fall back to the bootstrap flags.
 */
export async function fetchFplEventStatus(
  lane: FplLane = "background"
): Promise<FplEventStatusPayload | null> {
  const cached = await getCachedLiveEventStatus().catch(() => null);
  if (cached) return cached;

  try {
    const res = await fplRequest(`${FPL_BASE_URL}/event-status/`, { lane });
    if (!res.ok) {
      console.warn(`[fpl/event-status] status=${res.status}`);
      return null;
    }
    const data = (await res.json()) as FplEventStatusPayload;
    if (!data || !Array.isArray(data.status)) {
      console.warn("[fpl/event-status] unexpected body shape");
      return null;
    }
    // Only cache a populated payload — an empty `status` between gameweeks
    // shouldn't pin "nothing is known" for the next 60s.
    if (data.status.length > 0) {
      await setCachedLiveEventStatus(data).catch(() => {});
    }
    return data;
  } catch (e) {
    if (e instanceof FplUnavailableError) {
      // Breaker open or a scoring run holds the lock. Expected, not an error.
      return null;
    }
    console.warn("[fpl/event-status] fetch error", e);
    return null;
  }
}

/**
 * True when FPL has added bonus and finished updating tables for this GW.
 *
 * /event-status/ only ever describes the gameweek FPL is currently working on — it
 * carries one row per match day of that GW and nothing for earlier ones. So an absent
 * row is ambiguous, and which way it resolves depends on where the payload has moved
 * on to:
 *
 *   - payload already describes a LATER gameweek  -> this one is historical, and FPL
 *     only advances after settling the previous GW. Settled.
 *   - payload describes this GW or an earlier one -> FPL has not reached this GW's
 *     reconciliation yet. Not settled.
 *
 * Without that first case every past gameweek would read as unconcluded, which would
 * pin "current gameweek" at GW1 for the whole season.
 */
function eventStatusSaysSettled(
  payload: FplEventStatusPayload,
  gw: number
): { settled: boolean; rows: FplEventStatusRow[]; historical: boolean } {
  const rows = payload.status.filter((r) => r.event === gw);
  const maxReportedEvent = payload.status.reduce((m, r) => Math.max(m, r.event), 0);

  if (rows.length === 0) {
    const historical = maxReportedEvent > gw;
    return { settled: historical, rows, historical };
  }

  // One row per match day in the gameweek; every day must have its bonus added
  // before the gameweek as a whole is settled.
  const allBonusAdded = rows.every((r) => r.bonus_added === true);
  const leaguesUpdated = payload.leagues === "Updated";
  return { settled: allBonusAdded && leaguesUpdated, rows, historical: false };
}

/**
 * Has this gameweek concluded?
 *
 * Never throws. On total FPL unavailability returns `concluded: false` with
 * `source: "unavailable"`, so callers gate rather than guess.
 */
export async function getGameweekConclusion(
  gw: number,
  lane: FplLane = "background"
): Promise<GameweekConclusion> {
  const [status, fixtures] = await Promise.all([
    fetchFplEventStatus(lane),
    getFplFixturesForGw(gw).catch(() => null),
  ]);

  if (status && fixtures) {
    if (fixtures.length === 0) {
      // A genuinely blank gameweek has no matches to wait on; event-status decides.
      const { settled } = eventStatusSaysSettled(status, gw);
      return {
        gw,
        concluded: settled,
        source: "event-status",
        detail: settled ? "blank gameweek, settled" : "blank gameweek, not yet settled",
      };
    }
    const unfinished = fixtures.filter((f) => !f.finished).length;
    if (unfinished > 0) {
      return {
        gw,
        concluded: false,
        source: "event-status",
        detail: `${unfinished} of ${fixtures.length} PL fixtures still in progress`,
      };
    }
    const { settled, rows, historical } = eventStatusSaysSettled(status, gw);
    if (!settled) {
      const detail = rows.length === 0
        ? "all fixtures finished; FPL has not published event status for this GW yet"
        : rows.every((r) => r.bonus_added)
          ? "all fixtures finished and bonus added; FPL is still updating league tables"
          : "all fixtures finished; bonus points not yet confirmed by FPL";
      return { gw, concluded: false, source: "event-status", detail };
    }
    return {
      gw,
      concluded: true,
      source: "event-status",
      detail: historical
        ? "all fixtures finished; FPL has moved on to a later gameweek"
        : "all fixtures finished, bonus confirmed",
    };
  }

  // Fallback: the bootstrap `finished` flag. Laggier, but still correct when set.
  try {
    const events = await fetchBootstrapEventFlags();
    const event = events.find((e) => e.id === gw);
    if (!event) {
      return { gw, concluded: false, source: "bootstrap-fallback", detail: "not present in FPL bootstrap" };
    }
    return {
      gw,
      concluded: event.finished === true,
      source: "bootstrap-fallback",
      detail: event.finished
        ? "bootstrap reports finished (event-status unavailable)"
        : "bootstrap reports still in progress",
    };
  } catch (e) {
    return {
      gw,
      concluded: false,
      source: "unavailable",
      detail: `cannot verify FPL state: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
}

/** Convenience boolean wrapper around {@link getGameweekConclusion}. */
export async function isGameweekConcluded(gw: number, lane: FplLane = "background"): Promise<boolean> {
  return (await getGameweekConclusion(gw, lane)).concluded;
}

/**
 * The gameweek FPL is currently on: the lowest GW that has not concluded.
 *
 * Resolved in one pass from the fixtures list plus a single event-status read, rather
 * than by asking `getGameweekConclusion` about each gameweek in turn. The fixtures
 * list already says which gameweeks are fully played; event-status only has to settle
 * the frontier one.
 */
export async function getActiveFplGameweek(lane: FplLane = "background"): Promise<ActiveGameweek> {
  const [status, matchesFinished] = await Promise.all([
    fetchFplEventStatus(lane),
    getMatchesFinishedGwNumbers(),
  ]);

  if (status && matchesFinished) {
    // Walk up from GW1 to the first gameweek whose matches are not all played.
    let frontier = 1;
    while (frontier <= MAX_GW && matchesFinished.has(frontier)) frontier++;

    if (frontier > MAX_GW) {
      return {
        gw: null,
        lastConcludedGw: MAX_GW,
        source: "event-status",
        detail: "season complete — every gameweek has concluded",
      };
    }

    // Everything below the frontier is played. The one directly below it may still be
    // awaiting bonus confirmation, which is what decides whether the frontier is
    // genuinely "active" or we are still settling the previous gameweek.
    const previous = frontier - 1;
    if (previous >= 1) {
      const { settled } = eventStatusSaysSettled(status, previous);
      if (!settled) {
        return {
          gw: previous,
          lastConcludedGw: previous >= 2 ? previous - 1 : null,
          source: "event-status",
          detail: `GW${previous} matches all played; awaiting FPL bonus confirmation`,
        };
      }
    }

    return {
      gw: frontier,
      lastConcludedGw: previous >= 1 ? previous : null,
      source: "event-status",
      detail: previous >= 1
        ? `GW${previous} concluded — GW${frontier} is next`
        : `GW${frontier} has not started`,
    };
  }

  // Fallback: derive from the bootstrap flags in one pass.
  try {
    const events = await fetchBootstrapEventFlags();
    const finished = events.filter((e) => e.finished).map((e) => e.id);
    const lastConcluded = finished.length > 0 ? Math.max(...finished) : null;
    const next = events.find((e) => !e.finished)?.id ?? null;
    return {
      gw: next,
      lastConcludedGw: lastConcluded,
      source: "bootstrap-fallback",
      detail: "event-status unavailable; derived from FPL bootstrap",
    };
  } catch (e) {
    return {
      gw: null,
      lastConcludedGw: null,
      source: "unavailable",
      detail: `cannot reach FPL: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
}

/**
 * Gameweeks whose PL matches have all been played — the "last whistle" signal.
 *
 * Deliberately WEAKER than {@link isGameweekConcluded}: it does not wait for FPL to
 * confirm bonus points. That distinction is load-bearing. Scoring must wait for bonus
 * (points still move), but the team-submission window must not — holding it shut for
 * the extra day or two FPL takes to confirm bonus would be worse than the problem it
 * solves. See getFinishedGwNumbers in src/lib/gameweeks/finished-set.ts.
 *
 * Derived from the fixtures list in a single pass. Returns null when FPL is
 * unreachable, so callers can fail open.
 */
export async function getMatchesFinishedGwNumbers(): Promise<Set<number> | null> {
  const all = await getAllFplFixtures().catch(() => null);
  if (all == null) return null;

  const byGw = new Map<number, { total: number; finished: number }>();
  for (const f of all) {
    if (f.event == null) continue;
    const entry = byGw.get(f.event) ?? { total: 0, finished: 0 };
    entry.total++;
    if (f.finished) entry.finished++;
    byGw.set(f.event, entry);
  }

  const done = new Set<number>();
  for (const [gw, { total, finished }] of byGw.entries()) {
    if (total > 0 && finished === total) done.add(gw);
  }
  return done;
}

/**
 * Every gameweek number FPL considers concluded, or null when FPL is unreachable.
 *
 * Null is load-bearing: callers treat it as "unknown" and fail OPEN (keep team
 * submission available) rather than locking users out during an FPL outage.
 */
export async function getConcludedGwNumbers(lane: FplLane = "background"): Promise<Set<number> | null> {
  const active = await getActiveFplGameweek(lane);
  if (active.source === "unavailable") return null;
  const last = active.lastConcludedGw;
  if (last == null) return new Set<number>();
  return new Set(Array.from({ length: last }, (_, i) => i + 1));
}
