import { NextRequest, NextResponse } from "next/server";
import { db, leagues, auctionSessions, auctionBids, teams } from "@/lib/db";
import { eq, and, desc, isNotNull } from "drizzle-orm";
import { isSuperAdmin, verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { generateSnakeOrder } from "@/lib/formats/auction/mini-auction";
import {
  resolveExpiredBid,
  beginIntermission,
  advanceNominator,
  setNominationDeadline,
  auditAuctionComposition,
  findCompositionOffenders,
  allSquadsFull,
} from "@/lib/formats/auction/resolve-bid";
import { simulateAuction } from "@/lib/formats/auction/simulate";
import { finalizePendingReleasesNow } from "@/lib/formats/auction/process-gameweek";
import { purgePendingTrades } from "@/lib/formats/auction/live-session";
import {
  CLUB_AUCTION_SESSION_TYPE,
  fetchAllPLClubsWithTiers,
  setClubNominationDeadline,
  simulateClubAuction,
  loadStandingsConfig,
  getClubLessTeamIds,
} from "@/lib/formats/auction/club-auction";
import { resolveTier } from "@/lib/data/pl-standings-seed";
import { writeAuctionCompleteSnapshot } from "@/lib/backup/snapshot";

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
  let hadOpenBids = false;
  for (const bid of openBids) {
    hadOpenBids = true;
    if (now > bid.expiresAt) {
      const outcome = await resolveExpiredBid(bid);
      if (outcome === "sold") {
        // Begin the post-sale intermission (the SSE stream advances the nominator when it elapses),
        // mirroring the stream's resolution path so the safety-net doesn't skip the cooldown.
        await beginIntermission(sessionId);
      }
    }
  }

  // Intermission self-healing: if the post-sale cooldown has elapsed and nothing is on the block,
  // advance the nominator here too — so the auction can't stall between lots when no SSE stream is
  // live to do it. Atomic claim (intermissionUntil → null) guarantees a single advance across pollers.
  if (!hadOpenBids) {
    const sess = await db
      .select({ status: auctionSessions.status, intermissionUntil: auctionSessions.intermissionUntil })
      .from(auctionSessions)
      .where(eq(auctionSessions.id, sessionId))
      .limit(1);
    if (sess.length && sess[0].status === "active" && sess[0].intermissionUntil && now >= sess[0].intermissionUntil) {
      const claimed = await db
        .update(auctionSessions)
        .set({ intermissionUntil: null })
        .where(and(eq(auctionSessions.id, sessionId), isNotNull(auctionSessions.intermissionUntil)));
      if (claimed.rowsAffected > 0) {
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

  let currentBid: (typeof auctionBids.$inferSelect & { tier?: string | null }) | null = null;
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
    // For club-auction sessions, attach tier so the UI can render a TierChip on first paint
    // (before the SSE stream fills in subsequent updates).
    if (currentBid && activeSession.type === CLUB_AUCTION_SESSION_TYPE) {
      try {
        const config = await loadStandingsConfig();
        currentBid = { ...currentBid, tier: resolveTier(currentBid.fplElementId, config) };
      } catch (e) {
        console.warn("[session GET] loadStandingsConfig failed — tier will be null", e);
        currentBid = { ...currentBid, tier: null };
      }
    }
  }

  // For a club auction, signal when every team owns a club so the UI can show a "complete — awaiting
  // admin" conclusion (the session idles rather than auto-completing). Also derive the caller's own
  // club-ownership eligibility from the same authoritative list — piggybacking on this endpoint's
  // already-frequent refresh cadence (SSE-driven `refreshSessionState`) so the bid buttons never lag
  // behind what the server would actually accept, independent of the separate `/api/standings` cache.
  let allClubsAllocated = false;
  let myOwnsClub = false;
  if (activeSession && activeSession.type === CLUB_AUCTION_SESSION_TYPE) {
    const clublessIds = await getClubLessTeamIds(leagueId);
    allClubsAllocated = clublessIds.length === 0;
    if (session.type === "team") myOwnsClub = !clublessIds.includes(session.id);
  }

  // For a player auction (initial / mini), signal when every squad is full so the UI shows a
  // "auction complete — awaiting admin" conclusion instead of "Waiting for <team>..." while the
  // session idles with no eligible nominators left.
  let nominationsComplete = false;
  if (activeSession && activeSession.type !== CLUB_AUCTION_SESSION_TYPE && !currentBid) {
    let snakeOrder: string[] = [];
    try { snakeOrder = JSON.parse(activeSession.snakeOrder); } catch { snakeOrder = []; }
    nominationsComplete = await allSquadsFull(leagueId, snakeOrder);
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
          bidTimerSeconds: activeSession.bidTimerSeconds ?? 20,
          nominationTimeoutSeconds: activeSession.nominationTimeoutSeconds ?? 60,
          intermissionSeconds: activeSession.intermissionSeconds ?? 5,
          intermissionUntil: activeSession.intermissionUntil?.toISOString() ?? null,
          allClubsAllocated,
          myOwnsClub,
          nominationsComplete,
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
  const { leagueId, action, sessionId, type, cycleNumber, scheduledAt, bidTimerSeconds, nominationTimeoutSeconds, intermissionSeconds } = body;

  if (!leagueId || !action) {
    return NextResponse.json({ error: "leagueId and action are required" }, { status: 400 });
  }

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  if (action === "create") {
    // Validate auction-session timer values. Both must be positive integers within
    // a sane bid-bot-vs-human range. Without these guards a typo could store
    // negative or zero values, producing instantly-expired bids and broken state.
    const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
    if (bidTimerSeconds !== undefined && (!isPosInt(bidTimerSeconds) || bidTimerSeconds < 5 || bidTimerSeconds > 600)) {
      return NextResponse.json(
        { error: "bidTimerSeconds must be an integer between 5 and 600" },
        { status: 400 }
      );
    }
    if (nominationTimeoutSeconds !== undefined && (!isPosInt(nominationTimeoutSeconds) || nominationTimeoutSeconds < 5 || nominationTimeoutSeconds > 3600)) {
      return NextResponse.json(
        { error: "nominationTimeoutSeconds must be an integer between 5 and 3600" },
        { status: 400 }
      );
    }
    // 0 disables the post-sale intermission; otherwise 1–60s.
    if (intermissionSeconds !== undefined && (typeof intermissionSeconds !== "number" || !Number.isInteger(intermissionSeconds) || intermissionSeconds < 0 || intermissionSeconds > 60)) {
      return NextResponse.json(
        { error: "intermissionSeconds must be an integer between 0 and 60" },
        { status: 400 }
      );
    }

    // Club auction: snakeOrder stores a randomised list of fantasy team IDs (each club-less team
    // takes a turn nominating a PL club). Only one club-auction session may exist per league.
    // Session-ordering guard: allowed creation order is club-auction → initial → mini-auction.
    // Schedule is free-form (each session's `scheduledAt` can be any date) — only creation order is
    // enforced. Read the existing sessions once for the rest of the create branch.
    const existingSessions = await db
      .select({ id: auctionSessions.id, type: auctionSessions.type, status: auctionSessions.status })
      .from(auctionSessions)
      .where(eq(auctionSessions.leagueId, leagueId));
    const hasClubAuction = existingSessions.some((s) => s.type === CLUB_AUCTION_SESSION_TYPE);
    const completedClubAuction = existingSessions.some(
      (s) => s.type === CLUB_AUCTION_SESSION_TYPE && s.status === "completed"
    );
    const hasInitialAuction = existingSessions.some((s) => s.type === "initial");
    const completedInitialAuction = existingSessions.some(
      (s) => s.type === "initial" && s.status === "completed"
    );

    if (type === CLUB_AUCTION_SESSION_TYPE) {
      if (!leagueRow[0].clubAuctionEnabled) {
        return NextResponse.json({ error: "Club auction is not enabled for this league" }, { status: 400 });
      }
      // Reject if a club-auction session already exists for this league
      if (hasClubAuction) {
        return NextResponse.json({ error: "A club auction session already exists for this league" }, { status: 409 });
      }
      // Reject if the initial player auction has already been created — clubs must run first
      if (hasInitialAuction) {
        return NextResponse.json(
          { error: "Cannot create a club auction after an initial player auction has been scheduled. Allowed order: club-auction → initial → mini-auction." },
          { status: 409 }
        );
      }
      // Validate the FPL/standings config loads (so the admin gets an early, clear error rather
      // than a mid-auction tier-resolution failure). We don't queue clubs — teams nominate them.
      let clubs;
      try {
        clubs = await fetchAllPLClubsWithTiers();
      } catch (err) {
        console.error("[session] fetchAllPLClubsWithTiers failed:", err);
        return NextResponse.json({ error: "Failed to load PL clubs from FPL" }, { status: 502 });
      }
      if (clubs.length === 0) {
        return NextResponse.json({ error: "FPL bootstrap returned no PL clubs" }, { status: 502 });
      }

      // Team-based nomination: snakeOrder holds fantasy team IDs (random order, like the initial
      // player auction). Each club-less team takes a turn nominating a PL club.
      const clubTeams = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));
      if (clubTeams.length === 0) {
        return NextResponse.json({ error: "No teams in league" }, { status: 400 });
      }
      const clubSnakeOrder = clubTeams
        .map((t) => ({ id: t.id, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map((t) => t.id);

      const id = generateId();
      await db.insert(auctionSessions).values({
        id,
        leagueId,
        type: CLUB_AUCTION_SESSION_TYPE,
        cycleNumber: 1,
        status: "pending",
        snakeOrder: JSON.stringify(clubSnakeOrder),
        currentNominatorIndex: 0,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        bidTimerSeconds: bidTimerSeconds ?? 20,
        nominationTimeoutSeconds: nominationTimeoutSeconds ?? 60,
        intermissionSeconds: intermissionSeconds ?? 5,
      });
      return NextResponse.json({ success: true, id, teamCount: clubSnakeOrder.length });
    }

    // Ordering guards for player auctions.
    if (type === "initial") {
      // Reject if a prior initial auction already exists for this league
      if (hasInitialAuction) {
        return NextResponse.json(
          { error: "An initial auction session already exists for this league." },
          { status: 409 }
        );
      }
      // If clubs are enabled, the club auction must have completed first.
      if (leagueRow[0].clubAuctionEnabled && !completedClubAuction) {
        return NextResponse.json(
          { error: "Club auction must be completed before creating the initial player auction. Allowed order: club-auction → initial → mini-auction." },
          { status: 409 }
        );
      }
    } else if (type === "mini-auction") {
      // Mini-auctions require a completed initial auction.
      if (!completedInitialAuction) {
        return NextResponse.json(
          { error: "Initial auction must be completed before creating a mini-auction. Allowed order: club-auction → initial → mini-auction." },
          { status: 409 }
        );
      }
    }

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
      intermissionSeconds: intermissionSeconds ?? 3,
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

  // Composition gate: a player auction cannot be completed while any team sits below the 1/3/3/1
  // minimum. Releases are allowed to drop a squad below the minimum, but the team must rebuild before
  // the (consecutive) auction concludes — so block completion here and tell the admin which teams owe
  // which positions. Club auctions and simulated leagues (auto-filled to a valid composition) are exempt.
  if (action === "complete" && sessionRow[0].type !== CLUB_AUCTION_SESSION_TYPE && !leagueRow[0].isSimulated) {
    const offenders = await findCompositionOffenders(sessionId);
    if (offenders.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot complete the auction yet — ${offenders.length} team(s) are below the 1 GKP / 3 DEF / 3 MID / 1 FWD minimum: ${offenders
            .map((o) => `${o.teamName} (needs ${o.summary})`)
            .join("; ")}. They must fill these positions before the auction can be completed.`,
          offenders,
        },
        { status: 409 },
      );
    }
  }

  // If starting a session in a simulated league, run auto-allocation instead of a live auction —
  // but ONLY for the club auction and the initial player auction. Mini-auctions always run live
  // (they fall through to the normal live-start path below) even in a simulated league.
  if (
    newStatus === "active" &&
    action === "start" &&
    leagueRow[0].isSimulated &&
    sessionRow[0].type !== "mini-auction"
  ) {
    await db
      .update(auctionSessions)
      .set({ status: "active" })
      .where(eq(auctionSessions.id, sessionId));

    try {
      if (sessionRow[0].type === CLUB_AUCTION_SESSION_TYPE) {
        const result = await simulateClubAuction(leagueId, sessionId);
        return NextResponse.json({
          success: true,
          sessionId,
          status: "completed",
          simulated: true,
          clubsAllocated: result.allocated,
        });
      }
      // type === "initial"
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

  // Pause/resume must preserve remaining time on deadlines. We record `pausedAt` on pause and on
  // resume shift every active deadline (nomination + open bids) forward by the elapsed pause
  // duration. Otherwise a 60s window paused for 50s would either expire instantly (no shift) or
  // reset to a fresh 60s (incorrectly favorable). See plan Section E.5.
  const now = new Date();
  if (action === "pause") {
    await db
      .update(auctionSessions)
      .set({ status: newStatus, pausedAt: now })
      .where(eq(auctionSessions.id, sessionId));
  } else if (action === "resume") {
    const pausedAt = sessionRow[0].pausedAt;
    if (pausedAt) {
      const elapsedMs = now.getTime() - new Date(pausedAt).getTime();
      // Shift nomination deadline forward if set
      if (sessionRow[0].nominationDeadline) {
        const newDeadline = new Date(new Date(sessionRow[0].nominationDeadline).getTime() + elapsedMs);
        await db
          .update(auctionSessions)
          .set({ status: newStatus, pausedAt: null, nominationDeadline: newDeadline })
          .where(eq(auctionSessions.id, sessionId));
      } else {
        await db
          .update(auctionSessions)
          .set({ status: newStatus, pausedAt: null })
          .where(eq(auctionSessions.id, sessionId));
      }
      // Shift open bid expiries by the same elapsed amount
      const openBids = await db
        .select({ id: auctionBids.id, expiresAt: auctionBids.expiresAt })
        .from(auctionBids)
        .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")));
      for (const bid of openBids) {
        if (bid.expiresAt) {
          const shifted = new Date(new Date(bid.expiresAt).getTime() + elapsedMs);
          await db.update(auctionBids).set({ expiresAt: shifted }).where(eq(auctionBids.id, bid.id));
        }
      }
    } else {
      // No pausedAt recorded (legacy paused session pre-migration) — just resume without shift.
      await db
        .update(auctionSessions)
        .set({ status: newStatus, pausedAt: null })
        .where(eq(auctionSessions.id, sessionId));
    }
  } else {
    await db
      .update(auctionSessions)
      .set({ status: newStatus })
      .where(eq(auctionSessions.id, sessionId));
  }

  // Admin-initiated session completion (real / non-simulated path). Mini-auctions wind down here in
  // production; initial + club auctions also pass through this branch when an admin force-completes.
  // Idempotent — `writeAutoSnapshot` skips if a snapshot for this (leagueId, trigger) pair exists.
  if (newStatus === "completed") {
    await writeAuctionCompleteSnapshot(sessionId).catch((e) => console.error("[auction snapshot]", e));
    // Auctions no longer auto-complete, so run the 1/3/3/1 composition audit here, on admin completion.
    await auditAuctionComposition(sessionId).catch((e) => console.error("[auction composition audit]", e));
  }

  // When starting a mini-auction, finalize any pending player releases first
  if (newStatus === "active" && action === "start" && sessionRow[0].type === "mini-auction") {
    const gwNumber = sessionRow[0].cycleNumber ?? 0;
    await finalizePendingReleasesNow(leagueId, gwNumber);
  }

  // When starting an auction (first-time only, not resume — resume already restored the shifted
  // deadline above), arm the nomination deadline for the current nominator. Club auctions are now
  // team-nominated too, so both paths set a deadline for the first team in the snake order.
  if (newStatus === "active" && action === "start") {
    if (sessionRow[0].type === CLUB_AUCTION_SESSION_TYPE) {
      await setClubNominationDeadline(sessionId);
    } else {
      await setNominationDeadline(sessionId);
    }
  }

  // First-time start (not resume): purge any non-completed trade proposals so
  // the marketplace is fully locked down for the duration of the auction.
  if (newStatus === "active" && action === "start") {
    await purgePendingTrades(leagueId);
  }

  return NextResponse.json({ success: true, sessionId, status: newStatus });
}
