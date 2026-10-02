/**
 * Several accounts on one device.
 *
 * One person often runs more than one team (or a team and an admin login). Signing in to a second
 * account keeps the first signed in, and the account menu switches between them without a
 * password. These specs pin the parts that matter for safety as much as convenience:
 *  - switching really changes who the API thinks you are;
 *  - another open tab of the same browser reloads under the new account instead of quietly acting
 *    as it (in the auction room that would be a bid placed for the wrong team);
 *  - Sign Out signs out only the active account, and "Sign out of all accounts" clears the device.
 *
 * Runs in the desktop `chromium` project (the account menu lives in the desktop app bar; the phone
 * drawer renders the same list).
 *
 * Run with: npm run test:e2e -- tests/smoke/account-switch.spec.ts
 */

import { test, expect, type Page } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignOut,
  createTvtLeague,
  setupAllTeams,
  teamLoginId,
  TEAM_RESET_PASSWORD,
  type LeagueRef,
} from "../harness";

let league: LeagueRef;

async function signInForm(page: Page, identifier: string, url = "/signin") {
  await page.goto(url);
  await page.locator('input[type="text"]').first().fill(identifier);
  await page.locator('input[type="password"]').first().fill(TEAM_RESET_PASSWORD);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain("/dashboard");
}

async function whoAmI(page: Page): Promise<string | null> {
  const res = await page.request.get("/api/auth/me");
  const body = await res.json();
  return body.authenticated ? (body.team?.name ?? body.user?.name ?? null) : null;
}

const accountMenu = (page: Page) => page.getByRole("button", { name: "Account", exact: true });

test.describe.serial("Account switcher", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    await setupAllTeams(request, league.slug, 8, "tvt");
    await apiSignOut(request);
  });

  test("a second sign-in keeps the first account, and the menu switches between them", async ({ page }) => {
    await signInForm(page, teamLoginId(league.slug, 1));
    expect(await whoAmI(page)).toBe("Team 1");

    // "Add another account" — the sign-in form, with the first account still signed in.
    await signInForm(page, teamLoginId(league.slug, 2), "/signin?add=1");
    expect(await whoAmI(page)).toBe("Team 2");

    await accountMenu(page).click();
    const switchTo1 = page.getByRole("button", { name: /Team 1/ });
    await expect(switchTo1).toBeVisible();
    await switchTo1.click();

    await expect.poll(() => whoAmI(page), { timeout: 20_000 }).toBe("Team 1");
    await expect(page.getByRole("heading", { name: "Team 1", level: 1 })).toBeVisible();
  });

  test("another open tab reloads under the newly active account", async ({ page, context }) => {
    await signInForm(page, teamLoginId(league.slug, 1));
    await signInForm(page, teamLoginId(league.slug, 2), "/signin?add=1");

    const other = await context.newPage();
    await other.goto("/dashboard");
    await expect(other.getByRole("heading", { name: "Team 2", level: 1 })).toBeVisible();

    await accountMenu(page).click();
    await page.getByRole("button", { name: /Team 1/ }).click();
    await expect.poll(() => whoAmI(page), { timeout: 20_000 }).toBe("Team 1");

    // The background tab heard the switch and reloaded as Team 1 on its own.
    await expect(other.getByRole("heading", { name: "Team 1", level: 1 })).toBeVisible({ timeout: 20_000 });
    await other.close();
  });

  test("Sign Out signs out only the active account; sign-in offers the other", async ({ page }) => {
    await signInForm(page, teamLoginId(league.slug, 3));
    await signInForm(page, teamLoginId(league.slug, 4), "/signin?add=1");

    await accountMenu(page).click();
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await expect.poll(() => page.url(), { timeout: 20_000 }).toContain("/signin");
    expect(await whoAmI(page)).toBeNull();

    const continueAs = page.getByRole("button", { name: /Continue as Team 3/ });
    await expect(continueAs).toBeVisible();
    await continueAs.click();
    await expect.poll(() => whoAmI(page), { timeout: 20_000 }).toBe("Team 3");
  });

  test("Sign out of all accounts clears the device", async ({ page }) => {
    await signInForm(page, teamLoginId(league.slug, 5));
    await signInForm(page, teamLoginId(league.slug, 6), "/signin?add=1");

    await accountMenu(page).click();
    await page.getByRole("button", { name: "Sign out of all accounts" }).click();
    await expect.poll(() => page.url(), { timeout: 20_000 }).toContain("/signin");
    expect(await whoAmI(page)).toBeNull();

    const accounts = await (await page.request.get("/api/auth/accounts")).json();
    expect(accounts.accounts).toEqual([]);
    await expect(page.getByRole("button", { name: /Continue as/ })).toHaveCount(0);
  });

  test("the accounts list never exposes a session token", async ({ page }) => {
    await signInForm(page, teamLoginId(league.slug, 7));
    const res = await page.request.get("/api/auth/accounts");
    const text = await res.text();
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "session")?.value;
    expect(session).toBeTruthy();
    expect(text).not.toContain(session!);
    const accountsCookie = cookies.find((c) => c.name === "jpl_accounts");
    expect(accountsCookie?.httpOnly).toBe(true);
  });
});
