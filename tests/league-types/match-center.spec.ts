/**
 * Fixtures page enhancements: the Match Center, the GW stats sidebar, and the bonus highlight.
 *
 * The Match Center's whole value is that its per-player rows explain the fixture score, so the
 * load-bearing assertion here is that its team total equals the live fixture score for the same
 * fixture — computed by a different route from the same caches.
 *
 * Run with: npx playwright test tests/league-types/match-center.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  apiSignInSuperadmin,
  createTvtLeague,
  generateFixtures,
  setupAllTeams,
  ensureGameweeks,
  expireGameweek,
  invalidateLeagueCache,
  setFixtureResult,
  testDb,
  schema,
  type LeagueRef,
} from "../harness";

let league: LeagueRef;

/** MC_SHOTS=1 also saves full-page screenshots for a visual review, as MOBILE_SHOTS does. */
const SHOTS = process.env.MC_SHOTS === "1";
const SHOT_DIR = path.join("test-results", "mc-shots");

interface Fx {
  id: string;
  homeTeam: { id: string; name: string };
  awayTeam: { id: string; name: string };
}

async function fixturesFor(request: APIRequestContext, gw: number): Promise<Fx[]> {
  const res = await request.get(`/api/fixtures?leagueSlug=${encodeURIComponent(league.slug)}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.fixtures[gw] as Fx[];
}

async function liveScores(request: APIRequestContext) {
  const res = await request.get(`/api/fixtures/live?gameweek=1&leagueSlug=${encodeURIComponent(league.slug)}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.isLive, `GW1 should be live, got reason=${body.reason}`).toBe(true);
  return body.fixtures as { fixtureId: string; homeScore: number; awayScore: number; homeTeamId: string; awayTeamId: string }[];
}

