/**
 * Builds the per-gameweek context {@link managerGameweekPoints} scores against.
 *
 * Kept apart from manager-points.ts so that module stays free of runtime imports and its
 * unit tests can exercise the scoring rules without a Redis client or an FPL gateway.
 *
 * Cost is one context per REQUEST, not per manager: a 16-fixture TVT-32 sweep scores 64
 * managers off a single build. Everything it touches is already cached and in-process
 * single-flighted — `/event/{gw}/live/` and `/fixtures/` each behind a 60-second Redis
 * window, the latter usually warmed already by the players-left counter, and bootstrap
 * element info behind 24 hours.
 */

import { fetchElementGameweekStats, fetchElementInfo, isGameweekFinal } from "@/lib/fpl";
import { getFplFixturesForGw } from "@/lib/fpl-live/players-left";
import type { FplLane } from "@/lib/fpl/gateway";
import type { ManagerPointsContext } from "@/lib/fpl-live/manager-points";

/**
 * In-process memo, keyed by lane and gameweek.
 *
 * `calculateTeamGameweekScore` resolves a context per MANAGER, and its callers loop over a
 * whole league — a 64-manager standings rebuild would otherwise pay four Upstash round-trips
 * and a ~700-element set rebuild sixty-four times, on a 60s function ceiling.
 *
 * The TTL is strictly tighter than every Redis window underneath it (60s element stats, 60s
 * fixtures), so it can never serve numbers those would have refreshed. The promise is stored
 * rather than the value so concurrent callers share one build; a rejection is dropped
 * immediately so a transient FPL refusal is not replayed to everyone for a minute.
 */
const CONTEXT_MEMO_TTL_MS = 60_000;
const contextMemo = new Map<string, { at: number; value: Promise<ManagerPointsContext> }>();

/**
 * Resolve the live/settled context for a gameweek.
 *
 * Throws `FplUnavailableError` if the gateway refuses the live-elements fetch. That is
 * deliberate and must stay: the callers treat it as "show the last known numbers", whereas
 * degrading to an empty stats map here would score every manager 0 and then cache it.
 */
export async function buildManagerPointsContext(
  gwNumber: number,
  lane: FplLane = "background"
): Promise<ManagerPointsContext> {
  // Lane is part of the key for the same reason it is on the gateway's in-flight maps:
  // the two lanes have different permissions, and a background caller inheriting a
  // context built on the critical lane would be riding past a refusal it was owed.
  const key = `${lane}:${gwNumber}`;
  const hit = contextMemo.get(key);
  if (hit && Date.now() - hit.at < CONTEXT_MEMO_TTL_MS) return hit.value;

  const pending = buildFreshManagerPointsContext(gwNumber, lane);
  contextMemo.set(key, { at: Date.now(), value: pending });
  void pending.catch(() => {
    if (contextMemo.get(key)?.value === pending) contextMemo.delete(key);
  });
  return pending;
}

/** Test seam: drops the memo so a spec can change the underlying FPL state mid-run. */
export function __resetManagerPointsContextMemo(): void {
  contextMemo.clear();
}

async function buildFreshManagerPointsContext(
  gwNumber: number,
  lane: FplLane
): Promise<ManagerPointsContext> {
  const settled = await isGameweekFinal(gwNumber, lane);

  // A settled gameweek reads `entry_history.points` and touches neither of the below, so
  // skip both fetches rather than paying ~460KB to build a context nothing will consult.
  if (settled) {
    return { settled: true, stats: {}, concludedElements: new Set() };
  }

  const stats = await fetchElementGameweekStats(gwNumber, lane);
  return {
    settled: false,
    stats,
    concludedElements: await resolveConcludedElements(gwNumber, lane),
  };
}

/**
 * Element ids whose club has no unfinished fixture left in this gameweek.
 *
 * Returns an empty set on any failure, which reads downstream as "no vice-captain handover".
 * That is the safe direction: a late handover corrects itself on the next poll, an early one
 * inflates every manager whose captain simply has not kicked off yet.
 *
 * A double gameweek is handled by construction — a club is only concluded once BOTH its
 * fixtures are finished, so a captain between their two matches keeps the armband.
 */
async function resolveConcludedElements(
  gwNumber: number,
  lane: FplLane
): Promise<ReadonlySet<number>> {
  const concluded = new Set<number>();
  try {
    const [gwFixtures, elements] = await Promise.all([
      // getFplFixturesForGw is background-only by design. During a scoring run it returns
      // null, which lands here as "no handover" — the safe direction, and self-correcting
      // as soon as normal traffic resumes.
      getFplFixturesForGw(gwNumber),
      fetchElementInfo(lane),
    ]);
    if (!gwFixtures || gwFixtures.length === 0) return concluded;

    // `finished_provisional` as well as `finished`, and the provisional flag is the one that
    // actually does the work. FPL does not set `finished` at the final whistle — it sets it
    // once bonus is confirmed for the round. Measured on 2026-09-12 with GW4 in flight:
    //
    //   kickoff 14:00  started=true  finished=FALSE  finished_provisional=true   1-2
    //   kickoff 19:00  started=true  finished=false  finished_provisional=false  0-0
    //   kickoff Sun    started=false finished=false  finished_provisional=false
    //
    // Six matches were over and none was `finished`. Gating on that alone would hold the
    // handover until roughly the moment `entry_history.points` goes live anyway, making this
    // whole path dead code. `finished_provisional` means the match has ended, and a player's
    // MINUTES are final at the whistle even while bonus is still moving — minutes are the
    // only thing this gate consults. A captain yet to kick off has both flags false, which is
    // the case the gate exists to protect.
    const clubsWithFixtureRemaining = new Set<number>();
    for (const f of gwFixtures) {
      if (f.finished || f.finished_provisional) continue;
      clubsWithFixtureRemaining.add(f.team_h);
      clubsWithFixtureRemaining.add(f.team_a);
    }

    // Clubs blank this gameweek fall through with no fixture remaining, which is right:
    // a captain who has no match at all has definitively not played, and FPL hands their
    // armband to the vice-captain exactly as it does for one who was left out.
    for (const el of elements) {
      if (!clubsWithFixtureRemaining.has(el.team)) concluded.add(el.id);
    }
  } catch {
    return new Set();
  }
  return concluded;
}
