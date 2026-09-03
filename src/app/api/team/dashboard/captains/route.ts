/**
 * GET /api/team/dashboard/captains?gw=N
 *
 * One gameweek's league-wide captain and chip announcements, for the dashboard card's gameweek
 * navigator. Split out from /api/team/dashboard so stepping back a gameweek costs one small
 * query set rather than rebuilding that route's very large payload.
 *
 * ⚠️ DISCLOSURE GATE. `gw` is validated against `availableGws`, which ends at the current
 * gameweek. A chip is written when it is DECLARED, which can be well before its gameweek's
 * deadline, so serving a future gameweek here would let a team read their opponent's chip before
 * choosing their own — the same hazard /api/fixtures guards with its past-deadline filter. The
 * rejection must stay server-side: a client-only clamp is not an access control.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, teams } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  buildLeagueCaptains,
  findGameweekId,
  resolveCaptainsWindow,
} from "@/lib/dashboard/league-captains";

export async function GET(request: NextRequest) {
  try {
    // Middleware has already verified the session and that it is a team session.
    const teamId = request.headers.get("x-session-id");
    if (!teamId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [team] = await db
      .select({ id: teams.id, leagueId: teams.leagueId })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    if (!team?.leagueId) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const league = await db.query.leagues.findFirst({
      where: (l, { eq: eqOp }) => eqOp(l.id, team.leagueId!),
      columns: { format: true },
    });

    const window = await resolveCaptainsWindow(team.leagueId);
    if (!window) {
      return NextResponse.json({ error: "League has no gameweeks" }, { status: 404 });
    }

    const raw = request.nextUrl.searchParams.get("gw");
    const gw = raw === null ? window.defaultGw : Number(raw);
    if (!Number.isInteger(gw) || !window.availableGws.includes(gw)) {
      // Deliberately specific: a reader stepping past the edge should be told the range, not
      // silently handed the default, which would look like the navigator was broken.
      return NextResponse.json(
        {
          error: `Gameweek ${raw} is not available. Announcements are shown up to GW${window.defaultGw}.`,
          defaultGw: window.defaultGw,
          availableGws: window.availableGws,
        },
        { status: 400 },
      );
    }

    const gameweekId = await findGameweekId(team.leagueId, gw);
    if (!gameweekId) {
      return NextResponse.json({ error: `GW${gw} not found` }, { status: 404 });
    }

    const leagueCaptains = await buildLeagueCaptains({
      leagueId: team.leagueId,
      gameweekId,
      viewerTeamId: team.id,
      leagueFormat: league?.format ?? "tvt",
    });

    return NextResponse.json({
      gameweek: gw,
      defaultGw: window.defaultGw,
      availableGws: window.availableGws,
      leagueCaptains,
    });
  } catch (error) {
    console.error("Dashboard captains error:", error);
    return NextResponse.json({ error: "Failed to load captain announcements" }, { status: 500 });
  }
}
