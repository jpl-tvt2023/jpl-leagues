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
  createContinentalChampionshipLeague,
  generateFixtures,
  setupAllTeams,
  ensureGameweeks,
  expireGameweek,
  expectPageLoads,
  testDb,
  schema,
  type LeagueRef,
} from "../harness";
import { and, eq } from "drizzle-orm";

/** A gameweek far enough out that beforeAll has not expired it. */
const FUTURE_GW = 6;

/**
 * Captaincies allowed per manager across the League Stage: ceil((playoffStartGw - 1) / 2).
 * This spec's league has 8 teams, which defaults to playoffStartGw 36 -> 18. A 16- or
 * 32-team league starts playoffs at GW31 and gets 15.
 */
const CAPTAIN_CAP = 18;

interface ChipSlot {
  code: string;
  displayCode: string;
  set: 1 | 2;
  used: boolean;
  gw: number | null;
  wasted: boolean;
}
interface TeamStat {
  teamId: string;
  teamName: string;
  group: string | null;
  chips: ChipSlot[] | null;
  captains: { playerId: string; playerName: string; used: number; cap: number }[];
}
interface StatsPayload {
  rows: { teamId: string }[];
  teams: TeamStat[];
  groupNames: string[];
  groupsRevealed: boolean;
  hasHiddenGroups: boolean;
  chipsSupported: boolean;
  currentSet: 1 | 2 | "playoffs" | null;
}

/** A plain (non-warming) read — team stats are DB-sourced and never pend. */
async function statsFor(request: APIRequestContext, slug: string): Promise<StatsPayload> {
  const res = await request.get(`/api/fpl-league?leagueSlug=${encodeURIComponent(slug)}`);
  expect(res.ok(), `fpl-league returned ${res.status()}`).toBeTruthy();
  return res.json();
}

