"use client";

import Link from "next/link";
import { useState } from "react";
import { AccountAvatar } from "./AccountSwitcher";
import { signOutAccounts, switchAccount, useDeviceAccounts } from "@/lib/accounts-client";

/**
 * Settings → "Accounts on this device": every account signed in on this browser, with switch and
 * sign-out per account, plus sign out of all of them. The shared-device caveat lives here, where
 * someone deciding whether to stay signed in will read it.
 */
export function AccountsOnDevice() {
  const { accounts, refresh } = useDeviceAccounts();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!accounts || accounts.length === 0) return null;

  const onSwitch = async (key: string) => {
    setBusy(key);
    setError(null);
    const result = await switchAccount(key);
    if (result?.error) {
      setError(result.error);
      setBusy(null);
    }
  };

  const onRemove = async (key: string, active: boolean) => {
    setBusy(key);
    await signOutAccounts({ key });
    // Signing out the account this page belongs to leaves nothing to show here.
    if (active) {
      window.location.href = "/signin";
      return;
    }
    await refresh();
    setBusy(null);
  };

  const onSignOutAll = async () => {
    setBusy("__all");
    await signOutAccounts({ all: true });
    window.location.href = "/signin";
  };

  return (
    <section id="accounts" className="mt-6 scroll-mt-24 rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-300">Accounts on this device</h2>
      <p className="mt-1 text-xs text-gray-500">
        Switch between them without signing in again. Anyone using this device can do the same — sign out of
        accounts you don&apos;t want left here.
      </p>

      <ul className="mt-4 space-y-2">
        {accounts.map((account) => (
          <li key={account.key} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3">
            <AccountAvatar account={account} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">{account.label}</div>
              <div className="truncate text-xs text-gray-400">
                {account.active ? <span className="text-green-400">Active · </span> : null}
                {account.sublabel}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {!account.active && (
                <button
                  type="button"
                  onClick={() => onSwitch(account.key)}
                  disabled={busy !== null}
                  className="min-h-9 rounded-full bg-white/10 px-3 text-xs font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
                >
                  Switch
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemove(account.key, account.active)}
                disabled={busy !== null}
                aria-label={`Sign out ${account.label}`}
                className="min-h-9 rounded-full px-3 text-xs font-semibold text-gray-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                Sign out
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link
          href="/signin?add=1"
          className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        >
          Add another account
        </Link>
        {accounts.length > 1 && (
          <button
            type="button"
            onClick={onSignOutAll}
            disabled={busy !== null}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
          >
            Sign out of all accounts
          </button>
        )}
      </div>
    </section>
  );
}
