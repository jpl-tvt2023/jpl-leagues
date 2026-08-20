import { NextRequest, NextResponse } from "next/server";
import { db, auctionBids, auctionOwnership, auctionSessions, teams } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { logTurnEvent } from "@/lib/formats/auction/resolve-bid";

/** Actions that mutate live nomination-turn state, and therefore require a paused session. */
const TURN_ACTIONS = new Set(["cancel-nomination", "grant-turn", "dequeue-makeup", "set-nominator"]);

/** Parse a JSON id-array column defensively — a malformed value must not brick the admin tools. */
function safeParseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * POST /api/admin/[leagueId]/auction-corrections
 * Admin corrections for auction results.
 *
 * Actions:
 * - undo-sale: Revert a sold bid — delete ownership, refund buyer, mark bid cancelled
 * - manual-transfer: Move a player to another team (or to unowned) with purse adjustments
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const { action } = body;

  if (action === "undo-sale") {
    const { bidId } = body;
    if (!bidId) return NextResponse.json({ error: "bidId is required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      // Find the sold bid
      const bidRow = await tx
        .select()
        .from(auctionBids)
        .where(and(eq(auctionBids.id, bidId), eq(auctionBids.leagueId, leagueId)))
        .limit(1);

      if (bidRow.length === 0) return { error: "Bid not found", status: 404 };
      const bid = bidRow[0];

      if (bid.status !== "sold") return { error: "Bid is not in sold status", status: 400 };

      // Find and delete the ownership record
      const ownership = await tx
        .select()
        .from(auctionOwnership)
        .where(
          and(
            eq(auctionOwnership.leagueId, leagueId),
            eq(auctionOwnership.fplElementId, bid.fplElementId),
            eq(auctionOwnership.status, "active")
          )
        )
        .limit(1);

      if (ownership.length > 0) {
        const ow = ownership[0];
        // Delete ownership
        await tx.delete(auctionOwnership).where(eq(auctionOwnership.id, ow.id));
        // Refund the buyer's purse
        await tx
          .update(teams)
          .set({
            purse: sql`${teams.purse} + ${ow.purchasePrice}`,
            totalSpent: sql`${teams.totalSpent} - ${ow.purchasePrice}`,
          })
          .where(eq(teams.id, ow.teamId));
      }

      // Mark bid as cancelled
      await tx
        .update(auctionBids)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(auctionBids.id, bidId));

      return {
        success: true,
        message: `Undone: ${bid.playerName} sale reverted`,
        playerName: bid.playerName,
        fplElementId: bid.fplElementId,
      };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  }

  if (action === "manual-transfer") {
    const { ownershipId, toTeamId, price } = body;
    if (!ownershipId || !toTeamId) {
      return NextResponse.json({ error: "ownershipId and toTeamId are required" }, { status: 400 });
    }

    const result = await db.transaction(async (tx) => {
      const ow = await tx
        .select()
        .from(auctionOwnership)
        .where(and(eq(auctionOwnership.id, ownershipId), eq(auctionOwnership.leagueId, leagueId)))
        .limit(1);

      if (ow.length === 0) return { error: "Ownership not found", status: 404 };
      const ownership = ow[0];

      if (toTeamId === "unowned") {
        // Remove ownership entirely, full refund to original owner
        await tx.delete(auctionOwnership).where(eq(auctionOwnership.id, ownershipId));
        await tx
          .update(teams)
          .set({
            purse: sql`${teams.purse} + ${ownership.purchasePrice}`,
            totalSpent: sql`${teams.totalSpent} - ${ownership.purchasePrice}`,
          })
          .where(eq(teams.id, ownership.teamId));

        return { success: true, message: `${ownership.playerName} removed — ${ownership.teamId} refunded` };
      }

      // Transfer to another team
      const transferPrice = price ?? ownership.purchasePrice;

      // Refund original owner
      await tx
        .update(teams)
        .set({
          purse: sql`${teams.purse} + ${ownership.purchasePrice}`,
          totalSpent: sql`${teams.totalSpent} - ${ownership.purchasePrice}`,
        })
        .where(eq(teams.id, ownership.teamId));

      // Charge new owner
      await tx
        .update(teams)
        .set({
          purse: sql`${teams.purse} - ${transferPrice}`,
          totalSpent: sql`${teams.totalSpent} + ${transferPrice}`,
        })
        .where(eq(teams.id, toTeamId));

      // Update ownership
      await tx
        .update(auctionOwnership)
        .set({
          teamId: toTeamId,
          purchasePrice: transferPrice,
          updatedAt: new Date(),
        })
        .where(eq(auctionOwnership.id, ownershipId));

      return {
        success: true,
        message: `${ownership.playerName} transferred to ${toTeamId}`,
        playerName: ownership.playerName,
      };
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  }

  // ---- Turn rectification ----
  //
  // Every action below requires the session to be PAUSED. That is the whole safety argument: while a
  // session is active, ~20 independent processes (one SSE poll loop per connected browser, plus a
  // mutating REST poll per client) are concurrently reading and writing the same turn state, and a
  // correction racing them would be neither atomic nor reproducible. `GET /api/auction/session` only
  // runs its safety net while `status === "active"`, and the SSE stream returns early for anything
  // that is not active, so pausing freezes every writer and makes these edits exclusive.
  if (TURN_ACTIONS.has(action)) {
    const { sessionId } = body;
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });

    const sessRow = await db
      .select()
      .from(auctionSessions)
      .where(and(eq(auctionSessions.id, sessionId), eq(auctionSessions.leagueId, leagueId)))
      .limit(1);
    if (sessRow.length === 0) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const sess = sessRow[0];

    if (sess.status !== "paused") {
      return NextResponse.json(
        { error: "Pause the auction before correcting the turn order." },
        { status: 409 }
      );
    }

    const snakeOrder: string[] = safeParseIds(sess.snakeOrder);
    const queue: string[] = safeParseIds(sess.makeupQueue);
    const cursor = sess.currentNominatorIndex ?? 0;

    // Void the lot currently on the block.
    //
    // Nothing has been paid at this point: ownership rows and purse deductions are written by
    // `resolveBidToSold`, which only runs once the bid expires. So voiding an *open* bid is just a
    // status flip — unlike `undo-sale` above, which has to unwind a completed sale. Guarded on
    // "open" so a lot that resolved while the admin was deciding cannot be silently discarded.
    if (action === "cancel-nomination") {
      const { restoreNominator = true } = body;
      const openBid = await db
        .select()
        .from(auctionBids)
        .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "open")))
        .limit(1);
      if (openBid.length === 0) {
        return NextResponse.json({ error: "No lot is currently on the block" }, { status: 404 });
      }
      const bid = openBid[0];

      const cancelled = await db
        .update(auctionBids)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(auctionBids.id, bid.id), eq(auctionBids.status, "open")));
      if (cancelled.rowsAffected === 0) {
        return NextResponse.json({ error: "Lot already resolved — reload and try again" }, { status: 409 });
      }

      // The nominator spent their turn on a lot that no longer exists, so give it back by default.
      // Front of the queue, because they are mid-turn: anyone the admin grants next should still be
      // able to jump ahead of them by asking for the front explicitly.
      const nextQueue = restoreNominator ? [...queue, bid.nominatorTeamId] : queue;
      await db
        .update(auctionSessions)
        .set({ nominationDeadline: null, intermissionUntil: null, makeupQueue: JSON.stringify(nextQueue) })
        .where(eq(auctionSessions.id, sessionId));

      await logTurnEvent({
        sessionId,
        leagueId,
        teamId: bid.nominatorTeamId,
        nominatorIndex: cursor,
        event: "nomination-cancelled",
        actor: "admin",
        detail: { bidId: bid.id, playerName: bid.playerName, restoreNominator, queue: nextQueue },
      });

      return NextResponse.json({
        success: true,
        message: `Voided ${bid.playerName}${restoreNominator ? " — nomination returned to the nominator" : ""}`,
        makeupQueue: nextQueue,
      });
    }

    // Owe a team a make-up nomination. This does NOT move the ring cursor — `advanceNominator`
    // drains the queue first and parks the real ring position in `ringReturnIndex`, so once the
    // queue empties the order resumes exactly where it stopped. Moving the cursor instead would
    // restart the ring from the make-up team and re-skew everyone behind them.
    if (action === "grant-turn") {
      const { teamId, position = "back" } = body;
      if (!teamId) return NextResponse.json({ error: "teamId is required" }, { status: 400 });
      if (!snakeOrder.includes(teamId)) {
        return NextResponse.json({ error: "Team is not in this session's nomination order" }, { status: 400 });
      }
      const nextQueue = position === "front" ? [teamId, ...queue] : [...queue, teamId];
      await db
        .update(auctionSessions)
        .set({ makeupQueue: JSON.stringify(nextQueue) })
        .where(eq(auctionSessions.id, sessionId));

      await logTurnEvent({
        sessionId,
        leagueId,
        teamId,
        nominatorIndex: cursor,
        event: "makeup-granted",
        actor: "admin",
        detail: { position, queue: nextQueue },
      });

      return NextResponse.json({ success: true, makeupQueue: nextQueue });
    }

    // Remove a queued make-up turn (or clear the queue) — for undoing a mis-click.
    if (action === "dequeue-makeup") {
      const { teamId } = body;
      const nextQueue = teamId ? queue.filter((t, i) => !(t === teamId && i === queue.indexOf(teamId))) : [];
      await db
        .update(auctionSessions)
        .set({ makeupQueue: JSON.stringify(nextQueue) })
        .where(eq(auctionSessions.id, sessionId));

      await logTurnEvent({
        sessionId,
        leagueId,
        teamId: teamId ?? null,
        nominatorIndex: cursor,
        event: "makeup-dequeued",
        actor: "admin",
        detail: { queue: nextQueue },
      });

      return NextResponse.json({ success: true, makeupQueue: nextQueue });
    }

    // Hard cursor move — for when the RING ITSELF is wrong, rather than one turn being owed.
    // Clears `ringReturnIndex` too: the admin is declaring where the order actually is, so a parked
    // return position from a half-finished make-up sequence would silently override them.
    if (action === "set-nominator") {
      const { teamId, direction } = body;
      let nextIndex: number;
      if (direction === "back" || direction === "forward") {
        const step = direction === "back" ? -1 : 1;
        nextIndex = (cursor + step + snakeOrder.length) % snakeOrder.length;
      } else {
        if (!teamId) {
          return NextResponse.json({ error: "teamId or direction is required" }, { status: 400 });
        }
        nextIndex = snakeOrder.indexOf(teamId);
        if (nextIndex < 0) {
          return NextResponse.json({ error: "Team is not in this session's nomination order" }, { status: 400 });
        }
      }

      await db
        .update(auctionSessions)
        .set({
          currentNominatorIndex: nextIndex,
          ringReturnIndex: null,
          nominationDeadline: null,
          intermissionUntil: null,
        })
        .where(eq(auctionSessions.id, sessionId));

      await logTurnEvent({
        sessionId,
        leagueId,
        teamId: snakeOrder[nextIndex] ?? null,
        nominatorIndex: nextIndex,
        event: "admin-rewind",
        actor: "admin",
        detail: { from: cursor, to: nextIndex },
      });

      return NextResponse.json({ success: true, currentNominatorIndex: nextIndex });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
