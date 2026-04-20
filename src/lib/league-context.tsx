"use client";

import { createContext, useContext, type ReactNode } from "react";

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
