"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/** One account signed in on this device, as `/api/auth/accounts` describes it (never the token). */
export interface DeviceAccount {
  key: string;
  type: "team" | "admin" | "superadmin";
  /** Team name, or the admin's name. */
  label: string;
  /** League name for a team; role for an admin. */
  sublabel: string | null;
  /** Team login ID or admin email — what the sign-in form would need. */
  loginId: string | null;
  active: boolean;
}

/** Same-browser tabs hear about account changes here (see AccountSync). */
export const AUTH_CHANNEL = "jpl-auth";

export type AuthChannelMessage = (
  | { type: "account-switched"; label: string }
  | { type: "signed-out" }
) & {
  /** The page that sent it. */
  from?: string;
};

/**
 * Identifies this page load. A BroadcastChannel message reaches every *other* channel object of
 * that name — including AccountSync's listener in the very page that sent it, which would then
 * reload the page out from under its own navigation. Listeners skip messages carrying their own id.
 */
export const PAGE_ID = Math.random().toString(36).slice(2);

/** Tell every other tab of this browser that the active account just changed. */
export function announceAuthChange(message: AuthChannelMessage): void {
  try {
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.postMessage({ ...message, from: PAGE_ID });
    channel.close();
  } catch {
    // No BroadcastChannel (very old browsers): AccountSync's focus re-check still catches it.
  }
}

/**
 * The accounts signed in on this device. `null` until loaded; an empty list when signed out or
 * on any error (the switcher then simply doesn't render).
 */
export function useDeviceAccounts(enabled = true) {
  const [accounts, setAccounts] = useState<DeviceAccount[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/accounts", { cache: "no-store" });
      const body = res.ok ? ((await res.json()) as { accounts?: DeviceAccount[] }) : {};
      setAccounts(body.accounts ?? []);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/auth/accounts", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : {}))
      .then((body: { accounts?: DeviceAccount[] }) => {
        if (!cancelled) setAccounts(body.accounts ?? []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { accounts, refresh };
}

/**
 * Make `key` the active account, then hard-navigate to its dashboard. The full page load (not a
 * client-side push) is deliberate: polling, the auction SSE stream and every bit of client state
 * have to restart under the new identity.
 */
export async function switchAccount(key: string): Promise<{ error: string } | void> {
  const res = await fetch("/api/auth/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const body = (await res.json().catch(() => ({}))) as { redirectTo?: string; label?: string; error?: string };
  if (!res.ok || !body.redirectTo) return { error: body.error ?? "Couldn't switch account. Please sign in again." };
  announceAuthChange({ type: "account-switched", label: body.label ?? "another account" });
  window.location.href = body.redirectTo;
}

/** Sign out of one account (default: the active one) or, with `all`, every account on this device. */
export async function signOutAccounts(opts: { all?: boolean; key?: string } = {}): Promise<void> {
  await fetch("/api/auth/signout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  }).catch(() => null);
  announceAuthChange({ type: "signed-out" });
}

/* ── Remembered login IDs ─────────────────────────────────────────────────────
 * Login IDs and display names only — never passwords. Passwords belong in the browser's or OS's
 * password manager, which the sign-in form's autocomplete attributes hand them to. This list just
 * lets /signin offer "sign in again as …" for accounts whose session has expired.
 */

const REMEMBERED_KEY = "jpl.rememberedLogins";
const MAX_REMEMBERED = 8;

export interface RememberedLogin {
  loginId: string;
  label: string;
}

const rememberedListeners = new Set<() => void>();

function subscribeRemembered(onChange: () => void) {
  rememberedListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    rememberedListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function rememberedSnapshot(): string {
  try {
    return window.localStorage.getItem(REMEMBERED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function parseRemembered(raw: string): RememberedLogin[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RememberedLogin =>
        !!e && typeof e === "object" && typeof (e as RememberedLogin).loginId === "string" && typeof (e as RememberedLogin).label === "string",
    );
  } catch {
    return [];
  }
}

export function readRememberedLogins(): RememberedLogin[] {
  return parseRemembered(rememberedSnapshot());
}

/** Remembered login IDs, live: updates when this or another tab remembers or forgets one. */
export function useRememberedLogins(): RememberedLogin[] {
  const raw = useSyncExternalStore(subscribeRemembered, rememberedSnapshot, () => "[]");
  return useMemo(() => parseRemembered(raw), [raw]);
}

export function rememberLogin(entry: RememberedLogin): void {
  try {
    const rest = readRememberedLogins().filter((e) => e.loginId.toLowerCase() !== entry.loginId.toLowerCase());
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify([entry, ...rest].slice(0, MAX_REMEMBERED)));
    rememberedListeners.forEach((l) => l());
  } catch {
    // Storage unavailable — nothing to remember, nothing breaks.
  }
}

export function forgetLogin(loginId: string): void {
  try {
    const rest = readRememberedLogins().filter((e) => e.loginId.toLowerCase() !== loginId.toLowerCase());
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify(rest));
    rememberedListeners.forEach((l) => l());
  } catch {
    // Storage unavailable.
  }
}
