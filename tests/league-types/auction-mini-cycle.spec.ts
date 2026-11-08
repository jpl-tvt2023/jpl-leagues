/**
 * A full mini-auction cycle, end to end through the real routes.
 *
 * Covers the release deadline and the ownership window together, because they only make sense
 * together: a team marks a release, it is confirmed and paid 24 hours before the mini-auction, the
 * player is bought back by another team in that auction, and scoring credits him to the seller up
 * to the release gameweek and to the buyer after it — never both, never neither.
 *
 *   1. No mini-auction scheduled → the countdown is the next GW deadline, tentative.
 *   2. Releases marked (and one cancelled) while the window is open → countdown = start − 24h.
 *   3. Deadline passes → confirmed and paid exactly once, releases closed, player back in the pool.
 *   4. The auction re-sells him to another team → acquiredGw = the release gameweek, no UNIQUE.
 *   5. Scoring GW10 / GW11 → seller then buyer.
 *   6. Auction completes → releases reopen.
 *
 * Run with: npm run test:e2e -- tests/league-types/auction-mini-cycle.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import {
  apiSignInSuperadmin,
  apiSignInTeam,
  apiSignOut,
  createAuctionLeague,
  setupAllTeams,
  ensureGameweeks,
  createAndRunInitialAuction,
  deleteLeague,
  testDb,
  schema,
  type LeagueRef,
} from "../harness";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** The gameweek in progress throughout the auction — releases confirm "in" it. */
const CURRENT_GW = 10;

let league: LeagueRef;
const indexByTeamId = new Map<string, number>();
let miniId: string;
let sellerId: string;
let buyerId: string;
let playerX: { ownershipId: string; fplElementId: number; playerName: string; refund: number };
let playerY: { ownershipId: string; fplElementId: number; refund: number };

/** League GW deadlines laid out exactly as the FPL stub's bootstrap does for `anchor`. */
async function setDeadlines(anchor: number) {
  const db = testDb();
  const now = Date.now();
  for (let n = 1; n <= 38; n++) {
    await db
      .update(schema.gameweeks)
      .set({ deadline: new Date(now + (n - anchor) * WEEK - DAY) })
      .where(and(eq(schema.gameweeks.leagueId, league.id), eq(schema.gameweeks.number, n)));
  }
}

async function stub(request: APIRequestContext, finishedThrough: number) {
  const res = await request.post("/api/test-fpl-stub/control", { data: { finishedThrough, liveGw: null } });
  expect(res.ok()).toBe(true);
}

async function asTeam(request: APIRequestContext, teamId: string) {
  await apiSignOut(request);
  await apiSignInTeam(request, league.slug, indexByTeamId.get(teamId)!);
}

async function asAdmin(request: APIRequestContext) {
  await apiSignOut(request);
  await apiSignInSuperadmin(request);
}