async function gwId(leagueId: string, number: number): Promise<string> {
  const db = testDb();
  const [row] = await db
    .select({ id: schema.gameweeks.id })
    .from(schema.gameweeks)
    .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, number)));
  return row.id;
}

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

  /* ── team-level stats ────────────────────────────────────────────────── */

  test("carries one stat block per team, alphabetical, with a full chip grid", async ({ request }) => {
    const stats = await statsFor(request, league.slug);

    expect(stats.teams.length).toBe(league.teamSize);
    expect(stats.chipsSupported).toBe(true);
    expect(stats.currentSet).toBe(1);

    const names = stats.teams.map((t) => t.teamName);
    expect(names, "teams are ordered alphabetically").toEqual(
      [...names].sort((a, b) => a.localeCompare(b)),
    );

    for (const team of stats.teams) {
      // 3 enabled chips x 2 sets. Nothing has been played yet, so all six read available.
      expect(team.chips, `${team.teamName} has no chip grid`).not.toBeNull();
      expect(team.chips!.length).toBe(6);
      expect(team.chips!.every((c) => !c.used && c.gw === null)).toBeTruthy();
      expect(team.captains.length, `${team.teamName} should have 2 managers`).toBe(2);
      // An 8-team league runs its League Stage to GW35 (playoffStartGw 36), so the captaincy
      // cap is ceil(35/2) = 18 — not the 15 a 16/32-team league gets.
      expect(team.captains.every((c) => c.cap === CAPTAIN_CAP && c.used === 0)).toBeTruthy();
    }
  });

  test("every manager row belongs to a team in the stats block", async ({ request }) => {
    const body = await statsFor(request, league.slug);
    const known = new Set(body.teams.map((t) => t.teamId));
    for (const row of body.rows) {
      expect(known.has(row.teamId), `orphan row for team ${row.teamId}`).toBeTruthy();
    }
  });

  test("a chip declared for a still-open gameweek is NOT disclosed", async ({ request }) => {
    const db = testDb();
    const before = await statsFor(request, league.slug);
    const team = before.teams[0];

    // A live declaration whose deadline has not passed. The row exists the moment a team
    // submits, so this is exactly the state the gate has to withhold.
    await db.insert(schema.gameweekChips).values({
      id: `chip-open-${Date.now()}`,
      teamId: team.teamId,
      gameweekId: await gwId(league.id, FUTURE_GW),
      chipType: "D",
      isValid: true,
      isProcessed: false,
    });
    // And one that was rejected and never played, on an already-expired gameweek — showing it
    // would tell the league a team spent something it did not.
    await db.insert(schema.gameweekChips).values({
      id: `chip-rejected-${Date.now()}`,
      teamId: team.teamId,
      gameweekId: await gwId(league.id, 2),
      chipType: "W",
      isValid: false,
      isProcessed: false,
    });

    const after = await statsFor(request, league.slug);
    const mine = after.teams.find((t) => t.teamId === team.teamId)!;
    const dp = mine.chips!.find((c) => c.code === "D" && c.set === 1)!;
    const ww = mine.chips!.find((c) => c.code === "W" && c.set === 1)!;

    expect(dp.used, "an open-gameweek declaration must not read as spent").toBe(false);
    expect(dp.gw, "and must not name the gameweek it is queued for").toBeNull();
    expect(ww.used, "a rejected declaration must never show").toBe(false);
    expect(JSON.stringify(mine)).not.toContain(`"gw":${FUTURE_GW}`);
  });

  test("once the deadline passes the chip IS disclosed — with no cache invalidation", async ({ request }) => {
    await expireGameweek(league.id, FUTURE_GW);
    // Deliberately no invalidation: the gate runs at read time. If this payload is ever
    // cached, a warm cache would keep the chip hidden and this assertion is what catches it.
    const stats = await statsFor(request, league.slug);
    const dp = stats.teams
      .flatMap((t) => t.chips ?? [])
      .find((c) => c.code === "D" && c.set === 1 && c.used);

    expect(dp, "the now-expired chip should be disclosed").toBeTruthy();
    expect(dp!.gw).toBe(FUTURE_GW);
    expect(dp!.wasted).toBe(false);
  });

  test("captaincies are counted from announcements, and gated on the deadline too", async ({ request }) => {
    const db = testDb();
    const before = await statsFor(request, league.slug);
    const target = before.teams.find((t) => t.captains.length === 2)!;
    const player = target.captains[0];

    // GW1-3 are expired by beforeAll; GW7 is not.
    for (const gw of [1, 2, 3, 7]) {
      await db.insert(schema.gameweekCaptains).values({
        id: `cap-${gw}-${Date.now()}`,
        gameweekId: await gwId(league.id, gw),
        playerId: player.playerId,
      });
    }

    const gated = await statsFor(request, league.slug);
    const counted = gated.teams
      .find((t) => t.teamId === target.teamId)!
      .captains.find((c) => c.playerId === player.playerId)!;
    expect(counted.used, "GW7 is still open, so it must not be counted publicly").toBe(3);
    expect(counted.cap).toBe(CAPTAIN_CAP);

    await expireGameweek(league.id, 7);
    const after = await statsFor(request, league.slug);
    const now = after.teams
      .find((t) => t.teamId === target.teamId)!
      .captains.find((c) => c.playerId === player.playerId)!;
    expect(now.used).toBe(4);
  });

  test("a single-group league reports its group without a reveal gate", async ({ request }) => {
    // An 8-team TVT league defaults to groupCount 1, so there is nothing to withhold: one
    // group is not a grouping. Only 32-team leagues default to two.
    const stats = await statsFor(request, league.slug);
    expect(stats.hasHiddenGroups).toBe(false);
    expect(stats.groupNames).toEqual(["A"]);
    expect(stats.teams.every((t) => t.group === "A")).toBeTruthy();
  });

  test("with two groups, assignments are withheld until the admin reveals them", async ({ request }) => {
    const db = testDb();
    // Split the league in two rather than standing up a 32-team one: this exercises the same
    // branch for a fraction of the ~90s a second league costs under workers:1.
    const groupBId = `grp-b-${Date.now()}`;
    await db.insert(schema.groups).values({ id: groupBId, name: "B", leagueId: league.id });
    const teamRows = await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.leagueId, league.id));
    for (const t of teamRows.slice(0, 4)) {
      await db.update(schema.teams).set({ groupId: groupBId }).where(eq(schema.teams.id, t.id));
    }

    const before = await statsFor(request, league.slug);
    expect(before.groupsRevealed).toBe(false);
    expect(before.hasHiddenGroups).toBe(true);
    expect(before.groupNames).toEqual([]);
    // The route is public, so hiding this client-side would not be hiding it at all — the
    // assertion is against the raw payload, which anyone can read.
    for (const team of before.teams) {
      expect(team.group, `${team.teamName} leaked its group before reveal`).toBeNull();
    }

    await apiSignInSuperadmin(request);
    const res = await request.post(`/api/admin/${league.id}/settings`, {
      data: { key: "groupsRevealed", value: true },
    });
    expect(res.ok(), `settings returned ${res.status()}`).toBeTruthy();
    await apiSignOut(request);

    const after = await statsFor(request, league.slug);
    expect(after.groupsRevealed).toBe(true);
    expect(after.hasHiddenGroups).toBe(false);
    expect(after.groupNames).toEqual(["A", "B"]);
    expect(after.teams.filter((t) => t.group === "B").length).toBe(4);
    expect(after.teams.filter((t) => t.group === "A").length).toBe(4);
  });

  test("the page renders team rows, both group tables, and fits a phone", async ({ page }) => {
    // Runs after the two-group test above, so groups are split and revealed by now.
    await expectPageLoads(page, `/${league.slug}/fpl-league`);
    await expect(page.getByRole("heading", { name: "FPL League" })).toBeVisible();

    await expect(page.getByText("Group A", { exact: true })).toBeVisible();
    await expect(page.getByText("Group B", { exact: true })).toBeVisible();

    // A team banner row, with its TVT chip sets labelled so they cannot be read as FPL chips.
    await expect(page.getByText("Team 1", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Set 1", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Set 2", { exact: true }).first()).toBeVisible();

    // The header row adds no columns, so the table must still fit a phone without the page
    // scrolling sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".overflow-x-auto")].map(
        (el) => el.scrollWidth - el.clientWidth,
      ),
    );
    expect(Math.max(0, ...overflow), "the table overflows a 390px screen").toBeLessThanOrEqual(1);
  });

  test.afterAll(async ({ request }) => {
    await request
      .post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } })
      .catch(() => {});
  });
});

