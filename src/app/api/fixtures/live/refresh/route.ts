import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { LiveGameweekData } from "@/lib/fpl-cache";
import {
  getLiveCachedScores,
  setLiveCachedScores,
  claimRefreshSlot,
  releaseRefreshSlot,
} from "@/lib/fpl-cache";
import { computeLiveFixtureScores } from "@/lib/fpl-live/tvt-live-scores";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";

/**
 * GET /api/fixtures/live/refresh?gameweek=N&leagueSlug=slug[&fixtureId=a,b]
 *
 * Forced refresh behind the Refresh button. Recomputes live scores from FPL
 * rather than serving the 10-minute cache.
 *
 * This is the most expensive endpoint in the app: a 16-fixture TVT-32
 * gameweek is 64 picks fetches. Three things keep that bounded —
 *   1. the scoring itself is shared with /api/fixtures/live (one live-element
 *      fetch per request, not one per team side),
 *   2. a Redis single-flight claim so concurrent clicks coalesce,
 *   3. results are written into the same cache /api/fixtures/live reads, so
 *      the work is not thrown away (it used to be).
 */

// Vercel Hobby ceiling. Without this the default budget can cut a large
// gameweek's sweep off midway.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const gwParam = searchParams.get("gameweek");

    if (!gwParam) {
      return NextResponse.json({ error: "gameweek parameter required" }, { status: 400 });
    }

    const gwNumber = parseInt(gwParam);
    if (isNaN(gwNumber) || gwNumber < 1 || gwNumber > 38) {
      return NextResponse.json({ error: "Invalid gameweek" }, { status: 400 });
    }

    // Required. Resolving a gameweek by number alone picked an arbitrary
    // league's row on a multi-league deployment, so a refresh could return
    // another league's fixtures entirely.
    const leagueSlug = searchParams.get("leagueSlug");
    if (!leagueSlug) {
      return NextResponse.json({ error: "leagueSlug parameter required" }, { status: 400 });
    }
    const leagueRow = await db
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.slug, leagueSlug))
      .limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    const leagueId = leagueRow[0].id;

    const fixtureIds =
      searchParams.get("fixtureId")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

    // Single-flight: only one caller sweeps FPL per gameweek per window.
    // Everyone else gets whatever is cached, flagged as stale.
    const won = await claimRefreshSlot(gwNumber, leagueId);
    if (!won) {
      const cached = await getLiveCachedScores(gwNumber, leagueId);
      if (cached) {
        return NextResponse.json({ ...cached, stale: true });
      }
      // Nothing cached yet and someone else is mid-sweep — tell the client to
      // retry rather than launching a second sweep.
      return NextResponse.json(
        { gameweek: gwNumber, fixtures: [], cachedAt: null, stale: true, pending: true },
        { status: 202 }
      );
    }

    try {
      // A whole TVT-32 gameweek is 1 live fetch + 64 picks fetches. The ceiling
      // is deliberately a little above that so a legitimate sweep completes but
      // a runaway loop cannot.
      const liveFixtures = await withFplBudget(
        { lane: "background", label: `refresh gw${gwNumber}`, max: 80 },
        () => computeLiveFixtureScores({ leagueId, gwNumber, fixtureIds })
      );

      const liveData: LiveGameweekData = {
        gameweek: gwNumber,
        fixtures: liveFixtures,
        cachedAt: new Date().toISOString(),
      };

      // Warm the cache /api/fixtures/live reads. Only for a full-gameweek
      // sweep — a filtered result would blank the other fixtures for everyone.
      if (!fixtureIds || fixtureIds.length === 0) {
        await setLiveCachedScores(gwNumber, liveData, leagueId);
      }

      return NextResponse.json(liveData);
    } finally {
      await releaseRefreshSlot(gwNumber, leagueId);
    }
  } catch (error) {
    if (error instanceof FplUnavailableError) {
      // Breaker open, or a scoring run holds the lock. Expected — not a fault.
      return NextResponse.json(
        { error: "Live scores are briefly unavailable — try again shortly.", reason: error.reason },
        { status: 503 }
      );
    }
    console.error("Refresh error:", error);
    return NextResponse.json({ error: "Failed to refresh scores" }, { status: 500 });
  }
}
