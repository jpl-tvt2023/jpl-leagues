import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildFplLeagueStandings } from "@/lib/fpl-league/standings";

/**
 * GET /api/fpl-league?leagueSlug=slug[&gw=N]
 *
 * Player-level FPL standings: every manager in the league ranked by their
 * official FPL season total. Public, like /api/standings — it exposes nothing
 * a viewer could not read on the FPL site itself.
 *
 * Never throws on a bad or unreachable entry: a manager whose history could
 * not be read comes back flagged `pending` so the page can render a "—" row
 * rather than 500ing the whole table.
 */

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const leagueSlug = searchParams.get("leagueSlug");
    if (!leagueSlug) {
      return NextResponse.json({ error: "leagueSlug parameter required" }, { status: 400 });
    }

    const leagueRow = await db
      .select({ id: leagues.id, name: leagues.name, format: leagues.format })
      .from(leagues)
      .where(eq(leagues.slug, leagueSlug))
      .limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }

    const gwParam = searchParams.get("gw");
    const gw = gwParam ? Number(gwParam) : undefined;

    const standings = await buildFplLeagueStandings(leagueRow[0].id, {
      gw: Number.isFinite(gw) ? gw : undefined,
    });

    return NextResponse.json({ ...standings, leagueName: leagueRow[0].name });
  } catch (error) {
    console.error("FPL league standings error:", error);
    return NextResponse.json({ error: "Failed to load FPL standings" }, { status: 500 });
  }
}
