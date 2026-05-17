import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership, auctionScores } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { calculateFMV } from "@/lib/formats/auction/economy";

/**
 * GET /api/auction/squad?teamId=xxx
 * Returns a team's 14-player auction squad with stats and FMV.
 * Accessible by any authenticated team in the same league, or admin.
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

  // Get the team and verify it belongs to an auction league
  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, teamRow[0].leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  // Get all owned players (active + deadwood)
  const ownedPlayers = await db
    .select()
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueRow[0].id),
        eq(auctionOwnership.teamId, teamId)
      )
    );

  // Get all auction scores for this team to compute cumulative points per player
  const scores = await db
    .select()
    .from(auctionScores)
    .where(
      and(
        eq(auctionScores.leagueId, leagueRow[0].id),
        eq(auctionScores.teamId, teamId)
      )
    );

  // Accumulate total points per element across all GWs
  const elementTotalPoints = new Map<number, number>();
  for (const score of scores) {
    const breakdown: { elementId: number; points: number }[] = JSON.parse(score.playerBreakdown);
    for (const p of breakdown) {
      elementTotalPoints.set(p.elementId, (elementTotalPoints.get(p.elementId) ?? 0) + p.points);
    }
  }

  const squad = ownedPlayers
    .filter((p) => p.status !== "released")
    .map((p) => {
      const totalPoints = elementTotalPoints.get(p.fplElementId) ?? 0;
      const fmv = calculateFMV(p.purchasePrice, totalPoints);
      return {
        ownershipId: p.id,
        fplElementId: p.fplElementId,
        playerName: p.playerName,
        elementType: p.elementType,
        purchasePrice: p.purchasePrice,
        acquiredGw: p.acquiredGw,
        status: p.status,
        totalPoints,
        fmv,
      };
    });

  return NextResponse.json({
    teamId,
    teamName: teamRow[0].name,
    leagueId: leagueRow[0].id,
    squad,
    activeCount: squad.filter((p) => p.status === "active").length,
    deadwoodCount: squad.filter((p) => p.status === "deadwood").length,
  });
}
