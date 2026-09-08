"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Logo } from "./Logo";
import type { NavGroup } from "@/lib/nav-links";

/**
 * Exit-animation fallback. `prefers-reduced-motion` suppresses the transition entirely,
 * so `transitionend` never fires and the drawer would stay mounted forever without this.
 */
const CLOSE_ANIMATION_MS = 250;

export interface NavDrawerProps {
  /** Drives the slide: false starts the exit, which ends in `onExited`. */
  open: boolean;
  groups: NavGroup[];
  activeKey: string;
  brandHref: string;
  brandLabel: string;
  brandBadge?: { label: string; bgClass: string; textClass: string } | null;
  /** Palette classes for the active row. Falls back to a neutral highlight. */
  activeBgClass?: string;
  activeTextClass?: string;
  onClose: () => void;
  /** Called once the exit animation has finished; the parent unmounts the drawer here. */
  onExited: () => void;
}

function toneClass(tone: string | undefined): string {
  if (tone === "accent") return "text-orange-400 font-semibold";
  if (tone === "back") return "text-yellow-400 font-semibold";
  return "text-gray-300";
}

/**
 * The mobile/tablet navigation drawer.
 *
 * Portalled to `document.body` rather than rendered inside `<nav>`: the nav has
 * `backdrop-blur` (which creates a stacking context) and its desktop link row has
 * `overflow-x-auto` — the exact clipping trap `NotificationBell` documents and works
 * around. Portalling sidesteps both.
 *
 * Mounted only while open. An always-mounted-but-hidden drawer would put a second copy
 * of every link in the accessibility tree, which both breaks link-count assertions in
 * the e2e suite and makes screen-reader navigation ambiguous.
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
  onClose,
  onExited,
}: NavDrawerProps) {
  const [mounted, setMounted] = useState(false);
  const [painted, setPainted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Portals need a DOM; render nothing on the server pass. Same guard as HelpTip/EconomyCard.
  useEffect(() => setMounted(true), []);

  // The browser has to paint the off-screen position once before the transition to it has
  // anything to animate from, so the slide-in waits a frame past mount.
  useEffect(() => {
    if (!mounted) return;
    const raf = requestAnimationFrame(() => setPainted(true));
    return () => cancelAnimationFrame(raf);
  }, [mounted]);

  // Closing: `open` goes false, the panel slides back out, and the parent unmounts us.
  useEffect(() => {
    if (open) return;
    const t = setTimeout(onExited, CLOSE_ANIMATION_MS);
    return () => clearTimeout(t);
  }, [open, onExited]);

  const entered = open && painted;

  useEffect(() => {
    if (!mounted) return;
    closeRef.current?.focus();
  }, [mounted]);

  // Escape to dismiss — same listener shape as HelpTip. Outside clicks are handled by the
  // scrim's own onClick, so no pointerdown capture is needed here.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Scroll lock. No scrollbar-width compensation: the drawer only exists below `lg`,
  // where overlay scrollbars are the norm.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /**
   * `aria-modal="true"` promises the rest of the page is unreachable, so keyboard focus is
   * cycled inside the panel. Background `inert` is deliberately skipped: the page content
   * is not reachable from a body-portalled node, so a screen-reader virtual cursor can
   * still wander out. Accepted trade-off — keyboard is the common case.
   */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const selector = "a[href], button:not([disabled])";
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(selector);
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none ${
          entered ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      <div
        id="app-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Site navigation"
        ref={panelRef}
        onKeyDown={trapTab}
        className={`fixed inset-y-0 left-0 z-[71] flex h-full w-[86vw] max-w-xs flex-col overflow-y-auto overscroll-contain border-r border-white/10 bg-slate-900 shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none ${
          entered ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <Link href={brandHref} onClick={onClose} className="flex min-w-0 items-center gap-2">
            <Logo className="h-8 w-8 shrink-0" />
            <span className="truncate text-base font-bold text-white">{brandLabel}</span>
            {brandBadge && (
              <span
                className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${brandBadge.bgClass} ${brandBadge.textClass}`}
              >
                {brandBadge.label}
              </span>
            )}
          </Link>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close menu"
            className="shrink-0 rounded-full p-2 text-gray-400 transition hover:bg-white/10 hover:text-white"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="flex-1 py-2">
          {groups.map((group) => (
            <section key={group.id}>
              <h2 className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
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
                            ? `block border-l-2 border-current px-4 py-3 text-sm font-semibold ${activeBgClass} ${activeTextClass}`
                            : `block border-l-2 border-transparent px-4 py-3 text-sm transition hover:bg-white/5 hover:text-white ${toneClass(item.tone)}`
                        }
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

      </div>
    </>,
    document.body,
  );
}
