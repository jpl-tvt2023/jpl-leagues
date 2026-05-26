/**
 * Auth helpers for tests.
 *
 * Two modes are supported:
 *   - `apiSignIn(request, identifier, password)` — uses Playwright's
 *     `APIRequestContext` to POST /api/auth/signin. The session cookie is
 *     persisted in that request context for subsequent API calls. Use this
 *     when a spec is API-only.
 *   - `uiSignIn(page, identifier, password)` — drives the /signin form. Use
 *     this when the spec needs the resulting page navigation (e.g. team
 *     dashboard, captain submission).
 *
 * Both reuse the same /api/auth/signin endpoint (src/app/api/auth/signin/route.ts).
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { TEST_SUPERADMIN, teamLoginId, teamInitialPassword, TEAM_RESET_PASSWORD } from "./constants";

interface SignInOk {
  ok: true;
  redirectTo: string;
  body: unknown;
}
interface SignInErr {
  ok: false;
  status: number;
  error: string;
}
export type SignInResult = SignInOk | SignInErr;

export async function apiSignIn(
  request: APIRequestContext,
  identifier: string,
  password: string,
): Promise<SignInResult> {
  const res = await request.post("/api/auth/signin", {
    data: { identifier, password },
    failOnStatusCode: false,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    return { ok: false, status: res.status(), error: body?.error ?? "unknown error" };
  }
  return { ok: true, redirectTo: body?.redirectTo ?? "/", body };
}

export async function apiSignInSuperadmin(request: APIRequestContext): Promise<void> {
  const res = await apiSignIn(request, TEST_SUPERADMIN.email, TEST_SUPERADMIN.password);
  if (!res.ok) {
    throw new Error(
      `Failed to sign in as test superadmin (${TEST_SUPERADMIN.email}): ${res.status} ${res.error}. ` +
        "Did you run `npm run test:reset`?",
    );
  }
}

export async function apiSignInAdmin(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const res = await apiSignIn(request, email, password);
  if (!res.ok) throw new Error(`apiSignInAdmin(${email}) failed: ${res.status} ${res.error}`);
}

export async function apiSignInTeam(
  request: APIRequestContext,
  slug: string,
  index: number,
  password = TEAM_RESET_PASSWORD,
): Promise<void> {
  const res = await apiSignIn(request, teamLoginId(slug, index), password);
  if (!res.ok) throw new Error(`apiSignInTeam(${slug}, ${index}) failed: ${res.status} ${res.error}`);
}

export async function apiSignOut(request: APIRequestContext): Promise<void> {
  await request.post("/api/auth/signout").catch(() => {});
}

export async function uiSignIn(page: Page, identifier: string, password: string): Promise<void> {
  // The signin form's <label> elements are not htmlFor-bound to their inputs
  // (see src/app/signin/page.tsx), so `getByLabel` can't match them. Target
  // the inputs by type/role instead — first text input is the identifier,
  // the password input is unambiguous.
  await page.goto("/signin");
  await page.locator('input[type="text"]').first().fill(identifier);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForLoadState("networkidle");
}

export async function uiSignInSuperadmin(page: Page): Promise<void> {
  await uiSignIn(page, TEST_SUPERADMIN.email, TEST_SUPERADMIN.password);
}

export async function uiSignInTeam(
  page: Page,
  slug: string,
  index: number,
  password = TEAM_RESET_PASSWORD,
): Promise<void> {
  await uiSignIn(page, teamLoginId(slug, index), password);
}

/**
 * Bypass the first-login password-change wall by calling the change-password
 * API directly. Returns the new password the team can now use.
 *
 * The auto-created team accounts (POST /api/superadmin/leagues) all carry
 * `mustChangePassword: true`, which forces a /change-password redirect on
 * sign-in. For most specs that's noise we'd rather skip.
 */
export async function apiResetTeamPassword(
  request: APIRequestContext,
  slug: string,
  index: number,
): Promise<string> {
  // Step 1: sign in with the seeded password
  await apiSignIn(request, teamLoginId(slug, index), teamInitialPassword(index));
  // Step 2: change to the canonical reset password
  const res = await request.post("/api/auth/change-password", {
    data: {
      currentPassword: teamInitialPassword(index),
      newPassword: TEAM_RESET_PASSWORD,
    },
    failOnStatusCode: false,
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `apiResetTeamPassword(${slug}, ${index}) failed: ${res.status()} ${body?.error ?? ""}`,
    );
  }
  await apiSignOut(request);
  return TEAM_RESET_PASSWORD;
}
