"use client";

import { AppNav } from "./AppNav";
import { getFormatPalette } from "@/lib/format-palette";

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

/**
 * League-page navigation.
 *
 * A thin adapter over `AppNav` — the links themselves live in `src/lib/nav-links.ts` and
 * the chrome (desktop bar + mobile drawer) lives in `AppNav`. This wrapper exists only so
 * the ~20 league pages that already pass these props keep working unchanged; new call
 * sites should use `AppNav` directly.
 */
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
  const palette = getFormatPalette(format, teamSize);

  return (
    <AppNav
      context={{
        surface: "league",
        leagueSlug,
        format,
        auctionTier,
        isLoggedIn,
        dashboardHref,
      }}
      activeKey={currentPage}
      brandHref="/"
      brandLabel={leagueName || "League"}
      brandBadge={{ label: palette.label, bgClass: palette.badgeBg, textClass: palette.badgeText }}
      activeTextClass={palette.badgeText}
      activeBgClass={palette.badgeBg}
      onSignOut={onSignOut}
    />
  );
}
