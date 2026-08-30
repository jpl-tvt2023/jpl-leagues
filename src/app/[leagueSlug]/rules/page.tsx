"use client";

import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { useLeague } from "@/lib/league-context";
import { AuctionRules } from "../_components/rules/AuctionRules";
import { ContinentalChampionshipRules } from "../_components/rules/ContinentalChampionshipRules";
import { TvtRules } from "../_components/rules/TvtRules";
import type { LeagueConfig } from "../_components/rules/shared";

export default function LeagueRulesPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const { league, viewer } = useLeague();

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const config: LeagueConfig = {
    teamSize: league.teamSize,
    leagueStageEnd: league.playoffStartGw - 1,
    leagueName: league.name,
    enabledChips: league.enabledChips.length ? league.enabledChips : ["D", "W", "C"],
  };

  const isContinentalChampionship = league.format === "continental-championship";
  const isAuction = league.format === "auction";

  const variantLabel = isAuction
    ? "Auction Format"
    : isContinentalChampionship
    ? "JPL Continental Championship (20 Teams)"
    : config.teamSize === 8
    ? "8-Team Format"
    : config.teamSize === 16
    ? "16-Team Format"
    : "32-Team Format";

  const title = isAuction
    ? "Auction League Rules & Regulations"
    : isContinentalChampionship
    ? "JPL Continental Championship Rules & Regulations"
    : "TVT Rules & Regulations";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="rules"
        format={isAuction ? "auction" : isContinentalChampionship ? "continental-championship" : "tvt"}
        teamSize={league.teamSize}
        auctionTier={league.auctionTier ?? "complete"}
        isLoggedIn={viewer.authenticated}
        dashboardHref={viewer.dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-10">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-3">{title}</h1>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <p className="text-gray-400">{league.name || leagueSlug}</p>
            <span className="rounded-full bg-purple-500/20 border border-purple-500/30 px-3 py-0.5 text-purple-300 text-xs font-semibold">
              {variantLabel}
            </span>
          </div>
        </div>

        {isAuction ? <AuctionRules tier={league.auctionTier ?? "complete"} releaseCycleGws={league.releaseCycleGws} /> : isContinentalChampionship ? <ContinentalChampionshipRules /> : <TvtRules config={config} />}
      </div>
    </div>
  );
}
