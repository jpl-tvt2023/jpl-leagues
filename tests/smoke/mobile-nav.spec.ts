/**
 * Mobile / tablet navigation drawer.
 *
 * Below `lg` (1024px) the horizontal nav bar collapses into a hamburger and a portalled
 * side drawer. Every other spec runs at Desktop Chrome's 1280px, where the bar is still
 * a bar — so this file is the ONLY coverage of the collapsed state, and it runs in its
 * own `mobile` Playwright project (see playwright.config.ts).
 *
 * Run with: npm run test:e2e -- --project=mobile
 */

import { test, expect, type Page } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignOut,
  createTvtLeague,
  setupAllTeams,
  teamLoginId,
  TEAM_RESET_PASSWORD,
  uiSignIn,
  type LeagueRef,
  type TeamHandle,
} from "../harness";

let league: LeagueRef;
let teams: TeamHandle[];

const hamburger = (page: Page) => page.getByRole("button", { name: "Open menu" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Site navigation" });

test.describe.serial("Mobile nav drawer", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    teams = await setupAllTeams(request, league.slug, 8, "tvt");
    await apiSignOut(request);
  });

  test("the horizontal link bar collapses to a hamburger", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await expect(hamburger(page)).toBeVisible();
    // The desktop row is `hidden lg:flex`, so its links are out of the a11y tree entirely.
    await expect(page.getByRole("link", { name: "Fixtures", exact: true })).toHaveCount(0);
    await expect(hamburger(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("opening it reveals a labelled dialog with every league link, grouped", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();

    const panel = drawer(page);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("aria-modal", "true");
    await expect(hamburger(page)).toHaveAttribute("aria-expanded", "true");

    // Section headings — the whole point of the grouped drawer over a flat list.
    for (const heading of ["League", "Knockouts", "Help"]) {
      await expect(panel.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }

    // Same links the desktop bar carries, from the same model.
    for (const label of ["Standings", "Fixtures", "FPL League", "Playoffs", "Winners", "Rules", "Help"]) {
      await expect(
        panel.getByRole("link", { name: label, exact: true }),
        `drawer is missing ${label}`,
      ).toBeVisible();
    }
  });

  test("the current page's row is marked aria-current", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();
    await expect(
      drawer(page).getByRole("link", { name: "Standings", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      drawer(page).getByRole("link", { name: "Rules", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");
  });

  test("Escape closes it and returns focus to the hamburger", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();
    await expect(drawer(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(hamburger(page)).toBeFocused();
    await expect(hamburger(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("tapping the scrim closes it", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();
    await expect(drawer(page)).toBeVisible();

    // Far right edge — outside the panel (max-w-xs), over the scrim.
    const size = page.viewportSize();
    await page.mouse.click((size?.width ?? 393) - 10, 300);
    await expect(drawer(page)).toHaveCount(0);
  });

  test("the page behind is scroll-locked while it is open", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();
    await expect(drawer(page)).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });

  test("following a link navigates and closes the drawer", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();
    await drawer(page).getByRole("link", { name: "Rules", exact: true }).click();

    await expect.poll(() => page.url(), { timeout: 15_000 }).toContain("/rules");
    await expect(drawer(page)).toHaveCount(0);
  });

  test("signed out, the drawer hides the members-only links", async ({ page }) => {
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();

    const panel = drawer(page);
    await expect(panel.getByRole("link", { name: "All Leagues", exact: true })).toBeVisible();
    for (const gated of ["Feedback", "Settings"]) {
      await expect(
        panel.getByRole("link", { name: gated, exact: true }),
        `${gated} should be signed-in only`,
      ).toHaveCount(0);
    }
    // Sign In stays in the bar, not the drawer — it is one tap and should not be buried.
    await expect(page.getByRole("link", { name: "Sign In" })).toBeVisible();
  });

  test("signed in, the drawer gains Feedback and Settings", async ({ page }) => {
    await uiSignIn(page, teamLoginId(league.slug, 1), TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
    await page.goto(`/${league.slug}/standings`);
    await hamburger(page).click();

    const panel = drawer(page);
    await expect(panel.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Feedback", exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible();
  });

  test("the dashboard collapses the same way", async ({ page }) => {
    await uiSignIn(page, teamLoginId(league.slug, 1), TEAM_RESET_PASSWORD);
    await expect.poll(() => page.url(), { timeout: 15_000 }).not.toContain("/signin");
    await page.goto("/dashboard");

    await expect(hamburger(page)).toBeVisible();
    await hamburger(page).click();
    // The dashboard used to hand-copy this list; it now draws from the same model as the
    // league pages, so FPL League has to be here too.
    for (const label of ["Standings", "Fixtures", "FPL League", "Playoffs"]) {
      await expect(
        drawer(page).getByRole("link", { name: label, exact: true }),
        `dashboard drawer is missing ${label}`,
      ).toBeVisible();
    }
  });
});
