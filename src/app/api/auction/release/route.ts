import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { calculateRefund } from "@/lib/formats/auction/economy";
import { isAuctionLive } from "@/lib/formats/auction/live-session";

/**
 * POST /api/auction/release
 * Mark a player for pending release. The release only finalizes at GW 10/20/30 boundaries.
 * Player continues scoring for the team until then. Refund is NOT credited yet.
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

  // Get the ownership record
  const ownershipRow = await db
    .select()
    .from(auctionOwnership)
    .where(eq(auctionOwnership.id, ownershipId))
    .limit(1);

  if (ownershipRow.length === 0) {
    return NextResponse.json({ error: "Ownership record not found" }, { status: 404 });
  }

  const ownership = ownershipRow[0];

  if (ownership.status === "released") {
    return NextResponse.json({ error: "Player is already released" }, { status: 400 });
  }

  if (ownership.status === "pending_release") {
    return NextResponse.json({ error: "Player is already marked for release" }, { status: 400 });
  }

  // Verify the requesting team owns this player (unless admin)
  if (!isAdmin && session?.id !== ownership.teamId) {
    return NextResponse.json({ error: "You don't own this player" }, { status: 403 });
  }

  // Verify it's an auction league
  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, ownership.leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  if (await isAuctionLive(ownership.leagueId)) {
    return NextResponse.json(
      { error: "Marketplace is closed during a live auction" },
      { status: 409 }
    );
  }

  // Calculate projected refund (50% of purchase price) — for display only, not credited yet
  const projectedRefund = calculateRefund(ownership.purchasePrice);

  // Mark as pending release — do NOT update purse or totalRefunds
  await db
    .update(auctionOwnership)
    .set({
      status: "pending_release",
      updatedAt: new Date(),
    })
    .where(eq(auctionOwnership.id, ownershipId));

  return NextResponse.json({
    success: true,
    status: "pending_release",
    ownershipId,
    playerName: ownership.playerName,
    fplElementId: ownership.fplElementId,
    purchasePrice: ownership.purchasePrice,
    projectedRefund,
    projectedForfeit: ownership.purchasePrice - projectedRefund,
  });
}

/**
 * DELETE /api/auction/release
 * Cancel a pending release — revert player status back to "active".
 *
 * Body: { ownershipId }
 */
export async function DELETE(request: NextRequest) {
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

  const ownershipRow = await db
    .select()
    .from(auctionOwnership)
    .where(eq(auctionOwnership.id, ownershipId))
    .limit(1);

  if (ownershipRow.length === 0) {
    return NextResponse.json({ error: "Ownership record not found" }, { status: 404 });
  }

  const ownership = ownershipRow[0];

  if (ownership.status !== "pending_release") {
    return NextResponse.json({ error: "Player is not pending release" }, { status: 400 });
  }

  // Verify the requesting team owns this player (unless admin)
  if (!isAdmin && session?.id !== ownership.teamId) {
    return NextResponse.json({ error: "You don't own this player" }, { status: 403 });
  }

  if (await isAuctionLive(ownership.leagueId)) {
    return NextResponse.json(
      { error: "Marketplace is closed during a live auction" },
      { status: 409 }
    );
  }

  // Revert to active
  await db
    .update(auctionOwnership)
    .set({
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(auctionOwnership.id, ownershipId));

  return NextResponse.json({
    success: true,
    status: "active",
    ownershipId,
    playerName: ownership.playerName,
  });
}
