"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { NotificationBell } from "./NotificationBell";
import { getFormatPalette } from "@/lib/format-palette";

export interface LeagueNavProps {
  leagueSlug: string;
  leagueName: string;
  currentPage: string;
  format: "auction" | "triple-crown" | "tvt";
  /** Optional: when provided, distinguishes TVT-8 / TVT-16 / TVT-32 in the format chip. */
  teamSize?: number | null;
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
  isLoggedIn,
  dashboardHref,
  onSignOut,
}: LeagueNavProps) {
  const isAuction = format === "auction";
  const isTripleCrown = format === "triple-crown";
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
        <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-xs sm:text-base font-bold text-slate-900 shrink-0">
          JPL
        </div>
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
            <NavLink href={`/${leagueSlug}/squad`} activeClass={activeClass} active={currentPage ==="squad"}>Squad</NavLink>
            <NavLink href={`/${leagueSlug}/players`} activeClass={activeClass} active={currentPage ==="players"}>Players</NavLink>
            {!auctionLive && (
              <NavLink href={`/${leagueSlug}/marketplace`} activeClass={activeClass} active={currentPage ==="marketplace"}>Marketplace</NavLink>
            )}
            <NavLink href={`/${leagueSlug}/finance`} activeClass={activeClass} active={currentPage ==="finance"}>Finance</NavLink>
            <NavLink href={`/${leagueSlug}/rules`} activeClass={activeClass} active={currentPage ==="rules"}>Rules</NavLink>
            <NavLink href={`/${leagueSlug}/help`} activeClass={activeClass} active={currentPage ==="help"}>Help</NavLink>
          </>
        ) : isTripleCrown ? (
          <>
            <NavLink href={`/${leagueSlug}/standings`} activeClass={activeClass} active={currentPage ==="standings"}>PL Standings</NavLink>
            <NavLink href={`/${leagueSlug}/fixtures`} activeClass={activeClass} active={currentPage ==="fixtures"}>PL Fixtures</NavLink>
            <NavLink href={`/${leagueSlug}/uefa-standings`} activeClass={activeClass} active={currentPage ==="uefa-standings"}>UEFA Standings</NavLink>
            <NavLink href={`/${leagueSlug}/uefa-fixtures`} activeClass={activeClass} active={currentPage ==="uefa-fixtures"}>UEFA Fixtures</NavLink>
            <NavLink href={`/${leagueSlug}/playoffs`} activeClass={activeClass} active={currentPage ==="playoffs"}>Playoffs</NavLink>
            <NavLink href={`/${leagueSlug}/winners`} activeClass={activeClass} active={currentPage ==="winners"}>Winners</NavLink>
            <NavLink href={`/${leagueSlug}/rules`} activeClass={activeClass} active={currentPage ==="rules"}>Rules</NavLink>
            <NavLink href={`/${leagueSlug}/help`} activeClass={activeClass} active={currentPage ==="help"}>Help</NavLink>
          </>
        ) : (
          <>
            <NavLink href={`/${leagueSlug}/standings`} activeClass={activeClass} active={currentPage ==="standings"}>Standings</NavLink>
            <NavLink href={`/${leagueSlug}/fixtures`} activeClass={activeClass} active={currentPage ==="fixtures"}>Fixtures</NavLink>
            <NavLink href={`/${leagueSlug}/playoffs`} activeClass={activeClass} active={currentPage ==="playoffs"}>Playoffs</NavLink>
            <NavLink href={`/${leagueSlug}/winners`} activeClass={activeClass} active={currentPage ==="winners"}>Winners</NavLink>
            <NavLink href={`/${leagueSlug}/rules`} activeClass={activeClass} active={currentPage ==="rules"}>Rules</NavLink>
            <NavLink href={`/${leagueSlug}/help`} activeClass={activeClass} active={currentPage ==="help"}>Help</NavLink>
          </>
        )}

        {/* Notifications */}
        {isLoggedIn && <NotificationBell />}

        {/* Sign In / Sign Out */}
        {isLoggedIn ? (
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
