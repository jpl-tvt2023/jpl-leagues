"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { NavIcon } from "./icons/NavIcon";
import { signOutAccounts, switchAccount, useDeviceAccounts, type DeviceAccount } from "@/lib/accounts-client";

const AVATAR_COLOURS = ["bg-sky-600", "bg-emerald-600", "bg-violet-600", "bg-amber-600", "bg-rose-600", "bg-indigo-600"];

function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

/** Stable colour per account, so the same team always has the same avatar on every screen. */
function colourFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

export function AccountAvatar({ account, size = "md" }: { account: Pick<DeviceAccount, "key" | "label">; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "h-8 w-8 text-[11px]" : "h-10 w-10 text-sm";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${dims} ${colourFor(account.key)}`}
    >
      {initials(account.label)}
    </span>
  );
}

const ROW =
  "flex min-h-12 w-full items-center gap-3 rounded-full px-3 text-left text-sm text-gray-200 transition hover:bg-white/5 active:bg-white/15 disabled:opacity-50";

function AccountText({ account }: { account: DeviceAccount }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-semibold text-white">{account.label}</span>
      {account.sublabel && <span className="block truncate text-xs text-gray-400">{account.sublabel}</span>}
    </span>
  );
}

/**
 * The switch list shared by the drawer section and the desktop menu: every other signed-in
 * account (tap to switch), then add / manage / sign out of everything.
 */
function AccountActions({
  accounts,
  active,
  onNavigate,
}: {
  accounts: DeviceAccount[];
  active: DeviceAccount;
  onNavigate?: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const others = accounts.filter((a) => a.key !== active.key);

  const onSwitch = async (key: string) => {
    setBusyKey(key);
    setError(null);
    const result = await switchAccount(key);
    // On success the page is already navigating away.
    if (result?.error) {
      setError(result.error);
      setBusyKey(null);
    }
  };

  const onSignOutAll = async () => {
    setBusyKey("__all");
    await signOutAccounts({ all: true });
    window.location.href = "/signin";
  };

  return (
    <div className="space-y-0.5">
      {others.length > 0 && (
        <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">Switch account</p>
      )}
      {others.map((account) => (
        <button
          key={account.key}
          type="button"
          onClick={() => onSwitch(account.key)}
          disabled={busyKey !== null}
          className={ROW}
        >
          <AccountAvatar account={account} size="sm" />
          <AccountText account={account} />
          {busyKey === account.key && <span className="text-xs text-gray-400">Switching…</span>}
        </button>
      ))}
      {error && <p className="px-3 py-1 text-xs text-red-400">{error}</p>}
      <Link href="/signin?add=1" onClick={onNavigate} className={ROW}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-white/30">
          <NavIcon name="add" className="h-4 w-4" />
        </span>
        Add another account
      </Link>
      {active.type === "team" && (
        <Link href="/settings#accounts" onClick={onNavigate} className={ROW}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center">
            <NavIcon name="settings" className="h-5 w-5" />
          </span>
          Manage accounts
        </Link>
      )}
      {accounts.length > 1 && (
        <button type="button" onClick={onSignOutAll} disabled={busyKey !== null} className={ROW}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center">
            <NavIcon name="logout" className="h-5 w-5" />
          </span>
          Sign out of all accounts
        </button>
      )}
    </div>
  );
}

/**
 * Top of the navigation drawer (Android Gmail pattern): the active account, and a toggle that
 * expands the other signed-in accounts plus add / manage / sign-out-all. Renders nothing for a
 * signed-out viewer.
 */
export function DrawerAccountSection({ onNavigate }: { onNavigate?: () => void }) {
  const { accounts } = useDeviceAccounts();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (!accounts || accounts.length === 0) return null;
  const active = accounts.find((a) => a.active) ?? accounts[0];
  const others = accounts.length - 1;

  return (
    <div className="mx-3 mb-1 rounded-3xl bg-white/5">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={`Signed in as ${active.label}. ${expanded ? "Hide" : "Show"} accounts`}
        className="flex w-full items-center gap-3 rounded-3xl p-3 text-left transition active:bg-white/10"
      >
        <AccountAvatar account={active} />
        <AccountText account={active} />
        {others > 0 && (
          <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-gray-300">+{others}</span>
        )}
        <NavIcon
          name="chevron-down"
          className={`h-5 w-5 shrink-0 text-gray-400 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div id={listId} className="border-t border-white/10 p-1">
          <AccountActions accounts={accounts} active={active} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}

/**
 * The desktop app bar's account control (and the phone bar's, on drawer-less surfaces): an
 * "Account" button opening a menu with the switcher and Sign Out. Accounts are only fetched once
 * the menu opens, so the bar costs nothing on every page load.
 */
export function AccountMenu({ onSignOut, className = "" }: { onSignOut?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const { accounts } = useDeviceAccounts(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const active = accounts?.find((a) => a.active) ?? accounts?.[0];

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="true"
        className="inline-flex items-center gap-1.5 rounded-full bg-white/10 py-1.5 pl-2 pr-3 text-xs font-semibold text-white transition hover:bg-white/20 lg:py-2 lg:text-sm"
      >
        <NavIcon name="players" className="h-4 w-4 lg:h-5 lg:w-5" />
        Account
        <NavIcon name="chevron-down" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          id={menuId}
          className="absolute right-0 top-full z-[60] mt-2 w-[min(20rem,calc(100vw-1rem))] rounded-2xl border border-white/10 bg-slate-900 p-2 shadow-2xl"
        >
          {!accounts ? (
            <p className="px-3 py-3 text-sm text-gray-400">Loading…</p>
          ) : active ? (
            <>
              <div className="flex items-center gap-3 px-3 py-2">
                <AccountAvatar account={active} />
                <AccountText account={active} />
              </div>
              <div className="my-1 border-t border-white/10" />
              <AccountActions accounts={accounts} active={active} onNavigate={() => setOpen(false)} />
            </>
          ) : null}
          {onSignOut && (
            <>
              <div className="my-1 border-t border-white/10" />
              <button type="button" onClick={onSignOut} className={ROW}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                  <NavIcon name="logout" className="h-5 w-5" />
                </span>
                Sign Out
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
