/**
 * GET /api/fpl-classic/standings?leagueSlug=&gw=&month=
 *
 * Public, unauthenticated, read-only — the whole point of this format. One response carries
 * live standings, the gameweek leaderboard, and the monthly leaderboard, because they share the
 * league lookup and (for the current gameweek) the same live FPL block; splitting into three
 * routes would triple the round trips for nothing.
 *
 * The only FPL traffic this route can cause is the live standings refresh in
 * lib/fpl-classic/standings.ts, and that is behind a single-flight lock with a bounded call
 * count — this route itself never calls FPL directly. See PUBLIC_ROUTES in middleware.ts for
 * why this is safe to leave open to anyone with the URL.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, leagues } from "@/lib/db";
import { eq } from "drizzle-orm";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
import { buildClassicStandingsPayload } from "@/lib/fpl-classic/standings";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const leagueSlug = searchParams.get("leagueSlug");
    if (!leagueSlug) {
      return NextResponse.json({ error: "leagueSlug parameter is required" }, { status: 400 });
    }

    const [league] = await db
      .select({ id: leagues.id, slug: leagues.slug, name: leagues.name, season: leagues.season, format: leagues.format })
      .from(leagues)
      .where(eq(leagues.slug, leagueSlug))
      .limit(1);

    if (!league) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    // Never serve another format's league through this route, even if someone guesses the slug.
    if (league.format !== FPL_CLASSIC_FORMAT) {
      return NextResponse.json({ error: "Not an FPL Classic league" }, { status: 404 });
    }

    const gwParam = searchParams.get("gw");
    const requestedGw = gwParam ? Number(gwParam) : null;
    const monthParam = searchParams.get("month");

    const payload = await buildClassicStandingsPayload({
      leagueId: league.id,
      leagueSlug: league.slug,
      leagueName: league.name,
      season: league.season,
      requestedGw: requestedGw && Number.isInteger(requestedGw) ? requestedGw : null,
      requestedMonthKey: monthParam || null,
    });

    if (!payload) {
      // Config row missing — an fpl-classic league row exists but its config never landed
      // (a partially-failed creation, or a migration gap). Render as not-yet-ready, not a 500.
      return NextResponse.json({ error: "League configuration not found" }, { status: 404 });
    }

    return NextResponse.json(payload);
  } catch (error) {
    console.error("Error fetching FPL Classic standings:", error);
    return NextResponse.json({ error: "Failed to fetch standings" }, { status: 500 });
  }
}
