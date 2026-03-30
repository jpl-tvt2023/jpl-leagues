import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getCacheStatsForIds,
  clearGameweekCacheForIds,
  getAllCachedScoresForIds,
  clearLiveCache,
} from "@/lib/fpl-cache";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/** Fetch all FPL IDs for players in teams belonging to this league */
async function getLeagueFplIds(leagueId: string): Promise<string[]> {
  const leagueTeams = await db.query.teams.findMany({
    where: eq(teams.leagueId, leagueId),
    with: { players: true },
  });
  return leagueTeams.flatMap((t) => t.players.map((p) => p.fplId));
}

/**
 * GET /api/admin/[leagueId]/fpl-cache
 * Get FPL cache statistics scoped to this league's teams
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const fplIds = await getLeagueFplIds(leagueId);
    const stats = await getCacheStatsForIds(fplIds, leagueId);
    const totalEntries = stats.reduce((acc, s) => acc + s.entries, 0);

    return NextResponse.json({ totalEntries, gameweeks: stats });
  } catch (error) {
    console.error("Get cache stats error:", error);
    return NextResponse.json({ error: "Failed to get cache stats" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/[leagueId]/fpl-cache
 * Clear FPL cache for a specific gameweek or all, scoped to this league
 */
export async function DELETE(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const fplIds = await getLeagueFplIds(leagueId);
    const { searchParams } = new URL(request.url);
    const gwParam = searchParams.get("gw");

    if (gwParam) {
      const gw = parseInt(gwParam);
      if (isNaN(gw) || gw < 1 || gw > 38) {
        return NextResponse.json({ error: "Invalid gameweek number" }, { status: 400 });
      }
      await clearGameweekCacheForIds(gw, fplIds, leagueId);
      await clearLiveCache(gw, leagueId);
      return NextResponse.json({ success: true, message: `Cache cleared for GW${gw}` });
    } else {
      for (let gw = 1; gw <= 38; gw++) {
        await clearGameweekCacheForIds(gw, fplIds, leagueId);
        await clearLiveCache(gw, leagueId);
      }
      return NextResponse.json({ success: true, message: "All cache cleared" });
    }
  } catch (error) {
    console.error("Clear cache error:", error);
    return NextResponse.json({ error: "Failed to clear cache" }, { status: 500 });
  }
}

/**
 * POST /api/admin/[leagueId]/fpl-cache
 * Get detailed cache for a specific gameweek, scoped to this league
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { gameweek } = body;

    if (!gameweek || gameweek < 1 || gameweek > 38) {
      return NextResponse.json({ error: "Invalid gameweek number" }, { status: 400 });
    }

    const fplIds = await getLeagueFplIds(leagueId);
    const cacheData = await getAllCachedScoresForIds(gameweek, fplIds, leagueId);

    return NextResponse.json({
      gameweek,
      entries: Object.keys(cacheData).length,
      data: cacheData,
    });
  } catch (error) {
    console.error("Get cache data error:", error);
    return NextResponse.json({ error: "Failed to get cache data" }, { status: 500 });
  }
}
