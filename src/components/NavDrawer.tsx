"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Logo } from "./Logo";
import { NavIcon } from "./icons/NavIcon";
import { usePwa } from "./pwa/PwaProvider";
import type { NavGroup } from "@/lib/nav-links";
import { useIsClient, useModalOverlay, usePresence } from "@/hooks/useModalOverlay";

/**
 * Exit-animation length. `prefers-reduced-motion` suppresses the transition entirely, so
 * unmounting is timer-driven (see `usePresence`), never `transitionend`.
 */
const CLOSE_ANIMATION_MS = 250;
/** Fraction of the panel width a leftward swipe must cover to dismiss on release. */
const SWIPE_DISMISS_RATIO = 0.35;

export interface NavDrawerProps {
  /** Drives the slide in and out; the drawer unmounts itself once the exit has played. */
  open: boolean;
  groups: NavGroup[];
  activeKey: string;
  brandHref: string;
  brandLabel: string;
  brandBadge?: { label: string; bgClass: string; textClass: string } | null;
  /** Palette classes for the active row's pill. Falls back to a neutral highlight. */
  activeBgClass?: string;
  activeTextClass?: string;
  /** Present when the viewer is signed in: renders "Sign out" in the drawer footer. */
  onSignOut?: () => void;
  /** Account switcher slotted under the header (signed-in surfaces only). */
  accountSection?: ReactNode;
  onClose: () => void;
}

function toneClass(tone: string | undefined): string {
  if (tone === "accent") return "text-orange-400 font-semibold";
  if (tone === "back") return "text-yellow-400 font-semibold";
  return "text-gray-200";
}

const ROW =
  "flex min-h-12 items-center gap-4 rounded-full px-4 text-sm transition active:bg-white/15";

/**
 * The phone/tablet navigation drawer, styled after Android's Material navigation drawer:
 * icon + label rows, a pill behind the current page, section headings, account actions in the
 * footer. Swipe it left to close. There is deliberately no edge-swipe to *open* — with Android
 * gesture navigation the screen's left edge is the system Back gesture.
 *
 * Portalled to `document.body` rather than rendered inside `<nav>`: the nav has `backdrop-blur`
 * (which creates a stacking context) and its desktop link row has `overflow-x-auto` — the exact
 * clipping trap `NotificationBell` documents and works around. Portalling sidesteps both.
 *
 * Mounted only while open (or closing). An always-mounted-but-hidden drawer would put a second
 * copy of every link in the accessibility tree, which both breaks link-count assertions in the
 * e2e suite and makes screen-reader navigation ambiguous.
 */
export function NavDrawer({
  open,
  groups,
  activeKey,
  brandHref,
  brandLabel,
  brandBadge = null,
  activeBgClass = "bg-white/10",
  activeTextClass = "text-white",
  onSignOut,
  accountSection,
  onClose,
}: NavDrawerProps) {
  const isClient = useIsClient();
  const { rendered, shown } = usePresence(open, CLOSE_ANIMATION_MS);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const trapTab = useModalOverlay({ active: rendered, onClose, panelRef, initialFocusRef: closeRef });
  const { canInstall, install } = usePwa();

  const [swipe, setSwipe] = useState<{ startX: number; startY: number; dx: number; locked: boolean } | null>(null);

  if (!isClient || !rendered) return null;

  const onTouchStart = (e: React.TouchEvent) =>
    setSwipe({ startX: e.touches[0].clientX, startY: e.touches[0].clientY, dx: 0, locked: false });
  const onTouchMove = (e: React.TouchEvent) => {
    if (!swipe) return;
    const dx = e.touches[0].clientX - swipe.startX;
    const dy = e.touches[0].clientY - swipe.startY;
    // Decide once whether this gesture is a horizontal swipe or the list scrolling.
    if (!swipe.locked && Math.abs(dy) > Math.abs(dx)) {
      setSwipe(null);
      return;
    }
    setSwipe({ ...swipe, dx: Math.min(0, dx), locked: true });
  };
  const onTouchEnd = () => {
    const width = panelRef.current?.offsetWidth ?? 320;
    if (swipe && -swipe.dx > width * SWIPE_DISMISS_RATIO) onClose();
    setSwipe(null);
  };

  const dragging = swipe !== null && swipe.dx < 0;

  return createPortal(
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      <div
        id="app-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Site navigation"
        ref={panelRef}
        onKeyDown={trapTab}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={dragging ? { transform: `translateX(${swipe.dx}px)`, transition: "none" } : undefined}
        className={`fixed inset-y-0 left-0 z-[71] flex h-full w-[86vw] max-w-xs flex-col overflow-y-auto overscroll-contain rounded-r-3xl border-r border-white/10 bg-slate-900 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
          <Link href={brandHref} onClick={onClose} className="flex min-w-0 items-center gap-3">
            <Logo className="h-10 w-10 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate text-base font-bold text-white">{brandLabel}</span>
              {brandBadge && (
                <span
                  className={`mt-0.5 inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${brandBadge.bgClass} ${brandBadge.textClass}`}
                >
                  {brandBadge.label}
                </span>
              )}
            </span>
          </Link>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-white/10 hover:text-white active:bg-white/15"
          >
            <NavIcon name="close" className="h-5 w-5" />
          </button>
        </header>

        {accountSection}

        <div className="flex-1 px-3 py-1">
          {groups.map((group, gi) => (
            <section key={group.id} className={gi > 0 ? "mt-1 border-t border-white/5 pt-1" : ""}>
              <h2 className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
                {group.heading}
              </h2>
              <ul>
                {group.items.map((item) => {
                  const active = item.key === activeKey;
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        onClick={onClose}
                        aria-current={active ? "page" : undefined}
                        className={
                          active
                            ? `${ROW} font-semibold ${activeBgClass} ${activeTextClass}`
                            : `${ROW} hover:bg-white/5 hover:text-white ${toneClass(item.tone)}`
                        }
                      >
                        {item.icon && <NavIcon name={item.icon} className="h-5 w-5 shrink-0" />}
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        {(canInstall || onSignOut) && (
          <footer className="border-t border-white/10 px-3 py-2">
            {canInstall && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  install();
                }}
                className={`${ROW} w-full text-sky-300 hover:bg-white/5`}
              >
                <NavIcon name="install" className="h-5 w-5 shrink-0" />
                Install app
              </button>
            )}
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className={`${ROW} w-full text-gray-200 hover:bg-white/5 hover:text-white`}
              >
                <NavIcon name="logout" className="h-5 w-5 shrink-0" />
                Sign Out
              </button>
            )}
          </footer>
        )}
      </div>
    </>,
    document.body,
  );
}
