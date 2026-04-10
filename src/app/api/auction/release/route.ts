import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { calculateRefund } from "@/lib/formats/auction/economy";

/**
 * POST /api/auction/release
 * Release a player from a team's squad. Refund = 50% of purchase price.
 *
 * Body: { ownershipId }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { ownershipId } = body;

  if (!ownershipId) {
    return NextResponse.json({ error: "ownershipId is required" }, { status: 400 });
  }

  const result = await db.transaction(async (tx) => {
    // Get the ownership record
    const ownershipRow = await tx
      .select()
      .from(auctionOwnership)
      .where(eq(auctionOwnership.id, ownershipId))
      .limit(1);

    if (ownershipRow.length === 0) {
      return { error: "Ownership record not found", status: 404 };
    }

    const ownership = ownershipRow[0];

    if (ownership.status === "released") {
      return { error: "Player is already released", status: 400 };
    }

    // Verify the requesting team owns this player (unless admin)
    if (!isAdmin && session?.id !== ownership.teamId) {
      return { error: "You don't own this player", status: 403 };
    }

    // Verify it's an auction league
    const leagueRow = await tx.select().from(leagues).where(eq(leagues.id, ownership.leagueId)).limit(1);
    if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
      return { error: "Not an auction league", status: 400 };
    }

    // Calculate refund (50% of purchase price)
    const refund = calculateRefund(ownership.purchasePrice);

    // Update ownership status
    await tx
      .update(auctionOwnership)
      .set({
        status: "released",
        releasedGw: null, // will be set by admin to current GW if needed
        updatedAt: new Date(),
      })
      .where(eq(auctionOwnership.id, ownershipId));

    // Update team purse and refund tracking
    const teamRow = await tx.select().from(teams).where(eq(teams.id, ownership.teamId)).limit(1);
    if (teamRow.length > 0) {
      const team = teamRow[0];
      await tx
        .update(teams)
        .set({
          purse: team.purse + refund,
          totalRefunds: team.totalRefunds + refund,
          updatedAt: new Date(),
        })
        .where(eq(teams.id, ownership.teamId));
    }

    return {
      success: true,
      ownershipId,
      playerName: ownership.playerName,
      fplElementId: ownership.fplElementId,
      purchasePrice: ownership.purchasePrice,
      refundAmount: refund,
    };
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result);
}
