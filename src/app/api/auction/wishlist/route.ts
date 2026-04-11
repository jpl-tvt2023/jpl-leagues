import { NextRequest, NextResponse } from "next/server";
import { db, auctionWishlists } from "@/lib/db";
import { eq, and, asc, gt, lt, sql } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";

/**
 * GET /api/auction/wishlist?teamId=xxx
 * Returns the team's wishlist sorted by priority.
 * Team can only view their own; admins can view any.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const teamId = request.nextUrl.searchParams.get("teamId");
  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }

  // Team can only view own wishlist
  if (!isAdmin && session?.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const wishlist = await db
    .select()
    .from(auctionWishlists)
    .where(eq(auctionWishlists.teamId, teamId))
    .orderBy(asc(auctionWishlists.priority));

  return NextResponse.json({ wishlist });
}

/**
 * POST /api/auction/wishlist
 * Add a player to the team's wishlist (appended at bottom).
 *
 * Body: { leagueId, teamId, fplElementId, playerName }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { leagueId, teamId, fplElementId, playerName } = body;

  if (!leagueId || !teamId || !fplElementId || !playerName) {
    return NextResponse.json(
      { error: "leagueId, teamId, fplElementId, and playerName are required" },
      { status: 400 }
    );
  }

  if (!isAdmin && session?.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Check for duplicate
  const existing = await db
    .select({ id: auctionWishlists.id })
    .from(auctionWishlists)
    .where(
      and(
        eq(auctionWishlists.leagueId, leagueId),
        eq(auctionWishlists.teamId, teamId),
        eq(auctionWishlists.fplElementId, fplElementId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json({ error: "Player already in wishlist" }, { status: 400 });
  }

  // Get max priority to append at bottom
  const maxRow = await db
    .select({ maxPriority: sql<number>`COALESCE(MAX(${auctionWishlists.priority}), 0)` })
    .from(auctionWishlists)
    .where(
      and(
        eq(auctionWishlists.leagueId, leagueId),
        eq(auctionWishlists.teamId, teamId)
      )
    );

  const nextPriority = (maxRow[0]?.maxPriority ?? 0) + 1;

  const id = generateId();
  await db.insert(auctionWishlists).values({
    id,
    leagueId,
    teamId,
    fplElementId,
    playerName,
    priority: nextPriority,
  });

  return NextResponse.json({ success: true, id, priority: nextPriority });
}

/**
 * PATCH /api/auction/wishlist
 * Reorder the wishlist.
 *
 * Body: { teamId, items: [{ id, priority }] }
 */
export async function PATCH(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { teamId, items } = body;

  if (!teamId || !Array.isArray(items)) {
    return NextResponse.json({ error: "teamId and items array are required" }, { status: 400 });
  }

  if (!isAdmin && session?.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  for (const item of items) {
    await db
      .update(auctionWishlists)
      .set({ priority: item.priority })
      .where(
        and(
          eq(auctionWishlists.id, item.id),
          eq(auctionWishlists.teamId, teamId)
        )
      );
  }

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/auction/wishlist
 * Remove an entry from the wishlist.
 *
 * Body: { id, teamId }
 */
export async function DELETE(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { id, teamId } = body;

  if (!id || !teamId) {
    return NextResponse.json({ error: "id and teamId are required" }, { status: 400 });
  }

  if (!isAdmin && session?.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  await db
    .delete(auctionWishlists)
    .where(
      and(
        eq(auctionWishlists.id, id),
        eq(auctionWishlists.teamId, teamId)
      )
    );

  return NextResponse.json({ success: true });
}
