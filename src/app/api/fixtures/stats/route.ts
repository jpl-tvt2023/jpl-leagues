import { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/no-store";
import {
  CACHE_TTL,
  LIVE_CACHE_TTL,
  claimGwStatsBuild,
  getCachedGwStats,
  releaseGwStatsBuild,
  setCachedGwStats,
} from "@/lib/fpl-cache";
import { buildGwStats, GwStatsError, resolveStatsTarget } from "@/lib/fixtures-stats/build";
import type { GwStatsPayload } from "@/lib/fixtures-stats/aggregate";

// A cold build reads one transfers list per manager behind the gateway's pacing.
export const maxDuration = 60;

/** A partial build is kept only briefly, so the next reader tops up the managers it missed. */
const PARTIAL_TTL = 120;

/**
 * GET /api/fixtures/stats?leagueSlug=&gameweek=
 *
 * Compact per-manager facts (picks, chip, hits, transfers) for one gameweek; the fixtures page
 * folds them into the stats sidebar client-side (lib/fixtures-stats/aggregate.ts). Public under
 * the /api/fixtures prefix. Nothing is sent before the deadline — picks are secret until then.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const leagueSlug = sp.get("leagueSlug");
  const gw = Number(sp.get("gameweek"));
  if (!leagueSlug) return jsonNoStore({ error: "leagueSlug parameter required" }, { status: 400 });
  if (!Number.isInteger(gw) || gw < 1 || gw > 38) return jsonNoStore({ error: "Invalid gameweek" }, { status: 400 });

  try {
    const { league, gw: gwRow } = await resolveStatsTarget(leagueSlug, gw);

    const cached = await getCachedGwStats<GwStatsPayload>(league.id, gw).catch(() => null);
    if (cached) return jsonNoStore(cached);

    // One builder at a time per league gameweek: a cold build can be ~64 transfer reads.
    if (!(await claimGwStatsBuild(league.id, gw))) {
      return jsonNoStore({ pending: true }, { status: 202 });
    }
    try {
      const payload = await buildGwStats({
        leagueId: league.id,
        format: league.format ?? "tvt",
        gwNumber: gw,
        deadline: gwRow.deadline,
      });
      if (payload.status === "ok") {
        const complete = payload.picksComplete && payload.transfersComplete;
        const ttl = !complete ? PARTIAL_TTL : payload.settled ? CACHE_TTL : LIVE_CACHE_TTL;
        await setCachedGwStats(league.id, gw, payload, ttl);
      }
      return jsonNoStore(payload);
    } finally {
      await releaseGwStatsBuild(league.id, gw).catch(() => {});
    }
  } catch (err) {
    if (err instanceof GwStatsError) return jsonNoStore({ error: err.message }, { status: err.status });
    console.error("[fixtures-stats] failed:", err);
    return jsonNoStore({ error: "Failed to load stats" }, { status: 500 });
  }
}
