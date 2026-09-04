/**
 * POST /api/superadmin/fpl-classic/[leagueId]/process
 *
 * The Operations tab's "Process" action. Superadmin-only, and deliberately NOT under
 * /api/admin/[leagueId]/ — this format has no league admins to assign, so it uses the
 * superadmin path directly and checks isSuperAdmin(request) rather than
 * getAuthorizedLeagueId(request) (which relies on the x-league-id header /api/admin/* routes get
 * from middleware; this route never gets that header).
 *
 * Body: `{ step？: "roster" | "settle" | "freeze", force?: boolean }`. Omitting `step` runs
 * roster → settle → freeze in one call — the common case. The browser is expected to call again
 * while `done` is false, exactly like the existing Operations tab's process-all loop.
 *
 * ⚠️ Two bounds keep one call inside the Vercel Hobby ceiling of 60s, and BOTH are load-bearing:
 * `ENTRANT_BATCH` caps how many entrants' histories a settle touches, and `SETTLE_DEADLINE_MS`
 * stops it fetching at 40s regardless of count. The count alone is not enough — the affordable
 * number depends on FPL latency, which varies by 2x and which this code cannot know up front.
 * This route once claimed to be "bounded" with ENTRANT_BATCH at 250, larger than most leagues, so
 * the cap never engaged: a 237-entrant league made ~237 paced FPL calls plus ~475 sequential DB
 * round-trips and was killed mid-sweep with a bare 504. A kill is worse than a short pass — it
 * skips sync.ts's `finally`, stranding the settle lock.
 *
 * This route — and this route alone — is where the expensive settle sweep can be triggered. No
 * public route does this; see the docblock on lib/fpl-classic/sync.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, leagues } from "@/lib/db";
import { eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
import { syncRoster, settleGameweeks, freezeAwards } from "@/lib/fpl-classic/sync";

export const maxDuration = 60;

export async function POST(request: NextRequest, { params }: { params: Promise<{ leagueId: string }> }) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { leagueId } = await params;
  const [league] = await db.select({ id: leagues.id, format: leagues.format }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (!league) return NextResponse.json({ error: "League not found" }, { status: 404 });
  if (league.format !== FPL_CLASSIC_FORMAT) return NextResponse.json({ error: "Not an FPL Classic league" }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const step: "roster" | "settle" | "freeze" | undefined = body.step;
  const force = body.force === true;

  try {
    if (step === "roster") {
      const result = await syncRoster(leagueId);
      return NextResponse.json({ ...result, done: true });
    }
    if (step === "settle") {
      const result = await settleGameweeks(leagueId);
      return NextResponse.json(result);
    }
    if (step === "freeze") {
      const result = await freezeAwards(leagueId, { force });
      return NextResponse.json({ ...result, done: true });
    }

    // No step given: the common case. Roster first (cheap, keeps names/totals current), then one
    // settle pass, then freeze whatever that settle pass made newly eligible.
    const rosterResult = await syncRoster(leagueId);
    const settleResult = await settleGameweeks(leagueId);
    const freezeResult = settleResult.ok ? await freezeAwards(leagueId) : { ok: true, frozen: [] as string[] };

    return NextResponse.json({
      ok: rosterResult.ok && settleResult.ok && freezeResult.ok,
      done: settleResult.done,
      settledThroughGw: settleResult.settledThroughGw,
      remainingEntrants: settleResult.remainingEntrants,
      frozen: freezeResult.frozen,
      rosterError: rosterResult.ok ? null : rosterResult.error,
      settleError: settleResult.ok ? null : settleResult.error,
    });
  } catch (error) {
    console.error("[fpl-classic process] failed:", error);
    return NextResponse.json({ error: "Processing failed", detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
