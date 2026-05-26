/**
 * Auction harness — drives /api/auction/session for both real-bidding flows
 * (slow, drives the SSE stream) and isSimulated mode (fast, auto-allocates
 * via src/lib/formats/auction/simulate.ts).
 *
 * For most specs the fast path is enough: createAuctionLeague(...,
 * isSimulated: true), then `createAndRunInitialAuction(...)` to fully draft
 * every team in milliseconds. Specs that exercise UI auction behaviour can
 * still drive the live route as needed.
 */

import type { APIRequestContext } from "@playwright/test";
import { eq } from "drizzle-orm";
import { testDb, schema } from "./db";

export interface CreateSessionResponse {
  id: string;
  snakeOrder?: string[];
  queueLength?: number;
}

/**
 * Create an auction session. `type` defaults to "initial" — the first draft.
 * Caller must be signed in as superadmin.
 */
export async function createAuctionSession(
  request: APIRequestContext,
  leagueId: string,
  type: "initial" | "mini-auction" | "club-auction" = "initial",
  opts: { cycleNumber?: number; bidTimerSeconds?: number; nominationTimeoutSeconds?: number } = {},
): Promise<CreateSessionResponse> {
  const res = await request.post("/api/auction/session", {
    data: {
      leagueId,
      action: "create",
      type,
      cycleNumber: opts.cycleNumber ?? 0,
      bidTimerSeconds: opts.bidTimerSeconds ?? 5,
      nominationTimeoutSeconds: opts.nominationTimeoutSeconds ?? 10,
    },
    failOnStatusCode: false,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    throw new Error(`createAuctionSession failed (${res.status()}): ${body?.error ?? ""}`);
  }
  return body;
}

/**
 * Start a session. For isSimulated leagues this returns once the entire
 * draft has been auto-resolved (status "completed"). Caller must be
 * superadmin.
 */
export async function startAuctionSession(
  request: APIRequestContext,
  leagueId: string,
  sessionId: string,
): Promise<{ status: string; simulated?: boolean }> {
  const res = await request.post("/api/auction/session", {
    data: { leagueId, action: "start", sessionId },
    failOnStatusCode: false,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    throw new Error(`startAuctionSession failed (${res.status()}): ${body?.error ?? ""}`);
  }
  return body;
}

/** Create + start the initial draft for a simulated auction league. */
export async function createAndRunInitialAuction(
  request: APIRequestContext,
  leagueId: string,
): Promise<{ sessionId: string }> {
  const { id } = await createAuctionSession(request, leagueId, "initial");
  const result = await startAuctionSession(request, leagueId, id);
  if (!result.simulated) {
    // Non-simulated path: caller is responsible for nominate/bid flow.
  }
  return { sessionId: id };
}

/** Pause or resume a running session — useful for state-transition specs. */
export async function transitionSession(
  request: APIRequestContext,
  leagueId: string,
  sessionId: string,
  action: "pause" | "resume" | "complete",
): Promise<void> {
  const res = await request.post("/api/auction/session", {
    data: { leagueId, action, sessionId },
    failOnStatusCode: false,
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`transitionSession(${action}) failed: ${res.status()} ${body?.error ?? ""}`);
  }
}

/** Count how many active player ownerships a team holds. Fast sanity-check after auto-draft. */
export async function countSquad(leagueId: string, teamId: string): Promise<number> {
  const db = testDb();
  const rows = await db
    .select({ id: schema.auctionOwnership.id })
    .from(schema.auctionOwnership)
    .where(eq(schema.auctionOwnership.teamId, teamId));
  void leagueId; // teamId is globally unique within the auction tables; leagueId kept for symmetry/future use
  return rows.length;
}
