import { NextRequest, NextResponse } from "next/server";
import { db, leagues, auctionSessions, auctionBids, teams } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { isSuperAdmin, verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { generateSnakeOrder } from "@/lib/formats/auction/mini-auction";
import {
  resolveExpiredBid,
  advanceNominator,
  setNominationDeadline,
} from "@/lib/formats/auction/resolve-bid";
import { simulateAuction } from "@/lib/formats/auction/simulate";
import { finalizePendingReleasesNow } from "@/lib/formats/auction/process-gameweek";
import { purgePendingTrades } from "@/lib/formats/auction/live-session";

/**
 * Auto-resolve expired open bids that SSE may have missed.
 * Creates ownership + deducts purse for sold bids, advances nominator.
 */
async function resolveExpiredBids(sessionId: string) {
  const openBids = await db
    .select()
    .from(auctionBids)
    .where(
      and(
        eq(auctionBids.sessionId, sessionId),
        eq(auctionBids.status, "open")
      )
    );

  const now = new Date();
  for (const bid of openBids) {
    if (now > bid.expiresAt) {
      const outcome = await resolveExpiredBid(bid);
      if (outcome === "sold") {
        await advanceNominator(sessionId);
      }
    }
  }
}

/**
 * GET /api/auction/session?leagueId=xxx
 * Returns the current/latest auction session for a league.
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

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  // Get all sessions for this league, most recent first
  const sessions = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.leagueId, leagueId))
    .orderBy(desc(auctionSessions.createdAt));

  // For the active/latest session, include current bid item
  const activeSession = sessions.find((s) => s.status === "active" || s.status === "paused");

  let currentBid = null;
  if (activeSession) {
    // Auto-resolve any expired open bids (safety net if SSE wasn't running)
    await resolveExpiredBids(activeSession.id);

    const openBids = await db
      .select()
      .from(auctionBids)
      .where(
        and(
          eq(auctionBids.sessionId, activeSession.id),
          eq(auctionBids.status, "open")
        )
      )
      .limit(1);
    currentBid = openBids[0] ?? null;
  }

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      type: s.type,
      cycleNumber: s.cycleNumber,
      status: s.status,
      snakeOrder: JSON.parse(s.snakeOrder),
      currentNominatorIndex: s.currentNominatorIndex,
      scheduledAt: s.scheduledAt?.toISOString() ?? null,
      createdAt: s.createdAt,
    })),
    activeSession: activeSession
      ? {
          id: activeSession.id,
          type: activeSession.type,
          status: activeSession.status,
          snakeOrder: JSON.parse(activeSession.snakeOrder),
          currentNominatorIndex: activeSession.currentNominatorIndex,
          nominationDeadline: activeSession.nominationDeadline?.toISOString() ?? null,
          scheduledAt: activeSession.scheduledAt?.toISOString() ?? null,
          currentBid,
        }
      : null,
  });
}

/**
 * POST /api/auction/session
 * Create a new auction session or update an existing one's status.
 * Admin only.
 *
 * Body: { leagueId, action: "create" | "start" | "pause" | "resume" | "complete", sessionId?, type?, cycleNumber? }
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { leagueId, action, sessionId, type, cycleNumber, scheduledAt, bidTimerSeconds, nominationTimeoutSeconds } = body;

  if (!leagueId || !action) {
    return NextResponse.json({ error: "leagueId and action are required" }, { status: 400 });
  }

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  if (action === "create") {
    // Get teams to generate snake order
    const leagueTeams = await db
      .select({ id: teams.id, leaguePoints: teams.leaguePoints })
      .from(teams)
      .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));

    if (leagueTeams.length === 0) {
      return NextResponse.json({ error: "No teams in league" }, { status: 400 });
    }

    // For initial auction, use random order; for mini-auctions, use reverse standings
    let snakeOrder: string[];
    if (type === "initial") {
      // Shuffle teams randomly for initial draft
      snakeOrder = leagueTeams
        .map((t) => ({ id: t.id, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map((t) => t.id);
    } else {
      // Mini-auction: bottom-ranked teams pick first
      const standings = leagueTeams.map((t, i) => ({ teamId: t.id, rank: i + 1 }));
      snakeOrder = generateSnakeOrder(standings);
    }

    const id = generateId();
    await db.insert(auctionSessions).values({
      id,
      leagueId,
      type: type ?? "initial",
      cycleNumber: cycleNumber ?? 0,
      status: "pending",
      snakeOrder: JSON.stringify(snakeOrder),
      currentNominatorIndex: 0,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      bidTimerSeconds: bidTimerSeconds ?? 20,
      nominationTimeoutSeconds: nominationTimeoutSeconds ?? 60,
    });

    return NextResponse.json({ success: true, id, snakeOrder });
  }

  // Status transitions for existing sessions
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required for status changes" }, { status: 400 });
  }

  const sessionRow = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);

  if (sessionRow.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const currentStatus = sessionRow[0].status;

  // Allow updating schedule on pending sessions without a status transition
  if (action === "schedule") {
    if (currentStatus !== "pending") {
      return NextResponse.json({ error: "Can only schedule pending sessions" }, { status: 400 });
    }
    await db
      .update(auctionSessions)
      .set({ scheduledAt: scheduledAt ? new Date(scheduledAt) : null })
      .where(eq(auctionSessions.id, sessionId));
    return NextResponse.json({ success: true, sessionId, scheduledAt: scheduledAt ?? null });
  }

  const validTransitions: Record<string, string[]> = {
    start: ["pending", "paused"],
    pause: ["active"],
    resume: ["paused"],
    complete: ["active", "paused"],
  };

  if (!validTransitions[action]?.includes(currentStatus)) {
    return NextResponse.json(
      { error: `Cannot ${action} a session in ${currentStatus} status` },
      { status: 400 }
    );
  }

  const newStatus = action === "start" || action === "resume" ? "active" : action === "pause" ? "paused" : "completed";

  // If starting a session in a simulated league, run auto-draft instead of live auction
  if (newStatus === "active" && (action === "start") && leagueRow[0].isSimulated) {
    await db
      .update(auctionSessions)
      .set({ status: "active" })
      .where(eq(auctionSessions.id, sessionId));

    try {
      const result = await simulateAuction(leagueId, sessionId);
      return NextResponse.json({
        success: true,
        sessionId,
        status: "completed",
        simulated: true,
        playersAssigned: result.playersAssigned,
      });
    } catch (err) {
      console.error("[session] Simulation failed:", err);
      return NextResponse.json(
        { error: `Simulation failed: ${err instanceof Error ? err.message : "unknown error"}` },
        { status: 500 }
      );
    }
  }

  await db
    .update(auctionSessions)
    .set({ status: newStatus })
    .where(eq(auctionSessions.id, sessionId));

  // When starting a mini-auction, finalize any pending player releases first
  if (newStatus === "active" && action === "start" && sessionRow[0].type === "mini-auction") {
    const gwNumber = sessionRow[0].cycleNumber ?? 0;
    await finalizePendingReleasesNow(leagueId, gwNumber);
  }

  // When starting/resuming, set the nomination deadline for the current nominator
  if (newStatus === "active") {
    await setNominationDeadline(sessionId);
  }

  // First-time start (not resume): purge any non-completed trade proposals so
  // the marketplace is fully locked down for the duration of the auction.
  if (newStatus === "active" && action === "start") {
    await purgePendingTrades(leagueId);
  }

  return NextResponse.json({ success: true, sessionId, status: newStatus });
}
