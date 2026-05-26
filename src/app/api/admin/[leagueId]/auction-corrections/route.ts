import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionOwnership, teams } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * POST /api/admin/[leagueId]/auction-corrections
 * Admin corrections for auction results.
 *
 * Actions:
 * - undo-sale: Revert a sold bid — delete ownership, refund buyer, mark bid cancelled
 * - manual-transfer: Move a player to another team (or to unowned) with purse adjustments
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const { action } = body;

  if (action === "undo-sale") {
    const { bidId } = body;
    if (!bidId) return NextResponse.json({ error: "bidId is required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      // Find the sold bid
      const bidRow = await tx
        .select()
        .from(auctionBids)
        .where(and(eq(auctionBids.id, bidId), eq(auctionBids.leagueId, leagueId)))
        .limit(1);

      if (bidRow.length === 0) return { error: "Bid not found", status: 404 };
      const bid = bidRow[0];

      if (bid.status !== "sold") return { error: "Bid is not in sold status", status: 400 };

      // Find and delete the ownership record
      const ownership = await tx
        .select()
        .from(auctionOwnership)
        .where(
          and(
            eq(auctionOwnership.leagueId, leagueId),
            eq(auctionOwnership.fplElementId, bid.fplElementId),
            eq(auctionOwnership.status, "active")
          )
        )
        .limit(1);

      if (ownership.length > 0) {
        const ow = ownership[0];
        // Delete ownership
        await tx.delete(auctionOwnership).where(eq(auctionOwnership.id, ow.id));
        // Refund the buyer's purse
        await tx
          .update(teams)
          .set({
            purse: sql`${teams.purse} + ${ow.purchasePrice}`,
            totalSpent: sql`${teams.totalSpent} - ${ow.purchasePrice}`,
          })
          .where(eq(teams.id, ow.teamId));
      }

      // Mark bid as cancelled
      await tx
        .update(auctionBids)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(auctionBids.id, bidId));

      return {
        success: true,
        message: `Undone: ${bid.playerName} sale reverted`,
        playerName: bid.playerName,
        fplElementId: bid.fplElementId,
      };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  }

  if (action === "manual-transfer") {
    const { ownershipId, toTeamId, price } = body;
    if (!ownershipId || !toTeamId) {
      return NextResponse.json({ error: "ownershipId and toTeamId are required" }, { status: 400 });
    }

    const result = await db.transaction(async (tx) => {
      const ow = await tx
        .select()
        .from(auctionOwnership)
        .where(and(eq(auctionOwnership.id, ownershipId), eq(auctionOwnership.leagueId, leagueId)))
        .limit(1);

      if (ow.length === 0) return { error: "Ownership not found", status: 404 };
      const ownership = ow[0];

      if (toTeamId === "unowned") {
        // Remove ownership entirely, full refund to original owner
        await tx.delete(auctionOwnership).where(eq(auctionOwnership.id, ownershipId));
        await tx
          .update(teams)
          .set({
            purse: sql`${teams.purse} + ${ownership.purchasePrice}`,
            totalSpent: sql`${teams.totalSpent} - ${ownership.purchasePrice}`,
          })
          .where(eq(teams.id, ownership.teamId));

        return { success: true, message: `${ownership.playerName} removed — ${ownership.teamId} refunded` };
      }

      // Transfer to another team
      const transferPrice = price ?? ownership.purchasePrice;

      // Refund original owner
      await tx
        .update(teams)
        .set({
          purse: sql`${teams.purse} + ${ownership.purchasePrice}`,
          totalSpent: sql`${teams.totalSpent} - ${ownership.purchasePrice}`,
        })
        .where(eq(teams.id, ownership.teamId));

      // Charge new owner
      await tx
        .update(teams)
        .set({
          purse: sql`${teams.purse} - ${transferPrice}`,
          totalSpent: sql`${teams.totalSpent} + ${transferPrice}`,
        })
        .where(eq(teams.id, toTeamId));

      // Update ownership
      await tx
        .update(auctionOwnership)
        .set({
          teamId: toTeamId,
          purchasePrice: transferPrice,
          updatedAt: new Date(),
        })
        .where(eq(auctionOwnership.id, ownershipId));

      return {
        success: true,
        message: `${ownership.playerName} transferred to ${toTeamId}`,
        playerName: ownership.playerName,
      };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
