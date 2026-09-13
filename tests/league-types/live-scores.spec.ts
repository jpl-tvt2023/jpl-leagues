/**
 * Live-score coverage: the shared TVT scorer, players-left, and the guards on
 * the forced-refresh endpoint.
 *
 * The other league specs never have a live gameweek, so none of this path was
 * covered. Here we drive the FPL stub's /control endpoint to put GW1 "in
 * flight" and assert against the real routes.
 *
 * Run with: npm run test:e2e -- tests/league-types/live-scores.spec.ts
 */

import { test, expect } from "@playwright/test";
import { scoreGameweek } from "../harness/scores";
import {
  apiSignInSuperadmin,
  createTvtLeague,
  generateFixtures,
  setupAllTeams,
  ensureGameweeks,
  expireGameweek,
  type LeagueRef,
} from "../harness";

let league: LeagueRef;

/**
 * Fill the live-score cache the way the fixtures tab does.
 *
 * Necessary because the standings overlay reads that cache and never fetches FPL itself, and
 * because /api/test-fpl-stub/control deletes every `live:gw*` key on each call — so any spec that
 * moves the simulated world has to warm it again afterwards.
 */
async function warmLiveCache(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get(
    `/api/fixtures/live?gameweek=1&leagueSlug=${encodeURIComponent(league.slug)}`,
  );
  expect(res.ok()).toBeTruthy();
}

/** Point the FPL stub at a given live gameweek. */
async function setStubLiveGw(
  request: import("@playwright/test").APIRequestContext,
  liveGw: number | null,
) {
  const res = await request.post("/api/test-fpl-stub/control", {
    data: { liveGw, finishedThrough: 0 },
  });
  expect(res.ok(), "FPL stub control endpoint should be reachable").toBeTruthy();
}

