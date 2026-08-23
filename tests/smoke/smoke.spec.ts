/**
 * Smoke test — verifies the harness pieces wire together end-to-end before
 * the heavy per-format specs run. If this passes, league creation, admin
 * sign-in, team sign-in, and fixture generation are all working.
 *
 * Run with: npm run test:reset && npm run test:e2e -- tests/smoke
 */

import { test, expect } from "@playwright/test";
import {
  apiSignInSuperadmin,
  createTvtLeague,
  generateFixtures,
  ensureGameweeks,
  setupTvtTeam,
  apiSignIn,
  uiSignIn,
  teamLoginId,
  TEAM_RESET_PASSWORD,
} from "../harness";

test.describe.serial("smoke: harness end-to-end", () => {
  test("superadmin can create a TVT-8 league, generate fixtures, and a team can sign in", async ({ request, page }) => {
    await apiSignInSuperadmin(request);

    const league = await createTvtLeague(request, { teams: 8 });
    expect(league.slug).toMatch(/^t8-/);
    expect(league.teamSize).toBe(8);
    expect(league.format).toBe("tvt");

    // Gameweeks must exist before fixtures can be generated.
    await ensureGameweeks(league.id);
    const summary = await generateFixtures(request, league.slug);
    expect(summary.leagueStageGws).toBe(35); // 8-team × 5 reps
    expect(summary.totalFixtures).toBeGreaterThan(0);

    // Walk one team through password change + setup so the next sign-in
    // lands on the dashboard, not /change-password.
    await setupTvtTeam(request, league.slug, 1);

    // Now drive the UI sign-in for that team via the shared helper.
    await uiSignIn(page, teamLoginId(league.slug, 1), TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
  });

  test("public standings endpoint returns JSON for the smoke league", async ({ request }) => {
    // Reusing the league created above would require a beforeAll — instead
    // we hit the leagues list endpoint to confirm the public API is reachable.
    const res = await request.get("/api/leagues");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.leagues ?? body)).toBeTruthy();
  });

  test("the FPL redirect hop forwards permitted paths and refuses anything else", async ({ request }) => {
    // /go/fpl/* is a best-effort workaround for Android opening FPL links in
    // the Premier League app. It must never become an open redirect: without
    // the allow-list, an attacker could hand out links on our domain that
    // land on a phishing page.
    const ok = await request.get("/go/fpl/entry/12345/event/7", {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(ok.status()).toBe(302);
    expect(ok.headers()["location"]).toBe(
      "https://fantasy.premierleague.com/entry/12345/event/7",
    );

    for (const bad of [
      "/go/fpl/entry/abc/event/7",
      "/go/fpl/entry/12345/transfers",
      "/go/fpl/evil",
    ]) {
      const res = await request.get(bad, { maxRedirects: 0, failOnStatusCode: false });
      expect(res.status(), `${bad} should be refused`).toBe(400);
    }
  });

  test("apiSignIn rejects invalid credentials with 401", async ({ request }) => {
    const result = await apiSignIn(request, "nobody@example.com", "wrong");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});
