import { type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/auth";
import {
  ACCOUNTS_COOKIE_NAME,
  ACCOUNTS_COOKIE_OPTIONS,
  accountKey,
  encodeAccounts,
  readAccounts,
  upsertAccount,
} from "@/lib/auth-accounts";
import { describeAccounts } from "@/lib/auth-accounts-db";
import { jsonNoStore } from "@/lib/http/no-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/accounts — the accounts signed in on this device, for the account switcher.
 *
 * Returns display rows only (name, league, login ID); the session tokens stay in the httpOnly
 * cookie. Public in middleware (all of /api/auth is): a signed-out browser simply gets `[]`.
 *
 * Also tidies the cookie: entries that expired, were tampered with, or whose team/user has since
 * been deleted are dropped, and a session signed in before the accounts cookie existed is folded
 * in so the switcher always shows the active account.
 */
export async function GET(request: NextRequest) {
  const raw = request.cookies.get(ACCOUNTS_COOKIE_NAME)?.value;
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const activeSession = sessionToken ? await verifySession(sessionToken) : null;
  const activeKey = activeSession ? accountKey(activeSession) : null;

  let stored = await readAccounts(raw);
  if (sessionToken && activeKey && !stored.some((a) => a.key === activeKey)) {
    stored = await readAccounts(encodeAccounts(await upsertAccount(raw, sessionToken)));
  }

  const descriptions = await describeAccounts(stored);
  const live = stored.filter((a) => descriptions.has(a.key));

  const response = jsonNoStore({
    accounts: live.map((a) => {
      const d = descriptions.get(a.key)!;
      return {
        key: a.key,
        type: a.session.type,
        label: d.label,
        sublabel: d.sublabel,
        loginId: d.loginId,
        active: a.key === activeKey,
      };
    }),
  });

  const tidied = encodeAccounts(live.map((a) => a.token));
  // Rewrite only when something changed (never set a cookie for a visitor who has none).
  if (raw ? tidied !== raw : live.length > 0) {
    if (live.length > 0) response.cookies.set(ACCOUNTS_COOKIE_NAME, tidied, ACCOUNTS_COOKIE_OPTIONS);
    else response.cookies.set(ACCOUNTS_COOKIE_NAME, "", { ...ACCOUNTS_COOKIE_OPTIONS, maxAge: 0 });
  }
  return response;
}
