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

    await expect(page.getByTestId("mc-header")).toContainText(fx.homeTeam.name);
    await expect(page.getByTestId("mc-side-a")).toBeVisible();
    await expect(page.getByTestId("mc-side-b")).toBeVisible();
    await expect(page.getByTestId("mc-side-a").locator("[data-testid^='mc-row-']").first()).toBeVisible();

    await page.getByLabel("Second team").selectOption(other.awayTeam.id);
    await expect(page).toHaveURL(new RegExp(`b=${other.awayTeam.id}`));
    await expect(page.getByTestId("mc-header")).toContainText(other.awayTeam.name);
    await expect(page.getByTestId("mc-header")).toContainText("Comparison only");
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

  test("stats sidebar renders, and an entry drills down to its managers", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${league.slug}/fixtures`);
    const captained = page.getByTestId("stat-captained");
    await expect(captained).toBeVisible();
    await captained.getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toContainText("captained by");
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
});
