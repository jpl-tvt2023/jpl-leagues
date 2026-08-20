import { NextRequest, NextResponse } from "next/server";
import { db, auctionWishlists } from "@/lib/db";
import { eq, and, asc, sql } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";

/** Shared auth + ownership check. Teams may only touch their own wishlist; super-admins any. */
async function authorize(request: NextRequest, teamId: string | null | undefined) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }
  if (!isAdmin && session?.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  return null;
}

/**
 * GET /api/auction/wishlist?teamId=xxx
 * Returns the team's wishlist sorted by priority.
 *
 * Read-only. This used to delete duplicate rows inline on every request — and the auction room polls
 * it every 3s per connected client, so a passive read was issuing writes continuously. The unique
 * index on (team_id, fpl_element_id) makes duplicates impossible at the source; the in-memory filter
 * below is a display-only safety net for any row that predates it.
 */
export async function GET(request: NextRequest) {
  const teamId = request.nextUrl.searchParams.get("teamId");
  const denied = await authorize(request, teamId);
  if (denied) return denied;

  const rows = await db
    .select()
    .from(auctionWishlists)
    .where(eq(auctionWishlists.teamId, teamId!))
    .orderBy(asc(auctionWishlists.priority), asc(auctionWishlists.createdAt));

  const seen = new Set<number>();
  const wishlist = rows.filter((entry) => {
    if (seen.has(entry.fplElementId)) return false;
    seen.add(entry.fplElementId);
    return true;
  });

  return NextResponse.json({ wishlist });
}

/**
 * POST /api/auction/wishlist
 * Add player(s) to the team's wishlist (appended at bottom).
 *
 * Body (single): { leagueId, teamId, fplElementId, playerName }
 * Body (bulk):   { leagueId, teamId, players: [{ fplElementId, playerName }, ...] }
 *
 * Duplicates (already in the wishlist) are silently skipped; the response reports how many were
 * actually inserted. All inserts go out as ONE statement — bulk-add from the Unsold tab used to issue
 * one sequential round trip per player.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { leagueId, teamId, fplElementId, playerName, players } = body as {
    leagueId?: string;
    teamId?: string;
    fplElementId?: number;
    playerName?: string;
    players?: Array<{ fplElementId: number; playerName: string }>;
  };

  const denied = await authorize(request, teamId);
  if (denied) return denied;
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  // Normalize to an array regardless of input shape so the rest of the handler is one path.
  const toAdd: Array<{ fplElementId: number; playerName: string }> = Array.isArray(players)
    ? players.filter((p) => typeof p?.fplElementId === "number" && typeof p?.playerName === "string")
    : typeof fplElementId === "number" && playerName
      ? [{ fplElementId, playerName }]
      : [];

  if (toAdd.length === 0) {
    return NextResponse.json({ error: "Provide fplElementId+playerName or a non-empty players array" }, { status: 400 });
  }

  // One query for all existing wishlist fplElementIds — used to skip duplicates without N+1.
  const existingRows = await db
    .select({ fplElementId: auctionWishlists.fplElementId })
    .from(auctionWishlists)
    .where(and(eq(auctionWishlists.leagueId, leagueId), eq(auctionWishlists.teamId, teamId!)));
  const existing = new Set(existingRows.map((r) => r.fplElementId));

  const maxRow = await db
    .select({ maxPriority: sql<number>`COALESCE(MAX(${auctionWishlists.priority}), 0)` })
    .from(auctionWishlists)
    .where(and(eq(auctionWishlists.leagueId, leagueId), eq(auctionWishlists.teamId, teamId!)));
  let nextPriority = (maxRow[0]?.maxPriority ?? 0) + 1;

  const values: (typeof auctionWishlists.$inferInsert)[] = [];
  let skipped = 0;
  for (const p of toAdd) {
    if (existing.has(p.fplElementId)) {
      skipped++;
      continue;
    }
    values.push({
      id: generateId(),
      leagueId,
      teamId: teamId!,
      fplElementId: p.fplElementId,
      playerName: p.playerName,
      priority: nextPriority,
    });
    existing.add(p.fplElementId);
    nextPriority++;
  }

  if (values.length > 0) {
    await db.insert(auctionWishlists).values(values);
  }

  return NextResponse.json({ success: true, inserted: values.length, skipped });
}

/**
 * PATCH /api/auction/wishlist — reorder.
 *
 * Body: { teamId, moveId, beforeId }
 *   `beforeId` = id of the entry the moved entry should sit immediately ABOVE.
 *   `beforeId: null` sends it to the bottom.
 *
 * The move is expressed as an INTENT, not as a recomputed list. That matters for three reasons:
 *
 *  1. **Filter safety.** "Put A before B" is well-defined whatever the client has filtered out of
 *     view; "index ± 1" is not, which is why reordering used to be disabled outright whenever a
 *     position or club filter was active.
 *  2. **Payload.** The client used to send the entire re-indexed list on every arrow click — 327
 *     objects for the largest wishlist here. Now it sends two ids.
 *  3. **Round trips.** Only the rows whose priority actually changes are written, in ONE
 *     `db.batch()`. The previous handler issued one sequential UPDATE per item against a remote
 *     libSQL database: ~327 round trips, ~2s, per click.
 *
 * Densifying to 1..N as a side effect also repairs the priority gaps DELETE leaves behind and the
 * duplicate priorities that made `autoNominateFromWishlist`'s ORDER BY non-deterministic.
 *
 * The legacy `{ items: [{ id, priority }] }` shape is still accepted (batched) so a client loaded
 * before this deploy cannot start 400ing mid-auction.
 */
