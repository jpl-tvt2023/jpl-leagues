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

import { db, gameweeks, fixtures, leagues, auditLogs } from "@/lib/db";
import { gameweekCaptains } from "@/lib/db/schema";
import { asc, eq, and } from "drizzle-orm";
import { detectLiveGameweek, fetchBootstrapData, fetchTeamGameweekPicks } from "@/lib/fpl";
import { clearLiveCache, setLiveCachedScores } from "@/lib/fpl-cache";
import { processAuctionGameweek } from "@/lib/formats/auction/process-gameweek";
import { getPlayoffAdvanceGws, getPlayoffGenerateAction } from "@/lib/playoffs/advance-windows";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";
import { generateId } from "@/lib/id";

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
  globalErrors: string[];   // GWs skipped because FPL not finalized, FPL bootstrap failed, etc.
};

export type LeagueResult = {
  leagueId: string;
  slug: string;
  format: string;
  status: "ok" | "partial" | "error" | "skipped";
  scoredGws: number[];
  advancedGws: number[];
  generatedFor: number[];
  errors: Array<{ gw?: number; step: "score" | "generate" | "advance" | "auction" | "league"; message: string }>;
};

interface FetchInput {
  baseUrl: string;
  authHeader?: string;     // Bearer token forwarded for cron-secret callers
  cookieHeader?: string;   // session cookie forwarded for admin-button callers
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

async function safeJson(res: Response): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const txt = (await res.text()).slice(0, 200);
    throw new Error(`Non-JSON response (${res.status} ${ct.split(";")[0] || "no-ct"}): ${txt}`);
  }
  return { ok: res.ok, status: res.status, body: await res.json() };
}

type FplEvent = { id: number; finished: boolean; data_checked: boolean };
type FinalizeStatus = { ok: true } | { ok: false; reason: string };

/**
 * Pure lookup against an already-fetched bootstrap events array.
 * Returns a precise reason when the GW is not eligible, so the UI can show
 * "FPL still in progress (finished=false)" vs "FPL bootstrap fetch failed: HTTP 429"
 * vs "not present in FPL bootstrap" — instead of a single generic "not finalized" line.
 *
 * Note: we deliberately gate on `finished` only, NOT `data_checked`. FPL flips
 * `data_checked` 1–2 days after `finished` (it's the bonus-points reconciliation
 * flag); for our scoring + advance pipeline the published `entry_history.points`
 * is stable as soon as `finished=true`.
 */
function isGwFinalized(
  gw: number,
  bootstrapEvents: FplEvent[] | null,
  bootstrapError: string | null,
): FinalizeStatus {
  if (bootstrapError) {
    return { ok: false, reason: `cannot verify FPL state — bootstrap fetch failed: ${bootstrapError}` };
  }
  if (!bootstrapEvents) {
    return { ok: false, reason: "FPL bootstrap unavailable" };
  }
  const event = bootstrapEvents.find(e => e.id === gw);
  if (!event) {
    return { ok: false, reason: "not present in FPL bootstrap" };
  }
  if (event.finished !== true) {
    return { ok: false, reason: "FPL still in progress (finished=false)" };
  }
  return { ok: true };
}

function messageFrom(e: unknown): string {
  return e instanceof Error ? e.message : "unknown error";
}

