import { NextRequest } from "next/server";
import { jsonNoStore } from "@/lib/http/no-store";
import { loadMatchCenter, MatchCenterError } from "@/lib/match-center/load";

// A cold Match Center is a handful of FPL reads behind the gateway's pacing.
export const maxDuration = 30;

/**
 * GET /api/match-center?leagueSlug=&fixtureId=&gw=&a=&b=
 *
 * Two JPL teams' merged squads for one gameweek. `fixtureId` supplies defaults (its gameweek and
 * its two teams); `gw`, `a` and `b` override them, which is how the page's compare picker works.
 * Public, like /api/fixtures — nothing here is withheld from the FPL site itself, and anything
 * strategic (captain, TVT chip) is withheld until the deadline by the loader.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const leagueSlug = sp.get("leagueSlug");
  if (!leagueSlug) return jsonNoStore({ error: "leagueSlug parameter required" }, { status: 400 });

  const gwParam = sp.get("gw");
  const gw = gwParam ? Number(gwParam) : null;
  if (gw !== null && (!Number.isInteger(gw) || gw < 1 || gw > 38)) {
    return jsonNoStore({ error: "Invalid gameweek" }, { status: 400 });
  }

  try {
    const payload = await loadMatchCenter({
      leagueSlug,
      fixtureId: sp.get("fixtureId"),
      gw,
      teamA: sp.get("a"),
      teamB: sp.get("b"),
    });
    return jsonNoStore(payload);
  } catch (err) {
    if (err instanceof MatchCenterError) {
      return jsonNoStore({ error: err.message }, { status: err.status });
    }
    console.error("[match-center] failed:", err);
    return jsonNoStore({ error: "Failed to load the Match Center" }, { status: 500 });
  }
}
