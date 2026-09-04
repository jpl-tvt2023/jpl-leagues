/**
 * GET /api/fpl-classic/winners?leagueSlug=
 *
 * Every award for a public FPL Classic league, each labelled final / provisional / leading.
 *
 * Public and unauthenticated, via the `/api/fpl-classic` prefix already in PUBLIC_ROUTES
 * (middleware's isPublicRoute is GET-only, so a future POST under this prefix stays authenticated).
 *
 * Deliberately a separate route from /api/fpl-classic/standings rather than a flag on it:
 *  - it makes ZERO FPL calls, so no amount of crawler traffic can start FPL work here, whereas the
 *    standings route runs a cache-first live block; and
 *  - it avoids shipping every entrant's standings row to a page that only wants the awards.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, leagues } from "@/lib/db";
import { eq } from "drizzle-orm";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
import { buildClassicWinnersPayload } from "@/lib/fpl-classic/winners";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const leagueSlug = request.nextUrl.searchParams.get("leagueSlug");
  if (!leagueSlug) {
    return NextResponse.json({ error: "leagueSlug is required" }, { status: 400 });
  }

  const [league] = await db
    .select({ id: leagues.id, slug: leagues.slug, name: leagues.name, season: leagues.season, format: leagues.format })
    .from(leagues)
    .where(eq(leagues.slug, leagueSlug))
    .limit(1);

  if (!league) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }
  // 404 rather than 400: to a public caller this path simply does not exist for other formats.
  if (league.format !== FPL_CLASSIC_FORMAT) {
    return NextResponse.json({ error: "Not an FPL Classic league" }, { status: 404 });
  }

  const payload = await buildClassicWinnersPayload({
    leagueId: league.id,
    leagueSlug: league.slug,
    leagueName: league.name,
    season: league.season,
  });
  if (!payload) {
    return NextResponse.json({ error: "League configuration not found" }, { status: 404 });
  }

  return NextResponse.json(payload);
}
