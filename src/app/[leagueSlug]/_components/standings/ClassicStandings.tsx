"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { StandingsTable } from "@/components/StandingsTable";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague } from "@/lib/league-context";
import type { TeamStanding } from "@/types/standings";

export function ClassicStandings() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const { league, viewer } = useLeague();
  const leagueName = league.name;
  const leagueFormat = league.format;
  const isLoggedIn = viewer.authenticated;
  const dashboardHref = viewer.dashboardHref;

  const [groupA, setGroupA] = useState<TeamStanding[]>([]);
  const [groupB, setGroupB] = useState<TeamStanding[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestGameweek, setLatestGameweek] = useState<number>(0);
  const [teamSize, setTeamSize] = useState<number>(league.teamSize);
  const [groupsRevealed, setGroupsRevealed] = useState<boolean>(false);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  useEffect(() => {
    const fetchStandings = async () => {
      try {
        const response = await fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (!response.ok) throw new Error("Failed to fetch standings");
        const data = await response.json();
        setGroupA(data.groupA || []);
        setGroupB(data.groupB || []);
        if (data.teamSize) setTeamSize(data.teamSize);
        setGroupsRevealed(data.groupsRevealed === true);
        const stageEnd: number = data.leagueStageEnd ?? 30;
        const maxPlayed = Math.min(
          Math.max(
            ...(data.groupA ?? []).map((t: TeamStanding) => t.played),
            ...(data.groupB ?? []).map((t: TeamStanding) => t.played),
            0
          ),
          stageEnd
        );
        setLatestGameweek(maxPlayed);
      } catch (err) {
        console.error("Error fetching standings:", err);
        setError("Failed to load standings. Please try again later.");
      } finally {
        setIsLoading(false);
      }
    };
    if (leagueSlug) fetchStandings();
  }, [leagueSlug]);

  const totalTeams = groupA.length + groupB.length;
  const isContinentalChampionship = leagueFormat === "continental-championship";

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueName}
        currentPage="standings"
        format={isContinentalChampionship ? "continental-championship" : "tvt"}
        teamSize={teamSize}
        isLoggedIn={isLoggedIn}
        dashboardHref={dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="standings" fullScreen={false} />
        ) : (
          <>
            <div className="text-center mb-8 sm:mb-12">
              <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">
                {isContinentalChampionship ? leagueName || "League" : "League Standings"}
              </h1>
              {isContinentalChampionship && (
                <p className="text-[#00ff85] text-sm font-semibold uppercase tracking-widest mb-2">
                  JPL · 2025/26 Season
                </p>
              )}
              {!isContinentalChampionship && (
                <p className="text-gray-400">
                  {latestGameweek > 0
                    ? `After Gameweek ${latestGameweek} · League Stage`
                    : totalTeams > 0
                      ? "League Stage · No matches played yet"
                      : "League Stage · Awaiting teams"
                  }
                </p>
              )}
              {latestGameweek > 0 && (
                <p className="text-[11px] text-gray-500 mt-2">▲/▼ shows league rank change vs previous GW</p>
              )}
            </div>

            {!isContinentalChampionship && (
              <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 mb-6 sm:mb-8 text-xs sm:text-sm">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-green-500"></span>
                  <span className="text-gray-400">Title Play-offs (1-{teamSize === 8 ? 4 : 8})</span>
                </div>
                {teamSize !== 8 && (
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-yellow-500"></span>
                    <span className="text-gray-400">Challenger Series (9-14)</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-red-500"></span>
                  <span className="text-gray-400">Eliminated ({teamSize === 8 ? "5-8" : "15-16"})</span>
                </div>
              </div>
            )}

            {error ? (
              <div className="text-center text-red-400 py-12">{error}</div>
            ) : totalTeams === 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
                  <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">No Teams Yet</h2>
                  <p className="text-sm sm:text-base text-gray-400">Standings will appear here once teams are registered and matches are played.</p>
                </div>
              </div>
            ) : latestGameweek === 0 && totalTeams > 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
                  <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">Standings Coming Soon</h2>
                  <p className="text-gray-400 mb-4">Standings will be updated once:</p>
                  <ul className="text-gray-400 text-sm space-y-2">
                    <li>✓ {teamSize === 32 ? "Admin assigns teams to groups" : "Teams are registered"}</li>
                    <li>✓ Admin generates fixtures</li>
                    <li>✓ Matches are played</li>
                  </ul>
                </div>
              </div>
            ) : !groupsRevealed && groupB.length > 0 ? (
              <div className="max-w-3xl mx-auto">
                <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-center">
                  <p className="text-yellow-300 text-sm font-semibold">Groups have not been revealed yet</p>
                  <p className="text-yellow-400/70 text-xs mt-1">Group assignments will be announced by the admin before the season starts.</p>
                </div>
                <StandingsTable teams={[...groupA, ...groupB]} group={undefined} isContinentalChampionship={isContinentalChampionship} />
              </div>
            ) : (
              <div className={`grid gap-6 sm:gap-8 ${groupB.length > 0 ? "lg:grid-cols-2" : "max-w-2xl mx-auto"}`}>
                <StandingsTable teams={groupA} group={groupB.length > 0 ? "A" : undefined} isContinentalChampionship={isContinentalChampionship} />
                {groupB.length > 0 && <StandingsTable teams={groupB} group="B" isContinentalChampionship={isContinentalChampionship} />}
              </div>
            )}

            <div className="mt-6 sm:mt-8 text-center text-xs sm:text-sm text-gray-500 px-2">
              MP = Matches Played · W = Won · D = Drawn · L = Lost{!isContinentalChampionship && " · CP/BP = Chips & Bonus Points"} · Pts = League Points · Scores = Total FPL Score
            </div>
          </>
        )}
      </div>
    </div>
  );
}
