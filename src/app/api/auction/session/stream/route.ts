import { NextRequest } from "next/server";
import { db, auctionSessions, auctionBids } from "@/lib/db";
import { eq, and } from "drizzle-orm";

const POLL_INTERVAL_MS = 2000; // Poll DB every 2 seconds for updates
const HEARTBEAT_INTERVAL_MS = 15000; // Send heartbeat every 15 seconds

/**
 * GET /api/auction/session/stream?sessionId=xxx
 * Server-Sent Events stream for real-time auction updates.
 *
 * Events emitted:
 * - auction-state: Current bid state (bid amount, bidder, timer)
 * - bid-placed: New bid placed
 * - sold: Player sold to highest bidder
 * - unsold: Player went unsold (no bids above min)
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

          // Emit session status changes
          if (session.status !== lastSessionStatus) {
            lastSessionStatus = session.status;
            send("session-status", {
              status: session.status,
              currentNominatorIndex: session.currentNominatorIndex,
              snakeOrder: JSON.parse(session.snakeOrder),
            });
          }

          if (session.status === "completed") {
            send("session-complete", { message: "Auction session has ended" });
            isClosed = true;
            controller.close();
            return;
          }

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

            // Check if timer expired — mark as sold/unsold
            if (new Date() > bid.expiresAt) {
              const isSold = bid.currentHighBid > bid.minBid || bid.currentHighBidderId !== bid.nominatorTeamId;
              const newStatus = isSold ? "sold" : "unsold";

              await db
                .update(auctionBids)
                .set({ status: newStatus, updatedAt: new Date() })
                .where(eq(auctionBids.id, bid.id));

              send(newStatus, {
                bidId: bid.id,
                fplElementId: bid.fplElementId,
                playerName: bid.playerName,
                finalBid: bid.currentHighBid,
                winnerId: isSold ? bid.currentHighBidderId : null,
              });

              lastBidUpdatedAt = null; // Reset to pick up next state
            }
          } else {
            lastBidUpdatedAt = null;
            // No open bid — waiting for next nomination
            send("waiting", { message: "Waiting for next nomination" });
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
