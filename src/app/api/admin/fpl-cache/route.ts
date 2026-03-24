import { NextRequest, NextResponse } from "next/server";
import { getCacheStats, clearGameweekCache, getAllCachedScores, clearLiveCache } from "@/lib/fpl-cache";

/**
 * GET /api/admin/fpl-cache
 * Get FPL cache statistics
 */
export async function GET(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const stats = await getCacheStats();
    const totalEntries = stats.reduce((acc, s) => acc + s.entries, 0);

    return NextResponse.json({
      totalEntries,
      gameweeks: stats,
    });
  } catch (error) {
    console.error("Get cache stats error:", error);
    return NextResponse.json(
      { error: "Failed to get cache stats" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/fpl-cache
 * Clear FPL cache for a specific gameweek or all
 */
export async function DELETE(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const gwParam = searchParams.get("gw");

    if (gwParam) {
      const gw = parseInt(gwParam);
      if (isNaN(gw) || gw < 1 || gw > 38) {
        return NextResponse.json(
          { error: "Invalid gameweek number" },
          { status: 400 }
        );
      }
      // Clear both FPL data cache and live scores cache
      await clearGameweekCache(gw);
      await clearLiveCache(gw);
      return NextResponse.json({
        success: true,
        message: `Cache cleared for GW${gw}`,
      });
    } else {
      // Clear all
      for (let gw = 1; gw <= 38; gw++) {
        await clearGameweekCache(gw);
        await clearLiveCache(gw);
      }
      return NextResponse.json({
        success: true,
        message: "All cache cleared",
      });
    }
  } catch (error) {
    console.error("Clear cache error:", error);
    return NextResponse.json(
      { error: "Failed to clear cache" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/fpl-cache
 * Get detailed cache for a specific gameweek
 */
export async function POST(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { gameweek } = body;

    if (!gameweek || gameweek < 1 || gameweek > 38) {
      return NextResponse.json(
        { error: "Invalid gameweek number" },
        { status: 400 }
      );
    }

    const cacheData = await getAllCachedScores(gameweek);

    return NextResponse.json({
      gameweek,
      entries: Object.keys(cacheData).length,
      data: cacheData,
    });
  } catch (error) {
    console.error("Get cache data error:", error);
    return NextResponse.json(
      { error: "Failed to get cache data" },
      { status: 500 }
    );
  }
}