export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { teamId, moveId, beforeId, items } = body as {
    teamId?: string;
    moveId?: string;
    beforeId?: string | null;
    items?: Array<{ id: string; priority: number }>;
  };

  const denied = await authorize(request, teamId);
  if (denied) return denied;

  // --- Legacy path: explicit priorities, batched into one round trip ---
  if (!moveId && Array.isArray(items)) {
    const valid = items.filter((i) => typeof i?.id === "string" && Number.isFinite(i?.priority));
    if (valid.length === 0) return NextResponse.json({ success: true, updated: 0 });
    const legacy = valid.map((item) =>
      db
        .update(auctionWishlists)
        .set({ priority: item.priority })
        .where(and(eq(auctionWishlists.id, item.id), eq(auctionWishlists.teamId, teamId!)))
    );
    await db.batch(legacy as [(typeof legacy)[number], ...typeof legacy]);
    return NextResponse.json({ success: true, updated: valid.length });
  }

  if (!moveId) {
    return NextResponse.json({ error: "moveId (with beforeId) or items is required" }, { status: 400 });
  }
  if (beforeId != null && beforeId === moveId) {
    return NextResponse.json({ error: "beforeId cannot equal moveId" }, { status: 400 });
  }

  const rows = await db
    .select({ id: auctionWishlists.id, priority: auctionWishlists.priority })
    .from(auctionWishlists)
    .where(eq(auctionWishlists.teamId, teamId!))
    .orderBy(asc(auctionWishlists.priority), asc(auctionWishlists.createdAt));

  const moved = rows.find((r) => r.id === moveId);
  if (!moved) {
    return NextResponse.json({ error: "Entry not found in this team's wishlist" }, { status: 404 });
  }

  const next = rows.filter((r) => r.id !== moveId);
  let insertAt: number;
  if (beforeId == null) {
    insertAt = next.length;
  } else {
    insertAt = next.findIndex((r) => r.id === beforeId);
    if (insertAt < 0) {
      return NextResponse.json({ error: "beforeId not found in this team's wishlist" }, { status: 404 });
    }
  }
  next.splice(insertAt, 0, moved);

  // Only the rows that actually shift get written.
  const stmts = next
    .map((row, i) => ({ row, priority: i + 1 }))
    .filter(({ row, priority }) => row.priority !== priority)
    .map(({ row, priority }) =>
      db
        .update(auctionWishlists)
        .set({ priority })
        .where(and(eq(auctionWishlists.id, row.id), eq(auctionWishlists.teamId, teamId!)))
    );

  if (stmts.length > 0) {
    await db.batch(stmts as [(typeof stmts)[number], ...typeof stmts]);
  }

  return NextResponse.json({
    success: true,
    updated: stmts.length,
    order: next.map((r) => r.id),
  });
}

/**
 * DELETE /api/auction/wishlist
 * Remove an entry from the wishlist.
 *
 * Body: { id, teamId }
 */
export async function DELETE(request: NextRequest) {
  const body = await request.json();
  const { id, teamId } = body as { id?: string; teamId?: string };

  const denied = await authorize(request, teamId);
  if (denied) return denied;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  await db
    .delete(auctionWishlists)
    .where(and(eq(auctionWishlists.id, id), eq(auctionWishlists.teamId, teamId!)));

  return NextResponse.json({ success: true });
}
