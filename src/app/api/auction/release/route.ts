import { NextRequest, NextResponse } from "next/server";
import { db, leagues, auctionOwnership } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { FplAvailabilityError, priceRelease, type ReleasePricing } from "@/lib/formats/auction/release-pricing";
import { getNextMiniAuction, isAuctionLive } from "@/lib/formats/auction/live-session";
import { RELEASE_DEADLINE_HOURS, isReleaseWindowClosed } from "@/lib/formats/auction/release-deadline";
import { confirmDueReleases } from "@/lib/formats/auction/process-gameweek";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { withDbRetry } from "@/lib/db/errors";

/**
 * /api/auction/release — price, mark and cancel player releases.
 *
 * A release is confirmed 24 hours before the next mini-auction's scheduled start (see
 * lib/formats/auction/release-deadline.ts), or when that auction starts if it starts sooner. The
 * player keeps scoring for the team until then. The refund is NOT credited at mark time — it is
 * priced and snapshotted then (lib/formats/auction/release-refund.ts has the 50% / 80% deadwood
 * rule) and credited at confirmation.
 */

type Ownership = typeof auctionOwnership.$inferSelect;

/**
 * Shared gate: signed in, the ownership row exists, the caller owns it (or is superadmin), it is
 * in an auction league, and no live auction is holding the marketplace closed.
 */
async function authorizeOwnership(
  request: NextRequest,
  ownershipId: unknown
): Promise<{ ownership: Ownership } | { error: NextResponse }> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return { error: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  }

  if (!ownershipId || typeof ownershipId !== "string") {
    return { error: NextResponse.json({ error: "ownershipId is required" }, { status: 400 }) };
  }

  // Reads only, so a Turso blip (ECONNRESET / socket hang up) is retried rather than surfaced.
  const ownershipRow = await withDbRetry("release ownership lookup", () =>
    db.select().from(auctionOwnership).where(eq(auctionOwnership.id, ownershipId)).limit(1)
  );

  if (ownershipRow.length === 0) {
    return { error: NextResponse.json({ error: "Ownership record not found" }, { status: 404 }) };
  }

  const ownership = ownershipRow[0];

  if (!isAdmin && session?.id !== ownership.teamId) {
    return { error: NextResponse.json({ error: "You don't own this player" }, { status: 403 }) };
  }

  const leagueRow = await withDbRetry("release league lookup", () =>
    db.select().from(leagues).where(eq(leagues.id, ownership.leagueId)).limit(1)
  );
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return { error: NextResponse.json({ error: "Not an auction league" }, { status: 400 }) };
  }

  if (await isAuctionLive(ownership.leagueId)) {
    return {
      error: NextResponse.json({ error: "Marketplace is closed during a live auction" }, { status: 409 }),
    };
  }

  return { ownership };
}

/**
 * From the release deadline (24h before the next mini-auction) until that auction is over, releases
 * can't be marked or cancelled — the player pool is final. This request may be the first one past
 * the deadline, so confirm what's pending before refusing.
 */
async function refuseIfReleasesClosed(leagueId: string): Promise<NextResponse | null> {
  const nextMini = await getNextMiniAuction(leagueId);
  if (!nextMini || !isReleaseWindowClosed(nextMini)) return null;
  await confirmDueReleases(leagueId).catch((err) => console.error("[auction/release] confirmDueReleases failed:", err));
  return NextResponse.json(
    {
      error:
        `Releases closed ${RELEASE_DEADLINE_HOURS} hours before Mini-Auction #${nextMini.cycleNumber} and pending ones ` +
        "have been confirmed. You can release players again once that auction is over.",
    },
    { status: 409 }
  );
}

/** Only a player still in the squad can be released (or priced for release). */
function alreadyReleasing(ownership: Ownership): NextResponse | null {
  if (ownership.status === "released") {
    return NextResponse.json({ error: "Player is already released" }, { status: 400 });
  }
  if (ownership.status === "pending_release") {
    return NextResponse.json({ error: "Player is already marked for release" }, { status: 400 });
  }
  // A traded-away player's old row is the team's history, not a squad member.
  if (ownership.status !== "active" && ownership.status !== "deadwood") {
    return NextResponse.json({ error: "Player is no longer in your squad" }, { status: 400 });
  }
  return null;
}

