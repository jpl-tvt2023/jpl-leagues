/**
 * Common Playwright assertions reused across specs. Keep them format-aware
 * but format-agnostic where possible — every spec should be able to call
 * `expectStandingsHasTeam(page, slug, 'Team 1')` regardless of league type.
 */

import { expect, type Page } from "@playwright/test";

/** Visit /[leagueSlug]/standings and verify the team appears in the table. */
export async function expectStandingsHasTeam(page: Page, slug: string, teamName: string): Promise<void> {
  await page.goto(`/${slug}/standings`);
  // exact: true — otherwise "Team 1" also matches "Team 10".."Team 19" and
  // Playwright fails with a strict-mode violation on a page that rendered fine.
  await expect(
    page.getByRole("cell", { name: teamName, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Visit /[leagueSlug]/fixtures and assert at least one fixture rendered. */
export async function expectFixturesPageRenders(page: Page, slug: string): Promise<void> {
  await page.goto(`/${slug}/fixtures`);
  // The gameweek picker only renders in the non-empty branch — the empty state
  // shows "No Fixtures Yet" instead — so its presence is the real signal that
  // fixtures loaded.
  //
  // Assert on the combobox rather than "Gameweek N" text: that text lives
  // inside <option> elements, and Playwright's text engine resolves to the
  // deepest match, so toBeVisible() fails on an <option> even when the page
  // rendered perfectly.
  await expect(page.getByRole("combobox").first()).toBeVisible({ timeout: 15_000 });
}

/** Sign-in success: we're redirected off /signin within `timeout`. */
export async function expectSignedIn(page: Page, timeoutMs = 15_000): Promise<void> {
  await expect.poll(() => page.url(), { timeout: timeoutMs }).not.toContain("/signin");
}

/** Convenience: visit a page and assert response status. */
export async function expectPageLoads(page: Page, path: string): Promise<void> {
  const res = await page.goto(path);
  expect(res?.status() ?? 0).toBeLessThan(400);
}

/**
 * Visit a page and assert it doesn't throw an uncaught client-side exception
 * during hydration/render. A 200 response alone doesn't catch this — Next.js
 * SSRs the shell fine and the crash only happens once client JS runs, so
 * `expectPageLoads` would pass even when the page is broken.
 */
export async function expectPageLoadsWithoutError(page: Page, path: string): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const res = await page.goto(path);
  expect(res?.status() ?? 0).toBeLessThan(400);
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
}
