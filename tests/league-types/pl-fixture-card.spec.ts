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
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { testDb, schema } from "../harness";
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

/** Requests the stub has served, bucketed by route shape. */
async function stubCounts(request: APIRequestContext): Promise<Record<string, number>> {
  const res = await request.get("/api/test-fpl-stub/control");
  return ((await res.json()).counts ?? {}) as Record<string, number>;
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

  test("both sides report players-left, without duplicating the shared FPL lookups", async ({ request }) => {
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: 1 } });
    await expireGameweek(league.id, 1);
    await apiSignInTeam(request, league.slug, 1);

    await request.post("/api/test-fpl-stub/control", { data: { resetCounts: true } });
    const body = await card(request, 1);

    // The bug this guards: both sides were scored concurrently, so each missed
    // the fixtures cache and issued its own request. The duplicate pushed the
    // card past its FPL budget, and a budget refusal is converted to null by
    // playersLeftFor — so the away side silently rendered "—" while the home
    // side, which won the race, rendered fine.
    expect(body.fixture.home.playersLeft, "home players-left").not.toBeNull();
    expect(body.fixture.away.playersLeft, "away players-left").not.toBeNull();

    // Asserting on call COUNT rather than on the rendered value: the symptom was
    // a missing number, but the cause was a duplicated fetch, and only this
    // catches a regression that re-introduces the duplication while staying
    // under budget. The season fixtures list is identical for both sides, and
    // the two sides are scored concurrently, so one fetch must serve both.
    //
    // Deliberately not asserting on bootstrap-static. The route legitimately
    // reads it twice on a cold cache — once via getFinishedGwNumbers early in
    // the request, once via fetchElementInfo during scoring — and those are
    // sequential, so no amount of single-flighting can merge them. Bridging
    // sequential callers is the Redis cache's job, not this test's.
    const counts = await stubCounts(request);
    expect(counts["fixtures"] ?? 0, "season fixtures list is the same for both sides").toBeLessThanOrEqual(1);

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
      // Only spent/available state — never which chip the opponent has declared for an
      // upcoming gameweek.
      expect(Object.keys(side.tvtChips).sort()).toEqual(
        ["enabled", "set", "spent", "usedGws"],
      );
      // Driven by the league's own chips, not a fixed D/C/W trio.
      expect(side.tvtChips.enabled.sort()).toEqual(["C", "D", "W"]);
      expect(Array.isArray(side.tvtChips.spent)).toBe(true);
      // Nothing may be reported spent that the league does not even run.
      for (const code of side.tvtChips.spent) {
        expect(side.tvtChips.enabled).toContain(code);
      }
    }
    await apiSignOut(request);
  });

  test("a chip declared for a gameweek that has not started is not disclosed", async ({ request }) => {
    // The payload describes BOTH sides of the fixture, so anything it says
    // about a chip is visible to the opponent. A gameweek_chips row exists from
    // the moment a chip is declared, which can be long before that gameweek's
    // deadline — publishing its gameweek would let a team read their opponent's
    // Double Pointer before choosing their own captain.
    //
    // Written straight to the table on purpose: going through POST /api/team/chips
    // would be stopped by the submission gate, which tests the write path. The
    // filter under test here is on the read path, and it is team-agnostic, so
    // proving it for a team's own side proves it for the opponent's.
    const db = testDb();
    const [futureGw] = await db
      .select({ id: schema.gameweeks.id, number: schema.gameweeks.number })
      .from(schema.gameweeks)
      .where(
        and(
          eq(schema.gameweeks.leagueId, league.id),
          gt(schema.gameweeks.deadline, new Date()),
        ),
      )
      .orderBy(asc(schema.gameweeks.number))
      .limit(1);
    expect(futureGw, "the league needs at least one gameweek still to come").toBeTruthy();

    const myTeam = await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.leagueId, league.id))
      .limit(1);

    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      teamId: myTeam[0].id,
      gameweekId: futureGw.id,
      chipType: "W",
      isValid: true,
    });

    await apiSignInTeam(request, league.slug, 1);
    const body = await card(request, futureGw.number);

    for (const side of [body.fixture.home, body.fixture.away]) {
      expect(
        side.tvtChips.usedGws.some((u: { gw: number }) => u.gw === futureGw.number),
        `${side.name} leaked a chip declared for the not-yet-started GW${futureGw.number}`,
      ).toBe(false);
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
