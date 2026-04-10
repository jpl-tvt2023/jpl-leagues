import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionScores, gameweeks } from "@/lib/db";
import { eq, and, asc } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { calculatePurse } from "@/lib/formats/auction/economy";

/**
 * GET /api/auction/economy?teamId=xxx
 * Returns a team's full economic breakdown: purse, income history, spending.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teamId = request.nextUrl.searchParams.get("teamId");
  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }

  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  const team = teamRow[0];

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  // Get GW-by-GW income history
  const scores = await db
    .select({
      gameweekId: auctionScores.gameweekId,
      totalPoints: auctionScores.totalPoints,
      rank: auctionScores.rank,
      payout: auctionScores.payout,
    })
    .from(auctionScores)
    .where(
      and(
        eq(auctionScores.leagueId, leagueRow[0].id),
        eq(auctionScores.teamId, teamId)
      )
    );

  // Map gameweekId -> GW number
  const gwIds = scores.map((s) => s.gameweekId);
  const gwRows = gwIds.length > 0
    ? await db.select().from(gameweeks).where(eq(gameweeks.leagueId, leagueRow[0].id)).orderBy(asc(gameweeks.number))
    : [];
  const gwNumberMap = new Map(gwRows.map((gw) => [gw.id, gw.number]));

  const incomeHistory = scores
    .map((s) => ({
      gw: gwNumberMap.get(s.gameweekId) ?? 0,
      points: s.totalPoints,
      rank: s.rank ?? 0,
      payout: s.payout,
    }))
    .sort((a, b) => a.gw - b.gw);

  const computedPurse = calculatePurse(
    leagueRow[0].initialBudget,
    team.totalIncome,
    team.totalSpent,
    team.totalRefunds
  );

  return NextResponse.json({
    teamId,
    teamName: team.name,
    initialBudget: leagueRow[0].initialBudget,
    currentPurse: team.purse,
    computedPurse,
    totalSpent: team.totalSpent,
    totalIncome: team.totalIncome,
    totalRefunds: team.totalRefunds,
    incomeHistory,
  });
}
