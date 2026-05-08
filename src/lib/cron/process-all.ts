/**
 * Shared catch-up engine: scores, generates, and advances every active league
 * across every gameweek with a passed deadline + finalized FPL data.
 *
 * Used by:
 *  - The Vercel Cron route (kept for manual CRON_SECRET invocations).
 *  - The superadmin "Run Auto-Processing for All Leagues" button.
 *
 * Iteration order is league-first → GW-second so per-league error isolation is
 * built in: a failure inside league A's pipeline only affects league A's result;
 * leagues B, C, … continue normally.
 */

import { db, gameweeks, fixtures, leagues, auditLogs, type Gameweek } from "@/lib/db";
import { asc, eq, and } from "drizzle-orm";
import { detectLiveGameweek, fetchBootstrapData, fetchTeamGameweekPicks } from "@/lib/fpl";
import { clearLiveCache, setLiveCachedScores } from "@/lib/fpl-cache";
import { processAuctionGameweek } from "@/lib/formats/auction/process-gameweek";
import { getPlayoffAdvanceGws, getPlayoffGenerateAction } from "@/lib/playoffs/advance-windows";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";
import { gameweekCaptains } from "@/lib/db/schema";
import { generateId } from "@/lib/id";

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

export type Summary = {
  runId: string;
  dueGws: number[];
  leagues: LeagueResult[];
  globalErrors: string[];
};

interface ProcessAllInput {
  baseUrl: string;
  authHeader?: string;     // Bearer token forwarded for cron-secret callers
  cookieHeader?: string;   // session cookie forwarded for admin-button callers
}

/** Parse a fetch response as JSON, throwing if it isn't (Deployment Protection / HTML auth pages). */
async function safeJson(res: Response): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const txt = (await res.text()).slice(0, 200);
    throw new Error(`Non-JSON response (${res.status} ${ct.split(";")[0] || "no-ct"}): ${txt}`);
  }
  return { ok: res.ok, status: res.status, body: await res.json() };
}

/** Returns true only if FPL bootstrap reports the GW as fully finalized. */
async function isGwFinalized(gw: number): Promise<boolean> {
  try {
    const bs = await fetchBootstrapData() as { events?: Array<{ id: number; finished: boolean; data_checked: boolean }> };
    const event = bs.events?.find(e => e.id === gw);
    return !!event && event.finished === true && event.data_checked === true;
  } catch {
    // FPL unreachable → treat as not finalized to avoid premature advance.
    return false;
  }
}

/**
 * Build the list of GWs that have:
 *  - passed deadline,
 *  - at least one fixture in DB,
 *  - FPL bootstrap reports finished + data_checked = true.
 * The third condition prevents premature advance with partial FPL scores.
 */
async function computeDueGws(globalErrors: string[]): Promise<number[]> {
  const allGameweeks = await db.select().from(gameweeks).orderBy(asc(gameweeks.number));
  const now = new Date();
  const seenGwNumbers = new Set<number>();
  const dueByNumber = new Set<number>();

  for (const gw of allGameweeks) {
    if (gw.deadline > now) continue;
    if (seenGwNumbers.has(gw.number)) continue;
    seenGwNumbers.add(gw.number);

    const fxRows = await db
      .select({ id: fixtures.id })
      .from(fixtures)
      .where(eq(fixtures.gameweekId, gw.id));
    if (fxRows.length === 0) continue;

    const finalized = await isGwFinalized(gw.number);
    if (!finalized) {
      globalErrors.push(`GW${gw.number}: deadline passed but FPL not yet finalized — skipped`);
      continue;
    }
    dueByNumber.add(gw.number);
  }
  return [...dueByNumber].sort((a, b) => a - b);
}

function messageFrom(e: unknown): string {
  return e instanceof Error ? e.message : "unknown error";
}

/**
 * Main entry point. Returns a Summary describing what happened, league-by-league.
 * Always writes a CRON_RUN_START / CRON_RUN_END audit pair.
 */
