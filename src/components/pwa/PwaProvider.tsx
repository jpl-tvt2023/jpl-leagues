"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { InstallSheet } from "./InstallSheet";
import { Snackbar } from "@/components/ui/Snackbar";

/** Chromium's install-prompt event. Not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
/** How often an open app asks whether a newer deploy is live. Also checked on every resume. */
const UPDATE_CHECK_MS = 15 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const STANDALONE_QUERY = "(display-mode: standalone)";

function subscribeStandalone(onChange: () => void) {
  const mq = window.matchMedia(STANDALONE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getStandalone(): boolean {
  // `navigator.standalone` is iOS Safari's own flag for a home-screen launch.
  return (
    window.matchMedia(STANDALONE_QUERY).matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone, iPod, and iPadOS (which reports itself as a Mac but has a touch screen). */
function getIsIos(): boolean {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

const noopSubscribe = () => () => {};

export interface PwaContextValue {
  /** True when this browser can install the app and it isn't already running installed. */
  canInstall: boolean;
  /** Shows the native install prompt (Android/desktop Chromium) or the iOS how-to sheet. */
  install: () => void;
  /** Running from the home screen / app launcher rather than a browser tab. */
  isStandalone: boolean;
}

const PwaContext = createContext<PwaContextValue>({
  canInstall: false,
  install: () => {},
  isStandalone: false,
});

export function usePwa(): PwaContextValue {
  return useContext(PwaContext);
}

/**
 * App-wide PWA plumbing, mounted once in the root layout:
 *  - registers the service worker (`public/sw.js`) in production builds only, so `next dev` and
 *    the Playwright suite never run against a worker;
 *  - captures Chromium's `beforeinstallprompt` so "Install app" can be offered in our own UI;
 *  - on iOS (no install prompt exists) offers the Add-to-Home-Screen steps instead;
 *  - notices when a newer deploy is live and offers "Update available — Reload".
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  const isStandalone = useSyncExternalStore(subscribeStandalone, getStandalone, () => false);
  const isIos = useSyncExternalStore(noopSubscribe, getIsIos, () => false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosSheetOpen, setIosSheetOpen] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    if (!IS_PRODUCTION || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(APP_VERSION)}`, { scope: "/" })
      .catch((err) => console.warn("[pwa] service worker registration failed", err));
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Keep Chrome's mini-infobar from appearing; we offer install from the drawer/banner.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferredPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!IS_PRODUCTION) return;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/app-version", { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: string };
        if (version && version !== APP_VERSION) setUpdateAvailable(true);
      } catch {
        // Offline or mid-deploy — try again on the next tick or resume.
      }
    };
    document.addEventListener("visibilitychange", check);
    const interval = setInterval(check, UPDATE_CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", check);
      clearInterval(interval);
    };
  }, []);

  const install = useCallback(async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
      // A prompt can only be shown once; Chrome fires a fresh event if it is offered again.
      setDeferredPrompt(null);
      return;
    }
    if (isIos) setIosSheetOpen(true);
  }, [deferredPrompt, isIos]);

  const value = useMemo<PwaContextValue>(
    () => ({
      canInstall: !isStandalone && (deferredPrompt !== null || isIos),
      install: () => void install(),
      isStandalone,
    }),
    [deferredPrompt, install, isIos, isStandalone],
  );

  return (
    <PwaContext.Provider value={value}>
      {children}
      <InstallSheet open={iosSheetOpen} onClose={() => setIosSheetOpen(false)} />
      <Snackbar
        open={updateAvailable && !updateDismissed}
        message="A new version of JPL is available."
        action={{ label: "Reload", onClick: () => window.location.reload() }}
        onDismiss={() => setUpdateDismissed(true)}
      />
    </PwaContext.Provider>
  );
}
