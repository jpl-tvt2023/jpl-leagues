import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, fixtures, results, teams, gameweekCaptains, players, leagues, auditLogs } from "@/lib/db";
import { pickTempCaptain } from "@/lib/scoring/temp-captain";
import { eq, asc, and } from "drizzle-orm";
import { clearLiveCache, setLiveCachedScores } from "@/lib/fpl-cache";
import { detectLiveGameweek, fetchTeamGameweekPicks } from "@/lib/fpl";
import { processAuctionGameweek } from "@/lib/formats/auction/process-gameweek";
import { getPlayoffAdvanceGws, getPlayoffGenerateAction } from "@/lib/playoffs/advance-windows";
import { generateId } from "@/lib/id";

/**
 * GET /api/cron/process-scores
 * Vercel Cron Job — reprocesses scores for the current gameweek.
 * Authenticated via CRON_SECRET (checked in middleware).
 */
export async function GET(request: NextRequest) {
  const runId = generateId();
  const buildSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "local";
  const summary = {
    runId,
    dueGws: [] as number[],
    perGw: [] as Array<{ gw: number; processed: number; failed: number; advancedLeagues: number; generatedLeagues: number }>,
    errors: [] as string[],
  };

  // Self-record run start so "did the cron run?" is answerable from the DB.
  try {
    await db.insert(auditLogs).values({
      id: runId,
      type: "CRON_RUN_START",
      description: `process-scores cron started (build ${buildSha})`,
      pointsAffected: 0,
    });
  } catch (e) {
    console.error("Cron: failed to write CRON_RUN_START audit row:", e);
  }

  try {
    // Build an ordered list of every GW that has fixtures + a passed deadline.
    // We iterate them all so a multi-day backlog (or test data with all deadlines
    // set to one date) catches up in a single run rather than getting stuck on
    // the highest GW. Idempotency in score/generate/advance handlers makes
    // re-running already-done work a safe no-op.
    const allGameweeks = await db.select().from(gameweeks).orderBy(asc(gameweeks.number));
    const now = new Date();
    const dueGwSet = new Set<number>();
    for (const gw of allGameweeks) {
      if (gw.deadline > now) continue;
      const fxRows = await db
        .select({ id: fixtures.id })
        .from(fixtures)
        .where(eq(fixtures.gameweekId, gw.id));
      if (fxRows.length === 0) continue;
      dueGwSet.add(gw.number);
    }
    const dueGws = [...dueGwSet].sort((a, b) => a - b);
    summary.dueGws = dueGws;

    if (dueGws.length === 0) {
      console.log("Cron: no gameweeks need processing");
      await writeRunEnd(runId, "ok", summary);
      return NextResponse.json({ success: true, message: "No gameweek needs processing", runId, summary });
    }

    console.log(`Cron: due gameweeks (ascending): ${dueGws.join(", ")}`);

    // Fetch + cache fresh live FPL scores once for whichever GW is currently in-progress.
    // detectLiveGameweek consults FPL bootstrap, not our DB, so it gives us the real
    // mid-week GW (typically the highest one that's actually started).
    try {
      const { liveGw } = await detectLiveGameweek();
      if (liveGw && liveGw >= 31 && liveGw <= 38) {
        console.log(`Cron: Detected GW${liveGw} as in-progress, fetching live scores...`);
        await fetchAndCacheLiveScores(liveGw);
      }
    } catch (e) {
      console.error("Cron: Failed to fetch/cache live scores:", e);
    }

    const baseUrl = request.nextUrl.origin;
    const authHeader = request.headers.get("Authorization") || "";

    // Pull active leagues once so each GW iteration can dispatch generate + advance
    // without re-querying.
    const activeLeagues = await db
      .select({
        id: leagues.id,
        slug: leagues.slug,
        format: leagues.format,
        teamSize: leagues.teamSize,
        playoffStartGw: leagues.playoffStartGw,
        isActive: leagues.isActive,
      })
      .from(leagues)
      .where(eq(leagues.isActive, true));

    // ── Per-GW pipeline: clear cache → score → auction → generate → advance ──
    for (const gw of dueGws) {
      const gwSummary = { gw, processed: 0, failed: 0, advancedLeagues: 0, generatedLeagues: 0 };
      summary.perGw.push(gwSummary);

      try { await clearLiveCache(gw); } catch (e) {
        console.error(`Cron: failed to clear live cache for GW${gw}:`, e);
      }

      // Score
      try {
        const res = await fetch(`${baseUrl}/api/gameweeks/${gw}?force=true`, {
          method: "POST",
          headers: { Authorization: authHeader },
        });
        const body = await res.json();
        if (!res.ok) {
          console.error(`Cron: score failed for GW${gw}:`, body);
          summary.errors.push(`score GW${gw}: ${body.error ?? "unknown"}`);
        } else {
          gwSummary.processed = body.processed ?? 0;
          gwSummary.failed = body.failed ?? body.errors?.length ?? 0;
          if (gwSummary.processed === 0 && gwSummary.failed > 0) {
            console.warn(`Cron: GW${gw} processed 0 fixtures (${gwSummary.failed} FPL fetch errors — likely future GW)`);
          } else {
            console.log(`Cron: scored GW${gw} (processed=${gwSummary.processed}, failed=${gwSummary.failed})`);
          }
        }
      } catch (e) {
        console.error(`Cron: score threw for GW${gw}:`, e);
        summary.errors.push(`score GW${gw} threw`);
      }

      // Auction processing for this GW (auction leagues only)
      const auctionLeagues = activeLeagues.filter(l => l.format === "auction");
      for (const lg of auctionLeagues) {
        try {
          const gwRow = await db
            .select()
            .from(gameweeks)
            .where(and(eq(gameweeks.leagueId, lg.id), eq(gameweeks.number, gw)))
            .limit(1);
          if (gwRow.length === 0) continue;
          const result = await processAuctionGameweek(gwRow[0].id, gw, lg.id, true);
          console.log(`Cron: auction "${lg.slug}" GW${gw} processed (${result.teamsProcessed} teams)`);
        } catch (e) {
          console.error(`Cron: auction "${lg.slug}" GW${gw} failed:`, e);
        }
      }

      // Generate (one-shot per league when this GW is the trigger GW)
      for (const lg of activeLeagues) {
        const action = getPlayoffGenerateAction(lg.format, lg.teamSize ?? 32, lg.playoffStartGw ?? 31, gw);
        if (!action) continue;
        try {
          const genRes = await fetch(`${baseUrl}/api/admin/${lg.id}/${action.endpoint}`, {
            method: "POST",
            headers: { Authorization: authHeader },
          });
          const genBody = await genRes.json();
          if (!genRes.ok) {
            console.log(`Cron: ${action.endpoint} skipped for "${lg.slug}" GW${gw}: ${genBody.error ?? "unknown"}`);
          } else {
            gwSummary.generatedLeagues++;
            console.log(`Cron: ${action.endpoint} succeeded for "${lg.slug}" GW${gw}`);
          }
        } catch (e) {
          console.error(`Cron: ${action.endpoint} threw for "${lg.slug}" GW${gw}:`, e);
        }
      }

      // Advance (per-league, only if this GW is in the league's playoff window)
      for (const lg of activeLeagues) {
        const window = getPlayoffAdvanceGws(lg.format, lg.teamSize ?? 32, lg.playoffStartGw ?? 31);
        if (!window.has(gw)) continue;
        try {
          const advRes = await fetch(`${baseUrl}/api/admin/${lg.id}/advance-playoffs?gw=${gw}`, {
            method: "POST",
            headers: { Authorization: authHeader },
          });
          const advBody = await advRes.json();
          if (!advRes.ok) {
            console.error(`Cron: advance-playoffs failed for "${lg.slug}" GW${gw}:`, advBody);
          } else {
            gwSummary.advancedLeagues++;
            console.log(`Cron: Advanced "${lg.slug}" GW${gw} (${advBody.actions?.length ?? 0} actions)`);
          }
        } catch (e) {
          console.error(`Cron: advance-playoffs threw for "${lg.slug}" GW${gw}:`, e);
        }
      }
    }

    // Pre-warm page caches once at the very end so users get instant loads
    // reflecting the post-advance bracket state.
    try {
      for (const lg of activeLeagues) {
        try {
          await Promise.all([
            fetch(`${baseUrl}/api/standings?leagueSlug=${encodeURIComponent(lg.slug)}`, { headers: { Authorization: authHeader } }),
            fetch(`${baseUrl}/api/fixtures?leagueSlug=${encodeURIComponent(lg.slug)}`, { headers: { Authorization: authHeader } }),
            fetch(`${baseUrl}/api/playoffs/bracket?leagueSlug=${encodeURIComponent(lg.slug)}`, { headers: { Authorization: authHeader } }),
          ]);
        } catch (e) {
          console.error(`Cron: pre-warm failed for "${lg.slug}":`, e);
        }
      }
    } catch (e) {
      console.error("Cron: pre-warm loop failed:", e);
    }

    await writeRunEnd(runId, "ok", summary);
    return NextResponse.json({ success: true, runId, summary });
  } catch (error) {
    console.error("Cron process-scores error:", error);
    summary.errors.push(error instanceof Error ? error.message : "unknown");
    await writeRunEnd(runId, "error", summary);
    return NextResponse.json({ error: "Cron job failed", runId, summary }, { status: 500 });
  }
}

