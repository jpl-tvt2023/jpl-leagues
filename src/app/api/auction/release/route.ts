import { NextRequest, NextResponse } from "next/server";
import { db, leagues, auctionOwnership, auctionScores } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { calculateFMV } from "@/lib/formats/auction/economy";
import { isAuctionLive } from "@/lib/formats/auction/live-session";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

/**
 * POST /api/auction/release
 * Mark a player for pending release. The release only finalizes at the league's configured
 * release-cycle gameweeks (see lib/formats/auction/cycle.ts; default GW 10/20/30).
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

  // NOTE: A release is allowed to drop the squad below the 1/3/3/1 positional minimum. Teams are
  // free to release and then rebuild during the next mini-auction; the minimum is enforced at the
  // point the *next* auction is completed (see `findCompositionOffenders` / the session-complete
  // guard), not at release time.

  // Refund = 50% of the player's FMV *at release time* (not the purchase price). FMV = purchase +
  // appreciation from cumulative RAW points (mirrors the squad API). Snapshot it now so the amount
  // is locked even if the player keeps scoring before the release finalises.
  const playerScores = await db
    .select({ playerBreakdown: auctionScores.playerBreakdown })
    .from(auctionScores)
    .where(and(eq(auctionScores.leagueId, ownership.leagueId), eq(auctionScores.teamId, ownership.teamId)));
  let totalPoints = 0;
  for (const s of playerScores) {
    try {
      const breakdown: Array<{ elementId: number; points?: number; rawPoints?: number }> = JSON.parse(s.playerBreakdown);
      for (const p of breakdown) {
        if (p.elementId === ownership.fplElementId) totalPoints += p.rawPoints ?? p.points ?? 0;
      }
    } catch { /* tolerate malformed rows */ }
  }
  const fmv = calculateFMV(ownership.purchasePrice, totalPoints);
  const projectedRefund = Math.floor(fmv * 0.5);

  // Mark as pending release and snapshot the refund — do NOT update purse or totalRefunds yet.
  await db
    .update(auctionOwnership)
    .set({
      status: "pending_release",
      releaseRefund: projectedRefund,
      updatedAt: new Date(),
    })
    .where(eq(auctionOwnership.id, ownershipId));

  await invalidateLeaguePageCache(ownership.leagueId).catch((err) =>
    console.error("[auction/release] standings cache invalidation failed:", err)
  );

  return NextResponse.json({
    success: true,
    status: "pending_release",
    ownershipId,
    playerName: ownership.playerName,
    fplElementId: ownership.fplElementId,
    purchasePrice: ownership.purchasePrice,
    fmv,
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

  // Revert to active
  await db
    .update(auctionOwnership)
    .set({
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(auctionOwnership.id, ownershipId));

  await invalidateLeaguePageCache(ownership.leagueId).catch((err) =>
    console.error("[auction/release] standings cache invalidation failed:", err)
  );

  return NextResponse.json({
    success: true,
    status: "active",
    ownershipId,
    playerName: ownership.playerName,
  });
}
