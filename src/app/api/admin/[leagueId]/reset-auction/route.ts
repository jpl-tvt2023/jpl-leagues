import { NextRequest, NextResponse } from "next/server";
import {
  db,
  auctionBids,
  auctionSessions,
  auctionOwnership,
  auctionScores,
  tradeProposals,
  teams,
} from "@/lib/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * POST /api/admin/[leagueId]/reset-auction
 * Reset auction state to a prior checkpoint.
 *
 * Body: { resetTo: "initial" | "mini-1" | "mini-2" | "mini-3" }
 *
 * "initial" — full wipe of all auction data
 * "mini-N"  — keep data from sessions with cycleNumber < N, delete the rest
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const { resetTo } = body as { resetTo: string };

  if (!resetTo) {
    return NextResponse.json({ error: "resetTo is required" }, { status: 400 });
  }

  if (resetTo === "initial") {
    // Full wipe — delete everything auction-related for this league
    // Order matters: delete bids before sessions (FK), ownership, wishlists, scores, trades
    await db.delete(auctionBids).where(eq(auctionBids.leagueId, leagueId));
    await db.delete(auctionSessions).where(eq(auctionSessions.leagueId, leagueId));
    await db.delete(auctionOwnership).where(eq(auctionOwnership.leagueId, leagueId));
    // Wishlists are preserved across resets — they are user-curated
    await db.delete(auctionScores).where(eq(auctionScores.leagueId, leagueId));
    await db.delete(tradeProposals).where(eq(tradeProposals.leagueId, leagueId));

    // Reset team economy columns
    await db
      .update(teams)
      .set({
        totalSpent: 0,
        totalRefunds: 0,
        totalIncome: 0,
        penaltySlots: 0,
        purse: 0,
      })
      .where(eq(teams.leagueId, leagueId));

    return NextResponse.json({
      success: true,
      message: "Auction fully reset to initial state",
      resetTo,
    });
  }

  // Mini-auction reset: "mini-1", "mini-2", "mini-3"
  const match = resetTo.match(/^mini-(\d+)$/);
  if (!match) {
    return NextResponse.json({ error: 'resetTo must be "initial" or "mini-N"' }, { status: 400 });
  }

  const cycleNumber = parseInt(match[1], 10);

  // Find sessions to delete (cycleNumber >= N)
  const sessionsToDelete = await db
    .select({ id: auctionSessions.id })
    .from(auctionSessions)
    .where(
      and(
        eq(auctionSessions.leagueId, leagueId),
        sql`${auctionSessions.cycleNumber} >= ${cycleNumber}`
      )
    );

  const sessionIds = sessionsToDelete.map((s) => s.id);

  if (sessionIds.length > 0) {
    // Get fplElementIds from sold bids in these sessions — these ownerships need to be deleted
    const soldBids = await db
      .select({ fplElementId: auctionBids.fplElementId })
      .from(auctionBids)
      .where(
        and(
          eq(auctionBids.leagueId, leagueId),
          eq(auctionBids.status, "sold"),
          inArray(auctionBids.sessionId, sessionIds)
        )
      );

    const fplElementIds = soldBids.map((b) => b.fplElementId);

    // Delete ownerships for players sold in these sessions
    if (fplElementIds.length > 0) {
      await db
        .delete(auctionOwnership)
        .where(
          and(
            eq(auctionOwnership.leagueId, leagueId),
            inArray(auctionOwnership.fplElementId, fplElementIds)
          )
        );
    }

    // Delete bids in these sessions
    for (const sid of sessionIds) {
      await db.delete(auctionBids).where(eq(auctionBids.sessionId, sid));
    }

    // Delete the sessions
    for (const sid of sessionIds) {
      await db.delete(auctionSessions).where(eq(auctionSessions.id, sid));
    }
  }

  // Wishlists are preserved across resets — they are user-curated

  // Recalculate team totalSpent from remaining active ownerships
  const leagueTeams = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));

  for (const team of leagueTeams) {
    const ownerships = await db
      .select({ purchasePrice: auctionOwnership.purchasePrice })
      .from(auctionOwnership)
      .where(
        and(
          eq(auctionOwnership.leagueId, leagueId),
          eq(auctionOwnership.teamId, team.id),
          eq(auctionOwnership.status, "active")
        )
      );

    const totalSpent = ownerships.reduce((sum, o) => sum + o.purchasePrice, 0);
    await db
      .update(teams)
      .set({ totalSpent, penaltySlots: 0 })
      .where(eq(teams.id, team.id));
  }

  return NextResponse.json({
    success: true,
    message: `Auction reset to before mini-auction ${cycleNumber}`,
    resetTo,
    sessionsDeleted: sessionIds.length,
  });
}
