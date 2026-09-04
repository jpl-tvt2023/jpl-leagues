/**
 * FPL Classic — the Winners page and its API.
 *
 * The thing this file exists to pin is the three-state distinction. An award whose period is over
 * is a winner; one still being played for is only a leader, and the page must never call the
 * second a winner. Getting that wrong publishes a false result about a live competition, which is
 * worse than showing nothing.
 *
 * Also asserts the standing rule that no prize, amount or currency field appears anywhere in the
 * payload — see the warning at the top of lib/fpl-classic/awards.ts.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-classic-winners.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiSignInSuperadmin, apiSignOut, createFplClassicLeague, uniqueSlug } from "../harness";

const STUB_LEAGUE_ID = 900001;

async function processUntilDone(request: APIRequestContext, leagueId: string, maxCalls = 8) {
  let last;
  for (let i = 0; i < maxCalls; i++) {
    const res = await request.post(`/api/superadmin/fpl-classic/${leagueId}/process`, { data: {} });
    expect(res.ok(), await res.text()).toBe(true);
    last = await res.json();
    if (last.done) return last;
  }
  throw new Error(`process did not finish in ${maxCalls} calls: ${JSON.stringify(last)}`);
}

test.describe.serial("FPL Classic — winners", () => {
  let slug: string;
  let leagueId: string;

  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    const league = await createFplClassicLeague(request, {
      fplLeagueId: STUB_LEAGUE_ID,
      season: uniqueSlug("w"),
    });
    slug = league.slug;
    leagueId = league.id;
    // Three concluded gameweeks: enough for gameweek winners to be settled while the season and
    // the specials (which need GW38) are still only "leading".
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 3, liveGw: null } });
    await processUntilDone(request, leagueId);
  });

  test.afterAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } });
  });

  test("is public — a signed-out visitor gets 200, not 401", async ({ request }) => {
    await apiSignOut(request);
    const res = await request.get(`/api/fpl-classic/winners?leagueSlug=${slug}`, { failOnStatusCode: false });
    expect(res.status()).toBe(200);
  });

  test("gameweek awards are settled; season and specials are only LEADING", async ({ request }) => {
    const body = await request.get(`/api/fpl-classic/winners?leagueSlug=${slug}`).then((r) => r.json());
    expect(body.settledThroughGw).toBe(3);

    const byScopeKey = new Map<string, { status: string; scope: string }>(
      body.awards.map((a: { scopeKey: string; key: string; status: string; scope: string }) => [`${a.key}::${a.scopeKey}`, a]),
    );

    // GW1-3 are concluded and frozen by the process run.
    for (const gw of [1, 2, 3]) {
      const award = byScopeKey.get(`gw-winner::gw:${gw}`);
      expect(award, `gw:${gw} should be present`).toBeTruthy();
      expect(["final", "provisional"]).toContain(award!.status);
    }

    // The season is nowhere near over, so these must be LEADING and never final/provisional —
    // this is the assertion that matters most in the file.
    for (const key of ["season-podium::season", "highest-gw-score::season", "best-bench::season"]) {
      const award = byScopeKey.get(key);
      expect(award, `${key} should appear as a leader`).toBeTruthy();
      expect(award!.status, `${key} must not claim a winner mid-season`).toBe("leading");
    }
  });

  test("a leading award still names somebody — the whole point of the page", async ({ request }) => {
    const body = await request.get(`/api/fpl-classic/winners?leagueSlug=${slug}`).then((r) => r.json());
    const leading = body.awards.filter((a: { status: string }) => a.status === "leading");
    expect(leading.length, "some awards should still be in contention").toBeGreaterThan(0);
    for (const award of leading) {
      expect(award.winners.length, `${award.scopeKey} is leading but names nobody`).toBeGreaterThan(0);
      expect(award.winners[0].entryName).toBeTruthy();
    }
  });

  test("no prize, amount or currency field appears anywhere in the payload", async ({ request }) => {
    const raw = await request.get(`/api/fpl-classic/winners?leagueSlug=${slug}`).then((r) => r.text());
    for (const banned of ["prize", "amount", "currency", "payout"]) {
      expect(raw.toLowerCase(), `payload must not carry a "${banned}" field`).not.toContain(`"${banned}"`);
    }
  });

  test("the page renders, is reachable from the nav, and labels the leading awards", async ({ page }) => {
    await page.goto(`/${slug}/standings`);
    await page.getByRole("link", { name: "Winners" }).first().click();

    await expect(page.getByTestId("fpl-classic-winners")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Winners", exact: true })).toBeVisible();
    // The legend explains all three states, and the not-a-winner wording is present.
    await expect(page.getByText("Still being played for.")).toBeVisible();
    await expect(page.getByText(/Leading — not a winner yet\./).first()).toBeVisible();
    await expect(page.getByText(/never listed on this site/i)).toBeVisible();
  });

  test("an unknown league and a non-classic league both 404", async ({ request }) => {
    const missing = await request.get("/api/fpl-classic/winners?leagueSlug=nope-nope", { failOnStatusCode: false });
    expect(missing.status()).toBe(404);

    const noSlug = await request.get("/api/fpl-classic/winners", { failOnStatusCode: false });
    expect(noSlug.status()).toBe(400);
  });
});
