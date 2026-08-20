import { NextRequest } from "next/server";
import { db, auctionSessions, auctionBids } from "@/lib/db";
import { eq, and, count } from "drizzle-orm";
import {
  resolveExpiredBid,
  advanceNominator,
  setNominationDeadline,
  handleNominationTimeout,
} from "@/lib/formats/auction/resolve-bid";
import { CLUB_AUCTION_SESSION_TYPE } from "@/lib/formats/auction/club-auction";
import { buildLotMetaResolver, EMPTY_LOT_META, type LotMeta } from "@/lib/formats/auction/lot-meta";

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
      let lastWaitingSnapshot: string | null = null;
      let lastHighBidderId: string | null = null;
      let lastHighBid: number | null = null;

      // Lazily-built resolver for the identity of whatever is on the block: position, real-life PL
      // club, and club tier. Previously only club auctions resolved a tier and player auctions sent
      // `tier: null`, so a player lot carried no position or club at all and each room had to
      // reinvent it (the admin room could not, having discarded the bootstrap teams map).
      // Both lookups behind the resolver are cached, so this is cheap on the 2s poll.
      let lotMeta: ((fplElementId: number) => LotMeta) | null = null;

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

          const isClubAuction = session.type === CLUB_AUCTION_SESSION_TYPE;
          if (!lotMeta) {
            try {
              lotMeta = await buildLotMetaResolver(isClubAuction);
            } catch (e) {
              console.warn("[sse] lot metadata unavailable", e);
            }
          }
          const metaFor = (id: number): LotMeta => lotMeta?.(id) ?? EMPTY_LOT_META;

          /** Lot number = how many players have SOLD in this session, plus this one. */
          const soldCount = async (): Promise<number> => {
            const r = await db
              .select({ n: count() })
              .from(auctionBids)
              .where(and(eq(auctionBids.sessionId, sessionId), eq(auctionBids.status, "sold")));
            return Number(r[0]?.n ?? 0);
          };

          if (openBids.length > 0) {
            lastWaitingSnapshot = null;
            const bid = openBids[0];
            const updatedAtStr = bid.updatedAt.toISOString();

            // Emit if bid state changed
            if (updatedAtStr !== lastBidUpdatedAt) {
              lastBidUpdatedAt = updatedAtStr;

              const meta = metaFor(bid.fplElementId);
              const auctionPayload = {
                bidId: bid.id,
                fplElementId: bid.fplElementId,
                playerName: bid.playerName,
                currentHighBid: bid.currentHighBid,
                currentHighBidderId: bid.currentHighBidderId,
                nominatorTeamId: bid.nominatorTeamId,
                minBid: bid.minBid,
                expiresAt: bid.expiresAt.toISOString(),
                status: bid.status,
                // Identity of the lot. For a club auction `fplElementId` IS the PL team id; for a
                // player auction it is resolved through the player's club. Sent from the server so
                // both rooms render the same thing.
                elementType: meta.elementType,
                plTeamId: meta.plTeamId,
                tier: meta.tier,
                lotNumber: (await soldCount()) + 1,
              };

              send("auction-state", auctionPayload);

              // Emit bid-placed when the high bidder or amount changed (a new bid was placed)
              if (
                lastHighBidderId !== null &&
                (bid.currentHighBidderId !== lastHighBidderId || bid.currentHighBid !== lastHighBid)
              ) {
                send("bid-placed", auctionPayload);
              }

              lastHighBidderId = bid.currentHighBidderId;
              lastHighBid = bid.currentHighBid;
            }

            // Check if timer expired — 2s grace period for in-flight bids
            if (Date.now() > bid.expiresAt.getTime() + 2000) {
              const outcome = await resolveExpiredBid(bid);

              if (outcome === "sold") {
                // Begin a post-sale intermission (sync beat + pacing) instead of advancing
                // immediately. The nominator is armed once the cooldown elapses (handled below).
                // The post-sale intermission is opened inside the resolution transaction itself
                // (see `resolveBidToSold`), so there is deliberately no `beginIntermission` here.
                // Calling it from out here is not merely redundant: resolution does several more
                // round trips after that commit, and another poller can consume the beat and advance
                // the cursor before this line runs — opening a SECOND beat, which advances the cursor
                // again and skips a team.

                // Re-read the bid to get the freshest winner/amount (counter-bids
                // may have arrived after the initial read)
                const resolved = await db
                  .select()
                  .from(auctionBids)
                  .where(eq(auctionBids.id, bid.id))
                  .limit(1);
                const final = resolved[0] ?? bid;

                const soldMeta = metaFor(final.fplElementId);
                send("sold", {
                  bidId: final.id,
                  fplElementId: final.fplElementId,
                  playerName: final.playerName,
                  finalBid: final.currentHighBid,
                  winnerId: final.currentHighBidderId,
                  elementType: soldMeta.elementType,
                  plTeamId: soldMeta.plTeamId,
                  tier: soldMeta.tier,
                  // Already counted — this lot is now `sold`, so it IS the current total.
                  lotNumber: await soldCount(),
                });
              }
              // else: already-resolved by another caller — skip

              lastBidUpdatedAt = null;
            }
          } else {
            lastBidUpdatedAt = null;

            // No open bid — check nomination deadline
            const currentNominatorId = snakeOrder[session.currentNominatorIndex];
            const now = new Date();

            // Post-sale intermission: hold off arming the next nominator until the cooldown elapses.
            if (session.intermissionUntil) {
              if (now < session.intermissionUntil) {
                // Still cooling down — emit a countdown (deduped) and skip nomination logic.
                const snap = `intermission|${session.intermissionUntil.toISOString()}`;
                if (snap !== lastWaitingSnapshot) {
                  lastWaitingSnapshot = snap;
                  send("intermission", {
                    intermissionUntil: session.intermissionUntil.toISOString(),
                    currentNominatorIndex: session.currentNominatorIndex,
                    snakeOrder,
                  });
                }
                return;
              }
              // Cooldown elapsed — advance the nominator, clearing the intermission in the SAME
              // write so only one stream advances and the claim can never be spent without the
              // cursor moving. Next poll picks up the fresh nomination state.
              await advanceNominator(sessionId, {
                claimIntermission: session.intermissionUntil,
                expectIndex: session.currentNominatorIndex,
                actor: "sse",
              });
              return;
            }

            if (session.nominationDeadline && now > session.nominationDeadline) {
              // Atomically claim THIS EXACT window — only one SSE stream wins the race.
              //
              // Matching on the observed deadline AND cursor (not merely "some deadline exists") is
              // what makes the claim safe. `session` is a snapshot taken at the top of the poll; by
              // the time we get here the cursor may already have advanced and armed the NEXT team's
              // fresh 60s window. A bare `isNotNull` guard would happily consume that new window and
              // then run the timeout against `currentNominatorId` from the stale snapshot — which
              // penalised a team that had just nominated successfully, destroyed the next team's
              // window before they ever saw it, and advanced the cursor a second time so a third
              // team lost its turn too. Matching exactly means a stale poll affects 0 rows and does
              // nothing; the next poll re-evaluates against fresh state.
              const claimed = await db
                .update(auctionSessions)
                .set({ nominationDeadline: null })
                .where(
                  and(
                    eq(auctionSessions.id, sessionId),
                    eq(auctionSessions.nominationDeadline, session.nominationDeadline),
                    eq(auctionSessions.currentNominatorIndex, session.currentNominatorIndex)
                  )
                );

              if (claimed.rowsAffected > 0) {
                const result = await handleNominationTimeout(
                  sessionId,
                  currentNominatorId,
                  session.leagueId
                );

                const messageMap: Record<string, string> = {
                  "auto-nominated": "Auto-nominated from wishlist",
                  "penalised": "Penalised for missed nomination — turn skipped",
                  "skipped-full": "Squad full — nomination turn skipped",
                };
                send(result, {
                  teamId: currentNominatorId,
                  message: messageMap[result] ?? "Nomination turn resolved",
                });
              }
            } else if (!session.nominationDeadline) {
              // No deadline set yet (e.g. session just started) — set one.
              //
              // `session` is a snapshot from the top of this tick and every connected browser runs
              // this same fallback on its own 2s loop, so pin the cursor we observed. Selling a lot
              // takes two writes (mark sold, then open the intermission); a tick landing between
              // them sees no bid, no intermission and no deadline, and unguarded this armed a fresh
              // full window for the team that had just sold — handing them a second consecutive
              // nomination and costing the next team its turn. See `setNominationDeadline`.
              await setNominationDeadline(sessionId, {
                expectIndex: session.currentNominatorIndex,
                actor: "sse",
              });
            }

            // Emit waiting state with deadline info — deduped via snapshot
            // Re-fetch session to get updated deadline
            const refreshed = await db
              .select({ nominationDeadline: auctionSessions.nominationDeadline, currentNominatorIndex: auctionSessions.currentNominatorIndex })
              .from(auctionSessions)
              .where(eq(auctionSessions.id, sessionId))
              .limit(1);

            const waitingNominatorId = snakeOrder[refreshed[0]?.currentNominatorIndex ?? session.currentNominatorIndex];
            const waitingDeadline = refreshed[0]?.nominationDeadline?.toISOString() ?? null;
            const snapshot = `${waitingNominatorId}|${waitingDeadline}`;

            if (snapshot !== lastWaitingSnapshot) {
              lastWaitingSnapshot = snapshot;
              send("waiting", {
                message: "Waiting for next nomination",
                currentNominatorId: waitingNominatorId,
                nominationDeadline: waitingDeadline,
              });
            }
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