async function writeRunEnd(
  runId: string,
  status: "ok" | "error",
  summary: { dueGws: number[]; perGw: unknown[]; errors: string[] },
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: generateId(),
      type: "CRON_RUN_END",
      description: `process-scores cron finished (${status}) | runId=${runId} | ${JSON.stringify(summary)}`.slice(0, 1900),
      pointsAffected: 0,
    });
  } catch (e) {
    console.error("Cron: failed to write CRON_RUN_END audit row:", e);
  }
}

/**
 * Fetch live scores from FPL API and cache in Redis for the given gameweek
 * This runs every 10 minutes via cron during the in-progress GW
 */
async function fetchAndCacheLiveScores(gameweek: number): Promise<void> {
  try {
    const gwRecord = await db.query.gameweeks.findFirst({
      where: eq(gameweeks.number, gameweek),
    });

    if (!gwRecord) {
      console.warn(`Cron: Gameweek ${gameweek} not found in DB`);
      return;
    }

    // Get all playoff fixtures for this GW
    const gwFixtures = await db.query.fixtures.findMany({
      where: and(
        eq(fixtures.gameweekId, gwRecord.id),
        eq(fixtures.isPlayoff, true)
      ),
      with: {
        homeTeam: { with: { players: true } },
        awayTeam: { with: { players: true } },
      },
    });

    if (gwFixtures.length === 0) {
      console.log(`Cron: No playoff fixtures found for GW${gameweek}`);
      return;
    }

    // Get captain picks for this GW
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

    // Previous-GW captains (used for temp-cap tiebreak when current GW has no announcement)
    const prevCaptainByTeamId = new Map<string, string>();
    if (gameweek > 1) {
      const prevGw = await db.query.gameweeks.findFirst({
        where: and(eq(gameweeks.number, gameweek - 1), eq(gameweeks.leagueId, gwRecord.leagueId)),
      });
      if (prevGw) {
        const prevPicks = await db.query.gameweekCaptains.findMany({
          where: eq(gameweekCaptains.gameweekId, prevGw.id),
          with: { player: true },
        });
        for (const p of prevPicks) prevCaptainByTeamId.set(p.player.teamId, p.player.id);
      }
    }

    // Calculate live scores for each fixture from FPL API
    const gwLiveScores = [];
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
          gameweek: gameweek,  // Track which GW this score is from
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
        console.error(`Cron: Live score error for fixture ${fixture.id}:`, err);
        // Silently skip this fixture, don't include it in cache
      }
    }

    if (gwLiveScores.length > 0) {
      // Store in Redis with 10-minute TTL
      await setLiveCachedScores(gameweek, {
        gameweek,
        fixtures: gwLiveScores,
        cachedAt: new Date().toISOString(),
      });
      console.log(`Cron: Cached ${gwLiveScores.length} live fixture scores for GW${gameweek}`);
    }
  } catch (error) {
    console.error(`Cron: Error fetching live scores for GW${gameweek}:`, error);
    throw error;
  }
}

