/**
 * Trades keep ownership history, end to end through the real routes.
 *
 * Team A swaps X for team B's Y while GW10 is under way. Afterwards:
 *   - each team's squad shows only what it holds now, and A can't release X (or its old copy of him);
 *   - a stale proposal that asked A for X is refused instead of quietly dropping him;
 *   - both Finance ledgers still match the purses (no purchase moves with the player);
 *   - approving the trade again changes nothing;
 *   - scoring GW10 credits X to A and Y to B, GW11 the other way round — reprocessing included;
 *   - players-left for a live gameweek counts only the players each team holds then.
 *
 * Run with: npm run test:e2e -- tests/league-types/auction-trade-history.spec.ts
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

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
const CURRENT_GW = 10;

interface SquadPlayer {
  ownershipId: string;
  fplElementId: number;
  purchasePrice: number;
  elementType: number | null;
  status: string;
}

let league: LeagueRef;
const indexByTeamId = new Map<string, number>();
let A: string, B: string, C: string;
let X: SquadPlayer, Y: SquadPlayer, Z: SquadPlayer;
let tradeId: string;
let staleId: string;

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

async function stub(request: APIRequestContext, finishedThrough: number, liveGw: number | null = null) {
  const res = await request.post("/api/test-fpl-stub/control", { data: { finishedThrough, liveGw } });
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

async function squad(request: APIRequestContext, teamId: string): Promise<SquadPlayer[]> {
  const res = await request.get(`/api/auction/squad?teamId=${teamId}`);
  expect(res.ok()).toBe(true);
  return (await res.json()).squad;
}

async function purse(teamId: string): Promise<number> {
  const [row] = await testDb().select({ purse: schema.teams.purse }).from(schema.teams).where(eq(schema.teams.id, teamId));
  return row.purse;
}

/** Element ids in a team's stored breakdown for a gameweek. */
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

/** In the stub's live gameweek, a club playing in fixtures 5–9 hasn't kicked off: element id % 20 >= 10. */
const yetToPlay = (fplElementId: number) => fplElementId % 20 >= 10;

