"use client";

import { useLeague } from "@/lib/league-context";
import { AuctionStandings } from "../_components/standings/AuctionStandings";
import { ClassicStandings } from "../_components/standings/ClassicStandings";

export default function LeagueStandingsPage() {
  const { league } = useLeague();
  if (league.format === "auction") return <AuctionStandings />;
  return <ClassicStandings />;
}