test.describe.serial("live scores (TVT)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);

    // Put GW1 in flight: deadline in the past, no results yet.
    await expireGameweek(league.id, 1);
    await setStubLiveGw(request, 1);
  });

  test("live endpoint reports the gameweek as live and scores every fixture", async ({ request }) => {
    const res = await request.get(
      `/api/fixtures/live?gameweek=1&leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.isLive, `expected live, got reason=${body.reason}`).toBe(true);
    expect(Array.isArray(body.fixtures)).toBe(true);
    expect(body.fixtures.length).toBeGreaterThan(0);

    const fx = body.fixtures[0];
    expect(typeof fx.homeScore).toBe("number");
    expect(typeof fx.awayScore).toBe("number");
    expect(fx.homePlayers.length).toBeGreaterThan(0);
    expect(fx.awayPlayers.length).toBeGreaterThan(0);
  });

  test("a live gameweek scores something (entry_history.points is 0 while it is in flight)", async ({
    request,
  }) => {
    // The regression this exists for: the scorer read `entry_history.points`, which FPL holds
    // at 0 for the whole of an in-progress gameweek, so every fixture on the site rendered
    // 0-0 with a LIVE badge for three gameweeks. `typeof score === "number"` above was the
    // only assertion on the value, and 0 satisfies it — this one does not.
    const res = await request.get(
      `/api/fixtures/live?gameweek=1&leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    const body = await res.json();

    const scored = body.fixtures.filter(
      (f: { homeScore: number; awayScore: number }) => f.homeScore !== 0 || f.awayScore !== 0,
    );
    expect(
      scored.length,
      "every fixture scored 0-0 on a live gameweek — the live path is reading a settled field",
    ).toBe(body.fixtures.length);

    // And the per-manager breakdown must carry real numbers too, not just the totals.
    const everyPlayer = body.fixtures.flatMap(
      (f: { homePlayers: { fplScore: number }[]; awayPlayers: { fplScore: number }[] }) => [
        ...f.homePlayers,
        ...f.awayPlayers,
      ],
    );
    expect(everyPlayer.length).toBeGreaterThan(0);
    expect(
      everyPlayer.some((p: { fplScore: number }) => p.fplScore > 0),
      "no manager in the whole gameweek scored a point",
    ).toBe(true);
  });

  test("refresh and live agree on every score (one shared scorer)", async ({ request }) => {
    // This is the regression guard for the two implementations that had
    // drifted: /live used entry_history.points while /refresh recomputed from
    // /event/{gw}/live/ with a vice-captain fallback, so the number could
    // change just by clicking Refresh.
    const [liveRes, refreshRes] = await Promise.all([
      request.get(`/api/fixtures/live?gameweek=1&leagueSlug=${encodeURIComponent(league.slug)}`),
      request.get(
        `/api/fixtures/live/refresh?gameweek=1&leagueSlug=${encodeURIComponent(league.slug)}`,
      ),
    ]);
    expect(liveRes.ok()).toBeTruthy();
    expect(refreshRes.ok()).toBeTruthy();

    const live = await liveRes.json();
    const refresh = await refreshRes.json();

    const byId = new Map<string, { homeScore: number; awayScore: number }>(
      (refresh.fixtures ?? []).map((f: { fixtureId: string; homeScore: number; awayScore: number }) => [
        f.fixtureId,
        { homeScore: f.homeScore, awayScore: f.awayScore },
      ]),
    );

    expect(byId.size).toBeGreaterThan(0);
    for (const f of live.fixtures) {
      const r = byId.get(f.fixtureId);
      expect(r, `fixture ${f.fixtureId} missing from refresh payload`).toBeTruthy();
      expect(r!.homeScore, `home score drift on ${f.fixtureId}`).toBe(f.homeScore);
      expect(r!.awayScore, `away score drift on ${f.fixtureId}`).toBe(f.awayScore);
    }
  });

  test("refresh refuses to run without a leagueSlug", async ({ request }) => {
    // Resolving a gameweek by number alone picked an arbitrary league's row,
    // so a refresh could return a different league's fixtures.
    const res = await request.get("/api/fixtures/live/refresh?gameweek=1", {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });

  test("a not-yet-started gameweek is not live", async ({ request }) => {
    const res = await request.get(
      `/api/fixtures/live?gameweek=2&leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    const body = await res.json();
    expect(body.isLive).toBe(false);
    expect(body.reason).toBe("deadline_not_passed");
  });

  test("the standings table folds the live gameweek in", async ({ request }) => {
    // The table used to sit on the last processed gameweek while the fixtures tab beside it
    // showed live scores, because scoring is triggered by hand.
    await warmLiveCache(request);
    const settledRes = await request.get(
      `/api/standings?leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    expect(settledRes.ok()).toBeTruthy();
    const live = await settledRes.json();

    expect(live.isLive, "GW1 is in flight, so the table is provisional").toBe(true);
    expect(live.liveGameweek).toBe(1);
    expect(typeof live.liveCachedAt).toBe("string");

    const rows = [...(live.groupA ?? []), ...(live.groupB ?? [])];
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.some((r: { played: number }) => r.played > 0),
      "every team should have played the live gameweek",
    ).toBe(true);
    expect(
      rows.some((r: { leaguePoints: number }) => r.leaguePoints > 0),
      "a live gameweek with real scores must move somebody's points",
    ).toBe(true);
  });

  test("processing the gameweek replaces the provisional table with the settled one", async ({
    request,
  }) => {
    // The overlay only ever folds in fixtures with NO result row, which is what makes an admin's
    // processing win without any coordination between the two paths. Score the gameweek and the
    // live numbers must give way to the real ones.
    await warmLiveCache(request);
    const beforeRes = await request.get(
      `/api/standings?leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    expect((await beforeRes.json()).isLive, "provisional before scoring").toBe(true);

    await scoreGameweek(league.id, 1, () => ({ home: 120, away: 60 }));

    const afterRes = await request.get(
      `/api/standings?leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    const after = await afterRes.json();

    // `isLive` is derived from whether any fixture still lacks a result, so it is the honest
    // signal that the overlay has stood down. The row numbers are deliberately NOT asserted
    // here: this harness writes results straight to the database and never calls
    // `invalidateLeaguePageCache`, so `computeLeagueStageStandings` legitimately still serves
    // its 10-minute rows cache. Real scoring goes through the API, which does invalidate.
    expect(after.isLive, "nothing is in flight once every fixture has a result").toBe(false);
    expect(after.liveGameweek).toBeNull();
    expect(after.liveCachedAt).toBeNull();
  });

  test("the standings page marks itself live rather than quietly showing provisional numbers", async ({
    page,
    request,
  }) => {
    // Scoring above retired the live gameweek, so put one back in flight for the UI check.
    await expireGameweek(league.id, 2);
    await setStubLiveGw(request, 2);
    const warm = await request.get(
      `/api/fixtures/live?gameweek=2&leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    expect(warm.ok()).toBeTruthy();

    await page.goto(`/${league.slug}/standings`);

    await expect(page.getByTestId("standings-live-badge")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Gameweek \d+ in progress/)).toBeVisible();
    await expect(page.getByText(/Provisional/)).toBeVisible();
  });

  test.afterAll(async ({ request }) => {
    // Leave the stub neutral so spec order cannot leak state.
    await setStubLiveGw(request, null).catch(() => {});
  });
});
