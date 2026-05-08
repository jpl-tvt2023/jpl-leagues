import { NextRequest, NextResponse } from "next/server";
import { finishRun, type LeagueResult } from "@/lib/cron/process-all";
import { isSuperAdmin, SESSION_COOKIE_NAME } from "@/lib/auth";

export const maxDuration = 60;

/**
 * POST /api/admin/process-all/finish
 * Body: { runId: string, dueGws: number[], results: LeagueResult[], globalErrors: string[] }
 *
 * Writes the CRON_RUN_END audit row, populates live FPL cache for any in-progress
 * GW, and pre-warms standings/fixtures/playoffs caches per league.
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin only" }, { status: 403 });
  }

  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { runId?: string; dueGws?: number[]; results?: LeagueResult[]; globalErrors?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.runId || !Array.isArray(body.dueGws) || !Array.isArray(body.results)) {
    return NextResponse.json({ error: "Missing runId / dueGws / results" }, { status: 400 });
  }

  const baseUrl = request.nextUrl.origin;
  const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}`;

  try {
    await finishRun(body.runId, body.dueGws, body.results, body.globalErrors ?? [], { baseUrl, cookieHeader });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: "Finish failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
