import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auctionOwnership, leagues, teams } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { calculatePurse } from "@/lib/formats/auction/economy";

/**
 * GET /api/auction/league-owned?leagueId=xxx
 *
 * Returns the set of FPL element IDs currently owned (status = "active") by any
 * team in the given auction league, plus per-team ownership details for the
 * nomination order table (purse, owned players with purchasePrice).
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const leagueId = request.nextUrl.searchParams.get("leagueId");
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  const leagueRow = await db
    .select({ format: leagues.format, initialBudget: leagues.initialBudget })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!leagueRow.length || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  const initialBudget = leagueRow[0].initialBudget;

  const owned = await db
    .select({
      fplElementId: auctionOwnership.fplElementId,
      teamId: auctionOwnership.teamId,
      playerName: auctionOwnership.playerName,
      purchasePrice: auctionOwnership.purchasePrice,
    })
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueId),
        eq(auctionOwnership.status, "active")
      )
    );

  const ownedElementIds = owned.map((o) => o.fplElementId);
  const ownerByElementId: Record<number, string> = {};
  for (const o of owned) {
    ownerByElementId[o.fplElementId] = o.teamId;
  }

  // Per-team ownership details for nomination order table
  const leagueTeams = await db
    .select({
      id: teams.id,
      totalSpent: teams.totalSpent,
      totalIncome: teams.totalIncome,
      totalRefunds: teams.totalRefunds,
      penaltySlots: teams.penaltySlots,
      bonusSlots: teams.bonusSlots,
    })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));

  const teamSummaries: Record<string, {
    purse: number;
    penaltySlots: number;
    bonusSlots: number;
    players: { fplElementId: number; playerName: string; purchasePrice: number }[];
  }> = {};

  for (const t of leagueTeams) {
    teamSummaries[t.id] = {
      purse: calculatePurse(initialBudget, t.totalIncome, t.totalSpent, t.totalRefunds),
      penaltySlots: t.penaltySlots ?? 0,
      bonusSlots: t.bonusSlots ?? 0,
      players: [],
    };
  }

  for (const o of owned) {
    if (teamSummaries[o.teamId]) {
      teamSummaries[o.teamId].players.push({
        fplElementId: o.fplElementId,
        playerName: o.playerName,
        purchasePrice: o.purchasePrice,
      });
    }
  }

  return NextResponse.json({ ownedElementIds, ownerByElementId, teamSummaries });
}
