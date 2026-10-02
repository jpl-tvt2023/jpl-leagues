"use client";

import { useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { usePwa } from "./PwaProvider";

const DISMISS_KEY = "jpl.installBanner.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    // Private mode / blocked storage: treat as dismissed rather than nag on every visit.
    return true;
  }
}

const noopSubscribe = () => () => {};

/**
 * One-time "Install JPL" card for the home page and dashboard. Renders nothing when the app
 * can't be installed here (unsupported browser, or already running installed) or once dismissed.
 * The drawer's "Install app" row stays available either way.
 */
export function InstallBanner({ className = "" }: { className?: string }) {
  const { canInstall, install } = usePwa();
  // Server snapshot says "dismissed" so the card never flashes in before hydration.
  const storedDismissed = useSyncExternalStore(noopSubscribe, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);

  if (!canInstall || storedDismissed || dismissedNow) return null;

  const dismiss = () => {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage unavailable — it simply reappears next visit.
    }
  };

  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-4 ${className}`}
    >
      <Image src="/icons/icon-192.png" alt="" width={48} height={48} className="h-12 w-12 shrink-0 rounded-xl bg-slate-900" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">Install the JPL app</p>
        <p className="text-xs text-gray-400">Full screen, one tap from your home screen.</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={dismiss}
          className="min-h-10 rounded-full px-3 text-xs font-semibold text-gray-400 transition hover:text-white active:bg-white/10"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={install}
          className="min-h-10 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-4 text-xs font-bold text-slate-900 transition hover:from-yellow-300 hover:to-orange-400"
        >
          Install
        </button>
      </div>
    </div>
  );
}