export async function processAllLeagues(input: ProcessAllInput): Promise<Summary> {
  const runId = generateId();
  const buildSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
  const summary: Summary = { runId, dueGws: [], leagues: [], globalErrors: [] };

  try {
    await db.insert(auditLogs).values({
      id: runId,
      type: "CRON_RUN_START",
      description: `process-all started (build ${buildSha})`,
      pointsAffected: 0,
    });
  } catch (e) {
    console.error("process-all: failed to write CRON_RUN_START audit row:", e);
  }

  try {
    summary.dueGws = await computeDueGws(summary.globalErrors);
    console.log(`process-all: due gameweeks: ${summary.dueGws.join(", ") || "(none)"}`);

    // Live cache populate — once per run, for whichever GW FPL says is in-progress.
    try {
      const { liveGw } = await detectLiveGameweek();
      if (liveGw && liveGw >= 31 && liveGw <= 38) {
        await fetchAndCacheLiveScores(liveGw);
      }
    } catch (e) {
      summary.globalErrors.push(`live-cache fetch: ${messageFrom(e)}`);
    }

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

    for (const lg of activeLeagues) {
      const result: LeagueResult = {
        leagueId: lg.id,
        slug: lg.slug,
        format: lg.format,
        status: "ok",
        scoredGws: [],
        advancedGws: [],
        generatedFor: [],
        errors: [],
      };

      try {
        for (const gw of summary.dueGws) {
          // Clear any stale live-cache for this GW once (cheap; no per-league key needed).
          try { await clearLiveCache(gw); } catch { /* ignore — non-fatal */ }

          // ── Score this league at this GW ──
          if (lg.format === "auction") {
            // Auction has its own processor; doesn't go through /api/gameweeks.
            try {
              const gwRow = await db
                .select()
                .from(gameweeks)
                .where(and(eq(gameweeks.leagueId, lg.id), eq(gameweeks.number, gw)))
                .limit(1);
              if (gwRow.length > 0) {
                const r = await processAuctionGameweek(gwRow[0].id, gw, lg.id, true);
                result.scoredGws.push(gw);
                console.log(`process-all: auction "${lg.slug}" GW${gw} → ${r.teamsProcessed} teams`);
              }
            } catch (e) {
              result.errors.push({ gw, step: "auction", message: messageFrom(e) });
            }
          } else {
            try {
              const url = `${input.baseUrl}/api/gameweeks/${gw}?force=true&leagueId=${encodeURIComponent(lg.id)}`;
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

          // ── Generate (only fires when this GW is the trigger GW for this league) ──
          const action = getPlayoffGenerateAction(lg.format, lg.teamSize ?? 32, lg.playoffStartGw ?? 31, gw);
          if (action) {
            try {
              const url = `${input.baseUrl}/api/admin/${lg.id}/${action.endpoint}`;
              const res = await internalFetch(url, "POST", input);
              const parsed = await safeJson(res);
              const body = parsed.body as { error?: string };
              if (parsed.ok) {
                result.generatedFor.push(gw);
              } else {
                // 400 "already exists" is normal on re-runs — not an error worth surfacing.
                if (!(body.error ?? "").toLowerCase().includes("already")) {
                  result.errors.push({ gw, step: "generate", message: `HTTP ${parsed.status}: ${body.error ?? "unknown"}` });
                }
              }
            } catch (e) {
              result.errors.push({ gw, step: "generate", message: messageFrom(e) });
            }
          }

          // ── Advance (only fires for GWs in this league's playoff window) ──
          const advanceWindow = getPlayoffAdvanceGws(lg.format, lg.teamSize ?? 32, lg.playoffStartGw ?? 31);
          if (advanceWindow.has(gw)) {
            try {
              const url = `${input.baseUrl}/api/admin/${lg.id}/advance-playoffs?gw=${gw}`;
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

      // ── Pre-warm cached pages for this league (best-effort; doesn't affect status) ──
      try {
        await Promise.all([
          internalFetch(`${input.baseUrl}/api/standings?leagueSlug=${encodeURIComponent(lg.slug)}`, "GET", input),
          internalFetch(`${input.baseUrl}/api/fixtures?leagueSlug=${encodeURIComponent(lg.slug)}`, "GET", input),
          internalFetch(`${input.baseUrl}/api/playoffs/bracket?leagueSlug=${encodeURIComponent(lg.slug)}`, "GET", input),
        ]);
      } catch { /* swallow — pre-warm failures shouldn't downgrade league status */ }

      // Compute final status
      const didAnyWork = result.scoredGws.length + result.advancedGws.length + result.generatedFor.length > 0;
      if (result.errors.length === 0) {
        result.status = didAnyWork ? "ok" : "skipped";
      } else {
        result.status = didAnyWork ? "partial" : "error";
      }
      summary.leagues.push(result);
    }
  } catch (e) {
    summary.globalErrors.push(`run-level failure: ${messageFrom(e)}`);
  }

  try {
    await db.insert(auditLogs).values({
      id: generateId(),
      type: "CRON_RUN_END",
      description: `process-all finished | runId=${runId} | ${JSON.stringify({
        dueGws: summary.dueGws,
        leagues: summary.leagues.map(l => ({ slug: l.slug, status: l.status, scored: l.scoredGws.length, advanced: l.advancedGws.length, generated: l.generatedFor.length, errors: l.errors.length })),
        globalErrors: summary.globalErrors.length,
      })}`.slice(0, 1900),
      pointsAffected: 0,
    });
  } catch (e) {
    console.error("process-all: failed to write CRON_RUN_END audit row:", e);
  }

  return summary;
}

/** Issue an internal HTTP request, forwarding either a Bearer token or a session cookie. */
async function internalFetch(url: string, method: "GET" | "POST", input: ProcessAllInput): Promise<Response> {
  const headers: Record<string, string> = {};
  if (input.authHeader) headers["Authorization"] = input.authHeader;
  if (input.cookieHeader) headers["Cookie"] = input.cookieHeader;
  return fetch(url, { method, headers });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Below: live-score caching helpers (lifted from the old cron route)        */
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

// Re-export the Gameweek type alias just so this file can satisfy any
// downstream type imports without dragging the schema namespace.
export type { Gameweek };
