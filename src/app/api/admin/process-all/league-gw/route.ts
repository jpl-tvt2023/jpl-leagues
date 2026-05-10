import { NextRequest, NextResponse } from "next/server";
import { processOneLeagueOneGw, type LeaguePlanItem } from "@/lib/cron/process-all";
import { isSuperAdmin } from "@/lib/auth";

export const maxDuration = 60;

/**
 * POST /api/admin/process-all/league-gw
 * Body: { runId: string, league: LeaguePlanItem, gw: number }
 *
 * Runs score + generate + advance for ONE league × ONE gameweek. Each call is
 * bounded by a single GW's worth of work — well under the 60s Hobby ceiling
 * even for 32T. The browser orchestrates the league × gw nested loop and shows
 * live per-GW progress chips inside each league card.
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin only" }, { status: 403 });
  }

  let body: { league?: LeaguePlanItem; gw?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.league || typeof body.gw !== "number") {
    return NextResponse.json({ error: "Missing league or gw" }, { status: 400 });
  }

  const baseUrl = request.nextUrl.origin;

  try {
    const result = await processOneLeagueOneGw(body.league, body.gw, { baseUrl });
    return NextResponse.json({ success: true, result });
  } catch (e) {
    return NextResponse.json(
      {
        error: "League-GW run failed",
        message: e instanceof Error ? e.message : "unknown",
        leagueId: body.league.id,
        slug: body.league.slug,
        gw: body.gw,
      },
      { status: 500 }
    );
  }
}
