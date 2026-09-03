"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { NotificationBell } from "./NotificationBell";
import { getFormatPalette } from "@/lib/format-palette";
import { Logo } from "./Logo";

export interface LeagueNavProps {
  leagueSlug: string;
  leagueName: string;
  currentPage: string;
  format: "auction" | "continental-championship" | "tvt" | "fpl-classic";
  /** Optional: when provided, distinguishes TVT-8 / TVT-16 / TVT-32 in the format chip. */
  teamSize?: number | null;
  /** Auction-only: "primary" hides the Marketplace tab (trades disabled). Defaults to "complete". */
  auctionTier?: "primary" | "complete" | null;
  isLoggedIn: boolean;
  dashboardHref: string;
  onSignOut: () => void;
}

function NavLink({
  href,
  active,
  activeClass,
  children,
}: {
  href: string;
  active: boolean;
  activeClass: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? `${activeClass} font-semibold transition`
          : "text-gray-300 hover:text-white transition"
      }
    >
      {children}
    </Link>
  );
}

export function LeagueNav({
  leagueSlug,
  leagueName,
  currentPage,
  format,
  teamSize = null,
  auctionTier = null,
  isLoggedIn,
  dashboardHref,
  onSignOut,
}: LeagueNavProps) {
  const isAuction = format === "auction";
  const isContinentalChampionship = format === "continental-championship";
  // Public, read-only, no login accounts — isLoggedIn is always false here in practice, but the
  // nav also suppresses the Sign In invitation itself: there is nothing to sign in TO.
  const isFplClassic = format === "fpl-classic";
  const isPrimaryTier = isAuction && auctionTier === "primary";
  const palette = getFormatPalette(format, teamSize);
  const activeClass = palette.badgeText; // active link uses the palette accent color

  const [auctionLive, setAuctionLive] = useState(false);

  useEffect(() => {
    if (!isAuction) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`/api/auction/live-status?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setAuctionLive(!!data.live);
      } catch {
        // ignore
      }
    };
    check();
    const t = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isAuction, leagueSlug]);

  return (
    <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 bg-slate-900/80 backdrop-blur">
      <Link href="/" className="flex items-center gap-2 shrink-0">
        <Logo className="h-8 w-8 sm:h-10 sm:w-10" />
        <span className="text-base sm:text-xl font-bold text-white hidden sm:inline truncate max-w-[180px] lg:max-w-none">{leagueName || "League"}</span>
        <span
          className={`inline-block text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${palette.badgeBg} ${palette.badgeText}`}
          title={`Format: ${palette.label}`}
        >
          {palette.label}
        </span>
      </Link>

      <div className="flex items-center gap-3 sm:gap-4 text-xs sm:text-sm lg:text-base overflow-x-auto whitespace-nowrap scrollbar-thin scrollbar-thumb-white/10 max-w-full -mx-1 px-1 [&>*]:shrink-0">
        {/* Dashboard / All Leagues */}
        <NavLink href={isLoggedIn ? dashboardHref : "/"} activeClass={activeClass} active={currentPage ==="dashboard"}>
          {isLoggedIn ? "Dashboard" : "All Leagues"}
        </NavLink>

        {isAuction ? (
          <>
            <NavLink href={`/${leagueSlug}/standings`} activeClass={activeClass} active={currentPage ==="standings"}>Standings</NavLink>
            <NavLink href={`/${leagueSlug}/gw-results`} activeClass={activeClass} active={currentPage ==="gw-results"}>GW Results</NavLink>
            <NavLink href={`/${leagueSlug}/teams`} activeClass={activeClass} active={currentPage ==="teams"}>Teams</NavLink>
            <NavLink href={`/${leagueSlug}/auction`} activeClass={activeClass} active={currentPage ==="auction"}>Auction</NavLink>
            {isLoggedIn && (
              <NavLink href="/dashboard#wishlist" activeClass={activeClass} active={false}>Wishlist</NavLink>
            )}
            <NavLink href={`/${leagueSlug}/squad`} activeClass={activeClass} active={currentPage ==="squad"}>Squad</NavLink>
            <NavLink href={`/${leagueSlug}/players`} activeClass={activeClass} active={currentPage ==="players"}>Players</NavLink>
            {/* Trades are gated by auctionLive (mid-auction freeze) AND by tier (Primary disables). */}
            {!auctionLive && !isPrimaryTier && (
              <NavLink href={`/${leagueSlug}/marketplace`} activeClass={activeClass} active={currentPage ==="marketplace"}>Marketplace</NavLink>
            )}
            <NavLink href={`/${leagueSlug}/finance`} activeClass={activeClass} active={currentPage ==="finance"}>Finance</NavLink>
            <NavLink href={`/${leagueSlug}/rules`} activeClass={activeClass} active={currentPage ==="rules"}>Rules</NavLink>
            <NavLink href={`/${leagueSlug}/help`} activeClass={activeClass} active={currentPage ==="help"}>Help</NavLink>
            {isLoggedIn && (
              <NavLink href={`/${leagueSlug}/feedback`} activeClass={activeClass} active={currentPage ==="feedback"}>Feedback</NavLink>
            )}
          </>
        ) : isContinentalChampionship ? (
          <>
            <NavLink href={`/${leagueSlug}/standings`} activeClass={activeClass} active={currentPage ==="standings"}>JPL Standings</NavLink>
            <NavLink href={`/${leagueSlug}/fixtures`} activeClass={activeClass} active={currentPage ==="fixtures"}>JPL Fixtures</NavLink>
            <NavLink href={`/${leagueSlug}/jpl-cup-standings`} activeClass={activeClass} active={currentPage ==="jpl-cup-standings"}>JPL Cup Standings</NavLink>
            <NavLink href={`/${leagueSlug}/jpl-cup-fixtures`} activeClass={activeClass} active={currentPage ==="jpl-cup-fixtures"}>JPL Cup Fixtures</NavLink>
            <NavLink href={`/${leagueSlug}/playoffs`} activeClass={activeClass} active={currentPage ==="playoffs"}>Playoffs</NavLink>
            <NavLink href={`/${leagueSlug}/winners`} activeClass={activeClass} active={currentPage ==="winners"}>Winners</NavLink>
            <NavLink href={`/${leagueSlug}/rules`} activeClass={activeClass} active={currentPage ==="rules"}>Rules</NavLink>
            <NavLink href={`/${leagueSlug}/help`} activeClass={activeClass} active={currentPage ==="help"}>Help</NavLink>
            {isLoggedIn && (
              <NavLink href={`/${leagueSlug}/feedback`} activeClass={activeClass} active={currentPage ==="feedback"}>Feedback</NavLink>
            )}
          </>
        ) : isFplClassic ? (
          <>
            <NavLink href={`/${leagueSlug}/standings`} activeClass={activeClass} active={currentPage ==="standings"}>Standings</NavLink>
            <NavLink href={`/${leagueSlug}/rules`} activeClass={activeClass} active={currentPage ==="rules"}>Rules</NavLink>
          </>
        ) : (
          <>
            <NavLink href={`/${leagueSlug}/standings`} activeClass={activeClass} active={currentPage ==="standings"}>Standings</NavLink>
            <NavLink href={`/${leagueSlug}/fixtures`} activeClass={activeClass} active={currentPage ==="fixtures"}>Fixtures</NavLink>
            <NavLink href={`/${leagueSlug}/fpl-league`} activeClass={activeClass} active={currentPage ==="fpl-league"}>FPL League</NavLink>
            <NavLink href={`/${leagueSlug}/playoffs`} activeClass={activeClass} active={currentPage ==="playoffs"}>Playoffs</NavLink>
            <NavLink href={`/${leagueSlug}/winners`} activeClass={activeClass} active={currentPage ==="winners"}>Winners</NavLink>
            <NavLink href={`/${leagueSlug}/rules`} activeClass={activeClass} active={currentPage ==="rules"}>Rules</NavLink>
            <NavLink href={`/${leagueSlug}/help`} activeClass={activeClass} active={currentPage ==="help"}>Help</NavLink>
            {isLoggedIn && (
              <NavLink href={`/${leagueSlug}/feedback`} activeClass={activeClass} active={currentPage ==="feedback"}>Feedback</NavLink>
            )}
          </>
        )}

        {isLoggedIn && (
          <NavLink href="/settings" activeClass={activeClass} active={currentPage === "settings"}>Settings</NavLink>
        )}

        {/* Notifications */}
        {isLoggedIn && <NotificationBell />}

        {/* Sign In / Sign Out — omitted entirely for fpl-classic: a public, read-only format
            with no login accounts has nothing to sign in to. */}
        {isFplClassic ? null : isLoggedIn ? (
          <button
            onClick={onSignOut}
            className="rounded-full bg-white/10 px-4 sm:px-6 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-white hover:bg-white/20 transition"
          >
            Sign Out
          </button>
        ) : (
          <Link
            href="/signin"
            className="rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-4 sm:px-6 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
          >
            Sign In
          </Link>
        )}
      </div>
    </nav>
  );
}
