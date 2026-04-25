"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LeagueNav } from "@/components/LeagueNav";
import { useLeague } from "@/lib/league-context";
import { RoundColumn, usePlayoffsBracket } from "./shared";

export function TripleCrownPlayoffs() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const { league, viewer } = useLeague();
  const leagueName = league.name;
  const isLoggedIn = viewer.authenticated;
  const dashboardHref = viewer.dashboardHref;

  const { data, isLoading, refreshing, tempLiveScores, handleRefreshRound } = usePlayoffsBracket(leagueSlug);
  const [tcTab, setTcTab] = useState<"ucl" | "uel">("ucl");

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  if (isLoading) return <LoadingScreen variant="playoffs" />;

  if (!data) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center">
        <div className="text-red-400 text-xl">Failed to load playoffs bracket</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueName}
        currentPage="playoffs"
        format="triple-crown"
        isLoggedIn={isLoggedIn}
        dashboardHref={dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-white mb-2">Knockout Stage</h1>
          <p className="text-gray-400 text-sm">UEFA Champions League &amp; Europa League · Triple Crown</p>
        </div>

        <div className="flex gap-1 mb-8 bg-slate-800/50 rounded-lg p-1 w-fit">
          <button
            onClick={() => setTcTab("ucl")}
            className={`px-5 py-2 rounded-md text-sm font-semibold transition ${
              tcTab === "ucl" ? "bg-blue-600 text-white" : "text-gray-400 hover:text-white"
            }`}
          >
            ★ UCL
          </button>
          <button
            onClick={() => setTcTab("uel")}
            className={`px-5 py-2 rounded-md text-sm font-semibold transition ${
              tcTab === "uel" ? "bg-orange-600 text-white" : "text-gray-400 hover:text-white"
            }`}
          >
            ◆ Europa League
          </button>
        </div>

        {tcTab === "ucl" && (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="h-8 w-1 rounded-full bg-blue-500" />
              <div>
                <h2 className="text-xl font-bold text-white">UCL Knockouts</h2>
                <p className="text-blue-400 text-xs font-semibold uppercase tracking-wider">UEFA Champions League</p>
              </div>
            </div>
            {(data.tvt.qf?.length || data.tvt.sf?.length || data.tvt.final?.length) ? (
              <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 min-w-[480px]">
                  <RoundColumn title="Quarter-Finals" ties={data.tvt.qf ?? []} liveScores={data.liveScores} refreshingGw={refreshing} tempLiveScores={tempLiveScores} onRefreshRound={handleRefreshRound} className="border-l-2 border-blue-500/30 pl-3" />
                  <RoundColumn title="Semi-Finals" ties={data.tvt.sf ?? []} liveScores={data.liveScores} refreshingGw={refreshing} tempLiveScores={tempLiveScores} onRefreshRound={handleRefreshRound} className="border-l-2 border-blue-500/30 pl-3" />
                  <RoundColumn title="UCL Final 🏆" ties={data.tvt.final ?? []} liveScores={data.liveScores} refreshingGw={refreshing} tempLiveScores={tempLiveScores} onRefreshRound={handleRefreshRound} className="border-l-2 border-yellow-500/50 pl-3" />
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-5 py-6 text-sm text-blue-300">
                UCL bracket will be generated after the group stage (GW24).
              </div>
            )}
          </div>
        )}

        {tcTab === "uel" && (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="h-8 w-1 rounded-full bg-orange-500" />
              <div>
                <h2 className="text-xl font-bold text-white">Europa Knockouts</h2>
                <p className="text-orange-400 text-xs font-semibold uppercase tracking-wider">UEFA Europa League</p>
              </div>
            </div>
            {(() => {
              const uelQF = data.challenger.c31 ?? data.challenger.c34 ?? [];
              const uelSF = data.challenger.c35 ?? data.challenger.c37 ?? [];
              const uelFinal = data.challenger.c36 ?? data.challenger.c38 ?? [];
              const hasData = uelQF.length > 0 || uelSF.length > 0 || uelFinal.length > 0;
              return hasData ? (
                <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 min-w-[480px]">
                    <RoundColumn title="Quarter-Finals" ties={uelQF} liveScores={data.liveScores} refreshingGw={refreshing} tempLiveScores={tempLiveScores} onRefreshRound={handleRefreshRound} className="border-l-2 border-orange-500/30 pl-3" />
                    <RoundColumn title="Semi-Finals" ties={uelSF} liveScores={data.liveScores} refreshingGw={refreshing} tempLiveScores={tempLiveScores} onRefreshRound={handleRefreshRound} className="border-l-2 border-orange-500/30 pl-3" />
                    <RoundColumn title="Europa Final 🏆" ties={uelFinal} liveScores={data.liveScores} refreshingGw={refreshing} tempLiveScores={tempLiveScores} onRefreshRound={handleRefreshRound} className="border-l-2 border-orange-400/50 pl-3" />
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 px-5 py-6 text-sm text-orange-300">
                  Europa bracket will be generated after the group stage (GW24).
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
