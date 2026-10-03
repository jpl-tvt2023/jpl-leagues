/**
 * POST /api/superadmin/fpl-classic/[leagueId]/process
 *
 * The Operations tab's "Process" action. Superadmin-only, and deliberately NOT under
 * /api/admin/[leagueId]/ — this format has no league admins to assign, so it uses the
 * superadmin path directly and checks isSuperAdmin(request) rather than
 * getAuthorizedLeagueId(request) (which relies on the x-league-id header /api/admin/* routes get
 * from middleware; this route never gets that header).
 *
 * Body: `{ step？: "roster" | "settle" | "freeze", force?: boolean, skipRoster?: boolean }`.
 * Omitting `step` runs roster → settle → freeze in one call — the common case ("All pending"). The
 * browser is expected to call again while `done` is false, exactly like the existing Operations
 * tab's process-all loop. It sends `skipRoster: true` after the first pass: the roster cannot
 * usefully change between passes of one run, and re-syncing it cost an FPL standings fetch plus a
 * write per changed entrant every time. Freeze runs only on the pass that reports `done` — nothing
 * becomes eligible until the cursor moves, and it moves to its final value on that pass.
 *
 * Body `{ gw: number, offset?: number }` instead re-fetches that ONE gameweek for every entrant and
 * overwrites the stored rows ("Process GWn") — see refreshGameweek. Paged by `offset`; the browser
 * passes back `nextOffset` until `done`. Frozen awards are never touched by it: the final pass only
 * freezes scopes that have newly become eligible. A gameweek out of range is a 400.
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
import { syncRoster, settleGameweeks, refreshGameweek, freezeAwards } from "@/lib/fpl-classic/sync";

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
  const skipRoster = body.skipRoster === true;

  try {
    if (body.gw !== undefined) {
      const gw = Number(body.gw);
      const result = await refreshGameweek(leagueId, gw, { offset: Number(body.offset) || 0 });
      if (result.invalid) return NextResponse.json({ error: result.error }, { status: 400 });
      const freezeResult = result.ok && result.done ? await freezeAwards(leagueId) : { ok: true, frozen: [] as string[] };
      return NextResponse.json({
        ...result,
        frozen: freezeResult.frozen,
        // Same field the default path uses, so the browser has one place to look for a stop reason.
        settleError: result.ok ? null : result.error,
      });
    }

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

    // No step given: the common case. Roster first (keeps names/totals current — first pass only),
    // then one settle pass, then — once the sweep is done — freeze whatever it made newly eligible.
    const rosterResult = skipRoster ? { ok: true as const, error: undefined } : await syncRoster(leagueId);
    const settleResult = await settleGameweeks(leagueId);
    const freezeResult = settleResult.ok && settleResult.done ? await freezeAwards(leagueId) : { ok: true, frozen: [] as string[] };

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
