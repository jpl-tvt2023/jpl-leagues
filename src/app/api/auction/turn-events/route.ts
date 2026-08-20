import { NextRequest, NextResponse } from "next/server";
import { db, auctionSessions, auctionTurnEvents } from "@/lib/db";
import { eq, desc, and } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * GET /api/auction/turn-events?sessionId=xxx&limit=50
 *
 * Recent nomination-turn events for a session, newest first. Backs the admin correction panel.
 *
 * Admin-only, and not part of the 3s participant poll: this is a diagnostic read, so it should not
 * add load to the hot path that already has ~20 processes per second hitting the session row.
 */
export async function GET(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const sessionId = request.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;

  // Scope to the caller's league so a session id from another league can't be read.
  const sess = await db
    .select({
      id: auctionSessions.id,
      snakeOrder: auctionSessions.snakeOrder,
      currentNominatorIndex: auctionSessions.currentNominatorIndex,
      makeupQueue: auctionSessions.makeupQueue,
      ringReturnIndex: auctionSessions.ringReturnIndex,
    })
    .from(auctionSessions)
    .where(and(eq(auctionSessions.id, sessionId), eq(auctionSessions.leagueId, leagueId)))
    .limit(1);
  if (sess.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const events = await db
    .select()
    .from(auctionTurnEvents)
    .where(eq(auctionTurnEvents.sessionId, sessionId))
    .orderBy(desc(auctionTurnEvents.createdAt))
    .limit(limit);

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      teamId: e.teamId,
      nominatorIndex: e.nominatorIndex,
      event: e.event,
      actor: e.actor,
      detail: e.detail,
      createdAt: e.createdAt,
    })),
    turnState: {
      currentNominatorIndex: sess[0].currentNominatorIndex,
      ringReturnIndex: sess[0].ringReturnIndex,
      makeupQueue: sess[0].makeupQueue,
      snakeOrder: sess[0].snakeOrder,
    },
  });
}
