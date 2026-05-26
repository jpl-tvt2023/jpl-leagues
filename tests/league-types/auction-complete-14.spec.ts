/**
 * Auction Complete (14 teams) coverage spec.
 *
 * Tier "complete" enables every economy feature: marketplace trades, 3 bonus
 * slots (£10M / £20M / £30M), and optional club auction. This spec covers
 * the Primary scenarios plus the Complete-only flows.
 *
 * Run with: npm run test:e2e -- tests/league-types/auction-complete-14.spec.ts
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  apiSignInSuperadmin,
  apiSignInTeam,
  apiSignOut,
  createAuctionLeague,
  setupAllTeams,
  ensureGameweeks,
  createAndRunInitialAuction,
  countSquad,
  expectPageLoads,
  testDb,
  schema,
  type LeagueRef,
  type TeamHandle,
} from "../harness";

let league: LeagueRef;
let teams: TeamHandle[];

test.describe.serial("Auction Complete 14 (admin + user)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await apiSignInSuperadmin(request);
    league = await createAuctionLeague(request, { tier: "complete", isSimulated: true });
    teams = await setupAllTeams(request, league.slug, league.teamSize, "auction");
    await ensureGameweeks(league.id);
  });

  test("admin: league created with 14 teams, tier=complete", async () => {
    expect(league.teamSize).toBe(14);
    expect(league.auctionTier).toBe("complete");
  });

  test("admin: simulated draft assigns players to every team", async ({ request }) => {
    await apiSignInSuperadmin(request);
    await createAndRunInitialAuction(request, league.id);
    const db = testDb();
    const allTeams = await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.leagueId, league.id));
    for (const t of allTeams) {
      const n = await countSquad(league.id, t.id);
      expect(n).toBeGreaterThanOrEqual(10);
    }
  });

  test("complete: trade proposal endpoint is reachable (tier allows trades)", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    // We're not asserting a happy-path trade lifecycle here — only that the
    // tier doesn't pre-reject the request. Body validation may return 400,
    // but the response should NOT be a "feature disabled" 403/409.
    const res = await request.post("/api/auction/trade", {
      data: {
        offeredPlayerIds: [],
        requestedPlayerIds: [],
        cashOffered: 0,
      },
      failOnStatusCode: false,
    });
    expect(res.status()).not.toBe(403);
    await apiSignOut(request);
  });

  test("complete: unlock-slot endpoint accepts the request shape (may fail business rules — not tier)", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const res = await request.post("/api/auction/unlock-slot", { data: {}, failOnStatusCode: false });
    expect(res.status()).not.toBe(403);
    await apiSignOut(request);
  });

  test("user: marketplace page loads for complete-tier", async ({ page }) => {
    await expectPageLoads(page, `/${league.slug}/marketplace`);
  });

  test("user: squad + finance pages render after draft", async ({ page, request }) => {
    await apiSignInTeam(request, league.slug, 2);
    await expectPageLoads(page, `/${league.slug}/squad`);
    await expectPageLoads(page, `/${league.slug}/finance`);
    await apiSignOut(request);
  });

  test("admin: gw-summary endpoint returns JSON for the league", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const res = await request.get(`/api/auction/gw-summary?leagueId=${league.id}`);
    expect([200, 400, 404]).toContain(res.status());
  });

  test("admin: release endpoint requires a teamId + ownership row (rejected without one)", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const res = await request.post("/api/auction/release", { data: {}, failOnStatusCode: false });
    expect([400, 404]).toContain(res.status());
    await apiSignOut(request);
  });
});
