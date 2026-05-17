import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auctionScores, gameweeks, leagues, teams } from "@/lib/db/schema";
import { and, eq, lte } from "drizzle-orm";

/**
 * GET /api/auction/gw-summary?leagueSlug=xxx&gw=N
 *
 * Returns per-team scoring data for a single processed gameweek in an auction
 * league: each team's GW points, rank, payout, and the contributing players.
 * Also returns the list of processed gameweeks so the client can build a GW picker.
 *
 * Publicly readable — same visibility as Standings.
 */
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("leagueSlug");
  const gwParam = request.nextUrl.searchParams.get("gw");

  if (!slug) {
    return NextResponse.json({ error: "leagueSlug is required" }, { status: 400 });
  }

  const [league] = await db.select().from(leagues).where(eq(leagues.slug, slug)).limit(1);
  if (!league) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }
  if (league.format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  const now = new Date();
  const gws = await db
    .select({ id: gameweeks.id, number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, league.id), lte(gameweeks.deadline, now)));

  if (gws.length === 0) {
    return NextResponse.json({
      leagueId: league.id,
      processedGameweeks: [],
      selectedGw: null,
      rows: [],
    });
  }

  const allScores = await db
    .select({
      teamId: auctionScores.teamId,
      gameweekId: auctionScores.gameweekId,
      totalPoints: auctionScores.totalPoints,
      rank: auctionScores.rank,
      payout: auctionScores.payout,
      playerBreakdown: auctionScores.playerBreakdown,
    })
    .from(auctionScores)
    .where(eq(auctionScores.leagueId, league.id));

  const scoredGwIds = new Set(allScores.map((s) => s.gameweekId));
  const processedGameweeks = gws
    .filter((g) => scoredGwIds.has(g.id))
    .map((g) => g.number)
    .sort((a, b) => a - b);

  if (processedGameweeks.length === 0) {
    return NextResponse.json({
      leagueId: league.id,
      processedGameweeks: [],
      selectedGw: null,
      rows: [],
    });
  }

  const requestedGw = gwParam ? parseInt(gwParam, 10) : NaN;
  const selectedGw = Number.isFinite(requestedGw) && processedGameweeks.includes(requestedGw)
    ? requestedGw
    : processedGameweeks[processedGameweeks.length - 1];

  const targetGameweek = gws.find((g) => g.number === selectedGw);
  if (!targetGameweek) {
    return NextResponse.json({
      leagueId: league.id,
      processedGameweeks,
      selectedGw,
      rows: [],
    });
  }

  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.leagueId, league.id));
  const teamNameMap = new Map(teamRows.map((t) => [t.id, t.name]));

  type BreakdownPlayer = { elementId: number; name: string; points: number };

  const rows = allScores
    .filter((s) => s.gameweekId === targetGameweek.id)
    .map((s) => {
      let players: BreakdownPlayer[] = [];
      try {
        const parsed = JSON.parse(s.playerBreakdown) as BreakdownPlayer[];
        if (Array.isArray(parsed)) players = parsed;
      } catch {
        // Malformed JSON in playerBreakdown — skip the per-player view but keep the row.
      }
      return {
        teamId: s.teamId,
        teamName: teamNameMap.get(s.teamId) ?? "Unknown",
        totalPoints: s.totalPoints,
        rank: s.rank ?? 0,
        payout: s.payout,
        players: players.sort((a, b) => b.points - a.points),
      };
    })
    .sort((a, b) => {
      if (a.rank && b.rank && a.rank !== b.rank) return a.rank - b.rank;
      return b.totalPoints - a.totalPoints;
    });

  return NextResponse.json({
    leagueId: league.id,
    processedGameweeks,
    selectedGw,
    rows,
  });
}
