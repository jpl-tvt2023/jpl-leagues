"use client";

import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { useLeague } from "@/lib/league-context";
import { AuctionRules } from "../_components/rules/AuctionRules";
import { ContinentalChampionshipRules } from "../_components/rules/ContinentalChampionshipRules";
import { TvtRules } from "../_components/rules/TvtRules";
import { FplClassicRules } from "../_components/rules/FplClassicRules";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
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
  const isFplClassic = league.format === FPL_CLASSIC_FORMAT;

  const variantLabel = isFplClassic
    ? "Public FPL Classic"
    : isAuction
    ? "Auction Format"
    : isContinentalChampionship
    ? "JPL Continental Championship (20 Teams)"
    : config.teamSize === 8
    ? "8-Team Format"
    : config.teamSize === 16
    ? "16-Team Format"
    : "32-Team Format";

  const title = isFplClassic
    ? "League Rules"
    : isAuction
    ? "Auction League Rules & Regulations"
    : isContinentalChampionship
    ? "JPL Continental Championship Rules & Regulations"
    : "TVT Rules & Regulations";

  return (
    <div className={`min-h-screen bg-gradient-to-b ${isFplClassic ? "from-slate-900 via-sky-900/40 to-slate-900" : "from-slate-900 via-purple-900 to-slate-900"}`}>
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="rules"
        format={isFplClassic ? "fpl-classic" : isAuction ? "auction" : isContinentalChampionship ? "continental-championship" : "tvt"}
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
            <span className={`rounded-full px-3 py-0.5 text-xs font-semibold border ${isFplClassic ? "bg-sky-500/20 border-sky-500/30 text-sky-200" : "bg-purple-500/20 border-purple-500/30 text-purple-300"}`}>
              {variantLabel}
            </span>
          </div>
        </div>

        {isFplClassic ? (
          <FplClassicRules
            scoringMetric={league.fplScoringMetric ?? "net"}
            winnerCutPercent={league.fplWinnerCutPercent ?? 30}
            startGameweek={league.startGameweek}
            fplLeagueId={league.fplLeagueId ?? null}
          />
        ) : isAuction ? (
          <AuctionRules tier={league.auctionTier ?? "complete"} releaseCycleGws={league.releaseCycleGws} />
        ) : isContinentalChampionship ? (
          <ContinentalChampionshipRules />
        ) : (
          <TvtRules config={config} />
        )}
      </div>
    </div>
  );
}
