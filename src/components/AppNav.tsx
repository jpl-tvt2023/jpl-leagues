"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { NavDrawer } from "./NavDrawer";
import { NotificationBell } from "./NotificationBell";
import { buildNavModel, type NavContext, type NavItem } from "@/lib/nav-links";
import { useAuctionLiveStatus } from "@/lib/use-auction-live-status";

export interface AppNavProps {
  context: NavContext;
  /** Which `NavItem.key` is the current page. Empty string means "none of them". */
  activeKey: string;
  brandHref: string;
  brandLabel: string;
  /** Format chip beside the brand. */
  brandBadge?: { label: string; bgClass: string; textClass: string } | null;
  /** Active-link colour on the desktop bar and in the drawer — usually `palette.badgeText`. */
  activeTextClass?: string;
  /** Active-row background in the drawer — usually `palette.badgeBg`. */
  activeBgClass?: string;
  /** Nav surface colour. Defaults to the app-wide translucent slate. */
  surfaceClass?: string;
  sticky?: boolean;
  /** Omitted on surfaces whose model resolves `auth` to "none" (e.g. the admin auction room). */
  onSignOut?: () => void;
}

function toneClass(tone: NavItem["tone"]): string {
  if (tone === "accent") return "text-orange-400 font-semibold transition";
  if (tone === "back") return "text-yellow-400 font-semibold transition";
  return "text-gray-300 hover:text-white transition";
}

/**
 * The one navigation shell for the whole app.
 *
 * At `lg` and up it renders the horizontal bar the app has always had. Below `lg` — phones
 * and tablets, where 9-15 links either scrolled sideways or wrapped onto four rows — the
 * links move into a side drawer behind a hamburger.
 *
 * Links come from `buildNavModel`, so every surface draws from one list. The notification
 * bell and the sign in/out control stay in the bar at every width: they are one tap each
 * and burying them behind a menu would be a regression.
 */
export function AppNav({
  context,
  activeKey,
  brandHref,
  brandLabel,
  brandBadge = null,
  activeTextClass = "text-yellow-400",
  activeBgClass = "bg-white/10",
  surfaceClass = "bg-slate-900/80",
  sticky = true,
  onSignOut,
}: AppNavProps) {
  const [open, setOpen] = useState(false);
  // `open` is intent, `rendered` is presence: they diverge for the length of the exit
  // animation, after which NavDrawer's onExited drops `rendered`.
  const [rendered, setRendered] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  const isAuctionLeague = context.surface === "league" && context.format === "auction";
  const auctionLive = useAuctionLiveStatus(
    context.surface === "league" ? context.leagueSlug : "",
    isAuctionLeague,
  );

  const model = buildNavModel(context, { auctionLive });

  // Next keeps the nav mounted across client navigations, so a route change has to close
  // the drawer explicitly.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const openDrawer = () => {
    setRendered(true);
    setOpen(true);
  };

  const closeDrawer = useCallback(() => {
    setOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  const handleExited = useCallback(() => setRendered(false), []);

  // Surfaces with a single link (or none) have nothing worth hiding behind a menu.
  const showHamburger = model.flat.length > 1;

  const authControl =
    model.auth.kind === "none" ? null : model.auth.kind === "signOut" ? (
      <button
        onClick={onSignOut}
        className="rounded-full bg-white/10 px-4 sm:px-6 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-white hover:bg-white/20 transition"
      >
        Sign Out
      </button>
    ) : (
      <Link
        href={model.auth.href}
        className="rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-4 sm:px-6 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
      >
        Sign In
      </Link>
    );

  return (
    <>
      <nav
        className={`${sticky ? "sticky top-0 z-50" : ""} flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 ${surfaceClass} backdrop-blur`}
      >
        <div className="flex min-w-0 items-center gap-2">
          {showHamburger && (
            <button
              ref={hamburgerRef}
              type="button"
              onClick={openDrawer}
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="app-nav-drawer"
              className="lg:hidden shrink-0 rounded-lg p-2 text-gray-300 transition hover:bg-white/10 hover:text-white"
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
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          )}

          <Link href={brandHref} className="flex min-w-0 items-center gap-2 shrink-0">
            <Logo className="h-8 w-8 sm:h-10 sm:w-10" />
            <span className="text-base sm:text-xl font-bold text-white hidden sm:inline truncate max-w-[180px] lg:max-w-none">
              {brandLabel}
            </span>
            {brandBadge && (
              <span
                className={`inline-block text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${brandBadge.bgClass} ${brandBadge.textClass}`}
                title={`Format: ${brandBadge.label}`}
              >
                {brandBadge.label}
              </span>
            )}
          </Link>
        </div>

        {/* Desktop links. Keeps `overflow-x-auto` so NotificationBell's existing
            fixed-positioning workaround stays valid when the bell sits alongside. */}
        <div
          className={`${showHamburger ? "hidden lg:flex" : "flex"} items-center gap-3 sm:gap-4 text-xs sm:text-sm lg:text-base overflow-x-auto whitespace-nowrap max-w-full -mx-1 px-1 [&>*]:shrink-0`}
        >
          {model.flat.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === activeKey ? "page" : undefined}
              className={
                item.key === activeKey
                  ? `${activeTextClass} font-semibold transition`
                  : toneClass(item.tone)
              }
            >
              {item.label}
            </Link>
          ))}
        </div>

        {/* The bell and the auth control are one tap each, so they stay in the bar at every
            width rather than moving into the drawer. Rendered ONCE — a second
            NotificationBell would double its 30s poll of /api/notifications even while
            hidden, since `display: none` does not stop effects. */}
        {(model.showNotificationBell || authControl) && (
          <div className="flex items-center gap-3 sm:gap-4 shrink-0">
            {model.showNotificationBell && <NotificationBell />}
            {authControl}
          </div>
        )}
      </nav>

      {rendered && (
        <NavDrawer
          open={open}
          groups={model.groups}
          activeKey={activeKey}
          brandHref={brandHref}
          brandLabel={brandLabel}
          brandBadge={brandBadge}
          activeBgClass={activeBgClass}
          activeTextClass={activeTextClass}
          onClose={closeDrawer}
          onExited={handleExited}
        />
      )}
    </>
  );
}
