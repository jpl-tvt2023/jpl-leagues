"use client";

import { useLeague, useEnforceFormat } from "@/lib/league-context";
import { AuctionGwResults } from "../_components/gw-results/AuctionGwResults";

export default function LeagueGwResultsPage() {
  useEnforceFormat(["auction"]);
  useLeague();
  return <AuctionGwResults />;
}
