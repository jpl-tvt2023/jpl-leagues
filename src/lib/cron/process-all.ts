/**
 * Catch-up engine for the superadmin "Run Auto-Processing" flow.
 *
 * Split into three exports so each per-league call stays well under the
 * Vercel Hobby 60-second function ceiling:
 *  - computePlan()       → builds the work list + writes CRON_RUN_START
 *  - processOneLeague()  → runs score + generate + advance for ONE league
 *  - finishRun()         → writes CRON_RUN_END + pre-warms page caches
 *
 * The superadmin browser stitches these together: `/plan` → loop `/league` per
 * league → `/finish`. Because each HTTP call is small, the wall-clock total can
 * grow without ever tripping a single function's 60s budget.
 */

import { NextRequest } from "next/server";
import { db, gameweeks, fixtures, leagues, auditLogs, results } from "@/lib/db";
import { gameweekCaptains, playoffTies } from "@/lib/db/schema";
import { asc, eq, and, isNull, ne, or } from "drizzle-orm";
import { detectLiveGameweek, fetchTeamGameweekPicks } from "@/lib/fpl";
import { getGameweekConclusion, getActiveFplGameweek, type ActiveGameweek } from "@/lib/fpl/event-status";
import { syncGameweekDeadlines } from "@/lib/gameweeks/sync-deadlines";
import { clearLiveCache, setLiveCachedScores, invalidateLeaguePageCache, markScoringActive, clearScoringActive } from "@/lib/fpl-cache";
import { processAuctionGameweek } from "@/lib/formats/auction/process-gameweek";
import { getPlayoffAdvanceGws, getPlayoffGenerateAction } from "@/lib/playoffs/advance-windows";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";
import { generateId } from "@/lib/id";
import { writeAutoSnapshot } from "@/lib/backup/snapshot";

// In-process handler imports — bypass Vercel's edge / Deployment Protection
// entirely. Each handler is just an async function; we invoke it directly with
// a constructed NextRequest and superadmin headers (mimicking what middleware
// would have set), then read its NextResponse like any normal Response.
import { POST as scorePost } from "@/app/api/gameweeks/[gw]/route";
import { POST as generatePlayoffsPost } from "@/app/api/admin/[leagueId]/generate-playoffs/route";
import { POST as generateBracketsPost } from "@/app/api/admin/[leagueId]/generate-brackets/route";
import { advancePlayoffsImpl } from "@/app/api/admin/[leagueId]/advance-playoffs/route";

/**
 * Invoke another route's POST handler directly (no HTTP, no edge layer).
 * Constructs a NextRequest with admin session headers — middleware would
 * normally inject these, but we skip middleware so we set them ourselves.
 */