async function matchCenter(request: APIRequestContext, query: Record<string, string>) {
  const qs = new URLSearchParams({ leagueSlug: league.slug, ...query });
  const res = await request.get(`/api/match-center?${qs.toString()}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

test.describe.serial("Match Center, GW stats and bonus highlight (TVT)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);

    // GW1 in flight; GW2 still ahead.
    await expireGameweek(league.id, 1);
    const res = await request.post("/api/test-fpl-stub/control", { data: { liveGw: 1, finishedThrough: 0 } });
    expect(res.ok()).toBeTruthy();
  });

  test("Match Center total equals the live fixture score, and rows reconcile to it", async ({ request }) => {
    const [fx] = await fixturesFor(request, 1);
    const live = (await liveScores(request)).find((l) => l.fixtureId === fx.id)!;
    const body = await matchCenter(request, { fixtureId: fx.id });

    expect(body.gameweek.started).toBe(true);
    expect(body.a.teamId).toBe(fx.homeTeam.id);
    expect(body.b.teamId).toBe(fx.awayTeam.id);
    expect(body.fixture?.id).toBe(fx.id);

    for (const [side, expected] of [[body.a, live.homeScore], [body.b, live.awayScore]] as const) {
      expect(side.sheet, `${side.teamName} should have a sheet`).toBeTruthy();
      expect(side.sheet.managers).toHaveLength(2);
      expect(side.displayTotal, `${side.teamName}: Match Center vs fixture live score`).toBe(expected);

      // Exactly one JPL captain, and every row's multiplier is the sum of its owners'.
      expect(side.sheet.managers.filter((m: { isJplCaptain: boolean }) => m.isJplCaptain)).toHaveLength(1);
      const rows = [...side.sheet.rows, ...side.sheet.bench];
      for (const r of rows) {
        const sum = r.owners.reduce((s: number, o: { effective: number }) => s + o.effective, 0);
        expect(r.multiplier).toBe(sum);
        expect(r.contribution).toBe(r.points * r.multiplier);
      }
      // Rows (gross) minus hits, with the JPL captain's hits doubled, is the team total.
      const contributions = rows.reduce((s: number, r: { contribution: number }) => s + r.contribution, 0);
      const hits = side.sheet.managers.reduce(
        (s: number, m: { hits: number; isJplCaptain: boolean }) => s + m.hits * (m.isJplCaptain ? 2 : 1),
        0,
      );
      expect(contributions - hits).toBe(side.sheet.total);
    }
  });

  test("any two teams can be compared, each scored from its own fixture", async ({ request }) => {
    const fixtures = await fixturesFor(request, 1);
    const [f1, f2] = fixtures;
    const live = await liveScores(request);
    const body = await matchCenter(request, { gw: "1", a: f1.homeTeam.id, b: f2.homeTeam.id });

    expect(body.fixture, "these two did not meet").toBeNull();
    expect(body.a.displayTotal).toBe(live.find((l) => l.fixtureId === f1.id)!.homeScore);
    expect(body.b.displayTotal).toBe(live.find((l) => l.fixtureId === f2.id)!.homeScore);
    expect(body.comparison).toBeTruthy();
  });

  test("before the deadline nothing strategic is disclosed", async ({ request }) => {
    const [fx] = await fixturesFor(request, 2);
    const res = await request.get(
      `/api/match-center?leagueSlug=${encodeURIComponent(league.slug)}&fixtureId=${fx.id}`,
    );
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body.gameweek.started).toBe(false);
    expect(body.a.sheet).toBeNull();
    expect(body.b.sheet).toBeNull();
    expect(body.a.tvtChip).toBeNull();
    expect(raw, "no captain field may appear before the deadline").not.toContain("isJplCaptain");
    expect(body.a.roster).toHaveLength(2);
  });

  test("fixture card links to the Match Center, and the picker updates the URL", async ({ page, request }) => {
    const fixtures = await fixturesFor(request, 1);
    const fx = fixtures[0];
    const other = fixtures[1];

    await page.goto(`/${league.slug}/fixtures`);
    await page.getByTestId(`match-center-link-${fx.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/fixtures/${fx.id}\\?gw=1&a=${fx.homeTeam.id}&b=${fx.awayTeam.id}`));

    // The team names ARE the pickers, so assert the selected value — text matching would hit
    // every <option> in the list.
    await expect(page.getByLabel("First team")).toHaveValue(fx.homeTeam.id);
    await expect(page.getByLabel("Second team")).toHaveValue(fx.awayTeam.id);
    await expect(page.getByTestId("mc-side-a")).toBeVisible();
    await expect(page.getByTestId("mc-side-b")).toBeVisible();
    await expect(page.getByTestId("mc-side-a").locator("[data-testid^='mc-row-']").first()).toBeVisible();
    await expect(page.getByTestId("mc-swing")).toBeVisible();

    // Playing XI is ordered by points, high to low, and comes before the bench.
    const rows = await page
      .getByTestId("mc-side-a")
      .locator("[data-testid^='mc-row-']")
      .evaluateAll((els) => els.map((r) => [r.getAttribute("data-section"), Number(r.getAttribute("data-points"))] as const));
    const xiPoints = rows.filter(([section]) => section === "xi").map(([, pts]) => pts);
    expect(xiPoints.length).toBeGreaterThanOrEqual(11);
    expect(xiPoints, "XI sorted by points, high to low").toEqual([...xiPoints].sort((x, y) => y - x));
    const firstBench = rows.findIndex(([section]) => section === "bench");
    if (firstBench >= 0) {
      expect(rows.slice(firstBench).every(([section]) => section === "bench"), "bench rows come last").toBe(true);
    }

    await page.getByLabel("Second team").selectOption(other.awayTeam.id);
    await expect(page).toHaveURL(new RegExp(`b=${other.awayTeam.id}`));
    await expect(page.getByLabel("Second team")).toHaveValue(other.awayTeam.id);
    await expect(page.getByTestId("mc-header")).toContainText("Comparison only");
  });

  test("phone: one squad at a time behind team tabs", async ({ page, request }) => {
    const [fx] = await fixturesFor(request, 1);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/${league.slug}/fixtures/${fx.id}`);

    const tabs = page.getByRole("tablist", { name: "Choose team" });
    await expect(tabs).toBeVisible();
    await expect(page.getByTestId("mc-side-a")).toBeVisible();
    await expect(page.getByTestId("mc-side-b")).toBeHidden();

    await tabs.getByRole("tab").nth(1).click();
    await expect(page.getByTestId("mc-side-b")).toBeVisible();
    await expect(page.getByTestId("mc-side-a")).toBeHidden();
  });

  test("stats endpoint covers every manager, with transfers", async ({ request }) => {
    let body: { status: string; managers: unknown[]; picksComplete: boolean; transfersComplete: boolean } | null = null;
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/fixtures/stats?leagueSlug=${encodeURIComponent(league.slug)}&gameweek=1`);
          if (res.status() !== 200) return res.status();
          body = await res.json();
          return 200;
        },
        { timeout: 60_000, intervals: [2000] },
      )
      .toBe(200);
    expect(body!.status).toBe("ok");
    expect(body!.managers).toHaveLength(league.teamSize * 2);
    expect(body!.picksComplete).toBe(true);
    expect(body!.transfersComplete).toBe(true);

    const upcoming = await request.get(`/api/fixtures/stats?leagueSlug=${encodeURIComponent(league.slug)}&gameweek=2`);
    expect((await upcoming.json()).status).toBe("upcoming");
  });

  test("wide screen: fixtures and stats side by side, and an entry drills down", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/${league.slug}/fixtures`);
    const fixtures = page.getByRole("region", { name: "Fixtures" });
    const stats = page.getByTestId("gw-stats-panel");
    await expect(stats.getByTestId("stat-captained").getByRole("button").first()).toBeVisible();

    const f = (await fixtures.boundingBox())!;
    const s = (await stats.boundingBox())!;
    expect(s.x, "stats to the right of the fixtures").toBeGreaterThanOrEqual(f.x + f.width - 1);
    expect(Math.abs(s.y - f.y), "both sections start on the same row").toBeLessThan(5);

    // Most owned and most captained share the first row of the stats grid.
    const owned = (await stats.getByTestId("stat-owned").boundingBox())!;
    const captained = (await stats.getByTestId("stat-captained").boundingBox())!;
    expect(Math.abs(owned.y - captained.y)).toBeLessThan(2);
    expect(captained.x).toBeGreaterThan(owned.x);

    await stats.getByTestId("stat-captained").getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toContainText("captained by");
  });

  test("phone: Fixtures | Stats switch shows one section at a time", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/${league.slug}/fixtures`);
    const switcher = page.getByRole("tablist", { name: "Fixtures or stats" });
    await expect(switcher).toBeVisible();
    await expect(page.getByRole("region", { name: "Fixtures" })).toBeVisible();
    await expect(page.getByTestId("gw-stats-panel")).toBeHidden();

    await switcher.getByRole("tab", { name: /Stats/ }).click();
    await expect(page.getByTestId("gw-stats-panel")).toBeVisible();
    await expect(page.getByRole("region", { name: "Fixtures" })).toBeHidden();
    await expect(page.getByTestId("stat-captained").getByRole("button").first()).toBeVisible();
  });

  test("a bonus win is highlighted with its value", async ({ page, request }) => {
    const [fx] = await fixturesFor(request, 1);
    await setFixtureResult({ fixtureId: fx.id, homeScore: 180, awayScore: 90, homeTeamId: fx.homeTeam.id });
    await testDb()
      .update(schema.results)
      .set({ homeGotBonus: true, homeUsedDoublePointer: true })
      .where(and(eq(schema.results.fixtureId, fx.id)));
    await invalidateLeagueCache(league.id);

    await page.goto(`/${league.slug}/fixtures`);
    const card = page.getByTestId(`fixture-card-${fx.id}`);
    await expect(card).toHaveAttribute("data-bonus", "true");
    await expect(card.getByTestId("bonus-pill")).toHaveText("★ BONUS +2");
  });

  test("TVT chips show the league points they gained: green above 0, red at 0", async ({ page, request }) => {
    const db = testDb();
    const [gw1] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, league.id), eq(schema.gameweeks.number, 1))).limit(1);
    const [fx, fx2] = await fixturesFor(request, 1);
    // fx: home won by 90 and took the group bonus on Double Pointer. fx2: home lost, away won.
    await setFixtureResult({ fixtureId: fx.id, homeScore: 180, awayScore: 90, homeTeamId: fx.homeTeam.id });
    await db.update(schema.results)
      .set({ homeGotBonus: true, homeUsedDoublePointer: true, homeMatchPoints: 4 })
      .where(eq(schema.results.fixtureId, fx.id));
    await setFixtureResult({ fixtureId: fx2.id, homeScore: 100, awayScore: 120, homeTeamId: fx2.homeTeam.id });

    const chip = (teamId: string, chipType: string, over: { pointsAwarded: number; hadNegativeHits?: boolean }) => ({
      id: randomUUID(), gameweekId: gw1.id, teamId, chipType, isValid: true, isProcessed: true, ...over,
    });
    await db.delete(schema.gameweekChips).where(eq(schema.gameweekChips.gameweekId, gw1.id));
    await db.insert(schema.gameweekChips).values([
      // Stored as the scorer stores them: EXTRA points only.
      chip(fx.homeTeam.id, "D", { pointsAwarded: 2 }),
      chip(fx.awayTeam.id, "W", { pointsAwarded: 2 }),
      // Win-Win against transfer hits: spent, voided.
      chip(fx2.homeTeam.id, "W", { pointsAwarded: 0, hadNegativeHits: true }),
      // Win-Win on a win: the win already earned the 2 points, so the chip added none.
      chip(fx2.awayTeam.id, "W", { pointsAwarded: 0 }),
    ]);
    await invalidateLeagueCache(league.id);

    await page.goto(`/${league.slug}/fixtures`);
    const card = page.getByTestId("stat-chips-hits");
    const gain = (teamId: string) => card.getByTestId(`tvt-chip-${teamId}`).getByTestId("tvt-chip-gain");

    // Double Pointer: the win's 2 again, plus the bonus point it doubled.
    await expect(gain(fx.homeTeam.id)).toHaveText("+3", { timeout: 60_000 });
    await expect(gain(fx.homeTeam.id)).toHaveAttribute("data-tone", "gain");
    await expect(gain(fx.homeTeam.id)).toHaveClass(/text-emerald-400/);
    // Win-Win on a loss: 0 → 2.
    await expect(gain(fx.awayTeam.id)).toHaveText("+2");
    await expect(gain(fx.awayTeam.id)).toHaveAttribute("data-tone", "gain");
    // Win-Win on a win: 0, in red, and the row says the match was won — as the standings count it.
    await expect(gain(fx2.awayTeam.id)).toHaveText("0");
    await expect(gain(fx2.awayTeam.id)).toHaveAttribute("data-tone", "none");
    await expect(card.getByTestId(`tvt-chip-${fx2.awayTeam.id}`)).toContainText("match won");
    // Voided: nothing gained, in red.
    await expect(gain(fx2.homeTeam.id)).toHaveText("0");
    await expect(gain(fx2.homeTeam.id)).toHaveAttribute("data-tone", "none");
    await expect(gain(fx2.homeTeam.id)).toHaveClass(/text-rose-400/);
    // Highest gain first.
    await expect(card.getByTestId("tvt-chip-gain").first()).toHaveText("+3");
  });

  test("screenshots for visual review (MC_SHOTS=1)", async ({ page, request }) => {
    test.skip(!SHOTS, "set MC_SHOTS=1 to capture");
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = (name: string) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
    // Whatever the dev overlay would count as an issue, written out for the review.
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`${page.url()} :: ${m.text()}`); });
    page.on("pageerror", (e) => consoleErrors.push(`${page.url()} :: pageerror ${e.message}`));
    const [fx] = await fixturesFor(request, 1);

    for (const width of [1920, 1600, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/${league.slug}/fixtures`);
      await expect(page.getByTestId("stat-captained").getByRole("button").first()).toBeVisible();
      await shot(`fixtures-${width}`);
      // The Chips & hits card alone, at the width it gets beside the fixtures.
      await page.getByTestId("stat-chips-hits").screenshot({ path: path.join(SHOT_DIR, `chips-hits-${width}.png`) });
    }
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/${league.slug}/fixtures`);
    await expect(page.locator("[data-testid^='fixture-card-']").first()).toBeVisible();
    await shot("fixtures-375");
    await page.getByRole("tablist", { name: "Fixtures or stats" }).getByRole("tab", { name: /Stats/ }).click();
    await expect(page.getByTestId("stat-captained").getByRole("button").first()).toBeVisible();
    await shot("fixtures-375-stats");
    await page.getByTestId("stat-chips-hits").screenshot({ path: path.join(SHOT_DIR, "chips-hits-375.png") });

    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${league.slug}/fixtures/${fx.id}`);
      await expect(page.getByTestId("mc-side-a").locator("[data-testid^='mc-row-']").first()).toBeVisible();
      await shot(`match-center-${width}`);
    }
    writeFileSync(path.join(SHOT_DIR, "console-errors.txt"), consoleErrors.join("\n") || "(none)");
  });
});
