import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues } from "@/lib/db";
import { auctionOwnership } from "@/lib/db/schema";
import { eq, and, lt, gte, or, isNull } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { fetchElementInfo, fetchElementGameweekPoints, fetchBootstrapData } from "@/lib/fpl";

/**
 * GET /api/auction/players?leagueId=xxx&gameweek=N&page=1&pageSize=50
 *   &position=1..4&plTeam=id&ownership=all|owned|free|mine&search=name
 *
 * Returns a paginated list of all FPL players with per-GW points,
 * ownership info (which JPL team owns them during the selected GW), and metadata.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const leagueId = searchParams.get("leagueId");
  const gameweek = parseInt(searchParams.get("gameweek") ?? "0", 10);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get("pageSize") ?? "50", 10)));
  const positionFilter = searchParams.get("position") ? parseInt(searchParams.get("position")!, 10) : null;
  const plTeamFilter = searchParams.get("plTeam") ? parseInt(searchParams.get("plTeam")!, 10) : null;
  const ownershipFilter = searchParams.get("ownership") ?? "all"; // all | owned | free | mine
  const searchQuery = (searchParams.get("search") ?? "").toLowerCase().trim();

  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }
  if (gameweek < 1 || gameweek > 38) {
    return NextResponse.json({ error: "gameweek must be 1-38" }, { status: 400 });
  }

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (!leagueRow.length || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  try {
    // Fetch FPL data (all cached)
    const [elements, gwPoints, bootstrap] = await Promise.all([
      fetchElementInfo(),
      fetchElementGameweekPoints(gameweek),
      fetchBootstrapData(),
    ]);

    // Build PL team name map
    const plTeamMap = new Map<number, string>();
    for (const t of (bootstrap.teams ?? []) as { id: number; short_name: string }[]) {
      plTeamMap.set(t.id, t.short_name);
    }

    // Fetch ownership records valid during the target GW
    // acquiredGw < gameweek AND (releasedGw IS NULL OR releasedGw >= gameweek)
    const ownershipRows = await db
      .select({
        fplElementId: auctionOwnership.fplElementId,
        teamId: auctionOwnership.teamId,
        purchasePrice: auctionOwnership.purchasePrice,
      })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          lt(auctionOwnership.acquiredGw, gameweek),
          or(
            isNull(auctionOwnership.releasedGw),
            gte(auctionOwnership.releasedGw, gameweek),
          ),
        )
      );

    // Build elementId -> ownership map
    const ownerMap = new Map<number, { teamId: string; purchasePrice: number }>();
    for (const o of ownershipRows) {
      ownerMap.set(o.fplElementId, { teamId: o.teamId, purchasePrice: o.purchasePrice });
    }

    // Fetch team abbreviations
    const leagueTeams = await db
      .select({ id: teams.id, abbreviation: teams.abbreviation, name: teams.name })
      .from(teams)
      .where(eq(teams.leagueId, leagueId));
    const teamAbbrMap = new Map<string, string>();
    const teamNameMap = new Map<string, string>();
    for (const t of leagueTeams) {
      teamAbbrMap.set(t.id, t.abbreviation);
      teamNameMap.set(t.id, t.name);
    }

    // Determine requesting team's ID for "mine" filter
    const myTeamId = session?.id ?? null;

    // Build full row set, apply filters
    type PlayerRow = {
      elementId: number;
      webName: string;
      position: number;
      plTeamId: number;
      plTeamShort: string;
      ownerTeamId: string | null;
      ownerAbbreviation: string | null;
      ownerTeamName: string | null;
      gwPoints: number;
      seasonPoints: number;
      nowCost: number;
      status: string;
      minutes: number;
      purchasePrice: number | null;
    };

    let rows: PlayerRow[] = [];

    for (const el of elements) {
      // Position filter
      if (positionFilter !== null && el.element_type !== positionFilter) continue;
      // PL team filter
      if (plTeamFilter !== null && el.team !== plTeamFilter) continue;
      // Search filter
      if (searchQuery && !el.web_name.toLowerCase().includes(searchQuery)) continue;

      const owner = ownerMap.get(el.id);
      const ownerTeamId = owner?.teamId ?? null;

      // Ownership filter
      if (ownershipFilter === "owned" && !ownerTeamId) continue;
      if (ownershipFilter === "free" && ownerTeamId) continue;
      if (ownershipFilter === "mine" && ownerTeamId !== myTeamId) continue;

      rows.push({
        elementId: el.id,
        webName: el.web_name,
        position: el.element_type,
        plTeamId: el.team,
        plTeamShort: plTeamMap.get(el.team) ?? `Team ${el.team}`,
        ownerTeamId,
        ownerAbbreviation: ownerTeamId ? (teamAbbrMap.get(ownerTeamId) ?? null) : null,
        ownerTeamName: ownerTeamId ? (teamNameMap.get(ownerTeamId) ?? null) : null,
        gwPoints: gwPoints[el.id] ?? 0,
        seasonPoints: el.total_points,
        nowCost: el.now_cost,
        status: el.status,
        minutes: el.minutes,
        purchasePrice: owner?.purchasePrice ?? null,
      });
    }

    // Default sort: GW points descending, then season points descending
    rows.sort((a, b) => b.gwPoints - a.gwPoints || b.seasonPoints - a.seasonPoints);

    const totalCount = rows.length;
    const start = (page - 1) * pageSize;
    const paged = rows.slice(start, start + pageSize);

    return NextResponse.json({
      gameweek,
      totalCount,
      page,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      rows: paged,
    });
  } catch (err) {
    console.error("Auction players API error:", err);
    return NextResponse.json({ error: "Failed to fetch player data" }, { status: 500 });
  }
}
