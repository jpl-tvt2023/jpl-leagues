"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
import { NavDrawer } from "./NavDrawer";
import { BottomNav } from "./BottomNav";
import { NotificationBell } from "./NotificationBell";
import { NavIcon } from "./icons/NavIcon";
import { AccountMenu, DrawerAccountSection } from "./AccountSwitcher";
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
  /**
   * Phone app-bar title. Defaults to the active link's label ("Standings"), then `brandLabel`.
   * Pass it for pages that are not themselves a nav link ("Change password").
   */
  title?: string;
  /** Suppress the phone bottom navigation bar (e.g. the live auction room needs the full height). */
  hideBottomNav?: boolean;
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
 * At `lg` and up it renders the horizontal bar the app has always had. Below `lg` — phones and
 * tablets — it is an Android-style shell instead:
 *  - a Material top app bar: menu button, the current page's title over the league name, and the
 *    one-tap actions (notifications, Sign In);
 *  - the navigation drawer behind the menu button, holding every link, grouped, plus Sign Out;
 *  - a bottom navigation bar with the format's four most-used pages (`model.bottom`).
 *
 * Links come from `buildNavModel`, so every surface draws from one list.
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
  title,
  hideBottomNav = false,
  onSignOut,
}: AppNavProps) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  const isAuctionLeague = context.surface === "league" && context.format === "auction";
  const auctionLive = useAuctionLiveStatus(
    context.surface === "league" ? context.leagueSlug : "",
    isAuctionLeague,
  );

  const model = buildNavModel(context, { auctionLive });

  // Next keeps the nav mounted across client navigations, so a route change has to close the
  // drawer explicitly. Adjusting state during render (not in an effect) avoids a wasted paint
  // of the open drawer over the new page.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  // Material's "scrolled" app bar: flat at the top of the page, lifted once content slides under.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const openDrawer = useCallback(() => setOpen(true), []);
  const closeDrawer = useCallback(() => {
    setOpen(false);
    hamburgerRef.current?.focus();
  }, []);

  // Surfaces with a single link (or none) have nothing worth hiding behind a menu.
  const showHamburger = model.flat.length > 1;
  const showBottomNav = !hideBottomNav && model.bottom.length > 0;

  const activeItem = model.flat.find((i) => i.key === activeKey);
  const pageTitle = title ?? activeItem?.label ?? brandLabel;
  // The league name moves under the title once the title is the page's own name.
  const showSubtitle = pageTitle !== brandLabel;

  const signedIn = model.auth.kind === "signOut";

  // Account switcher + Sign Out. Below `lg` these live in the drawer whenever there is a drawer —
  // on Android the account actions belong in the navigation drawer, not in the app bar.
  const accountMenu = signedIn ? (
    <AccountMenu onSignOut={onSignOut} className={showHamburger ? "hidden lg:block" : "block"} />
  ) : null;

  const signInLink =
    model.auth.kind === "signIn" ? (
      <Link
        href={model.auth.href}
        className="inline-flex items-center rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-4 lg:px-6 py-1.5 lg:py-2 text-xs lg:text-sm font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
      >
        Sign In
      </Link>
    ) : null;

  return (
    <>
      <nav
        aria-label="Main"
        className={`${sticky ? "sticky top-0 z-50" : ""} border-b border-white/10 ${surfaceClass} backdrop-blur pt-[env(safe-area-inset-top)] transition-shadow ${
          scrolled ? "shadow-lg shadow-black/40 lg:shadow-none" : ""
        }`}
      >
        <div className="flex min-h-14 items-center gap-1 px-1 sm:px-3 lg:justify-between lg:gap-2 lg:px-12 lg:py-4">
          {showHamburger && (
            <button
              ref={hamburgerRef}
              type="button"
              onClick={openDrawer}
              aria-label="Open menu"
              aria-expanded={open}
              aria-controls="app-nav-drawer"
              className="lg:hidden flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-gray-200 transition hover:bg-white/10 active:bg-white/15"
            >
              <NavIcon name="menu" />
            </button>
          )}

          {/* Brand. Desktop always; phones only when there is no drawer to carry it. */}
          <Link
            href={brandHref}
            className={`${showHamburger ? "hidden lg:flex" : "flex pl-2 lg:pl-0"} min-w-0 items-center gap-2 shrink-0`}
          >
            <Logo className="h-8 w-8 lg:h-10 lg:w-10" />
            <span className="hidden lg:inline text-xl font-bold text-white truncate">{brandLabel}</span>
            {brandBadge && (
              <span
                className={`hidden lg:inline-block text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${brandBadge.bgClass} ${brandBadge.textClass}`}
                title={`Format: ${brandBadge.label}`}
              >
                {brandBadge.label}
              </span>
            )}
          </Link>

          {/* Phone/tablet title block (Material top app bar). */}
          <div className="min-w-0 flex-1 px-2 lg:hidden">
            <div className="truncate text-[17px] font-semibold leading-tight text-white">{pageTitle}</div>
            {showSubtitle && (
              <p className="flex min-w-0 items-center gap-1.5 text-xs leading-tight text-gray-400">
                <span className="truncate">{brandLabel}</span>
                {brandBadge && (
                  <span
                    className={`shrink-0 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wider ${brandBadge.bgClass} ${brandBadge.textClass}`}
                  >
                    {brandBadge.label}
                  </span>
                )}
              </p>
            )}
          </div>

          {/* Desktop links (and phone links on drawer-less surfaces). Keeps `overflow-x-auto` so
              NotificationBell's fixed-positioning workaround stays valid alongside it. */}
          <div
            className={`${showHamburger ? "hidden lg:flex" : "flex mr-2 lg:mr-0"} items-center gap-3 sm:gap-4 text-xs sm:text-sm lg:text-base overflow-x-auto whitespace-nowrap max-w-full -mx-1 px-1 [&>*]:shrink-0`}
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

          {/* The bell and Sign In are one tap each, so they stay in the bar at every width.
              Rendered ONCE — a second NotificationBell would double its 30s poll of
              /api/notifications even while hidden, since `display: none` does not stop effects. */}
          {(model.showNotificationBell || accountMenu || signInLink) && (
            <div className="flex items-center gap-1 pr-2 sm:gap-3 lg:gap-4 lg:pr-0 shrink-0">
              {model.showNotificationBell && <NotificationBell />}
              {accountMenu}
              {signInLink}
            </div>
          )}
        </div>
      </nav>

      <NavDrawer
        open={open}
        groups={model.groups}
        activeKey={activeKey}
        brandHref={brandHref}
        brandLabel={brandLabel}
        brandBadge={brandBadge}
        activeBgClass={activeBgClass}
        activeTextClass={activeTextClass}
        onSignOut={signedIn ? onSignOut : undefined}
        accountSection={signedIn ? <DrawerAccountSection onNavigate={closeDrawer} /> : undefined}
        onClose={closeDrawer}
      />

      {showBottomNav && (
        <BottomNav
          items={model.bottom}
          activeKey={activeKey}
          activeBgClass={activeBgClass}
          activeTextClass={activeTextClass}
          // The "More" slot only earns its place when the drawer holds pages the bar doesn't.
          onMore={model.flat.length > model.bottom.length ? openDrawer : undefined}
          moreExpanded={open}
        />
      )}
    </>
  );
}
