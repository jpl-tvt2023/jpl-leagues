import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/auth";
import {
  ACCOUNTS_COOKIE_NAME,
  ACCOUNTS_COOKIE_OPTIONS,
  accountKey,
  encodeAccounts,
  removeAccount,
} from "@/lib/auth-accounts";

/**
 * POST /api/auth/signout
 *
 *  - no body (every existing page's Sign Out): signs out the active account. Other accounts
 *    signed in on this device stay signed in, and /signin offers to continue as one of them.
 *  - `{ key }`: signs out that one account (active or not) — Settings → Accounts on this device.
 *  - `{ all: true }`: signs out every account on this device.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { all?: unknown; key?: unknown };
  const response = NextResponse.json({ success: true, message: "Signed out" });
  const clearSession = () => response.cookies.set(SESSION_COOKIE_NAME, "", { maxAge: 0, path: "/" });
  const clearAccounts = () =>
    response.cookies.set(ACCOUNTS_COOKIE_NAME, "", { ...ACCOUNTS_COOKIE_OPTIONS, maxAge: 0 });

  if (body.all === true) {
    clearSession();
    clearAccounts();
    return response;
  }

  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const activeSession = sessionToken ? await verifySession(sessionToken) : null;
  const activeKey = activeSession ? accountKey(activeSession) : null;
  const key = typeof body.key === "string" ? body.key : activeKey;

  if (!key || key === activeKey) clearSession();
  if (key) {
    const remaining = await removeAccount(request.cookies.get(ACCOUNTS_COOKIE_NAME)?.value, key);
    if (remaining.length > 0) response.cookies.set(ACCOUNTS_COOKIE_NAME, encodeAccounts(remaining), ACCOUNTS_COOKIE_OPTIONS);
    else clearAccounts();
  }
  return response;
}
