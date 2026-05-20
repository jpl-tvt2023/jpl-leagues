"use client";

import { createContext, useContext, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { getFormatPalette, type FormatPalette } from "@/lib/format-palette";

export type LeagueFormat = "tvt" | "triple-crown" | "auction";

export interface LeagueInfo {
  id: string;
  slug: string;
  name: string;
  sport: string;
  format: string; // "tvt" | "auction" | "triple-crown"
  season: string;
  teamSize: number;
  groupCount: number;
  playoffStartGw: number;
  enabledChips: string[];
  initialBudget: number;
  // Auction-only — "primary" disables trades + slot expansion. Default "complete" for legacy
  // (TVT/triple-crown leagues default to "complete" too but never act on it).
  auctionTier?: "primary" | "complete";
}

export interface ViewerInfo {
  authenticated: boolean;
  type: "team" | "admin" | "superadmin" | null;
  dashboardHref: string;
  teamId?: string;
  userId?: string;
  adminLeagueId?: string | null;
}

export interface LeagueContextValue {
  league: LeagueInfo;
  viewer: ViewerInfo;
}

const LeagueContext = createContext<LeagueContextValue | null>(null);

export function LeagueProvider({
  value,
  children,
}: {
  value: LeagueContextValue;
  children: ReactNode;
}) {
  return <LeagueContext.Provider value={value}>{children}</LeagueContext.Provider>;
}

export function useLeague(): LeagueContextValue {
  const ctx = useContext(LeagueContext);
  if (!ctx) {
    throw new Error("useLeague must be used within a LeagueProvider (under /[leagueSlug]/*)");
  }
  return ctx;
}

// Guard for pages that only make sense for specific league formats. Renders
// the 404 page if the current league's format isn't in the allowed list.
// Call at the top of a page component, before any other hooks that depend
// on the format being valid.
export function useEnforceFormat(allowed: readonly LeagueFormat[]): void {
  const { league } = useLeague();
  if (!allowed.includes(league.format as LeagueFormat)) {
    notFound();
  }
}

/**
 * Resolve the visual palette for the current league. Use whenever a chrome
 * surface should look format-aware (header chip, hero accents, top borders).
 * Returns a stable object — pure function of (format, teamSize) under the hood.
 */
export function useFormatPalette(): FormatPalette {
  const { league } = useLeague();
  return getFormatPalette(league.format, league.teamSize);
}
