import { NextRequest, NextResponse } from "next/server";
import { processOneLeague, type LeaguePlanItem } from "@/lib/cron/process-all";
import { isSuperAdmin, SESSION_COOKIE_NAME } from "@/lib/auth";

export const maxDuration = 60;

/**
 * POST /api/admin/process-all/league
 * Body: { runId: string, league: LeaguePlanItem, dueGws: number[] }
 *
 * Runs score + generate + advance for ONE league across the supplied dueGws.
 * Returns LeagueResult. Each invocation is bounded by one league's work,
 * comfortably inside the 60s Hobby ceiling.
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin only" }, { status: 403 });
  }

  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { league?: LeaguePlanItem; dueGws?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.league || !Array.isArray(body.dueGws)) {
    return NextResponse.json({ error: "Missing league or dueGws" }, { status: 400 });
  }

  const baseUrl = request.nextUrl.origin;
  const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  const reprocess = request.nextUrl.searchParams.get("reprocess") === "true";

  try {
    const result = await processOneLeague(body.league, body.dueGws, { baseUrl, cookieHeader, reprocess });
    return NextResponse.json({ success: true, result });
  } catch (e) {
    return NextResponse.json(
      {
        error: "League run failed",
        message: e instanceof Error ? e.message : "unknown",
        leagueId: body.league.id,
        slug: body.league.slug,
      },
      { status: 500 }
    );
  }
}
