"use client";

import { useEffect, useState } from "react";
import { AUTH_CHANNEL, PAGE_ID, type AuthChannelMessage } from "@/lib/accounts-client";

/** Re-checks on resume are skipped if the last one was this recent. */
const RECHECK_MIN_MS = 30_000;

async function readIdentity(): Promise<string | null> {
  const res = await fetch("/api/auth/me", { cache: "no-store" });
  const body = (await res.json()) as {
    authenticated?: boolean;
    type?: string;
    team?: { id?: string };
    user?: { id?: string };
  };
  return body.authenticated ? `${body.type}:${body.team?.id ?? body.user?.id ?? ""}` : null;
}

/**
 * Keeps every open tab acting as the account it shows.
 *
 * The session cookie is browser-wide, so switching account (or signing in to another one) in one
 * tab silently changes who every other tab acts as — in the auction room, a bid from a stale tab
 * would go out as the newly active team. So:
 *  - a switch announces itself on a BroadcastChannel and every other tab shows a blocking
 *    "Switched to …" notice and reloads under the new identity;
 *  - as a backstop for tabs that were frozen in the background when the message went out (mobile
 *    browsers do this), a tab notes who it is when hidden and re-checks when it comes back.
 */
export function AccountSync() {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(AUTH_CHANNEL);
    } catch {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    channel.onmessage = (e: MessageEvent<AuthChannelMessage>) => {
      const msg = e.data;
      // This page's own announcement: it is already navigating to where it needs to be.
      if (msg?.from === PAGE_ID) return;
      if (msg?.type !== "account-switched" && msg?.type !== "signed-out") return;
      setNotice(msg.type === "account-switched" ? `Switched to ${msg.label}` : "Signed out");
      timer = setTimeout(() => window.location.reload(), 700);
    };
    return () => {
      clearTimeout(timer);
      channel.close();
    };
  }, []);

  useEffect(() => {
    let identityWhenHidden: string | null | undefined;
    let lastCheck = 0;
    const onVisibility = async () => {
      try {
        if (document.visibilityState === "hidden") {
          identityWhenHidden = await readIdentity();
          return;
        }
        if (identityWhenHidden === undefined || Date.now() - lastCheck < RECHECK_MIN_MS) return;
        lastCheck = Date.now();
        if ((await readIdentity()) !== identityWhenHidden) window.location.reload();
      } catch {
        // Offline — nothing to compare against; the next resume tries again.
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (!notice) return null;
  return (
    <div
      role="status"
      aria-live="assertive"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/90 p-6 backdrop-blur-sm"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-yellow-400" aria-hidden="true" />
        <p className="text-base font-semibold text-white">{notice}</p>
        <p className="text-sm text-gray-400">Reloading…</p>
      </div>
    </div>
  );
}