async function internalFetch(url: string, method: "GET" | "POST", input: FetchInput): Promise<Response> {
  const headers: Record<string, string> = {};
  if (input.authHeader) headers["Authorization"] = input.authHeader;
  if (input.cookieHeader) headers["Cookie"] = input.cookieHeader;
  return fetch(url, { method, headers });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  computePlan — fast, used by the /plan endpoint                            */
/* ────────────────────────────────────────────────────────────────────────── */

export async function computePlan(opts: { force?: boolean } = {}): Promise<Plan> {
  const runId = generateId();
  const buildSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
  const globalErrors: string[] = [];
  const force = opts.force === true;

  try {
    await db.insert(auditLogs).values({
      id: runId,
      type: "CRON_RUN_START",
      description: `process-all started (build ${buildSha}${force ? ", force=true" : ""})`,
      pointsAffected: 0,
    });
  } catch (e) {
    console.error("computePlan: CRON_RUN_START write failed:", e);
  }

  // Fetch FPL bootstrap ONCE for the whole plan. If this fails we surface the
  // single error to the UI rather than silently flagging every GW as "not finalized".
  let bootstrapEvents: FplEvent[] | null = null;
  let bootstrapError: string | null = null;
  if (!force) {
    try {
      const bs = await fetchBootstrapData() as { events?: FplEvent[] };
      bootstrapEvents = bs.events ?? [];
    } catch (e) {
      bootstrapError = e instanceof Error ? e.message : "unknown error";
      globalErrors.push(`FPL bootstrap fetch failed: ${bootstrapError}`);
    }
  } else {
    globalErrors.push("Force mode active — FPL finalization gate bypassed");
  }

  // Build the dueGws set: deadline passed AND (force OR FPL bootstrap says finished).
  const allGameweeks = await db.select().from(gameweeks).orderBy(asc(gameweeks.number));
  const now = new Date();
  const seen = new Set<number>();
  const dueByNumber = new Set<number>();

  for (const gw of allGameweeks) {
    if (gw.deadline > now) continue;
    if (seen.has(gw.number)) continue;
    seen.add(gw.number);

    const fxRows = await db
      .select({ id: fixtures.id })
      .from(fixtures)
      .where(eq(fixtures.gameweekId, gw.id));
    if (fxRows.length === 0) continue;

    if (force) {
      dueByNumber.add(gw.number);
      continue;
    }

    const status = isGwFinalized(gw.number, bootstrapEvents, bootstrapError);
    if (!status.ok) {
      globalErrors.push(`GW${gw.number}: ${status.reason} — skipped`);
      continue;
    }
    dueByNumber.add(gw.number);
  }
  const dueGws = [...dueByNumber].sort((a, b) => a - b);

  const activeLeagues = await db
    .select({
      id: leagues.id,
      slug: leagues.slug,
      format: leagues.format,
      teamSize: leagues.teamSize,
      playoffStartGw: leagues.playoffStartGw,
    })
    .from(leagues)
    .where(eq(leagues.isActive, true));

  return {
    runId,
    dueGws,
    leagues: activeLeagues,
    globalErrors,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  processOneLeague — used by /league endpoint                               */
/* ────────────────────────────────────────────────────────────────────────── */

export async function processOneLeague(
  league: LeaguePlanItem,
  dueGws: number[],
  input: FetchInput & { reprocess?: boolean },
): Promise<LeagueResult> {
  const result: LeagueResult = {
    leagueId: league.id,
    slug: league.slug,
    format: league.format,
    status: "ok",
    scoredGws: [],
    advancedGws: [],
    generatedFor: [],
    errors: [],
  };

  try {
    for (const gw of dueGws) {
      try { await clearLiveCache(gw); } catch { /* non-fatal */ }

      // ── Score ──
      // By default we DON'T pass force=true. The downstream processors filter
      // out already-scored fixtures (`!f.result`), so caught-up GWs do near-zero
      // work. Force-reprocess (delete+recompute) is opt-in via input.reprocess.
      const reprocess = input.reprocess === true;
      if (league.format === "auction") {
        try {
          const gwRow = await db
            .select()
            .from(gameweeks)
            .where(and(eq(gameweeks.leagueId, league.id), eq(gameweeks.number, gw)))
            .limit(1);
          if (gwRow.length > 0) {
            await processAuctionGameweek(gwRow[0].id, gw, league.id, reprocess);
            result.scoredGws.push(gw);
          }
        } catch (e) {
          result.errors.push({ gw, step: "auction", message: messageFrom(e) });
        }
      } else {
        try {
          const forceParam = reprocess ? "&force=true" : "";
          const url = `${input.baseUrl}/api/gameweeks/${gw}?leagueId=${encodeURIComponent(league.id)}${forceParam}`;
          const res = await internalFetch(url, "POST", input);
          const parsed = await safeJson(res);
          const body = parsed.body as { processed?: number; failed?: number; errors?: unknown[]; error?: string };
          if (!parsed.ok) {
            result.errors.push({ gw, step: "score", message: `HTTP ${parsed.status}: ${body.error ?? "unknown"}` });
          } else {
            const processed = body.processed ?? 0;
            const failed = body.failed ?? body.errors?.length ?? 0;
            if (processed > 0 || failed === 0) result.scoredGws.push(gw);
            if (processed === 0 && failed > 0) {
              result.errors.push({ gw, step: "score", message: `Processed 0 fixtures (${failed} FPL fetch errors — likely future GW)` });
            }
          }
        } catch (e) {
          result.errors.push({ gw, step: "score", message: messageFrom(e) });
        }
      }

      // ── Generate (one-shot per league when this GW is the trigger GW) ──
      const action = getPlayoffGenerateAction(league.format, league.teamSize ?? 32, league.playoffStartGw ?? 31, gw);
      if (action) {
        try {
          const url = `${input.baseUrl}/api/admin/${league.id}/${action.endpoint}`;
          const res = await internalFetch(url, "POST", input);
          const parsed = await safeJson(res);
          const body = parsed.body as { error?: string };
          if (parsed.ok) {
            result.generatedFor.push(gw);
          } else if (!(body.error ?? "").toLowerCase().includes("already")) {
            result.errors.push({ gw, step: "generate", message: `HTTP ${parsed.status}: ${body.error ?? "unknown"}` });
          }
        } catch (e) {
          result.errors.push({ gw, step: "generate", message: messageFrom(e) });
        }
      }

      // ── Advance (per-league, only if this GW is in the league's playoff window) ──
      const advanceWindow = getPlayoffAdvanceGws(league.format, league.teamSize ?? 32, league.playoffStartGw ?? 31);
      if (advanceWindow.has(gw)) {
        try {
          const url = `${input.baseUrl}/api/admin/${league.id}/advance-playoffs?gw=${gw}`;
          const res = await internalFetch(url, "POST", input);
          const parsed = await safeJson(res);
          const body = parsed.body as { actions?: unknown[]; error?: string };
          if (parsed.ok) {
            result.advancedGws.push(gw);
          } else {
            result.errors.push({ gw, step: "advance", message: `HTTP ${parsed.status}: ${body.error ?? "unknown"}` });
          }
        } catch (e) {
          result.errors.push({ gw, step: "advance", message: messageFrom(e) });
        }
      }
    }
  } catch (outerErr) {
    result.errors.push({ step: "league", message: `League-level failure: ${messageFrom(outerErr)}` });
  }

  // Compute final status
  const didAnyWork = result.scoredGws.length + result.advancedGws.length + result.generatedFor.length > 0;
  if (result.errors.length === 0) {
    result.status = didAnyWork ? "ok" : "skipped";
  } else {
    result.status = didAnyWork ? "partial" : "error";
  }
  return result;
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

  // Pre-warm cached pages for every league that did work.
  for (const r of results) {
    if (r.status === "skipped") continue;
    try {
      await Promise.all([
        internalFetch(`${input.baseUrl}/api/standings?leagueSlug=${encodeURIComponent(r.slug)}`, "GET", input),
        internalFetch(`${input.baseUrl}/api/fixtures?leagueSlug=${encodeURIComponent(r.slug)}`, "GET", input),
        internalFetch(`${input.baseUrl}/api/playoffs/bracket?leagueSlug=${encodeURIComponent(r.slug)}`, "GET", input),
      ]);
    } catch { /* swallow — pre-warm failures shouldn't downgrade status */ }
  }

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
export async function processAllLeagues(
  input: FetchInput & { force?: boolean; reprocess?: boolean },
): Promise<Summary> {
  const plan = await computePlan({ force: input.force });
  const results: LeagueResult[] = [];
  for (const lg of plan.leagues) {
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
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek);
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
    resolvedCaptainId = pickTempCaptain(rawScores, prevCaptainPlayerId);
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
