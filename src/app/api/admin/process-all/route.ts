import { NextRequest, NextResponse } from "next/server";
import { processAllLeagues } from "@/lib/cron/process-all";
import { isSuperAdmin, SESSION_COOKIE_NAME } from "@/lib/auth";

export const maxDuration = 60; // seconds — Vercel Hobby ceiling

/**
 * POST /api/admin/process-all
 *
 * Superadmin-only. Runs the same catch-up pipeline the cron used to:
 *  - For each active league × each due GW: score, generate (when applicable),
 *    advance (when applicable). Idempotent.
 *  - Returns a per-league summary with status badges + actionable error messages.
 *
 * Auth: middleware enforces a session cookie; this handler additionally
 * requires session-type=superadmin. We forward the same session cookie to
 * internal fetches so admin-route middleware lets them through.
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin only" }, { status: 403 });
  }

  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const baseUrl = request.nextUrl.origin;
  const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}`;

  try {
    const summary = await processAllLeagues({ baseUrl, cookieHeader });
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    console.error("process-all error:", error);
    return NextResponse.json(
      { error: "Run failed", message: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}
