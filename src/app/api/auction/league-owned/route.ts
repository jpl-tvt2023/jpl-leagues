import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auctionOwnership, leagues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * GET /api/auction/league-owned?leagueId=xxx
 *
 * Returns the set of FPL element IDs currently owned (status = "active") by any
 * team in the given auction league, plus a teamId map so the nomination modal
 * can show "owned by X" next to already-owned players.
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
    .select({ format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!leagueRow.length || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  const owned = await db
    .select({
      fplElementId: auctionOwnership.fplElementId,
      teamId: auctionOwnership.teamId,
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

  return NextResponse.json({ ownedElementIds, ownerByElementId });
}
