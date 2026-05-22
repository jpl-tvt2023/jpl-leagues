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

  const rawWishlist = await db
    .select()
    .from(auctionWishlists)
    .where(eq(auctionWishlists.teamId, teamId))
    .orderBy(asc(auctionWishlists.priority));

  // Deduplicate by fplElementId — keep highest-priority (lowest number) entry, delete extras
  const seen = new Set<number>();
  const wishlist = [];
  const toDelete: string[] = [];
  for (const entry of rawWishlist) {
    if (seen.has(entry.fplElementId)) {
      toDelete.push(entry.id);
    } else {
      seen.add(entry.fplElementId);
      wishlist.push(entry);
    }
  }
  // Clean up duplicates in background
  if (toDelete.length > 0) {
    for (const id of toDelete) {
      await db.delete(auctionWishlists).where(eq(auctionWishlists.id, id));
    }
  }

  return NextResponse.json({ wishlist });
}

/**
 * POST /api/auction/wishlist
 * Add player(s) to the team's wishlist (appended at bottom).
 *
 * Body (single): { leagueId, teamId, fplElementId, playerName }
 * Body (bulk):   { leagueId, teamId, players: [{ fplElementId, playerName }, ...] }
 *
 * The bulk form is used by the auction page's Unsold-players multi-select. Duplicate
 * fplElementIds (already in wishlist) are silently skipped — the response reports how many
 * were actually inserted.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { leagueId, teamId, fplElementId, playerName, players } = body as {
    leagueId?: string;
    teamId?: string;
    fplElementId?: number;
    playerName?: string;
    players?: Array<{ fplElementId: number; playerName: string }>;
  };

  if (!leagueId || !teamId) {
    return NextResponse.json({ error: "leagueId and teamId are required" }, { status: 400 });
  }
  if (!isAdmin && session?.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Normalize to an array regardless of input shape so the rest of the handler is one path.
  const toAdd: Array<{ fplElementId: number; playerName: string }> = Array.isArray(players)
    ? players.filter((p) => typeof p?.fplElementId === "number" && typeof p?.playerName === "string")
    : fplElementId && playerName
      ? [{ fplElementId, playerName }]
      : [];

  if (toAdd.length === 0) {
    return NextResponse.json({ error: "Provide fplElementId+playerName or a non-empty players array" }, { status: 400 });
  }

  // One query for all existing wishlist fplElementIds — used to skip duplicates without N+1.
  const existingRows = await db
    .select({ fplElementId: auctionWishlists.fplElementId })
    .from(auctionWishlists)
    .where(and(eq(auctionWishlists.leagueId, leagueId), eq(auctionWishlists.teamId, teamId)));
  const existing = new Set(existingRows.map((r) => r.fplElementId));

  const maxRow = await db
    .select({ maxPriority: sql<number>`COALESCE(MAX(${auctionWishlists.priority}), 0)` })
    .from(auctionWishlists)
    .where(and(eq(auctionWishlists.leagueId, leagueId), eq(auctionWishlists.teamId, teamId)));
  let nextPriority = (maxRow[0]?.maxPriority ?? 0) + 1;

  let inserted = 0;
  let skipped = 0;
  for (const p of toAdd) {
    if (existing.has(p.fplElementId)) {
      skipped++;
      continue;
    }
    await db.insert(auctionWishlists).values({
      id: generateId(),
      leagueId,
      teamId,
      fplElementId: p.fplElementId,
      playerName: p.playerName,
      priority: nextPriority,
    });
    existing.add(p.fplElementId);
    nextPriority++;
    inserted++;
  }

  // Backwards-compat shape: single-insert callers expect `success` + (legacy) `id`/`priority`.
  // Bulk callers can read `inserted` / `skipped`.
  return NextResponse.json({ success: true, inserted, skipped });
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