async function callHandlerDirect<T>(
  handler: (req: NextRequest, ctx: T) => Promise<Response>,
  url: string,
  ctx: T,
  opts?: { body?: unknown; leagueId?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    // Mimic the headers middleware would inject — we're skipping the HTTP layer.
    "x-session-id": "superadmin-orchestrator",
    "x-session-type": "superadmin",
  };
  // For routes that authorise via getAuthorizedLeagueId (reads x-league-id),
  // surface the leagueId here so handlers see it.
  if (opts?.leagueId) headers["x-league-id"] = opts.leagueId;
  if (opts?.body !== undefined) headers["Content-Type"] = "application/json";

  const req = new NextRequest(url, {
    method: "POST",
    headers,
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const res = await handler(req, ctx);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = await res.json();
  } catch { /* empty body — leave parsed as {} */ }
  return { status: res.status, body: parsed };
}

export type LeaguePlanItem = {
  id: string;
  slug: string;
  format: string;
  teamSize: number | null;
  playoffStartGw: number | null;
};

export type Plan = {
  runId: string;
  dueGws: number[];
  leagues: LeaguePlanItem[];
  globalErrors: string[];   // GWs skipped because FPL not finalized, FPL unreachable, etc.
  /** What FPL itself is currently on — rendered in the Operations header. */
  fplStatus: ActiveGameweek;
};

export type LeagueResult = {
  leagueId: string;
  slug: string;
  format: string;
  status: "ok" | "partial" | "error" | "skipped";
  scoredGws: number[];
  advancedGws: number[];
  generatedFor: number[];
  generatedAlready: number[];      // generate fired but bracket already existed (no-op success)
  advanceWindowFuture: number[];   // advance window GWs blocked because the GW hasn't concluded on FPL yet
  errors: Array<{ gw?: number; step: "score" | "generate" | "advance" | "auction" | "league" | "request"; message: string }>;
};

/**
 * Per-(league × gameweek) result returned by the /league-gw endpoint.
 * Each field is a single boolean — work was done, skipped, or errored for THIS GW.
 * The browser aggregates these into the LeagueResult shape for the league card.
 */
export type LeagueGwResult = {
  leagueId: string;
  slug: string;
  gw: number;
  status: "ok" | "skipped" | "error";  // skipped = nothing was needed
  scored: boolean;            // score handler ran AND produced new results
  scoreSkipped: boolean;      // pre-flight saw nothing to score
  generated: boolean;         // generate fired (created new bracket)
  generatedAlready: boolean;  // generate fired but bracket already existed
  advanced: boolean;          // advance dispatcher fired AND did work
  advanceSkipped: boolean;    // advance window matched but nothing pending
  advanceWindowFuture: boolean; // gw is in advance window but not in dueGws (hasn't concluded on FPL)
  errors: Array<{ step: "score" | "generate" | "advance" | "auction"; message: string }>;
};

interface FetchInput {
  baseUrl: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

type FinalizeStatus = { ok: true } | { ok: false; reason: string };

/**
 * Is this gameweek settled enough to score?
 *
 * Delegates to `getGameweekConclusion`, which requires every PL fixture finished AND
 * FPL to have confirmed bonus points, read from /event-status/ + /fixtures/ with
 * bootstrap-static as the fallback. It returns a precise reason when the GW is not
 * eligible, so the UI can show "3 of 10 PL fixtures still in progress" or "bonus
 * points not yet confirmed by FPL" rather than a single generic "not finalized" line.
 *
 * This gate is deliberately STRICTER than the team-submission gate
 * (getFinishedGwNumbers), which opens as soon as the matches end. Here we are writing
 * points into league tables, so waiting for bonus to stop moving is the point.
 */
async function isGwFinalized(gw: number): Promise<FinalizeStatus> {
  // Critical lane: this is the scoring pipeline, and a gateway refusal here would
  // silently skip a gameweek that is genuinely ready.
  const { concluded, source, detail } = await getGameweekConclusion(gw, "critical");
  if (concluded) return { ok: true };
  const prefix = source === "unavailable" ? "" : `[${source}] `;
  return { ok: false, reason: `${prefix}${detail}` };
}

function messageFrom(e: unknown): string {
  return e instanceof Error ? e.message : "unknown error";
}


/* ────────────────────────────────────────────────────────────────────────── */
/*  computePlan — fast, used by the /plan endpoint                            */
/* ────────────────────────────────────────────────────────────────────────── */

export async function computePlan(): Promise<Plan> {
  const runId = generateId();
  const buildSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
  const globalErrors: string[] = [];

  try {
    await db.insert(auditLogs).values({
      id: runId,
      type: "CRON_RUN_START",
      description: `process-all started (build ${buildSha})`,
      pointsAffected: 0,
    });
  } catch (e) {
    console.error("computePlan: CRON_RUN_START write failed:", e);
  }

  // fpl-classic is excluded here, not merely absent by accident. It creates no `gameweeks` rows,
  // so it contributes nothing to `dueGws` below — but this is a SEPARATE query, and without the
  // exclusion the league still landed in `plan.leagues` and still received one
  // POST /api/admin/process-all/league-gw per due gameweek. Those no-op safely (the pre-flight in
  // processOneLeagueOneGw finds nothing unscored and sets scoreSkipped), but they burn round-trips
  // against the 30-POST/min cap and put a confusing "skipped" row in the Operations table for a
  // league that is processed from its own section entirely.
  const activeLeagues = await db
    .select({
      id: leagues.id,
      slug: leagues.slug,
      format: leagues.format,
      teamSize: leagues.teamSize,
      playoffStartGw: leagues.playoffStartGw,
    })
    .from(leagues)
    .where(and(eq(leagues.isActive, true), ne(leagues.format, FPL_CLASSIC_FORMAT)));

  // What FPL itself is on right now. Surfaced in the Operations header so an
  // operator can see whether a run is worth starting before starting it.
  const fplStatus = await getActiveFplGameweek("critical");
  if (fplStatus.source === "unavailable") {
    globalErrors.push(`FPL unreachable: ${fplStatus.detail}`);
  }

  // Build the dueGws set: deadline passed AND the gameweek has concluded per FPL.
  // No force-bypass — emergency reprocess belongs in per-league admin.
  const allGameweeks = await db.select().from(gameweeks).orderBy(asc(gameweeks.number));
  const now = new Date();
  const dueByNumber = new Set<number>();
  const rejectedByNumber = new Map<number, string>();
  const conclusionByNumber = new Map<number, FinalizeStatus>();

  // Auction leagues have no fixtures at all — create-gameweeks seeds GW rows and
  // generate-fixtures is TVT/CC-only — so "has fixtures" cannot be a precondition
  // for their gameweeks. It also must not be evaluated before the dedupe, which is
  // the bug this replaces: `seen` was marked before the fixtures check, so whenever
  // an auction league's row for a GW number happened to sort first, that gameweek
  // was dropped for EVERY league, silently and non-deterministically.
  const fixturelessFormats = new Set(["auction"]);
  const formatByLeagueId = new Map(activeLeagues.map((l) => [l.id, l.format]));

  for (const gw of allGameweeks) {
    if (gw.deadline > now) continue;
    if (dueByNumber.has(gw.number)) continue;

    const format = formatByLeagueId.get(gw.leagueId);
    // Gameweek rows for inactive leagues aren't our business.
    if (format === undefined) continue;

    if (!fixturelessFormats.has(format)) {
      const fxRows = await db
        .select({ id: fixtures.id })
        .from(fixtures)
        .where(eq(fixtures.gameweekId, gw.id));
      // No fixtures for this league's GW — nothing to score HERE, but another
      // league may still have work at the same GW number, so keep looking.
      if (fxRows.length === 0) continue;
    }

    // Memoized per GW NUMBER, not per row: late in the season this loop sees ~38
    // gameweeks x every active league, and the conclusion check is identical for
    // all leagues sharing a number. /plan runs on a 30s budget.
    let status = conclusionByNumber.get(gw.number);
    if (!status) {
      status = await isGwFinalized(gw.number);
      conclusionByNumber.set(gw.number, status);
    }
    if (!status.ok) {
      // One notice per GW number, not one per league that shares it.
      if (!rejectedByNumber.has(gw.number)) rejectedByNumber.set(gw.number, status.reason);
      continue;
    }
    dueByNumber.add(gw.number);
  }

  for (const [gwNumber, reason] of rejectedByNumber) {
    if (dueByNumber.has(gwNumber)) continue;
    globalErrors.push(`GW${gwNumber}: ${reason} — skipped`);
  }

  const dueGws = [...dueByNumber].sort((a, b) => a - b);

  return {
    runId,
    dueGws,
    leagues: activeLeagues,
    globalErrors,
    fplStatus,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  hasAdvanceWork — fast skip-when-done guard for advance dispatcher         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Returns true iff any playoff_ties row touching this GW is not yet `complete`.
 * Catches the common case where every tie in the GW's window is already
 * resolved AND every next-round tie was already created (idempotent inserts) —
 * in which case the heavy advance dispatcher would just spend ~10s of reads
 * for a pure no-op. Skipping it shaves the bulk of catch-up runs.
 */
async function hasAdvanceWork(leagueId: string, gw: number): Promise<boolean> {
  const pending = await db
    .select({ tieId: playoffTies.tieId })
    .from(playoffTies)
    .where(and(
      eq(playoffTies.leagueId, leagueId),
      or(
        eq(playoffTies.gw1, gw),
        eq(playoffTies.gw2, gw),
        eq(playoffTies.gw3, gw),
      ),
      ne(playoffTies.status, "complete"),
    ))
    .limit(1);
  return pending.length > 0;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  processOneLeagueOneGw — used by /league-gw endpoint                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Process score + generate + advance for ONE league × ONE gameweek.
 * Bounded ≤ ~5-15s; well under the Vercel Hobby 60s ceiling.
 *
 * The browser orchestrates calling this for every (league, gw) pair so the UI
 * can render live per-GW progress chips. The legacy `processOneLeague` below
 * loops this function for the cron-fallback / single-shot code path.
 */
export async function processOneLeagueOneGw(
  league: LeaguePlanItem,
  gw: number,
  input: FetchInput,
): Promise<LeagueGwResult> {
  const result: LeagueGwResult = {
    leagueId: league.id,
    slug: league.slug,
    gw,
    status: "ok",
    scored: false,
    scoreSkipped: false,
    generated: false,
    generatedAlready: false,
    advanced: false,
    advanceSkipped: false,
    advanceWindowFuture: false,
    errors: [],
  };

  // League-scoped: the readers all pass a leagueSlug, so the key they hit is
  // live:gw{N}:{leagueId}. Clearing the bare live:gw{N}:all left the real one
  // serving pre-scoring captain data for its full retention window.
  try { await clearLiveCache(gw, league.id); } catch { /* non-fatal */ }

  // ── Score ──
  // Per-GW pre-flight: are there any unscored fixtures for this league at this GW?
  // If not, skip the heavy handler entirely. Auction format always goes through its
  // own processor (different scoring model — doesn't use the results table the same way).
  if (league.format === "auction") {
    try {
      const gwRow = await db
        .select()
        .from(gameweeks)
        .where(and(eq(gameweeks.leagueId, league.id), eq(gameweeks.number, gw)))
        .limit(1);
      if (gwRow.length > 0) {
        await processAuctionGameweek(gwRow[0].id, gw, league.id, false);
        await invalidateLeaguePageCache(league.id).catch((err) =>
          console.error("[cron/process-all] standings cache invalidation failed:", err)
        );
        result.scored = true;
      } else {
        result.scoreSkipped = true;
      }
    } catch (e) {
      result.errors.push({ step: "auction", message: messageFrom(e) });
    }
  } else {
    let unscoredCount = 0;
    try {
      const rows = await db
        .select({ id: fixtures.id })
        .from(gameweeks)
        .innerJoin(fixtures, eq(fixtures.gameweekId, gameweeks.id))
        .leftJoin(results, eq(results.fixtureId, fixtures.id))
        .where(and(
          eq(gameweeks.leagueId, league.id),
          eq(gameweeks.number, gw),
          isNull(results.id),
        ))
        .limit(1);
      unscoredCount = rows.length;
    } catch (e) {
      result.errors.push({ step: "score", message: `Pre-flight failed: ${messageFrom(e)}` });
    }

    if (unscoredCount === 0 && result.errors.length === 0) {
      result.scoreSkipped = true;
    } else {
      try {
        const url = `${input.baseUrl}/api/gameweeks/${gw}?leagueId=${encodeURIComponent(league.id)}`;
        const { status, body } = await callHandlerDirect(
          scorePost,
          url,
          { params: Promise.resolve({ gw: String(gw) }) },
        );
        const b = body as { processed?: number; failed?: number; errors?: unknown[]; error?: string };
        if (status >= 400) {
          result.errors.push({ step: "score", message: `HTTP ${status}: ${b.error ?? "unknown"}` });
        } else {
          const processed = b.processed ?? 0;
          const failed = b.failed ?? b.errors?.length ?? 0;
          if (processed > 0) {
            result.scored = true;
          } else if (failed === 0) {
            result.scoreSkipped = true;
          } else {
            result.errors.push({ step: "score", message: `Processed 0 fixtures (${failed} FPL fetch errors — likely future GW)` });
          }
        }
      } catch (e) {
        result.errors.push({ step: "score", message: messageFrom(e) });
      }
    }
  }

  // ── Generate (only at this league's trigger GW) ──
  const action = getPlayoffGenerateAction(league.format, league.teamSize ?? 32, league.playoffStartGw ?? 31, gw);
  if (action) {
    try {
      const url = `${input.baseUrl}/api/admin/${league.id}/${action.endpoint}`;
      const handler = action.endpoint === "generate-brackets" ? generateBracketsPost : generatePlayoffsPost;
      const { status, body } = await callHandlerDirect(
        handler,
        url,
        { params: Promise.resolve({ leagueId: league.id }) },
        { leagueId: league.id },
      );
      const b = body as { error?: string };
      if (status >= 200 && status < 300) {
        result.generated = true;
      } else if ((b.error ?? "").toLowerCase().includes("already")) {
        result.generatedAlready = true;
      } else {
        result.errors.push({ step: "generate", message: `HTTP ${status}: ${b.error ?? "unknown"}` });
      }
    } catch (e) {
      result.errors.push({ step: "generate", message: messageFrom(e) });
    }
  }

  // ── Advance (only if this GW is in the league's playoff window) ──
  const advanceWindow = getPlayoffAdvanceGws(league.format, league.teamSize ?? 32, league.playoffStartGw ?? 31);
  if (advanceWindow.has(gw)) {
    // Fast skip: every tie touching this GW is already complete → dispatcher would no-op.
    let pending = false;
    try {
      pending = await hasAdvanceWork(league.id, gw);
    } catch (e) {
      result.errors.push({ step: "advance", message: `hasAdvanceWork failed: ${messageFrom(e)}` });
    }
    if (!pending && result.errors.length === 0) {
      result.advanceSkipped = true;
    } else if (pending) {
      try {
        const { status, body } = await advancePlayoffsImpl(league.id, gw);
        if (status >= 200 && status < 300) {
          result.advanced = true;
        } else {
          const b = body as { error?: string };
          result.errors.push({ step: "advance", message: `HTTP ${status}: ${b.error ?? "unknown"}` });
        }
      } catch (e) {
        result.errors.push({ step: "advance", message: messageFrom(e) });
      }
    }
  }

  // ── Per-GW auto-snapshot ──
  // Capture league state after every successful GW so admins can roll back to any past gameweek.
  // Fires after either real scoring work OR a pre-flight skip (already scored). Idempotent —
  // re-running the cron for the same GW doesn't write duplicate rows. Wrapped so a snapshot
  // failure never breaks the scoring response.
  if ((result.scored || result.scoreSkipped) && result.errors.length === 0) {
    try {
      await writeAutoSnapshot(league.id, `gw${gw}-auto`);
    } catch (e) {
      console.error(`GW${gw} snapshot for ${league.slug} failed:`, e);
    }
  }

  // Final per-GW status
  const didAnyWork = result.scored || result.generated || result.advanced;
  const wasFullySkipped = !didAnyWork && (result.scoreSkipped || result.generatedAlready || result.advanceSkipped);
  if (result.errors.length > 0) {
    result.status = "error";
  } else if (didAnyWork) {
    result.status = "ok";
  } else if (wasFullySkipped) {
    result.status = "skipped";
  } else {
    // No work, no skip-marker — e.g. an early-GW outside any playoff window where score was already done.
    result.status = "skipped";
  }

  return result;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  processOneLeague — legacy wrapper that loops processOneLeagueOneGw        */
/* ────────────────────────────────────────────────────────────────────────── */

/** Used by `processAllLeagues` (cron-fallback path). Aggregates per-GW results into LeagueResult. */
export async function processOneLeague(
  league: LeaguePlanItem,
  dueGws: number[],
  input: FetchInput,
): Promise<LeagueResult> {
  const result: LeagueResult = {
    leagueId: league.id,
    slug: league.slug,
    format: league.format,
    status: "ok",
    scoredGws: [],
    advancedGws: [],
    generatedFor: [],
    generatedAlready: [],
    advanceWindowFuture: [],
    errors: [],
  };

  // Reconcile our gameweeks.deadline column with FPL's current truth once per
  // league before processing. Mid-season FPL deadline shifts would otherwise
  // leave the in-flight GW detection and live-mode triggers slightly off. The
  // sync is idempotent and bootstrap-cached, so this is cheap. Failures here
  // must NEVER block scoring — wrap in try/catch.
  try {
    await syncGameweekDeadlines(league.id);
  } catch (syncErr) {
    console.warn(`[process-all] sync-deadlines failed for league ${league.slug}:`, messageFrom(syncErr));
  }

  try {
    for (const gw of dueGws) {
      const gwRes = await processOneLeagueOneGw(league, gw, input);
      mergeGwIntoLeagueResult(result, gwRes);
    }
  } catch (outerErr) {
    result.errors.push({ step: "league", message: `League-level failure: ${messageFrom(outerErr)}` });
  }

  // Advance-window GWs that aren't in this run's dueGws (FPL not finalized yet).
  try {
    const advanceWindow = getPlayoffAdvanceGws(league.format, league.teamSize ?? 32, league.playoffStartGw ?? 31);
    const dueSet = new Set(dueGws);
    const advancedSet = new Set(result.advancedGws);
    for (const gw of advanceWindow) {
      if (!dueSet.has(gw) && !advancedSet.has(gw)) {
        result.advanceWindowFuture.push(gw);
      }
    }
    result.advanceWindowFuture.sort((a, b) => a - b);
  } catch { /* non-fatal */ }

  const didAnyWork = result.scoredGws.length + result.advancedGws.length + result.generatedFor.length + result.generatedAlready.length > 0;
  if (result.errors.length === 0) {
    result.status = didAnyWork ? "ok" : "skipped";
  } else {
    result.status = didAnyWork ? "partial" : "error";
  }
  return result;
}

/** Merge a single per-GW result into the league-aggregate shape. Exported so the browser can reuse it. */
export function mergeGwIntoLeagueResult(agg: LeagueResult, gwRes: LeagueGwResult): void {
  // "scored" in the aggregate means "this GW is fully scored" — covers both
  // cases where we did real work and where pre-flight confirmed it was already done.
  if (gwRes.scored || gwRes.scoreSkipped) agg.scoredGws.push(gwRes.gw);
  if (gwRes.advanced) agg.advancedGws.push(gwRes.gw);
  if (gwRes.generated) agg.generatedFor.push(gwRes.gw);
  if (gwRes.generatedAlready) agg.generatedAlready.push(gwRes.gw);
  for (const e of gwRes.errors) {
    agg.errors.push({ gw: gwRes.gw, step: e.step, message: e.message });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  finishRun — used by /finish endpoint                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export async function finishRun(
  runId: string,
  dueGws: number[],
  results: LeagueResult[],
  globalErrors: string[],
  input: FetchInput,
): Promise<void> {
  // Live cache populate for whichever GW FPL says is in-progress (best-effort).
  try {
    const { liveGw } = await detectLiveGameweek();
    if (liveGw && liveGw >= 31 && liveGw <= 38) {
      await fetchAndCacheLiveScores(liveGw);
    }
  } catch (e) {
    console.error("finishRun: live-cache fetch failed:", e);
  }

  // (Pre-warm dropped — was using internal HTTP fetches that get bounced by
  // Vercel Deployment Protection. The standings/fixtures/playoffs caches will
  // repopulate on the next user visit; no functional regression.)

  // Write CRON_RUN_END audit row with the rolled-up summary.
  try {
    await db.insert(auditLogs).values({
      id: generateId(),
      type: "CRON_RUN_END",
      description: `process-all finished | runId=${runId} | ${JSON.stringify({
        dueGws,
        leagues: results.map(l => ({
          slug: l.slug, status: l.status,
          scored: l.scoredGws.length, advanced: l.advancedGws.length,
          generated: l.generatedFor.length, errors: l.errors.length,
        })),
        globalErrors: globalErrors.length,
      })}`.slice(0, 1900),
      pointsAffected: 0,
    });
  } catch (e) {
    console.error("finishRun: CRON_RUN_END write failed:", e);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  processAllInOne — convenience for the cron route fallback                 */
/* ────────────────────────────────────────────────────────────────────────── */

export type Summary = {
  runId: string;
  dueGws: number[];
  leagues: LeagueResult[];
  globalErrors: string[];
};

/** Server-side single-shot orchestration. Used by /api/cron/process-scores. */
export async function processAllLeagues(input: FetchInput): Promise<Summary> {
  // Hold the scoring lock for the whole run. While it is set the FPL gateway
  // refuses every background (user-facing) call, so this run gets the entire
  // request budget. A scoring failure writes a wrong league table; a page
  // showing stale numbers for a couple of minutes does not.
  await markScoringActive();
  try {
    const plan = await computePlan();
    const results: LeagueResult[] = [];
    for (const lg of plan.leagues) {
      // Refresh the lock between leagues so a long run cannot let its own TTL lapse.
      await markScoringActive();
      const r = await processOneLeague(lg, plan.dueGws, input);
      results.push(r);
    }
    await finishRun(plan.runId, plan.dueGws, results, plan.globalErrors, input);
    return {
      runId: plan.runId,
      dueGws: plan.dueGws,
      leagues: results,
      globalErrors: plan.globalErrors,
    };
  } finally {
    await clearScoringActive();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Live-score caching helpers (lifted from the old cron route)               */
/* ────────────────────────────────────────────────────────────────────────── */

async function fetchAndCacheLiveScores(gameweek: number): Promise<void> {
  const gwRecord = await db.query.gameweeks.findFirst({ where: eq(gameweeks.number, gameweek) });
  if (!gwRecord) return;

  const gwFixtures = await db.query.fixtures.findMany({
    where: and(eq(fixtures.gameweekId, gwRecord.id), eq(fixtures.isPlayoff, true)),
    with: { homeTeam: { with: { players: true } }, awayTeam: { with: { players: true } } },
  });
  if (gwFixtures.length === 0) return;

  const captainPicks = await db.query.gameweekCaptains.findMany({
    where: eq(gameweekCaptains.gameweekId, gwRecord.id),
    with: { player: true },
  });
  const captainByTeamId = new Map<string, string>();
  const autoAssignedByTeamId = new Map<string, boolean>();
  for (const pick of captainPicks) {
    captainByTeamId.set(pick.player.teamId, pick.player.id);
    autoAssignedByTeamId.set(pick.player.teamId, pick.isValid === false);
  }

  const prevCaptainByTeamId = new Map<string, string>();
  if (gameweek > 1) {
    const prevGw = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, gameweek - 1), eq(gameweeks.leagueId, gwRecord.leagueId)),
    });
    if (prevGw) {
      const prevPicks = await db.query.gameweekCaptains.findMany({ where: eq(gameweekCaptains.gameweekId, prevGw.id), with: { player: true } });
      for (const p of prevPicks) prevCaptainByTeamId.set(p.player.teamId, p.player.id);
    }
  }

  const gwLiveScores: unknown[] = [];
  for (const fixture of gwFixtures) {
    try {
      const homeScore = await calculateLiveTeamScore(
        fixture.homeTeam.players,
        captainByTeamId.get(fixture.homeTeamId),
        prevCaptainByTeamId.get(fixture.homeTeamId) ?? null,
        gameweek,
        autoAssignedByTeamId.get(fixture.homeTeamId) ?? false,
      );
      const awayScore = await calculateLiveTeamScore(
        fixture.awayTeam.players,
        captainByTeamId.get(fixture.awayTeamId),
        prevCaptainByTeamId.get(fixture.awayTeamId) ?? null,
        gameweek,
        autoAssignedByTeamId.get(fixture.awayTeamId) ?? false,
      );
      gwLiveScores.push({
        fixtureId: fixture.id,
        gameweek,
        homeTeamName: fixture.homeTeam.name,
        awayTeamName: fixture.awayTeam.name,
        homeTeamId: fixture.homeTeamId,
        awayTeamId: fixture.awayTeamId,
        homeScore: homeScore.total,
        awayScore: awayScore.total,
        homePlayers: homeScore.players,
        awayPlayers: awayScore.players,
      });
    } catch (err) {
      console.error(`process-all live-cache: fixture ${fixture.id} skipped:`, err);
    }
  }

  if (gwLiveScores.length > 0) {
    await setLiveCachedScores(gameweek, {
      gameweek,
      fixtures: gwLiveScores as never,
      cachedAt: new Date().toISOString(),
    });
  }
}

async function calculateLiveTeamScore(
  teamPlayers: { id: string; name: string; fplId: string }[],
  captainPlayerId: string | undefined,
  prevCaptainPlayerId: string | null,
  gameweek: number,
  captainWasAutoAssigned: boolean = false,
) {
  const rawScores: Array<{ id: string; name: string; fplId: string; fplScore: number; transferHits: number; netScore: number }> = [];
  for (const player of teamPlayers) {
    try {
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek, "critical");
      const fplScore = picks.entry_history.points;
      const transferHits = picks.entry_history.event_transfers_cost;
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore, transferHits, netScore: fplScore - transferHits });
    } catch {
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore: 0, transferHits: 0, netScore: 0 });
    }
  }

  let resolvedCaptainId: string | null = captainPlayerId ?? null;
  let isTemp = captainWasAutoAssigned;
  if (!resolvedCaptainId) {
    // Live preview only — no capContext, so wouldExceedCap is irrelevant here.
    const picked = pickTempCaptain(rawScores, prevCaptainPlayerId);
    resolvedCaptainId = picked?.playerId ?? null;
    isTemp = !!resolvedCaptainId;
  }

  let total = 0;
  const players = rawScores.map(r => {
    const isCaptain = resolvedCaptainId === r.id;
    const finalScore = isCaptain ? r.netScore * 2 : r.netScore;
    total += finalScore;
    return {
      name: r.name, fplId: r.fplId, fplScore: r.fplScore, transferHits: r.transferHits,
      isCaptain,
      ...(isCaptain && isTemp ? { isTempCaptain: true } : {}),
      finalScore,
    };
  });

  return { total, players };
}
