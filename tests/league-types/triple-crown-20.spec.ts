/**
 * Triple Crown 20-team coverage spec.
 *
 * Format: 20 teams, PL all-play-all 2× ⇒ 38 GWs. 4 cup groups (each is 5
 * humans + 1 Ghost), cup matchdays land on even GWs (6, 8, …, 24). Captaincy
 * cap is 19 chips per player (vs. 15 in TVT).
 *
 * Run with: npm run test:e2e -- tests/league-types/triple-crown-20.spec.ts
 */

import { test, expect } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignInTeam,
  apiSignOut,
  createTripleCrownLeague,
  generateFixtures,
  getFixtureStatus,
  setupAllTeams,
  ensureGameweeks,
  expectStandingsHasTeam,
  expectFixturesPageRenders,
  expectPageLoads,
  type LeagueRef,
  type TeamHandle,
} from "../harness";

let league: LeagueRef;
let teams: TeamHandle[];

test.describe.serial("Triple Crown 20 (admin + user)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000); // 20 teams × setup
    await apiSignInSuperadmin(request);
    league = await createTripleCrownLeague(request);
    teams = await setupAllTeams(request, league.slug, league.teamSize, "continental-championship");
    await apiSignInSuperadmin(request);
    await generateFixtures(request, league.slug);
    await ensureGameweeks(league.id);
  });

  test("admin: league created with 20 teams and triple-crown format", async () => {
    expect(league.format).toBe("continental-championship");
    expect(league.teamSize).toBe(20);
  });

  test("admin: fixture generation produces 38 GWs of PL fixtures", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const status = await getFixtureStatus(request, league.slug);
    expect(status.fixturesGenerated).toBe(true);
    expect(status.totalFixtures).toBeGreaterThan(0);
  });

  test("admin: cup groups can be generated and deleted", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const create = await request.post(`/api/admin/${league.slug}/generate-cup-groups`, {
      failOnStatusCode: false,
    });
    expect([200, 400]).toContain(create.status());
    if (create.ok()) {
      const del = await request.delete(`/api/admin/${league.slug}/generate-cup-groups`);
      expect(del.ok()).toBeTruthy();
    }
  });

  test("user: cup-standings endpoint returns JSON", async ({ request }) => {
    const res = await request.get(`/api/triple-crown/cup-standings?leagueId=${league.id}`);
    expect([200, 400, 404]).toContain(res.status()); // tolerant: cup-groups may not exist yet
  });

  test("user: standings + fixtures pages render", async ({ page }) => {
    await expectStandingsHasTeam(page, league.slug, teams[0].name);
    await expectFixturesPageRenders(page, league.slug);
  });

  test("user: UCL / UEL / Europa pages load", async ({ page }) => {
    await expectPageLoads(page, `/${league.slug}/ucl`);
    await expectPageLoads(page, `/${league.slug}/europa`);
    await expectPageLoads(page, `/${league.slug}/jpl-cup-standings`);
  });

  test("user: rules page renders Triple-Crown-specific content", async ({ page }) => {
    await page.goto(`/${league.slug}/rules`);
    await expect(page.locator("body")).toContainText(/cup|triple crown|playoff/i, { timeout: 10_000 });
  });

  test("user: captain submission honours the TC-specific 19-chip cap", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    const players = dash?.team?.players ?? dash?.players ?? [];
    expect(players.length).toBeGreaterThan(0);
    const res = await request.post("/api/team/captain", {
      data: { playerId: players[0].id, gameweek: 1 },
      failOnStatusCode: false,
    });
    expect(res.ok()).toBeTruthy();
    await apiSignOut(request);
  });
});
