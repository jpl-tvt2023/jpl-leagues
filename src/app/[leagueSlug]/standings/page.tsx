"use client";

import { useLeague } from "@/lib/league-context";
import { AuctionStandings } from "../_components/standings/AuctionStandings";
import { ClassicStandings } from "../_components/standings/ClassicStandings";
import { FplClassicStandings } from "../_components/standings/FplClassicStandings";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";

export default function LeagueStandingsPage() {
  const { league } = useLeague();
  if (league.format === "auction") return <AuctionStandings />;
  // ⚠️ Must come before the ClassicStandings fallthrough below. Forgetting this branch does not
  // 404 — it silently renders the TVT standings table (which calls /api/standings and finds no
  // teams/fixtures for this league) and can write an empty payload into that league's own
  // standings cache key. See docs/plan risk notes on this exact line.
  if (league.format === FPL_CLASSIC_FORMAT) return <FplClassicStandings />;
  return <ClassicStandings />;
}
