/**
 * The dashboard's PL Fixture card endpoint.
 *
 * Covers the behaviours that were wrong or missing before: which gameweek it
 * defaults to, which gameweek the FPL links point at, and that a team can
 * only ever see its own fixture.
 *
 * Run with: npm run test:e2e -- tests/league-types/pl-fixture-card.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignInTeam,
  apiSignOut,
  createTvtLeague,
  generateFixtures,
  setupAllTeams,
  ensureGameweeks,
  expireGameweek,
  type LeagueRef,
} from "../harness";

let league: LeagueRef;

async function card(request: APIRequestContext, gw?: number) {
  const url = gw ? `/api/team/dashboard/pl-fixture?gw=${gw}` : "/api/team/dashboard/pl-fixture";
  const res = await request.get(url);
  expect(res.ok(), `pl-fixture returned ${res.status()}`).toBeTruthy();
  return res.json();
}

test.describe.serial("dashboard PL fixture card (TVT)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);
    await apiSignOut(request);
  });

  test("requires a team session", async ({ request }) => {
    const res = await request.get("/api/team/dashboard/pl-fixture", { failOnStatusCode: false });
    expect(res.status()).toBe(401);
  });

  test("defaults to the upcoming gameweek before anything has started", async ({ request }) => {
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } });
    await apiSignInTeam(request, league.slug, 1);

    const body = await card(request);
    expect(body.gw).toBe(1);
    expect(body.isLive).toBe(false);
    expect(body.fixture).toBeTruthy();
    expect(body.availableGws.length).toBeGreaterThan(1);
    await apiSignOut(request);
  });

  test("switches to the live gameweek once it is in flight", async ({ request }) => {
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: 1 } });
    await expireGameweek(league.id, 1);
    await apiSignInTeam(request, league.slug, 1);

    const body = await card(request);
    expect(body.gw).toBe(1);
    expect(body.isLive).toBe(true);
    await apiSignOut(request);
  });

  test("links point at the latest STARTED gameweek, even when viewing a later one", async ({ request }) => {
    // GW1 is live, so links must stay on GW1 while the user pages to GW2 —
    // FPL cannot render /event/2 before GW2's deadline has passed.
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: 1 } });
    await expireGameweek(league.id, 1);
    await apiSignInTeam(request, league.slug, 1);

    const viewingGw2 = await card(request, 2);
    expect(viewingGw2.gw).toBe(2);
    expect(viewingGw2.linkGw).toBe(1);
    for (const side of [viewingGw2.fixture.home, viewingGw2.fixture.away]) {
      for (const p of side.players) {
        expect(p.fplUrl).toContain("/event/1");
        // The old bug: gw 0 fell through to a /history URL.
        expect(p.fplUrl).not.toContain("/history");
      }
    }
    await apiSignOut(request);
  });

  test("carries TVT chip state for both sides, without leaking pending declarations", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const body = await card(request, 2);

    for (const side of [body.fixture.home, body.fixture.away]) {
      expect(side.tvtChips).toBeTruthy();
      // Only used/available booleans — never which chip the opponent has
      // declared for an upcoming gameweek.
      expect(Object.keys(side.tvtChips).sort()).toEqual(
        ["challengeChip", "doublePointer", "set", "winWin"],
      );
      expect(typeof side.tvtChips.doublePointer).toBe("boolean");
    }
    await apiSignOut(request);
  });

  test("a team only ever sees its own fixture", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const mine = await card(request, 3);
    await apiSignOut(request);

    await apiSignInTeam(request, league.slug, 2);
    const theirs = await card(request, 3);
    await apiSignOut(request);

    const ids = [mine.fixture.home.teamId, mine.fixture.away.teamId];
    const otherIds = [theirs.fixture.home.teamId, theirs.fixture.away.teamId];
    // Different teams, so at least one side must differ.
    expect(ids.join()).not.toBe(otherIds.join());
  });

  test.afterAll(async ({ request }) => {
    await request
      .post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } })
      .catch(() => {});
  });
});
