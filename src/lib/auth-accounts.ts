/**
 * Several signed-in accounts on one device, Gmail-style.
 *
 * The active account is still the one `session` cookie every API route and the middleware read —
 * nothing about authorization changes. Alongside it, an httpOnly `jpl_accounts` cookie holds the
 * signed session tokens of every account signed in on this browser (newest first, at most
 * `MAX_ACCOUNTS`). Switching account just copies one of those tokens into `session`.
 *
 * Each entry is a token minted by `createSession`, individually HMAC-signed, so the list can be
 * neither forged nor edited: every read re-verifies each token and silently drops anything that
 * fails or has expired. Tokens never reach JavaScript — the cookie is httpOnly and scoped to
 * `/api/auth`, and `/api/auth/accounts` returns display rows only.
 *
 * Pure apart from `verifySession`, so it is unit-tested directly (tests/unit/auth-accounts.test.ts).
 */

import { verifySession, type SessionPayload } from "./auth";

export const ACCOUNTS_COOKIE_NAME = "jpl_accounts";
/** Adding a sixth account evicts the least recently used. */
export const MAX_ACCOUNTS = 5;

export const ACCOUNTS_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  // Only the auth routes ever read it — no reason to ship ~1 KB on every other request.
  path: "/api/auth",
  // Outlives any single token; each token's own 7-day `exp` is what actually expires an entry.
  maxAge: 60 * 60 * 24 * 30,
};

export interface StoredAccount {
  /** `type:id` — stable identity of an account across sign-ins. */
  key: string;
  token: string;
  session: SessionPayload;
}

export function accountKey(session: Pick<SessionPayload, "id" | "type">): string {
  return `${session.type}:${session.id}`;
}

function b64urlEncode(str: string): string {
  return Buffer.from(str, "utf8").toString("base64url");
}

function b64urlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf8");
}

/** Serialise tokens for the cookie value. */
export function encodeAccounts(tokens: string[]): string {
  return b64urlEncode(JSON.stringify(tokens.slice(0, MAX_ACCOUNTS)));
}

/** Parse the cookie value. Anything malformed reads as an empty list rather than throwing. */
export function decodeAccounts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(b64urlDecode(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length < 2048);
  } catch {
    return [];
  }
}

/**
 * The verified accounts in the cookie, newest first, with forged, expired and duplicate entries
 * removed (the first — most recent — token for an account wins).
 */
export async function readAccounts(raw: string | undefined | null): Promise<StoredAccount[]> {
  const out: StoredAccount[] = [];
  const seen = new Set<string>();
  for (const token of decodeAccounts(raw)) {
    const session = await verifySession(token);
    if (!session) continue;
    const key = accountKey(session);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, token, session });
    if (out.length === MAX_ACCOUNTS) break;
  }
  return out;
}

/**
 * The account list after signing in (or switching to) `token`: it moves to the front, any older
 * token for the same account is replaced, and the list is capped. An invalid token leaves the
 * list unchanged.
 */
export async function upsertAccount(raw: string | undefined | null, token: string): Promise<string[]> {
  const existing = await readAccounts(raw);
  const session = await verifySession(token);
  if (!session) return existing.map((a) => a.token);
  const key = accountKey(session);
  return [token, ...existing.filter((a) => a.key !== key).map((a) => a.token)].slice(0, MAX_ACCOUNTS);
}

/** The account list without the account `key`. */
export async function removeAccount(raw: string | undefined | null, key: string): Promise<string[]> {
  return (await readAccounts(raw)).filter((a) => a.key !== key).map((a) => a.token);
}
