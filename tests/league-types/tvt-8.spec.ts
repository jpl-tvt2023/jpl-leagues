/**
 * TVT-8 coverage spec.
 *
 * Format: 1 group of 8, 5 round-robin repetitions ⇒ 35 league-stage GWs,
 * playoffs start at GW36 (Semi-finals → Final). Captain + chip submission
 * available throughout league stage.
 *
 * Run with: npm run test:e2e -- tests/league-types/tvt-8.spec.ts
 */

import { test, expect } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignIn,
  apiSignOut,
  apiSignInTeam,
  createTvtLeague,
  generateFixtures,
  deleteFixtures,
  getFixtureStatus,
  setupAllTeams,
  ensureGameweeks,
  scoreGameweek,
  teamLoginId,
  TEAM_RESET_PASSWORD,
  uiSignIn,
  expectStandingsHasTeam,
  expectFixturesPageRenders,
  expectPageLoads,
  type LeagueRef,
  type TeamHandle,
} from "../harness";

let league: LeagueRef;
let teams: TeamHandle[];

test.describe.serial("TVT-8 (admin + user)", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    teams = await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    // Gameweeks must exist first — generate-fixtures rejects a league with no
    // league-stage gameweeks (it needs their deadlines to place fixtures).
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);
  });

  // -------------------- ADMIN SCENARIOS --------------------

  test("admin: league was created with 8 teams and 35 league-stage GWs", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const status = await getFixtureStatus(request, league.slug);
    expect(status.fixturesGenerated).toBe(true);
    expect(status.totalFixtures).toBeGreaterThan(0);
    expect(status.leagueConfig?.teamSize).toBe(8);
    expect(status.leagueConfig?.playoffStartGw).toBe(36);
  });

  test("admin: fixtures can be deleted and regenerated", async ({ request }) => {
    await apiSignInSuperadmin(request);
    await deleteFixtures(request, league.slug);
    const after = await getFixtureStatus(request, league.slug);
    expect(after.fixturesGenerated).toBe(false);
    // DELETE removes the league-stage gameweeks along with the fixtures (see
    // the DELETE handler in generate-fixtures/route.ts), so put them back
    // before regenerating.
    await ensureGameweeks(league.id);
    const summary = await generateFixtures(request, league.slug);
    expect(summary.leagueStageGws).toBe(35);
    expect(summary.repetitions).toBe(5);
  });

  test("admin: league settings (captain/chip toggles) persist", async ({ request }) => {
    await apiSignInSuperadmin(request);
    await request.post(`/api/admin/${league.slug}/settings`, {
      data: { key: "captainAnnouncementEnabled", value: false },
    });
    const off = await request.get(`/api/admin/${league.slug}/settings`).then((r) => r.json());
    expect(off.captainAnnouncementEnabled).toBe(false);

    await request.post(`/api/admin/${league.slug}/settings`, {
      data: { key: "captainAnnouncementEnabled", value: true },
    });
    const on = await request.get(`/api/admin/${league.slug}/settings`).then((r) => r.json());
    expect(on.captainAnnouncementEnabled).toBe(true);
  });

  test("admin: backup export round-trips through the backups list", async ({ request }) => {
    await apiSignInSuperadmin(request);
    // Creating a snapshot is POST /backups (plural). The singular /backup
    // route is GET-only — it downloads an export — so POSTing there 405s.
    const create = await request.post(`/api/admin/${league.slug}/backups`, { data: {} });
    expect(create.ok()).toBeTruthy();
    const created = await create.json();
    expect(created.success).toBe(true);

    const list = await request.get(`/api/admin/${league.slug}/backups`).then((r) => r.json());
    expect(Array.isArray(list.backups)).toBeTruthy();
    expect(list.backups.some((b: { id: string }) => b.id === created.id)).toBe(true);
  });

  // -------------------- USER SCENARIOS --------------------

  test("user: team can sign in after first-login password change", async ({ page }) => {
    await uiSignIn(page, teams[0].loginId, TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
  });

  test("user: the dashboard nav links to every league page, FPL League included", async ({ page }) => {
    // The dashboard does NOT use the shared LeagueNav — it keeps its own copy of
    // the link list. That duplication is exactly how FPL League ended up
    // reachable from every league page but not from here, so this asserts the
    // dashboard's own nav rather than trusting the two stay in step.
    await uiSignIn(page, teams[0].loginId, TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
    await page.goto("/dashboard");

    const nav = page.locator("nav").first();
    for (const label of ["Standings", "Fixtures", "FPL League", "Playoffs"]) {
      await expect(
        nav.getByRole("link", { name: label, exact: true }),
        `dashboard nav is missing ${label}`,
      ).toBeVisible();
    }

    // And it actually goes somewhere.
    await nav.getByRole("link", { name: "FPL League", exact: true }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("/fpl-league");
  });

  test("user: public standings page shows seeded teams", async ({ page }) => {
    // The standings page deliberately renders a "Standings Coming Soon"
    // placeholder until at least one match has been played, so score GW1
    // first — this also exercises the real standings aggregation rather than
    // just asserting a page loads.
    await scoreGameweek(league.id, 1, () => ({ home: 60, away: 50 }));
    await expectStandingsHasTeam(page, league.slug, teams[0].name);
  });

  test("user: public fixtures page renders", async ({ page }) => {
    await expectFixturesPageRenders(page, league.slug);
  });

  test("user: rules + teams pages load without error", async ({ page }) => {
    await expectPageLoads(page, `/${league.slug}/rules`);
    await expectPageLoads(page, `/${league.slug}/teams`);
  });

  test("user: captain submission succeeds for a future-deadline GW", async ({ request }) => {
    // Sign in as Team 1
    const signIn = await apiSignIn(request, teamLoginId(league.slug, 1), TEAM_RESET_PASSWORD);
    expect(signIn.ok).toBe(true);

    // Pick the first player from the team's dashboard
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    // Player IDs come from captaincyStatus — the dashboard's `teamMembers`
    // array carries names/fplIds for display but deliberately no row ids.
    const players = [dash?.captaincyStatus?.player1, dash?.captaincyStatus?.player2]
      .filter((p): p is { id: string; name: string } => Boolean(p?.id));
    expect(players.length).toBeGreaterThan(0);

    const res = await request.post("/api/team/captain", {
      data: { playerId: players[0].id, gameweek: 1 },
      failOnStatusCode: false,
    });
    expect(res.ok()).toBeTruthy();
    await apiSignOut(request);
  });

  test("user: chip submission succeeds for an enabled chip", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 2);
    // Win-Win, not Double Pointer: DP is deliberately ineligible in GW1
    // because its rank rule needs a league table that does not exist yet
    // (see double-pointer-eligibility.ts). WW carries no positional constraint.
    const res = await request.post("/api/team/chips", {
      data: { gameweek: 1, chipType: "W" }, // Win-Win — enabled by default
      failOnStatusCode: false,
    });
    expect(res.ok(), `chips POST failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    await apiSignOut(request);
  });

  test("user: chip submission for a disabled chip returns 400", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 3);
    // SL ("Score Lock") not in default enabledChips ["D","W","C"]
    const res = await request.post("/api/team/chips", {
      data: { gameweek: 1, chipType: "SL" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    await apiSignOut(request);
  });
});