test.describe.serial("Trades keep ownership history", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000);
    await apiSignInSuperadmin(request);
    league = await createAuctionLeague(request, { tier: "complete", isSimulated: true });
    await setupAllTeams(request, league.slug, league.teamSize, "auction");
    await ensureGameweeks(league.id);
    await apiSignInSuperadmin(request);
    await createAndRunInitialAuction(request, league.id);

    for (let i = 1; i <= league.teamSize; i++) {
      await apiSignOut(request);
      await apiSignInTeam(request, league.slug, i);
      const me = await (await request.get("/api/auth/me")).json();
      indexByTeamId.set(me.team.id, i);
    }
    await asAdmin(request);

    // Three same-position players on three teams, priced within the 80% trade floor of each other,
    // with X's club yet to kick off in a live gameweek (so players-left can tell who holds him).
    // Trade validation also wants both squads at the 1/3/3/1 minimum, which the simulated draft
    // doesn't always reach — so only teams that meet it take part.
    const MIN: Record<number, number> = { 1: 1, 2: 3, 3: 3, 4: 1 };
    const meetsMinimum = (s: SquadPlayer[]) =>
      Object.entries(MIN).every(([pos, min]) => s.filter((p) => p.elementType === Number(pos)).length >= min);
    const squads = new Map<string, SquadPlayer[]>();
    for (const teamId of indexByTeamId.keys()) {
      const active = (await squad(request, teamId)).filter((p) => p.status === "active");
      if (meetsMinimum(active)) squads.set(teamId, active);
    }
    const close = (a: SquadPlayer, b: SquadPlayer) =>
      a.elementType === b.elementType && Math.max(a.purchasePrice, b.purchasePrice) <= 1.2 * Math.min(a.purchasePrice, b.purchasePrice);
    search: for (const [a, aSquad] of squads) {
      for (const x of aSquad.filter((p) => yetToPlay(p.fplElementId) && p.elementType != null)) {
        const others = [...squads].filter(([t]) => t !== a);
        for (const [b, bSquad] of others) {
          const y = bSquad.find((p) => close(p, x));
          if (!y) continue;
          for (const [c, cSquad] of others.filter(([t]) => t !== b)) {
            const z = cSquad.find((p) => close(p, x));
            if (!z) continue;
            [A, B, C, X, Y, Z] = [a, b, c, x, y, z];
            break search;
          }
        }
      }
    }
    expect(X, "found a tradeable trio in the simulated draft").toBeTruthy();

    await stub(request, CURRENT_GW);
    await setDeadlines(CURRENT_GW);
  });

  test.afterAll(async ({ request }) => {
    await asAdmin(request);
    await stub(request, 0);
    if (league) await deleteLeague(request, league.id);
  });

  test("A and B agree a swap; C's competing offer for X is left pending", async ({ request }) => {
    await asTeam(request, C);
    const stale = await request.post("/api/auction/trade", {
      data: { leagueId: league.id, targetTeamId: A, offeredPlayerIds: [Z.ownershipId], requestedPlayerIds: [X.ownershipId], cashOffered: 0 },
    });
    expect(stale.status(), await stale.text()).toBe(200);
    staleId = (await stale.json()).proposalId;

    await asTeam(request, A);
    const proposed = await request.post("/api/auction/trade", {
      data: { leagueId: league.id, targetTeamId: B, offeredPlayerIds: [X.ownershipId], requestedPlayerIds: [Y.ownershipId], cashOffered: 0 },
    });
    expect(proposed.status(), await proposed.text()).toBe(200);
    tradeId = (await proposed.json()).proposalId;

    await asTeam(request, B);
    const accepted = await request.patch("/api/auction/trade", { data: { proposalId: tradeId, action: "accept" } });
    expect(accepted.status(), await accepted.text()).toBe(200);
  });

  test("approval moves the players and leaves each seller his history", async ({ request }) => {
    const before = { a: await purse(A), b: await purse(B) };
    await asAdmin(request);
    const approved = await request.post("/api/auction/trade/admin", { data: { proposalId: tradeId, action: "approve" } });
    expect(approved.status(), await approved.text()).toBe(200);

    const db = testDb();
    for (const [p, seller, buyer] of [[X, A, B], [Y, B, A]] as const) {
      const rows = await db.select().from(schema.auctionOwnership)
        .where(and(eq(schema.auctionOwnership.leagueId, league.id), eq(schema.auctionOwnership.fplElementId, p.fplElementId)));
      expect(rows.find((r) => r.id === p.ownershipId)).toMatchObject({ teamId: buyer, status: "active", acquiredGw: CURRENT_GW, acquiredVia: "trade" });
      expect(rows.find((r) => r.id !== p.ownershipId)).toMatchObject({ teamId: seller, status: "transferred", releasedGw: CURRENT_GW });
    }
    // No cash in this trade, so neither purse moved.
    expect(await purse(A)).toBe(before.a);
    expect(await purse(B)).toBe(before.b);

    // Approving again changes nothing.
    const again = await request.post("/api/auction/trade/admin", { data: { proposalId: tradeId, action: "approve" }, failOnStatusCode: false });
    expect([400, 409]).toContain(again.status());
    const xRows = await db.select().from(schema.auctionOwnership)
      .where(and(eq(schema.auctionOwnership.leagueId, league.id), eq(schema.auctionOwnership.fplElementId, X.fplElementId)));
    expect(xRows).toHaveLength(2);
  });

  test("squads, releases, stale offers and ledgers all reflect the trade", async ({ request }) => {
    await asTeam(request, A);
    const aSquad = await squad(request, A);
    expect(aSquad.map((p) => p.fplElementId)).not.toContain(X.fplElementId);
    expect(aSquad.map((p) => p.fplElementId)).toContain(Y.fplElementId);

    // X's row is B's now, and A's copy of it is history — neither can be released by A.
    const live = await request.post("/api/auction/release", { data: { ownershipId: X.ownershipId }, failOnStatusCode: false });
    expect(live.status()).toBe(403);
    const [history] = await testDb().select().from(schema.auctionOwnership).where(and(
      eq(schema.auctionOwnership.teamId, A), eq(schema.auctionOwnership.fplElementId, X.fplElementId),
    ));
    const old = await request.post("/api/auction/release", { data: { ownershipId: history.id }, failOnStatusCode: false });
    expect(old.status()).toBe(400);

    // C asked A for X before the trade; A can't accept it now — refused for the right reason, not
    // because dropping X quietly left a lopsided trade that failed the value floor.
    const stale = await request.patch("/api/auction/trade", { data: { proposalId: staleId, action: "accept" }, failOnStatusCode: false });
    expect(stale.status(), await stale.text()).toBe(400);
    expect((await stale.json()).error).toContain("has left the squad");

    for (const teamId of [A, B]) {
      await asTeam(request, teamId);
      const ledger = await (await request.get(`/api/auction/finance?teamId=${teamId}`)).json();
      expect(ledger.currentPurse, `${teamId} ledger purse`).toBe(await purse(teamId));
    }
  });

  test("scoring and reprocessing credit each player to whoever held him that gameweek", async ({ request }) => {
    await asAdmin(request);
    await stub(request, CURRENT_GW + 1);
    await setDeadlines(CURRENT_GW + 1);
    for (const gw of [CURRENT_GW, CURRENT_GW + 1]) {
      const res = await request.post(`/api/gameweeks/${gw}?leagueId=${league.id}&force=true`, { failOnStatusCode: false });
      expect(res.ok(), `GW${gw}: ${await res.text()}`).toBe(true);
    }
    expect((await breakdown(A, CURRENT_GW)).has(X.fplElementId)).toBe(true);
    expect((await breakdown(B, CURRENT_GW)).has(X.fplElementId)).toBe(false);
    expect((await breakdown(A, CURRENT_GW + 1)).has(X.fplElementId)).toBe(false);
    expect((await breakdown(B, CURRENT_GW + 1)).has(X.fplElementId)).toBe(true);
    expect((await breakdown(B, CURRENT_GW)).has(Y.fplElementId)).toBe(true);
    expect((await breakdown(A, CURRENT_GW)).has(Y.fplElementId)).toBe(false);
    expect((await breakdown(B, CURRENT_GW + 1)).has(Y.fplElementId)).toBe(false);
    expect((await breakdown(A, CURRENT_GW + 1)).has(Y.fplElementId)).toBe(true);
  });

  test("players-left in a live gameweek counts only what each team holds then", async ({ request }) => {
    await asAdmin(request);
    await stub(request, CURRENT_GW + 1, CURRENT_GW + 2);
    await setDeadlines(CURRENT_GW + 2);

    const summary = await (await request.get(`/api/auction/gw-summary?leagueSlug=${league.slug}&gw=${CURRENT_GW + 2}`)).json();
    expect(summary.isLive, JSON.stringify(summary).slice(0, 300)).toBe(true);
    const aRow = summary.rows.find((r: { teamId: string }) => r.teamId === A);
    const aSquad = await squad(request, A);
    const expected = aSquad.filter((p) => yetToPlay(p.fplElementId)).length;
    // X (traded away, yet to play) would make it one more if A's history row were counted.
    expect(aRow.playersLeftToPlay).toBe(expected);
  });
});
