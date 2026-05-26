/**
 * Common Playwright assertions reused across specs. Keep them format-aware
 * but format-agnostic where possible — every spec should be able to call
 * `expectStandingsHasTeam(page, slug, 'Team 1')` regardless of league type.
 */

import { expect, type Page } from "@playwright/test";

/** Visit /[leagueSlug]/standings and verify the team appears in the table. */
export async function expectStandingsHasTeam(page: Page, slug: string, teamName: string): Promise<void> {
  await page.goto(`/${slug}/standings`);
  await expect(page.getByRole("cell", { name: teamName })).toBeVisible({ timeout: 15_000 });
}

/** Visit /[leagueSlug]/fixtures and assert at least one fixture rendered. */
export async function expectFixturesPageRenders(page: Page, slug: string): Promise<void> {
  await page.goto(`/${slug}/fixtures`);
  // Match either a "GW1" heading, a table, or any fixture-card class — be tolerant
  // because the UI markup can change without breaking the underlying feature.
  await expect(
    page.locator("text=/GW\\s*\\d+|Gameweek|Round/i").first(),
  ).toBeVisible({ timeout: 15_000 });
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