/** Price the release, or answer a retryable 503 when FPL can't be read. Other errors propagate. */
async function priceOr503(ownership: Ownership): Promise<ReleasePricing | NextResponse> {
  try {
    return await priceRelease(ownership);
  } catch (err) {
    if (!(err instanceof FplAvailabilityError)) throw err;
    console.warn("[auction/release]", err.message);
    return NextResponse.json(
      { error: "Couldn't check this player's FPL availability right now — please try again in a few minutes." },
      { status: 503 }
    );
  }
}

/**
 * GET /api/auction/release?ownershipId=xxx
 * Price a release without marking it, so the release dialog can show the exact refund, how it was
 * worked out, and why the player is (or isn't) deadwood. The POST re-prices; this is display only.
 */
export async function GET(request: NextRequest) {
  const auth = await authorizeOwnership(request, request.nextUrl.searchParams.get("ownershipId"));
  if ("error" in auth) return auth.error;
  const { ownership } = auth;

  const blocked = alreadyReleasing(ownership);
  if (blocked) return blocked;

  const priced = await priceOr503(ownership);
  if (priced instanceof NextResponse) return priced;

  return NextResponse.json({
    ownershipId: ownership.id,
    playerName: ownership.playerName,
    ...priced,
  });
}

/**
 * POST /api/auction/release
 * Mark a player for pending release and snapshot the refund, the FMV it used and the deadwood
 * verdict — the amount is locked even if he keeps scoring (or his availability changes) before
 * the release finalizes.
 *
 * Body: { ownershipId }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const auth = await authorizeOwnership(request, body.ownershipId);
  if ("error" in auth) return auth.error;
  const { ownership } = auth;

  const blocked = alreadyReleasing(ownership);
  if (blocked) return blocked;

  const closed = await refuseIfReleasesClosed(ownership.leagueId);
  if (closed) return closed;

  // NOTE: A release is allowed to drop the squad below the 1/3/3/1 positional minimum. Teams are
  // free to release and then rebuild during the next mini-auction; the minimum is enforced at the
  // point the *next* auction is completed (see `findCompositionOffenders` / the session-complete
  // guard), not at release time.

  const priced = await priceOr503(ownership);
  if (priced instanceof NextResponse) return priced;
  const { breakdown } = priced;

  // Mark as pending release and snapshot the pricing — do NOT update purse or totalRefunds yet.
  await db
    .update(auctionOwnership)
    .set({
      status: "pending_release",
      releaseRefund: breakdown.refund,
      releaseFmv: breakdown.fmv,
      deadwoodReason: breakdown.deadwoodReason,
      updatedAt: new Date(),
    })
    .where(eq(auctionOwnership.id, ownership.id));

  await invalidateLeaguePageCache(ownership.leagueId).catch((err) =>
    console.error("[auction/release] standings cache invalidation failed:", err)
  );

  return NextResponse.json({
    success: true,
    status: "pending_release",
    ownershipId: ownership.id,
    playerName: ownership.playerName,
    fplElementId: ownership.fplElementId,
    ...priced,
  });
}

/**
 * DELETE /api/auction/release
 * Cancel a pending release — revert the player to "active" and drop the snapshot, so a later
 * release is priced afresh.
 *
 * Body: { ownershipId }
 */
export async function DELETE(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const auth = await authorizeOwnership(request, body.ownershipId);
  if ("error" in auth) return auth.error;
  const { ownership } = auth;

  if (ownership.status !== "pending_release") {
    return NextResponse.json({ error: "Player is not pending release" }, { status: 400 });
  }

  const closed = await refuseIfReleasesClosed(ownership.leagueId);
  if (closed) return closed;

  // Only while still pending: a confirmation landing at the same moment wins, and the refund it
  // paid can't be followed by the player coming back.
  const reverted = await db
    .update(auctionOwnership)
    .set({
      status: "active",
      releaseRefund: null,
      releaseFmv: null,
      deadwoodReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(auctionOwnership.id, ownership.id), eq(auctionOwnership.status, "pending_release")))
    .returning({ id: auctionOwnership.id });
  if (reverted.length === 0) {
    return NextResponse.json({ error: "This release has already been confirmed" }, { status: 409 });
  }

  await invalidateLeaguePageCache(ownership.leagueId).catch((err) =>
    console.error("[auction/release] standings cache invalidation failed:", err)
  );

  return NextResponse.json({
    success: true,
    status: "active",
    ownershipId: ownership.id,
    playerName: ownership.playerName,
  });
}
