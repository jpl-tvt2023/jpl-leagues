import { NextRequest, NextResponse } from "next/server";
import { getActiveFplGameweek } from "@/lib/fpl/event-status";
import { isSuperAdmin } from "@/lib/auth";

export const maxDuration = 30;

/**
 * GET /api/admin/process-all/fpl-status
 * Superadmin only. Read-only: which gameweek FPL is currently on, which one last
 * concluded, and where that answer came from.
 *
 * Separate from /plan because the Operations tab shows this on mount — before any
 * button is pressed — and /plan writes a CRON_RUN_START audit row. Loading a tab
 * should not open a run in the audit log.
 */
export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin only" }, { status: 403 });
  }
  try {
    const fplStatus = await getActiveFplGameweek();
    return NextResponse.json({ success: true, fplStatus, checkedAt: Date.now() });
  } catch (e) {
    return NextResponse.json(
      { error: "FPL status check failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
