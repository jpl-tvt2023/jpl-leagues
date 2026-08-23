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

  test("players-left rides along in the live payload and is non-zero mid-gameweek", async ({ request }) => {
    const res = await request.get(
      `/api/fixtures/live?gameweek=1&leagueSlug=${encodeURIComponent(league.slug)}`,
    );
    const body = await res.json();
    const fx = body.fixtures[0];

    // The stub marks half of a live GW's fixtures as still to come, so both
    // sides should have players yet to feature.
    expect(fx.homePlayersLeft, "homePlayersLeft should be present").toBeTruthy();
    expect(fx.awayPlayersLeft, "awayPlayersLeft should be present").toBeTruthy();
    expect(fx.homePlayersLeft.total).toBeGreaterThan(0);
    expect(fx.homePlayersLeft.leftToPlay).toBeGreaterThan(0);
    expect(fx.homePlayersLeft.leftToPlay).toBeLessThanOrEqual(fx.homePlayersLeft.total);
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

  test.afterAll(async ({ request }) => {
    // Leave the stub neutral so spec order cannot leak state.
    await setStubLiveGw(request, null).catch(() => {});
  });
});
