import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/auth";
import {
  ACCOUNTS_COOKIE_NAME,
  ACCOUNTS_COOKIE_OPTIONS,
  encodeAccounts,
  readAccounts,
  removeAccount,
  upsertAccount,
} from "@/lib/auth-accounts";
import { describeAccounts } from "@/lib/auth-accounts-db";
import { resolveViewerForSession } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/switch { key } — make another signed-in account on this device the active one.
 *
 * Only an account already in this browser's httpOnly accounts cookie can be switched to, and its
 * token is re-verified here, so this grants nothing a stolen `key` string alone could use. The
 * session cookie that every API route reads is simply replaced with that account's token.
 *
 * Responds with where to go next; the client hard-navigates there so nothing from the previous
 * identity (polls, the auction stream, cached state) survives the switch.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { key?: unknown };
  const key = typeof body.key === "string" ? body.key : "";
  const raw = request.cookies.get(ACCOUNTS_COOKIE_NAME)?.value;

  const target = (await readAccounts(raw)).find((a) => a.key === key);
  const description = target ? (await describeAccounts([target])).get(target.key) : undefined;

  if (!target || !description) {
    // Expired, signed out elsewhere, or the team/user was deleted — forget it.
    const response = NextResponse.json(
      { error: "That account is no longer signed in on this device. Please sign in again." },
      { status: 404 },
    );
    if (key) response.cookies.set(ACCOUNTS_COOKIE_NAME, encodeAccounts(await removeAccount(raw, key)), ACCOUNTS_COOKIE_OPTIONS);
    return response;
  }

  const viewer = await resolveViewerForSession(target.session);
  const response = NextResponse.json({ redirectTo: viewer.dashboardHref, label: description.label });
  response.cookies.set(SESSION_COOKIE_NAME, target.token, SESSION_COOKIE_OPTIONS);
  // Most recently used goes first, so the cap evicts the account you use least.
  response.cookies.set(ACCOUNTS_COOKIE_NAME, encodeAccounts(await upsertAccount(raw, target.token)), ACCOUNTS_COOKIE_OPTIONS);
  return response;
}
