import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionBidLogs, auctionSessions, auctionOwnership, teams, leagues } from "@/lib/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import {
  resolveExpiredBid,
  logTurnEvent,
} from "@/lib/formats/auction/resolve-bid";
import { calculatePurse } from "@/lib/formats/auction/economy";
import { countsFromOwnership, validateAddPlayer } from "@/lib/formats/auction/squad-rules";
import { ownerOfPlayer } from "@/lib/formats/auction/ownership";
import { fetchElementInfo } from "@/lib/fpl";
import { CLUB_AUCTION_SESSION_TYPE, nominateClub } from "@/lib/formats/auction/club-auction";

const DEFAULT_MIN_BID = 500_000; // 500K minimum starting bid

/**
 * POST /api/auction/nominate
 * Nominate a PL player for auction. Only the current nominator or admin can do this.
 *
 * Body: { sessionId, fplElementId, playerName, minBid? }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { sessionId, fplElementId, playerName, minBid, plTeamId } = body;

  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  // Get the auction session
  const sessionRow = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);

  if (sessionRow.length === 0 || sessionRow[0].status !== "active") {
    console.error("[nominate] 400: session not active", { sessionId, status: sessionRow[0]?.status });
    return NextResponse.json({ error: "Auction session is not active" }, { status: 400 });
  }

  // Post-sale intermission: nominations are locked until the cooldown elapses (sync beat). Applies to
  // both player and club auctions; the SSE stream arms the next nominator when the window ends.
  if (sessionRow[0].intermissionUntil && Date.now() < new Date(sessionRow[0].intermissionUntil).getTime()) {
    return NextResponse.json(
      { error: "Auction is between lots — wait for the next nomination window." },
      { status: 409 }
    );
  }

  // Club auctions are team-nominated (snake order of fantasy teams). The current nominator (or admin)
  // picks a PL club; `nominateClub` validates club-less eligibility + availability and opens the bid.
  if (sessionRow[0].type === CLUB_AUCTION_SESSION_TYPE) {
    if (typeof plTeamId !== "number") {
      return NextResponse.json({ error: "plTeamId is required to nominate a club" }, { status: 400 });
    }
    const clubSnakeOrder: string[] = JSON.parse(sessionRow[0].snakeOrder);
    const clubNominatorId = clubSnakeOrder[sessionRow[0].currentNominatorIndex];
    if (!isAdmin && session?.id !== clubNominatorId) {
      return NextResponse.json({ error: "Not your turn to nominate a club" }, { status: 403 });
    }
    // When an admin nominates on a team's behalf, attribute it to the current nominator.
    const nominatorTeamId = !isAdmin && session ? session.id : clubNominatorId;
    const result = await nominateClub(sessionId, nominatorTeamId, plTeamId);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true, bidId: result.bidId });
  }

  // Player auction requires the element identity.
  if (!fplElementId || !playerName) {
    return NextResponse.json(
      { error: "fplElementId and playerName are required" },
      { status: 400 }
    );
  }

  const leagueId = sessionRow[0].leagueId;

  // Verify initial nominator authorization before running the safety-net
  const snakeOrderInitial: string[] = JSON.parse(sessionRow[0].snakeOrder);
  const initialNominatorId = snakeOrderInitial[sessionRow[0].currentNominatorIndex];

  if (!isAdmin && session?.id !== initialNominatorId) {
    console.error("[nominate] 403: not your turn", { sessionId, teamId: session?.id, currentNominator: initialNominatorId });
    return NextResponse.json({ error: "Not your turn to nominate" }, { status: 403 });
  }

  // Auto-resolve any expired open bids (safety net if SSE wasn't running)
  const staleOpenBids = await db
    .select()
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")));

  const nowMs = Date.now();
  let resolvedALot = false;
  for (const stale of staleOpenBids) {
    if (nowMs > stale.expiresAt.getTime() + 2000) {
      try {
        const outcome = await resolveExpiredBid(stale);
        if (outcome === "sold") {
          resolvedALot = true;
          // Open the post-sale intermission here too. Previously this path resolved the lot but
          // left no intermission, so the inter-lot gap was governed by whichever caller happened
          // to notice — and the turn could be handed straight back to the team that just won.
          // Intermission already opened inside the resolution transaction — see the note in
          // `resolveBidToSold`. Re-opening it here could hand out a second beat and skip a team.
        }
        // Do NOT call advanceNominator — let SSE stream handle advancement
        // to avoid double-advancing when both SSE and this safety-net resolve the same bid
      } catch (err) {
        // SSE may have already resolved this bid — log and continue
        console.error("[nominate] Safety-net resolution failed for bid", stale.id, err);
      }
    }
  }

  // If this request just closed a lot, it is NOT a valid nomination window: `currentNominatorIndex`
  // still points at the team that owned the lot we just resolved (advancement happens later, via
  // the intermission), so continuing here would let the winner of a lot nominate the very next one
  // — the "same team nominated twice" bug. Bounce the caller; the next window opens after the
  // intermission and the turn will have moved on.
  if (resolvedALot) {
    console.info("[nominate] 409: caller's request resolved the open lot — nomination window not yet open", {
      sessionId,
      teamId: session?.id,
    });
    return NextResponse.json(
      { error: "That lot just closed — the next nomination window is opening." },
      { status: 409 }
    );
  }

  // Re-fetch session after safety-net (nominatorIndex may have advanced)
  const refreshedSession = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);

  if (refreshedSession.length === 0 || refreshedSession[0].status !== "active") {
    console.error("[nominate] 400: session became inactive after safety-net", { sessionId });
    return NextResponse.json({ error: "Auction session is not active" }, { status: 400 });
  }

  const auctionSession = refreshedSession[0];
  const snakeOrder: string[] = JSON.parse(auctionSession.snakeOrder);
  const currentNominatorId = snakeOrder[auctionSession.currentNominatorIndex];

  // Re-check nominator auth — safety-net may have advanced past the submitter
  if (!isAdmin && session?.id !== currentNominatorId) {
    console.error("[nominate] 403: no longer nominator after safety-net advance", { sessionId, teamId: session?.id, currentNominator: currentNominatorId });
    return NextResponse.json({ error: "Not your turn to nominate" }, { status: 403 });
  }

  // Check no other item is currently open (after cleanup)
  const openBids = await db
    .select()
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")))
    .limit(1);

  if (openBids.length > 0) {
    console.error("[nominate] 400: open bid still exists after safety-net", { sessionId, bidId: openBids[0].id });
    return NextResponse.json({ error: "Another item is still open for bidding" }, { status: 400 });
  }

  // Defense in depth: even though the client filters owned players out of the nominate modal
  // (refreshOwned() runs on open), an SSE-stale tab or a direct API call could try to nominate
  // a player who's already been sold. Return 409 with a clear error so the UI can re-fetch.
  const ownerTeamId = await ownerOfPlayer(leagueId, fplElementId);
  if (ownerTeamId) {
    console.error("[nominate] 409: player already owned", { sessionId, fplElementId, ownerTeamId });
    return NextResponse.json({ error: "Player is already owned by another team" }, { status: 409 });
  }

  // Compose starting bid first so subsequent guards can use it
  const startingBid = minBid ?? DEFAULT_MIN_BID;

  // Squad-rule + purse pre-checks for the nominator (skipped for admin override)
  if (!isAdmin) {
    const [teamRow, leagueRow, ownership, elements] = await Promise.all([
      db.select().from(teams).where(eq(teams.id, currentNominatorId)).limit(1),
      db.select({ initialBudget: leagues.initialBudget }).from(leagues).where(eq(leagues.id, leagueId)).limit(1),
      db
        .select({ elementType: auctionOwnership.elementType })
        .from(auctionOwnership)
        .where(
          and(
            eq(auctionOwnership.leagueId, leagueId),
            eq(auctionOwnership.teamId, currentNominatorId),
            eq(auctionOwnership.status, "active")
          )
        ),
      fetchElementInfo(),
    ]);

    if (teamRow.length === 0 || leagueRow.length === 0) {
      return NextResponse.json({ error: "Team or league not found" }, { status: 404 });
    }

    // Purse must cover at least the starting bid
    const availablePurse = calculatePurse(
      leagueRow[0].initialBudget,
      teamRow[0].totalIncome,
      teamRow[0].totalSpent,
      teamRow[0].totalRefunds
    );
    if (availablePurse < startingBid) {
      return NextResponse.json(
        { error: `Insufficient purse (${availablePurse.toLocaleString()}) — minimum bid is ${startingBid.toLocaleString()}` },
        { status: 400 }
      );
    }

    // Squad-full + position-feasibility check
    const counts = countsFromOwnership(ownership);
    const el = elements.find((e) => e.id === fplElementId);
    if (!el) {
      return NextResponse.json({ error: "Unknown FPL element" }, { status: 400 });
    }
    const check = validateAddPlayer(counts, teamRow[0].penaltySlots ?? 0, el.element_type, teamRow[0].bonusSlots ?? 0);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }
  }

  // Create the auction bid item
  const bidTimerSeconds = auctionSession.bidTimerSeconds ?? 20;
  const expiresAt = new Date(Date.now() + bidTimerSeconds * 1000);
  const bidId = generateId();

  // Atomically claim the nomination window AND open the lot.
  //
  // The claim is the synchronisation point that makes a late nomination and the deadline-expiry
  // penalty mutually exclusive: whoever flips `nominationDeadline` to null first wins. If the SSE
  // penalty path already claimed it (the team missed its window), rowsAffected is 0 and we reject —
  // so a team can never be both penalised AND nominate. `intermissionUntil` is cleared here too: an
  // intermission belongs to exactly one inter-lot gap, and once a lot is on the block it must not
  // survive. A leftover intermission was claimable a second time after the next sale, which
  // advanced the cursor twice and skipped a team's turn.
  //
  // The claim and the insert MUST commit together. Run as two round trips, the row briefly reads
  // "no deadline, no intermission" with no lot open — indistinguishable from an idle auction. Every
  // connected browser polls that state every 2s, and the first one to see it arms a fresh window for
  // `currentNominatorIndex`, which is still the team that just nominated. They then nominate a
  // second time. A concurrency soak reproduces this ~37 times in 40 lots; in one transaction it is
  // structurally impossible, because no observer ever sees the in-between state.
  const claimResult = await db.transaction(async (tx) => {
    const claimedDeadline = await tx
      .update(auctionSessions)
      .set({ nominationDeadline: null, intermissionUntil: null })
      .where(and(eq(auctionSessions.id, sessionId), isNotNull(auctionSessions.nominationDeadline)));
    if (claimedDeadline.rowsAffected === 0) return { claimed: false as const };

    await tx.insert(auctionBids).values({
      id: bidId,
      leagueId,
      sessionId,
      nominatorTeamId: currentNominatorId,
      fplElementId,
      playerName,
      currentHighBid: startingBid,
      currentHighBidderId: currentNominatorId, // nominator starts as default bidder
      minBid: startingBid,
      status: "open",
      expiresAt,
    });

    // Log the nomination event
    await tx.insert(auctionBidLogs).values({
      id: generateId(),
      bidId,
      teamId: currentNominatorId,
      amount: startingBid,
      type: "nomination",
    });

    return { claimed: true as const };
  });

  if (!claimResult.claimed) {
    return NextResponse.json({ error: "Your nomination window has passed." }, { status: 409 });
  }

  await logTurnEvent({
    sessionId,
    leagueId,
    teamId: currentNominatorId,
    nominatorIndex: auctionSession.currentNominatorIndex,
    event: "nominated",
    actor: "nominate",
    detail: { bidId, playerName, startingBid },
  });

  return NextResponse.json({
    success: true,
    bidId,
    fplElementId,
    playerName,
    startingBid,
    expiresAt: expiresAt.toISOString(),
    nominatorTeamId: currentNominatorId,
  });
}
