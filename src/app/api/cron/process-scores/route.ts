import { NextRequest, NextResponse } from "next/server";
import { processAllLeagues } from "@/lib/cron/process-all";

export const maxDuration = 60; // seconds — Vercel Hobby ceiling

/**
 * GET /api/cron/process-scores
 * Vercel Cron Job (kept for manual invocation via CRON_SECRET).
 * Real day-to-day usage now goes through the superadmin "Operations" tab,
 * which calls processAllLeagues() directly. This route is preserved so
 * `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/process-scores`
 * still works for emergencies / debugging.
 */
export async function GET(request: NextRequest) {
  const baseUrl = request.nextUrl.origin;
  const authHeader = request.headers.get("Authorization") ?? "";
  const force = request.nextUrl.searchParams.get("force") === "true";
  const reprocess = request.nextUrl.searchParams.get("reprocess") === "true";

  try {
    const summary = await processAllLeagues({ baseUrl, authHeader, force, reprocess });
    const ok = summary.globalErrors.length === 0 && summary.leagues.every(l => l.status !== "error");
    return NextResponse.json({ success: ok, summary }, { status: ok ? 200 : 500 });
  } catch (error) {
    console.error("Cron process-scores error:", error);
    return NextResponse.json(
      { error: "Cron job failed", message: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    );
  }
}
