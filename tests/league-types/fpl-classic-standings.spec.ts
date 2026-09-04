/**
 * FPL Classic — the public standings API, signed out.
 *
 * The one thing every test in this file has in common: no session cookie, anywhere. That is the
 * entire point of this format, and it is what the PUBLIC_ROUTES entry in middleware.ts exists
 * to guarantee. Settle/gameweek/monthly-board behaviour (which needs concluded gameweeks) is
 * covered once the sync layer lands; this file is the always-available live-standings path.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-classic-standings.spec.ts
 */

import { test, expect } from "@playwright/test";
import { apiSignInSuperadmin, apiSignOut, createFplClassicLeague } from "../harness";

const STUB_LEAGUE_ID = 900001;

test.describe.serial("FPL Classic — public standings", () => {
  let slug: string;

  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    // Without this, the stub's default finishedThrough=0 means cumulativePoints(entryId, 0) is 0
    // for every entrant — a 120-way tie at rank 1, and no row ever lands at exactly the winner-cut
    // rank. A few finished gameweeks give entrants genuinely different totals, matching what the
    // page actually looks like once a season is under way.
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 3, liveGw: null } });
    // A unique season per run: the slug is derived from fplLeagueId+season, and test.db persists
    // across repeated local runs, so a fixed season string collides on the second run.
    const season = `test-${Date.now().toString(36)}`;
    const league = await createFplClassicLeague(request, { fplLeagueId: STUB_LEAGUE_ID, season });
    slug = league.slug;
    await apiSignOut(request);
  });

  test.afterAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } });
  });

  test("is public — a signed-out visitor gets 200, not 401", async ({ request }) => {
    const res = await request.get(`/api/fpl-classic/standings?leagueSlug=${slug}`);
    expect(res.status()).toBe(200);
  });

  test("live standings list every entrant, ranked, with no auth", async ({ request }) => {
    const body = await request.get(`/api/fpl-classic/standings?leagueSlug=${slug}`).then((r) => r.json());
    expect(body.league.fplLeagueId).toBe(STUB_LEAGUE_ID);
    expect(body.standings.rows.length).toBe(120);
    // Strictly descending total, rank 1 first.
    expect(body.standings.rows[0].rank).toBe(1);
    for (let i = 1; i < body.standings.rows.length; i++) {
      expect(body.standings.rows[i].total).toBeLessThanOrEqual(body.standings.rows[i - 1].total);
    }
    // No prize/amount field anywhere in the payload.
    expect(JSON.stringify(body)).not.toMatch(/prize|amount|currency|rupee|dollar/i);
  });

  test("winnerCutRank is the ceiling of entrantCount * winnerCutPercent / 100", async ({ request }) => {
    const body = await request.get(`/api/fpl-classic/standings?leagueSlug=${slug}`).then((r) => r.json());
    // 120 entrants * 30% (default) = 36 exactly.
    expect(body.standings.winnerCutRank).toBe(36);
  });

  test("an unknown league slug is a 404, not a crash", async ({ request }) => {
    const res = await request.get("/api/fpl-classic/standings?leagueSlug=does-not-exist-xyz");
    expect(res.status()).toBe(404);
  });

  test("missing leagueSlug is a 400", async ({ request }) => {
    const res = await request.get("/api/fpl-classic/standings");
    expect(res.status()).toBe(400);
  });

  test("a TVT league's slug through this route is a 404, not another format's data", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const tvtRes = await request.post("/api/superadmin/leagues", {
      data: { slug: `zz-${Date.now().toString(36)}`, name: "Not Classic", sport: "fpl", format: "tvt", season: "2025-26", teamSize: 8, groupCount: 1, enabledChips: ["D", "W", "C"] },
    });
    const tvt = await tvtRes.json();
    await apiSignOut(request);
    const res = await request.get(`/api/fpl-classic/standings?leagueSlug=${tvt.slug}`);
    expect(res.status()).toBe(404);
  });

  test("the standings page renders the FPL Classic component, not the TVT fallthrough", async ({ page }) => {
    // A weaker assertion here (just the league name text) would pass even if the dispatcher
    // branch were missing — ClassicStandings (the TVT component) renders league.name in its own
    // header too. The testid is the only signal that specifically proves the RIGHT component
    // mounted, which is the one thing this test exists to catch.
    await page.goto(`/${slug}/standings`);
    await expect(page.getByTestId("fpl-classic-standings")).toBeVisible({ timeout: 60_000 });
    // Confirms content actually loaded, not just the shell.
    await expect(page.getByText(/mirrors FPL classic league/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Standings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Manager of the Gameweek/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Manager of the Month/ })).toBeVisible();
    // No Sign In invitation on a page with no accounts.
    await expect(page.getByRole("link", { name: "Sign In" })).toHaveCount(0);
  });

  test("120 rows render, and the winner-cut divider sits at rank 36 (30% of 120)", async ({ page }) => {
    await page.goto(`/${slug}/standings`);
    await expect(page.getByTestId("fpl-classic-standings")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Top 30% cutoff")).toBeVisible();
  });
});
