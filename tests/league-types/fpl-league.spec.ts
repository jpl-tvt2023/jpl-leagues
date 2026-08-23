/**
 * The FPL League page: player-level standings ranked by official FPL total.
 *
 * The contract that matters here is "degrade, never throw". The page fans out
 * over every manager in the league, so a single unreachable entry — or FPL
 * being down entirely — must still render a table, with the unknown rows
 * marked pending rather than 500ing.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-league.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignOut,
  createTvtLeague,
  generateFixtures,
  setupAllTeams,
  ensureGameweeks,
  expireGameweek,
  expectPageLoads,
  type LeagueRef,
} from "../harness";

let league: LeagueRef;

/**
 * Load with warming requested, until the table settles.
 *
 * warm=1 matters: a plain read deliberately makes no FPL calls so the page can
 * paint instantly, so without it nothing ever fills in and every row stays
 * pending.
 */
async function loadUntilWarm(request: APIRequestContext, slug: string, maxTries = 12) {
  let body: { rows: { pending?: true }[]; warming: number } | null = null;
  for (let i = 0; i < maxTries; i++) {
    const res = await request.get(
      `/api/fpl-league?leagueSlug=${encodeURIComponent(slug)}&warm=1`,
    );
    expect(res.ok(), `fpl-league returned ${res.status()}`).toBeTruthy();
    body = await res.json();
    if (body!.warming === 0) break;
  }
  return body!;
}

test.describe.serial("FPL League (TVT)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);
    // Give the stub three finished gameweeks, and push our own deadlines for
    // those into the past to match — the service reads DB deadlines, which in
    // production come from FPL via create-gameweeks.
    await request.post("/api/test-fpl-stub/control", {
      data: { finishedThrough: 3, liveGw: null },
    });
    for (const gw of [1, 2, 3]) await expireGameweek(league.id, gw);
    await apiSignOut(request);
  });

  test("is public — a signed-out visitor gets the standings", async ({ request }) => {
    // Proves the PUBLIC_ROUTES entry; without it this 401s.
    const res = await request.get(
      `/api/fpl-league?leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    expect(res.status()).toBe(200);
  });

  test("lists every manager in the league, two per team", async ({ request }) => {
    const body = await loadUntilWarm(request, league.slug);
    expect(body.rows.length).toBe(league.teamSize * 2);
  });

  test("ranks by FPL season total, descending, with competition ranking", async ({ request }) => {
    const body = (await loadUntilWarm(request, league.slug)) as unknown as {
      rows: { rank: number; totalPoints: number; playerName: string }[];
    };

    for (let i = 1; i < body.rows.length; i++) {
      expect(
        body.rows[i - 1].totalPoints,
        `row ${i} out of order`,
      ).toBeGreaterThanOrEqual(body.rows[i].totalPoints);
    }

    // Equal totals share a rank; the next distinct total skips ahead.
    expect(body.rows[0].rank).toBe(1);
    for (let i = 1; i < body.rows.length; i++) {
      const prev = body.rows[i - 1];
      const cur = body.rows[i];
      if (cur.totalPoints === prev.totalPoints) {
        expect(cur.rank).toBe(prev.rank);
      } else {
        expect(cur.rank).toBe(i + 1);
      }
    }
  });

  test("reports the settled gameweek, and marks it live only when one is in flight", async ({ request }) => {
    const settled = await loadUntilWarm(request, league.slug);
    expect((settled as unknown as { gw: number | null }).gw).toBe(3);
    expect((settled as unknown as { isLive: boolean }).isLive).toBe(false);
  });

  test("carries FPL chip status per manager", async ({ request }) => {
    const body = (await loadUntilWarm(request, league.slug)) as unknown as {
      rows: { chips: { used: { code: string; gw: number }[]; available: string[] } }[];
    };
    for (const row of body.rows) {
      expect(Array.isArray(row.chips.used)).toBe(true);
      expect(Array.isArray(row.chips.available)).toBe(true);
      // Six standard chips: every one is either played or still available.
      expect(row.chips.used.length + row.chips.available.length).toBeGreaterThanOrEqual(6);
    }
  });

  test("the gameweek column is that gameweek alone, never a running total", async ({ request }) => {
    // The distinction only becomes visible from GW2 onwards: at GW1 a manager's
    // gameweek score and their season total are the same number, so a column
    // that had been quietly summing every gameweek would look perfectly correct.
    //
    // GW3, not GW2: "in flight" is decided from OUR gameweek rows (deadline
    // passed, no result yet) and beforeAll already expired GW1-3, so the app
    // considers GW3 live whatever the stub says. Pointing the stub at GW2 would
    // only create a disagreement between the two, which is not what this tests.
    //
    // The cached histories are reused deliberately. entryHistory depends only on
    // max(finishedThrough, liveGw), which is 3 both before and after this change,
    // so their contents are identical -- and discarding them would leave every
    // row pending behind the warm single-flight, with nothing to assert on.
    await request.post("/api/test-fpl-stub/control", {
      data: { finishedThrough: 2, liveGw: 3 },
    });

    const body = (await loadUntilWarm(request, league.slug)) as unknown as {
      gw: number;
      isLive: boolean;
      rows: { fplId: string; gwPoints: number | null; totalPoints: number }[];
    };
    expect(body.gw).toBe(3);
    expect(body.isLive, "GW3 is in flight").toBe(true);

    const row = body.rows.find((r) => r.gwPoints != null);
    expect(row, "at least one manager should have GW3 points").toBeTruthy();

    const history = await (
      await request.get(`/api/test-fpl-stub/entry/${row!.fplId}/history`)
    ).json();
    const liveGw = history.current.find((c: { event: number }) => c.event === 3);
    const cumulative = history.current[history.current.length - 1].total_points;

    // Guards the guard: if these two were equal the assertion below would pass
    // for a cumulative column as well, and prove nothing.
    expect(liveGw.points, "GW3 alone must differ from the season total").not.toBe(cumulative);

    expect(row!.gwPoints, "GW column is GW3 alone").toBe(liveGw.points);
    expect(row!.totalPoints, "Total column carries the cumulative figure").toBe(cumulative);
  });

  test("a gameweek with no data yet renders as blank rather than failing", async ({ request }) => {
    // GW30 is a real gameweek but nothing has been played in it, so every
    // manager should come back with null points and the page should still
    // render. (Out-of-range values like 99 are ignored, not honoured — the
    // service falls back to the resolved gameweek.)
    const res = await request.get(
      `/api/fpl-league?leagueSlug=${encodeURIComponent(league.slug)}&gw=30`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.gw).toBe(30);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) expect(row.gwPoints).toBeNull();
  });

  test("an unknown league slug is a 404, not a crash", async ({ request }) => {
    const res = await request.get("/api/fpl-league?leagueSlug=does-not-exist", {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
  });

  test("the page renders", async ({ page }) => {
    await expectPageLoads(page, `/${league.slug}/fpl-league`);
    await expect(page.getByRole("heading", { name: "FPL League" })).toBeVisible();
  });

  test.afterAll(async ({ request }) => {
    await request
      .post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } })
      .catch(() => {});
  });
});
