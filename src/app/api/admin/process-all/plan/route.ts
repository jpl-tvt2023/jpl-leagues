import { NextRequest, NextResponse } from "next/server";
import { computePlan } from "@/lib/cron/process-all";
import { isSuperAdmin } from "@/lib/auth";

export const maxDuration = 30;

/**
 * GET /api/admin/process-all/plan
 * Superadmin only. Builds the work list (dueGws + active leagues) and writes
 * CRON_RUN_START. Returns { runId, dueGws, leagues, globalErrors }.
 * Fast (~1-2s).
 */
export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin only" }, { status: 403 });
  }
  try {
    const plan = await computePlan();
    return NextResponse.json({ success: true, plan });
  } catch (e) {
    return NextResponse.json(
      { error: "Plan failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