/**
 * Continental Championship is the format most likely to be got wrong here, for two reasons
 * that only exist once cup groups are generated: teams' `groupId` is REASSIGNED to a cup
 * group (so a naive join splits the page into Cup-A…Cup-D), and Ghost teams appear carrying
 * a group but no players (so they would render as empty team rows). Neither is reachable
 * from a TVT league, which is why this pays for its own league.
 */
test.describe.serial("FPL League (Continental Championship)", () => {
  let ccLeague: LeagueRef;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await apiSignInSuperadmin(request);
    ccLeague = await createContinentalChampionshipLeague(request);
    await setupAllTeams(request, ccLeague.slug, ccLeague.teamSize, "continental-championship");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(ccLeague.id);
    // The reassignment + Ghost teams only exist after this runs.
    const res = await request.post(`/api/admin/${ccLeague.slug}/generate-cup-groups`, { data: {} });
    expect(res.ok(), `generate-cup-groups returned ${res.status()}`).toBeTruthy();
    await apiSignOut(request);
  });

  test("carries captaincies but no chip grid, and is never split by cup group", async ({ request }) => {
    const stats = await statsFor(request, ccLeague.slug);

    expect(stats.chipsSupported, "Continental Championship has no TVT chips").toBe(false);
    expect(stats.teams.every((t) => t.chips === null)).toBeTruthy();

    // Cup groups must not leak into the page's grouping — otherwise this reads Cup-A..Cup-D.
    expect(stats.groupNames.some((g) => g.toLowerCase().startsWith("cup"))).toBe(false);
    expect(stats.teams.every((t) => !t.group?.toLowerCase().startsWith("cup"))).toBeTruthy();

    // Its League Stage runs all 38 gameweeks, so the cap is ceil(38/2) = 19, not TVT's 15.
    expect(stats.teams.every((t) => t.captains.every((c) => c.cap === 19))).toBeTruthy();
  });

  test("Ghost teams are excluded — every team row has managers behind it", async ({ request }) => {
    const stats = await statsFor(request, ccLeague.slug);
    expect(stats.teams.length).toBe(ccLeague.teamSize);
    for (const team of stats.teams) {
      expect(team.captains.length, `${team.teamName} has no managers`).toBeGreaterThan(0);
    }
  });
});
