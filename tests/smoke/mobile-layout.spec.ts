/**
 * Phone layout: no horizontal scrolling, anywhere a player goes.
 *
 * At 360px (the narrowest common Android width) every player-facing page must fit: the page
 * itself must not scroll sideways, and neither may any table, tab strip or card inside it. The
 * check is mechanical — it walks the DOM for any element with `overflow-x: auto|scroll` whose
 * content is wider than its box — so a new `min-w-[…]` table anywhere fails here, not in a user's
 * hand.
 *
 * Also covers the Android-style shell: the bottom navigation bar is present on league pages,
 * marks the current page, and is absent where it should be.
 *
 * Runs in the `mobile` Playwright project. Set MOBILE_SHOTS=1 to also save a full-page screenshot
 * of every page to test-results/mobile-shots/ for eyeballing.
 *
 * Run with: npm run test:e2e -- --project=mobile tests/smoke/mobile-layout.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import {
  apiSignInSuperadmin,
  apiSignOut,
  createAndRunInitialAuction,
  createAuctionLeague,
  createContinentalChampionshipLeague,
  createFplClassicLeague,
  createTvtLeague,
  ensureGameweeks,
  generateFixtures,
  scoreGameweek,
  setupAllTeams,
  teamLoginId,
  TEAM_RESET_PASSWORD,
  uiSignIn,
  type LeagueRef,
} from "../harness";

const SHOTS = process.env.MOBILE_SHOTS === "1";
const SHOT_DIR = path.join("test-results", "mobile-shots");
const FPL_STUB_LEAGUE_ID = 900001;

test.use({ viewport: { width: 360, height: 780 } });

let tvt: LeagueRef;
let continental: LeagueRef;
let auction: LeagueRef;
let fplClassic: LeagueRef;

/**
 * Every element that scrolls (or would scroll) sideways at the current viewport, described well
 * enough to find in the source. Hidden elements have a zero client width and are skipped.
 */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const describe = (el: Element) => {
      const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 6).join(".");
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${el.tagName.toLowerCase()} .${cls}> "${text}"`;
    };
    const offenders: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) {
      offenders.push(`page: scrollWidth ${root.scrollWidth} > ${root.clientWidth}`);
    }
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (!(el instanceof HTMLElement) || el.clientWidth === 0) continue;
      const { overflowX } = getComputedStyle(el);
      if ((overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        offenders.push(`${describe(el)}: ${el.scrollWidth} > ${el.clientWidth}`);
      }
    }
    return offenders;
  });
}

async function visit(page: Page, url: string, shotName: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  if (SHOTS) {
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `${shotName}.png`), fullPage: true });
  }
}

async function expectFits(page: Page, url: string, shotName: string) {
  await visit(page, url, shotName);
  expect(await horizontalOverflow(page), `${url} scrolls sideways at 360px`).toEqual([]);
}

const bottomNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });

test.describe.serial("Phone layout (360px)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(900_000);
    await apiSignInSuperadmin(request);

    // TVT-32: the widest TVT layout (4 groups, 32-team bracket), with one scored gameweek so the
    // standings table has real numbers in every column.
    tvt = await createTvtLeague(request, { teams: 32 });
    await setupAllTeams(request, tvt.slug, tvt.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(tvt.id);
    await generateFixtures(request, tvt.slug);
    await scoreGameweek(tvt.id, 1, (i) => ({ home: 40 + ((i * 7) % 30), away: 35 + ((i * 11) % 30) }));

    continental = await createContinentalChampionshipLeague(request);
    await setupAllTeams(request, continental.slug, continental.teamSize, "continental-championship");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(continental.id);
    await generateFixtures(request, continental.slug);

    auction = await createAuctionLeague(request, { tier: "complete", isSimulated: true });
    await setupAllTeams(request, auction.slug, auction.teamSize, "auction");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(auction.id);
    await createAndRunInitialAuction(request, auction.id);

    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 3, liveGw: null } });
    fplClassic = await createFplClassicLeague(request, {
      fplLeagueId: FPL_STUB_LEAGUE_ID,
      season: `mobile-${Date.now().toString(36)}`,
    });

    await apiSignOut(request);
  });

  test("public pages fit", async ({ page }) => {
    await expectFits(page, "/", "public-home");
    await expectFits(page, "/signin", "public-signin");
  });

  test("TVT pages fit, signed out", async ({ page }) => {
    for (const p of ["standings", "fixtures", "fpl-league", "playoffs", "winners", "rules", "help"]) {
      await expectFits(page, `/${tvt.slug}/${p}`, `tvt-${p}`);
    }
  });

  test("Continental Championship pages fit, signed out", async ({ page }) => {
    for (const p of [
      "standings",
      "fixtures",
      "jpl-cup-standings",
      "jpl-cup-fixtures",
      "playoffs",
      "winners",
      "rules",
      "help",
    ]) {
      await expectFits(page, `/${continental.slug}/${p}`, `jcc-${p}`);
    }
  });

  test("Auction pages fit, signed out", async ({ page }) => {
    for (const p of ["standings", "gw-results", "teams", "auction", "players", "finance", "rules", "help"]) {
      await expectFits(page, `/${auction.slug}/${p}`, `auction-${p}`);
    }
  });

  test("FPL Classic pages fit", async ({ page }) => {
    for (const p of ["standings", "winners", "rules"]) {
      await expectFits(page, `/${fplClassic.slug}/${p}`, `classic-${p}`);
    }
  });

  test("TVT signed-in pages fit", async ({ page }) => {
    await uiSignIn(page, teamLoginId(tvt.slug, 1), TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
    await expectFits(page, "/dashboard", "tvt-dashboard");

    // Phone order: Captains & Chips sits directly under the GW Submissions card, ahead of the
    // tables and fixtures that come before it in the desktop left column.
    const top = async (name: RegExp) =>
      (await page.getByRole("heading", { name }).first().boundingBox())?.y ?? Number.NaN;
    const submissions = await top(/GW\d+ Submissions/);
    const captains = await top(/Captains & Chips/);
    const upcoming = await top(/Upcoming Fixtures/);
    expect(captains, "Captains & Chips should follow Submissions").toBeGreaterThan(submissions);
    expect(captains, "Captains & Chips should come before Upcoming Fixtures").toBeLessThan(upcoming);

    await expectFits(page, `/${tvt.slug}/feedback`, "tvt-feedback");
    await expectFits(page, "/settings", "account-settings");
    await expectFits(page, "/notifications", "account-notifications");
  });

  test("Auction signed-in pages fit", async ({ page }) => {
    await uiSignIn(page, teamLoginId(auction.slug, 1), TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
    await expectFits(page, "/dashboard", "auction-dashboard");
    for (const p of ["squad", "marketplace", "finance", "players"]) {
      await expectFits(page, `/${auction.slug}/${p}`, `auction-signedin-${p}`);
    }
  });

  test("bottom navigation bar marks the current page", async ({ page }) => {
    await visit(page, `/${tvt.slug}/fixtures`, "tvt-bottom-nav");
    const bar = bottomNav(page);
    await expect(bar).toBeVisible();
    for (const label of ["Leagues", "Standings", "Fixtures", "Playoffs", "More"]) {
      await expect(bar.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(bar.getByRole("link", { name: "Fixtures" })).toHaveAttribute("aria-current", "page");

    await bar.getByRole("link", { name: "Standings" }).click();
    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("/standings");
    await expect(bottomNav(page).getByRole("link", { name: "Standings" })).toHaveAttribute("aria-current", "page");
  });

  test("the bottom bar's More opens the drawer", async ({ page }) => {
    await visit(page, `/${tvt.slug}/standings`, "tvt-more");
    await bottomNav(page).getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("dialog", { name: "Site navigation" })).toBeVisible();
  });

  test("the last row of a page is not hidden behind the bottom bar", async ({ page }) => {
    await visit(page, `/${tvt.slug}/rules`, "tvt-rules-bottom");
    const padding = await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom));
    const bar = await bottomNav(page).boundingBox();
    expect(bar?.height ?? 0, "Material's navigation bar is 80px").toBeGreaterThanOrEqual(80);
    expect(padding).toBeGreaterThanOrEqual(bar?.height ?? 80);
  });

  test("phone touch targets: the bell and app-bar buttons are at least 48px", async ({ page }) => {
    await uiSignIn(page, teamLoginId(tvt.slug, 2), TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
    await visit(page, `/${tvt.slug}/standings`, "tvt-touch-targets");
    for (const name of ["Notifications", "Open menu"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box?.height ?? 0, `${name} button height`).toBeGreaterThanOrEqual(48);
      expect(box?.width ?? 0, `${name} button width`).toBeGreaterThanOrEqual(48);
    }
  });

  /** Synthesise a vertical drag on the page — Playwright's touchscreen only taps. */
  async function drag(page: Page, fromY: number, toY: number) {
    await page.evaluate(
      ([from, to]) => {
        const touch = (y: number) => new Touch({ identifier: 1, target: document.body, clientX: 180, clientY: y });
        window.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(from)], bubbles: true }));
        const step = Math.sign(to - from) * 20;
        for (let y = from + step; step > 0 ? y <= to : y >= to; y += step) {
          window.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(y)], bubbles: true }));
        }
        window.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
      },
      [fromY, toY] as const,
    );
  }

  test("pulling down from the top of a page reloads it", async ({ page }) => {
    await visit(page, `/${tvt.slug}/standings`, "tvt-pull-refresh");
    await page.evaluate(() => ((window as unknown as { __beforePull?: boolean }).__beforePull = true));
    const reloaded = page.waitForEvent("load");
    await drag(page, 150, 420);
    await reloaded;
    expect(await page.evaluate(() => (window as unknown as { __beforePull?: boolean }).__beforePull)).toBeUndefined();
  });

  test("a short pull springs back without reloading", async ({ page }) => {
    await visit(page, `/${tvt.slug}/standings`, "tvt-short-pull");
    await page.evaluate(() => ((window as unknown as { __beforePull?: boolean }).__beforePull = true));
    await drag(page, 150, 230);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __beforePull?: boolean }).__beforePull)).toBe(true);
  });

  test("no bottom bar on pages outside a league", async ({ page }) => {
    await visit(page, "/signin", "no-bottom-signin");
    await expect(bottomNav(page)).toHaveCount(0);
  });
});
