/**
 * GET /api/superadmin/fpl-classic/preview?fplLeagueId=123
 *
 * The wizard's "Verify league" step: confirms an FPL classic league id is real before the
 * superadmin commits to creating anything, and shows what they're about to get. Superadmin-only
 * — this hits FPL on every call, unlike the public standings route which is cache-first.
 */

import { NextRequest, NextResponse } from "next/server";
import { isSuperAdmin } from "@/lib/auth";
import { fetchClassicLeagueStandings, FplClassicLeagueNotFoundError } from "@/lib/fpl/classic-league";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const fplLeagueId = Number(searchParams.get("fplLeagueId"));
  if (!Number.isInteger(fplLeagueId) || fplLeagueId <= 0) {
    return NextResponse.json({ error: "fplLeagueId must be a positive integer" }, { status: 400 });
  }

  try {
    const payload = await withFplBudget(
      { lane: "background", label: "fpl-classic preview", max: 30 },
      () => fetchClassicLeagueStandings(fplLeagueId, { lane: "background" }),
    );
    return NextResponse.json({
      name: payload.league.name,
      startEvent: payload.league.startEvent,
      entrantCount: payload.entries.length,
      truncated: payload.truncated,
      sample: payload.entries.slice(0, 5).map((e) => ({ entryName: e.entryName, playerName: e.playerName })),
    });
  } catch (err) {
    if (err instanceof FplClassicLeagueNotFoundError) {
      return NextResponse.json({ error: `No FPL league found with id ${fplLeagueId}` }, { status: 404 });
    }
    if (err instanceof FplUnavailableError) {
      return NextResponse.json({ error: "FPL is temporarily unavailable — try again in a moment" }, { status: 503 });
    }
    console.error("[fpl-classic preview] failed:", err);
    return NextResponse.json({ error: "Failed to reach FPL" }, { status: 500 });
  }
}
