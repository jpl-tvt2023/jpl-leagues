import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildFplLeagueStandings } from "@/lib/fpl-league/standings";
import { buildFplLeagueTeamStats, EMPTY_TEAM_STATS } from "@/lib/fpl-league/team-stats";

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
      .select({
        id: leagues.id,
        name: leagues.name,
        format: leagues.format,
        playoffStartGw: leagues.playoffStartGw,
        enabledChips: leagues.enabledChips,
      })
      .from(leagues)
      .where(eq(leagues.slug, leagueSlug))
      .limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }

    const gwParam = searchParams.get("gw");
    const gw = gwParam ? Number(gwParam) : undefined;

    // warm=1 is what the page asks for AFTER it has painted. A plain read
    // must stay instant, so it never fetches.
    const standings = await buildFplLeagueStandings(leagueRow[0].id, {
      gw: Number.isFinite(gw) ? gw : undefined,
      warm: searchParams.get("warm") === "1",
    });

    // Team-level stats (TVT chip availability + captaincies used) run AFTER the standings
    // rather than alongside them: `currentSet` is derived from the gameweek the standings
    // builder resolved, and — more importantly — a rejected Promise.all would 500 the whole
    // table over one malformed chip row, breaking this route's "never throws" contract above.
    // These are indexed DB reads bounded by league size, so serialising them costs nothing
    // next to the FPL warm pass. On failure the page falls back to its flat manager table.
    //
    // Recomputed on EVERY request including warm polls: the page replaces its whole payload
    // on each poll, so stats sent only on the cold read would blank out seconds after paint.
    let teamStats = EMPTY_TEAM_STATS;
    try {
      teamStats = await buildFplLeagueTeamStats({
        leagueId: leagueRow[0].id,
        format: leagueRow[0].format,
        playoffStartGw: leagueRow[0].playoffStartGw,
        enabledChipsJson: leagueRow[0].enabledChips,
        headerGw: standings.gw,
      });
    } catch (err) {
      console.warn("[fpl-league] team stats failed; serving manager rows only", err);
    }

    return NextResponse.json({ ...standings, ...teamStats, leagueName: leagueRow[0].name });
  } catch (error) {
    console.error("FPL league standings error:", error);
    return NextResponse.json({ error: "Failed to load FPL standings" }, { status: 500 });
  }
}