async function squad(request: APIRequestContext, teamId: string) {
  const res = await request.get(`/api/auction/squad?teamId=${teamId}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

async function team(teamId: string) {
  const [row] = await testDb().select().from(schema.teams).where(eq(schema.teams.id, teamId));
  return row;
}

async function ownershipRows(fplElementId: number) {
  return testDb()
    .select()
    .from(schema.auctionOwnership)
    .where(and(eq(schema.auctionOwnership.leagueId, league.id), eq(schema.auctionOwnership.fplElementId, fplElementId)));
}

async function schedule(request: APIRequestContext, at: Date) {
  const res = await request.post("/api/auction/session", {
    data: { leagueId: league.id, action: "schedule", sessionId: miniId, scheduledAt: at.toISOString() },
  });
  expect(res.ok()).toBe(true);
}

/** elementId → raw points in a team's stored GW breakdown. */
async function breakdown(teamId: string, gw: number): Promise<Set<number>> {
  const db = testDb();
  const [gwRow] = await db
    .select({ id: schema.gameweeks.id })
    .from(schema.gameweeks)
    .where(and(eq(schema.gameweeks.leagueId, league.id), eq(schema.gameweeks.number, gw)));
  const [score] = await db
    .select({ playerBreakdown: schema.auctionScores.playerBreakdown })
    .from(schema.auctionScores)
    .where(and(eq(schema.auctionScores.teamId, teamId), eq(schema.auctionScores.gameweekId, gwRow.id)));
  expect(score, `GW${gw} score row for ${teamId}`).toBeTruthy();
  return new Set((JSON.parse(score.playerBreakdown) as { elementId: number }[]).map((p) => p.elementId));
}

test.describe.serial("Mini-auction cycle: release deadline → re-sale → scoring", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000);
    await apiSignInSuperadmin(request);
    league = await createAuctionLeague(request, { tier: "complete", isSimulated: true });
    await setupAllTeams(request, league.slug, league.teamSize, "auction");
    await ensureGameweeks(league.id);
    await apiSignInSuperadmin(request);
    await createAndRunInitialAuction(request, league.id);

    // Login index → team id, from the session itself rather than guessing the stored login format.
    for (let i = 1; i <= league.teamSize; i++) {
      await apiSignOut(request);
      await apiSignInTeam(request, league.slug, i);
      const me = await (await request.get("/api/auth/me")).json();
      indexByTeamId.set(me.team.id, i);
    }
    expect(indexByTeamId.size).toBe(league.teamSize);
    await asAdmin(request);

    // GW10 is under way: its deadline has passed, GW11's hasn't.
    await stub(request, CURRENT_GW);
    await setDeadlines(CURRENT_GW);
  });

  test.afterAll(async ({ request }) => {
    await asAdmin(request);
    await stub(request, 0);
    if (league) await deleteLeague(request, league.id);
  });

  test("no mini-auction scheduled: tentative countdown to the next GW deadline", async ({ request }) => {
    const anyTeam = [...indexByTeamId.keys()][0];
    await asTeam(request, anyTeam);
    const sq = await squad(request, anyTeam);
    expect(sq.releaseCountdown).toMatchObject({ tentative: true, gw: CURRENT_GW + 1 });
    expect(sq.releasesClosed).toBe(false);

    const dash = await (await request.get("/api/team/dashboard")).json();
    expect(dash.releaseCountdown).toMatchObject({ tentative: true, gw: CURRENT_GW + 1 });
  });

  test("releases marked while the window is open; the countdown becomes the real deadline", async ({ request }) => {
    await asAdmin(request);
    const scheduledAt = new Date(Date.now() + 25 * HOUR);
    const created = await request.post("/api/auction/session", {
      data: {
        leagueId: league.id, action: "create", type: "mini-auction", cycleNumber: 1,
        scheduledAt: scheduledAt.toISOString(), bidTimerSeconds: 5, nominationTimeoutSeconds: 120,
      },
    });
    expect(created.ok()).toBe(true);
    const body = await created.json();
    miniId = body.id;
    // The first nominator buys; any other team sells.
    buyerId = body.snakeOrder[0];
    sellerId = body.snakeOrder.find((id: string) => id !== buyerId);

    // Seller releases X — cancelled once and marked again, to prove cancel works before the deadline.
    await asTeam(request, sellerId);
    const sellerSquad = await squad(request, sellerId);
    const x = sellerSquad.squad.find((p: { status: string }) => p.status === "active");
    for (const step of ["mark", "cancel", "mark"] as const) {
      const res = await request.fetch("/api/auction/release", {
        method: step === "cancel" ? "DELETE" : "POST",
        data: { ownershipId: x.ownershipId },
      });
      expect(res.status(), `${step}: ${await res.text()}`).toBe(200);
      if (step === "mark") playerX = { ownershipId: x.ownershipId, fplElementId: x.fplElementId, playerName: x.playerName, refund: (await res.json()).breakdown.refund };
    }

    const afterMark = await squad(request, sellerId);
    expect(afterMark.releaseCountdown.tentative).toBe(false);
    expect(afterMark.releaseCountdown.cycleNumber).toBe(1);
    expect(Math.abs(Date.parse(afterMark.releaseCountdown.at) - (scheduledAt.getTime() - DAY))).toBeLessThan(2000);
    expect(afterMark.releasesClosed).toBe(false);
    const dash = await (await request.get("/api/team/dashboard")).json();
    expect(dash.pendingReleases).toEqual({ count: 1, refund: playerX.refund });

    // Buyer frees a slot by releasing Y.
    await asTeam(request, buyerId);
    const buyerSquad = await squad(request, buyerId);
    const y = buyerSquad.squad.find((p: { status: string }) => p.status === "active");
    const res = await request.post("/api/auction/release", { data: { ownershipId: y.ownershipId } });
    expect(res.status(), await res.text()).toBe(200);
    playerY = { ownershipId: y.ownershipId, fplElementId: y.fplElementId, refund: (await res.json()).breakdown.refund };
  });

  test("deadline passes: confirmed and paid exactly once, releases closed, X back in the pool", async ({ request }) => {
    const sellerBefore = await team(sellerId);
    const buyerBefore = await team(buyerId);

    await asAdmin(request);
    await schedule(request, new Date(Date.now() + 23 * HOUR));

    // Five pages at once all see the deadline — each release must still be paid once.
    await asTeam(request, sellerId);
    const results = await Promise.all(Array.from({ length: 5 }, () => squad(request, sellerId)));
    for (const sq of results) expect(sq.releasesClosed).toBe(true);

    for (const p of [playerX, playerY]) {
      const [row] = (await ownershipRows(p.fplElementId)).filter((r) => r.id === p.ownershipId);
      expect(row.status).toBe("released");
      expect(row.releasedGw).toBe(CURRENT_GW);
    }
    const sellerAfter = await team(sellerId);
    const buyerAfter = await team(buyerId);
    expect(sellerAfter.purse - sellerBefore.purse).toBe(playerX.refund);
    expect(sellerAfter.totalRefunds - sellerBefore.totalRefunds).toBe(playerX.refund);
    expect(buyerAfter.purse - buyerBefore.purse).toBe(playerY.refund);

    const notes = await testDb().select().from(schema.notifications)
      .where(and(eq(schema.notifications.leagueId, league.id), eq(schema.notifications.type, "release_refund")));
    expect(notes.filter((n) => n.teamId === sellerId)).toHaveLength(1);
    expect(notes.filter((n) => n.teamId === buyerId)).toHaveLength(1);

    // Window closed: no new releases, no cancelling a confirmed one.
    const another = results[0].squad.find((p: { status: string }) => p.status === "active");
    const mark = await request.post("/api/auction/release", { data: { ownershipId: another.ownershipId }, failOnStatusCode: false });
    expect(mark.status()).toBe(409);
    const cancel = await request.delete("/api/auction/release", { data: { ownershipId: playerX.ownershipId }, failOnStatusCode: false });
    expect([400, 409]).toContain(cancel.status());

    const unsold = await (await request.get(`/api/auction/unsold?leagueId=${league.id}`)).json();
    expect(unsold.unsold.map((u: { fplElementId: number }) => u.fplElementId)).toContain(playerX.fplElementId);
  });

  test("the mini-auction re-sells X to the buyer with the right ownership window", async ({ request }) => {
    await asAdmin(request);
    const start = await request.post("/api/auction/session", { data: { leagueId: league.id, action: "start", sessionId: miniId } });
    expect(start.ok(), await start.text()).toBe(true);
    const pending = await testDb().select().from(schema.auctionOwnership)
      .where(and(eq(schema.auctionOwnership.leagueId, league.id), eq(schema.auctionOwnership.status, "pending_release")));
    expect(pending).toHaveLength(0);

    const buyerBefore = await team(buyerId);
    await asTeam(request, buyerId);
    const nominate = await request.post("/api/auction/nominate", {
      data: { sessionId: miniId, fplElementId: playerX.fplElementId, playerName: playerX.playerName },
      failOnStatusCode: false,
    });
    expect(nominate.status(), await nominate.text()).toBe(200);

    // Nobody counter-bids; poll the session (its GET resolves expired lots) until X is sold.
    const deadline = Date.now() + 60_000;
    let bid: typeof schema.auctionBids.$inferSelect | undefined;
    while (Date.now() < deadline) {
      await request.get(`/api/auction/session?leagueId=${league.id}`);
      [bid] = await testDb().select().from(schema.auctionBids)
        .where(and(eq(schema.auctionBids.sessionId, miniId), eq(schema.auctionBids.fplElementId, playerX.fplElementId)));
      if (bid && bid.status !== "open") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(bid?.status).toBe("sold");
    expect(bid?.currentHighBidderId).toBe(buyerId);

    const rows = await ownershipRows(playerX.fplElementId);
    const history = rows.find((r) => r.id === playerX.ownershipId);
    const bought = rows.find((r) => r.id !== playerX.ownershipId);
    expect(history).toMatchObject({ teamId: sellerId, status: "released", releasedGw: CURRENT_GW });
    expect(bought).toMatchObject({ teamId: buyerId, status: "active", acquiredGw: CURRENT_GW });
    expect(buyerBefore.purse - (await team(buyerId)).purse).toBe(bid!.currentHighBid);
  });

  test("scoring credits X to the seller through GW10 and to the buyer from GW11", async ({ request }) => {
    await asAdmin(request);
    await stub(request, CURRENT_GW + 1);
    await setDeadlines(CURRENT_GW + 1);
    for (const gw of [CURRENT_GW, CURRENT_GW + 1]) {
      const res = await request.post(`/api/gameweeks/${gw}?leagueId=${league.id}&force=true`, { failOnStatusCode: false });
      expect(res.ok(), `GW${gw}: ${await res.text()}`).toBe(true);
    }
    const x = playerX.fplElementId;
    expect((await breakdown(sellerId, CURRENT_GW)).has(x)).toBe(true);
    expect((await breakdown(buyerId, CURRENT_GW)).has(x)).toBe(false);
    expect((await breakdown(sellerId, CURRENT_GW + 1)).has(x)).toBe(false);
    expect((await breakdown(buyerId, CURRENT_GW + 1)).has(x)).toBe(true);
    // The buyer's own release Y scored for him in GW10 and not after.
    expect((await breakdown(buyerId, CURRENT_GW)).has(playerY.fplElementId)).toBe(true);
    expect((await breakdown(buyerId, CURRENT_GW + 1)).has(playerY.fplElementId)).toBe(false);
  });

  test("auction completes: releases reopen", async ({ request }) => {
    await asAdmin(request);
    const done = await request.post("/api/auction/session", { data: { leagueId: league.id, action: "complete", sessionId: miniId } });
    expect(done.ok(), await done.text()).toBe(true);

    await asTeam(request, sellerId);
    const sq = await squad(request, sellerId);
    expect(sq.releasesClosed).toBe(false);
    expect(sq.releaseCountdown).toMatchObject({ tentative: true, gw: CURRENT_GW + 2 });
    const p = sq.squad.find((s: { status: string }) => s.status === "active");
    const mark = await request.post("/api/auction/release", { data: { ownershipId: p.ownershipId } });
    expect(mark.status(), await mark.text()).toBe(200);
    const cancel = await request.delete("/api/auction/release", { data: { ownershipId: p.ownershipId } });
    expect(cancel.status(), await cancel.text()).toBe(200);
  });
});