/**
 * Calculate live score for a TVT team (2 FPL players + captaincy doubling)
 * Fetches always from FPL API (never cached), applies captain doubling
 */
async function calculateLiveTeamScore(
  teamPlayers: { id: string; name: string; fplId: string }[],
  captainPlayerId: string | undefined,
  prevCaptainPlayerId: string | null,
  gameweek: number,
  captainWasAutoAssigned: boolean = false,
): Promise<{
  total: number;
  players: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
}> {
  // First pass: fetch raw scores (no captain doubling yet).
  const rawScores: { id: string; name: string; fplId: string; fplScore: number; transferHits: number; netScore: number }[] = [];
  for (const player of teamPlayers) {
    try {
      const picks = await fetchTeamGameweekPicks(player.fplId, gameweek);
      const fplScore = picks.entry_history.points;
      const transferHits = picks.entry_history.event_transfers_cost;
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore, transferHits, netScore: fplScore - transferHits });
    } catch (err) {
      console.error(`Cron: Failed to fetch FPL data for player ${player.fplId} in GW${gameweek}:`, err);
      rawScores.push({ id: player.id, name: player.name, fplId: player.fplId, fplScore: 0, transferHits: 0, netScore: 0 });
    }
  }

  // Resolve captain: announced > temp (lowest net, rotate-on-tie). Treat as temp captain
  // if either no row existed OR the existing row was auto-assigned post-deadline (isValid === false).
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
      name: r.name,
      fplId: r.fplId,
      fplScore: r.fplScore,
      transferHits: r.transferHits,
      isCaptain,
      ...(isCaptain && isTemp ? { isTempCaptain: true } : {}),
      finalScore,
    };
  });

  return { total, players };
}
