import { NextRequest } from "next/server";
import { db, auctionSessions, auctionBids } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import {
  resolveExpiredBid,
  advanceNominator,
  setNominationDeadline,
  handleNominationTimeout,
} from "@/lib/formats/auction/resolve-bid";

// Force dynamic so Vercel doesn't buffer/cache the SSE response
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_INTERVAL_MS = 2000; // Poll DB every 2 seconds for updates
const HEARTBEAT_INTERVAL_MS = 15000; // Send heartbeat every 15 seconds

/**
 * GET /api/auction/session/stream?sessionId=xxx
 * Server-Sent Events stream for real-time auction updates.
 *
 * Events emitted:
 * - auction-state: Current bid state (bid amount, bidder, timer)
 * - sold: Player sold to highest bidder (ownership created, purse deducted)
 * - unsold: Player went unsold (no bids above min)
 * - waiting: No open bid, waiting for nomination (includes deadline info)
 * - auto-nominated: System auto-nominated from wishlist after timeout
 * - penalised: Nominator penalised for missed nomination (empty wishlist)
 * - session-status: Session started/paused/completed
 * - heartbeat: Keep-alive
 */
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId");

  if (!sessionId) {
    return new Response("sessionId is required", { status: 400 });
  }

  const encoder = new TextEncoder();
  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          isClosed = true;
        }
      };

      let lastBidUpdatedAt: string | null = null;
      let lastSessionStatus: string | null = null;
      let lastNominatorIndex: number | null = null;

      const poll = async () => {
        if (isClosed) return;

        try {
          // Get session status
          const sessionRow = await db
            .select()
            .from(auctionSessions)
            .where(eq(auctionSessions.id, sessionId))
            .limit(1);

          if (sessionRow.length === 0) {
            send("error", { message: "Session not found" });
            isClosed = true;
            controller.close();
            return;
          }

          const session = sessionRow[0];
          const snakeOrder: string[] = JSON.parse(session.snakeOrder);

          // Emit session status changes (or nominator changes)
          if (session.status !== lastSessionStatus || session.currentNominatorIndex !== lastNominatorIndex) {
            lastSessionStatus = session.status;
            lastNominatorIndex = session.currentNominatorIndex;
            send("session-status", {
              status: session.status,
              currentNominatorIndex: session.currentNominatorIndex,
              snakeOrder,
              nominationDeadline: session.nominationDeadline?.toISOString() ?? null,
            });
          }

          if (session.status === "completed") {
            send("session-complete", { message: "Auction session has ended" });
            isClosed = true;
            controller.close();
            return;
          }

          // Only process bids/nominations for active sessions
          if (session.status !== "active") return;

          // Get current open bid
          const openBids = await db
            .select()
            .from(auctionBids)
            .where(
              and(
                eq(auctionBids.sessionId, sessionId),
                eq(auctionBids.status, "open")
              )
            )
            .limit(1);

          if (openBids.length > 0) {
            const bid = openBids[0];
            const updatedAtStr = bid.updatedAt.toISOString();

            // Emit if bid state changed
            if (updatedAtStr !== lastBidUpdatedAt) {
              lastBidUpdatedAt = updatedAtStr;
              send("auction-state", {
                bidId: bid.id,
                fplElementId: bid.fplElementId,
                playerName: bid.playerName,
                currentHighBid: bid.currentHighBid,
                currentHighBidderId: bid.currentHighBidderId,
                nominatorTeamId: bid.nominatorTeamId,
                minBid: bid.minBid,
                expiresAt: bid.expiresAt.toISOString(),
                status: bid.status,
              });
            }

            // Check if timer expired — resolve via shared logic
            if (new Date() > bid.expiresAt) {
              const outcome = await resolveExpiredBid(bid);

              send(outcome, {
                bidId: bid.id,
                fplElementId: bid.fplElementId,
                playerName: bid.playerName,
                finalBid: bid.currentHighBid,
                winnerId: outcome === "sold" ? bid.currentHighBidderId : null,
              });

              // Advance to next nominator (sets 60s nomination deadline)
              await advanceNominator(sessionId);

              lastBidUpdatedAt = null;
            }
          } else {
            lastBidUpdatedAt = null;

            // No open bid — check nomination deadline
            const currentNominatorId = snakeOrder[session.currentNominatorIndex];
            const now = new Date();

            if (session.nominationDeadline && now > session.nominationDeadline) {
              // Nomination timeout — auto-nominate or penalise
              const result = await handleNominationTimeout(
                sessionId,
                currentNominatorId,
                session.leagueId
              );

              send(result, {
                teamId: currentNominatorId,
                message: result === "auto-nominated"
                  ? "Auto-nominated from wishlist"
                  : "Penalised for missed nomination — turn skipped",
              });
            } else if (!session.nominationDeadline) {
              // No deadline set yet (e.g. session just started) — set one
              await setNominationDeadline(sessionId);
            }

            // Emit waiting state with deadline info
            // Re-fetch session to get updated deadline
            const refreshed = await db
              .select({ nominationDeadline: auctionSessions.nominationDeadline, currentNominatorIndex: auctionSessions.currentNominatorIndex })
              .from(auctionSessions)
              .where(eq(auctionSessions.id, sessionId))
              .limit(1);

            send("waiting", {
              message: "Waiting for next nomination",
              currentNominatorId: snakeOrder[refreshed[0]?.currentNominatorIndex ?? session.currentNominatorIndex],
              nominationDeadline: refreshed[0]?.nominationDeadline?.toISOString() ?? null,
            });
          }
        } catch (error) {
          console.error("SSE poll error:", error);
        }
      };

      // Initial poll
      await poll();

      // Set up polling interval
      const pollTimer = setInterval(poll, POLL_INTERVAL_MS);

      // Heartbeat
      const heartbeatTimer = setInterval(() => {
        if (isClosed) return;
        send("heartbeat", { time: new Date().toISOString() });
      }, HEARTBEAT_INTERVAL_MS);

      // Clean up on abort
      request.signal.addEventListener("abort", () => {
        isClosed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
