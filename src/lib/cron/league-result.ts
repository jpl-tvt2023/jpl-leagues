/**
 * Rolling per-gameweek outcomes up into one league's result.
 *
 * Import-free (the type imports below are erased), so the unit lane can exercise it without a
 * database. Extracted from the Operations tab, which owned this outright — a second copy on the
 * server would be two definitions of what "partial" means, differing the moment either was
 * touched. The daily runner and the browser now fold results identically.
 */

import type { LeaguePlanItem, LeagueResult, LeagueGwResult } from "@/lib/cron/process-all";

/**
 * Roll per-gameweek outcomes up into one league's result.
 *
 * Pure, and exported so the Operations tab and the daily runner fold results the same way. The
 * browser owned this outright; a second copy on the server would be two definitions of what
 * "partial" means, differing the moment either was touched.
 */
export function emptyLeagueResult(league: LeaguePlanItem): LeagueResult {
  return {
    leagueId: league.id,
    slug: league.slug,
    format: league.format,
    status: "skipped",
    scoredGws: [],
    advancedGws: [],
    generatedFor: [],
    generatedAlready: [],
    advanceWindowFuture: [],
    errors: [],
  };
}

/**
 * Fold one gameweek's outcome into the running aggregate. Mutates `agg` and returns it.
 *
 * `error` is a TRANSPORT failure — the call never produced a result, so which stage failed is
 * unknown. It is recorded as step "request" rather than "score": labelling every transport
 * failure as scoring is what made an auction league that never reached scoring report
 * "GW1 score: Network error".
 */
export function foldLeagueGwResult(
  agg: LeagueResult,
  gw: number,
  outcome: { result?: LeagueGwResult | null; error?: string | null },
): LeagueResult {
  if (outcome.error) {
    agg.errors.push({ gw, step: "request", message: outcome.error });
    return agg;
  }
  const r = outcome.result;
  if (!r) {
    agg.errors.push({ gw, step: "request", message: "unknown error" });
    return agg;
  }
  if (r.scored || r.scoreSkipped) agg.scoredGws.push(gw);
  if (r.advanced) agg.advancedGws.push(gw);
  if (r.generated) agg.generatedFor.push(gw);
  if (r.generatedAlready) agg.generatedAlready.push(gw);
  if (r.advanceWindowFuture) agg.advanceWindowFuture.push(gw);
  for (const e of r.errors) agg.errors.push({ gw, step: e.step, message: e.message });
  return agg;
}

/** Stamp the final status once every gameweek has been folded in. Mutates `agg` and returns it. */
export function finalizeLeagueResult(agg: LeagueResult): LeagueResult {
  const didWork =
    agg.scoredGws.length +
      agg.advancedGws.length +
      agg.generatedFor.length +
      agg.generatedAlready.length >
    0;
  agg.status = agg.errors.length === 0
    ? (didWork ? "ok" : "skipped")
    : (didWork ? "partial" : "error");
  return agg;
}
