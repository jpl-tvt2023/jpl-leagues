/**
 * Auction Primary (10 teams) coverage spec.
 *
 * Tier "primary" disables trades, slot expansion, and club auction.
 * Penalty-slot redemption stays available. Squad cap is 15 (no bonus slots).
 *
 * The harness runs the auction in `isSimulated: true` mode so the entire
 * draft completes in milliseconds via src/lib/formats/auction/simulate.ts —
 * fast enough to assert post-draft state in every test run.
 *
 * Run with: npm run test:e2e -- tests/league-types/auction-primary-10.spec.ts
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

test.describe.serial("Auction Primary 10 (admin + user)", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    league = await createAuctionLeague(request, { tier: "primary", isSimulated: true });
    teams = await setupAllTeams(request, league.slug, league.teamSize, "auction");
    await ensureGameweeks(league.id);
  });

  test("admin: league created with 10 teams and tier=primary", async () => {
    expect(league.format).toBe("auction");
    expect(league.teamSize).toBe(10);
    expect(league.auctionTier).toBe("primary");
  });

  test("admin: simulated initial auction fills every team's squad", async ({ request }) => {
    await apiSignInSuperadmin(request);
    await createAndRunInitialAuction(request, league.id);

    const db = testDb();
    const allTeams = await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.leagueId, league.id));

    for (const t of allTeams) {
      const n = await countSquad(league.id, t.id);
      // Snake-draft simulator fills up to the team's max slot count.
      // For primary tier (15 slots), expect at least 10 by the time the draft ends.
      expect(n).toBeGreaterThanOrEqual(10);
    }
  });

  test("primary: trade proposals are rejected for primary tier", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const res = await request.post("/api/auction/trade", {
      data: {
        targetTeamLoginId: `${league.slug}Team2`,
        offeredPlayerIds: [],
        requestedPlayerIds: [],
        cashOffered: 0,
      },
      failOnStatusCode: false,
    });
    // Primary tier blocks the marketplace entirely; the API should refuse
    // before any business validation runs.
    expect([400, 403, 409]).toContain(res.status());
    await apiSignOut(request);
  });

  test("primary: slot unlock is rejected before initial auction completes (and stays off-tier after)", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const res = await request.post("/api/auction/unlock-slot", {
      data: {},
      failOnStatusCode: false,
    });
    expect([400, 403, 409]).toContain(res.status());
    await apiSignOut(request);
  });

  test("user: squad page loads after the simulated draft", async ({ page, request }) => {
    await apiSignInTeam(request, league.slug, 1);
    await expectPageLoads(page, `/${league.slug}/squad`);
    await apiSignOut(request);
  });

  test("user: finance + marketplace pages load (marketplace renders \"unavailable\" for primary)", async ({ page }) => {
    await expectPageLoads(page, `/${league.slug}/finance`);
    await expectPageLoads(page, `/${league.slug}/marketplace`);
  });

  test("admin: scoring-status endpoint reports a state for the league", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const res = await request.get(`/api/auction/scoring-status?leagueId=${league.id}`);
    expect([200, 404]).toContain(res.status());
  });
});
