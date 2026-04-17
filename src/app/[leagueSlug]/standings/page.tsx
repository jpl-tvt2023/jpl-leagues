"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { LeagueNav } from "@/components/LeagueNav";
import { useParams } from "next/navigation";
import { StandingsTable } from "@/components/StandingsTable";
import { LoadingScreen } from "@/components/LoadingScreen";
import type { TeamStanding } from "@/types/standings";

interface AuctionStandingRow {
  teamId: string;
  teamName: string;
  abbreviation: string;
  totalPoints: number;
  purse: number;
  squadValue: number;
  rank: number;
}

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

export default function LeagueStandingsPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [groupA, setGroupA] = useState<TeamStanding[]>([]);
  const [groupB, setGroupB] = useState<TeamStanding[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestGameweek, setLatestGameweek] = useState<number>(0);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [leagueStageEnd, setLeagueStageEnd] = useState<number>(30);
  const [teamSize, setTeamSize] = useState<number>(32);
  const [groupsRevealed, setGroupsRevealed] = useState<boolean>(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [dashboardHref, setDashboardHref] = useState("/dashboard");
  const [leagueName, setLeagueName] = useState<string>("");
  const [leagueFormat, setLeagueFormat] = useState<string | null>(null);
  const [auctionStandings, setAuctionStandings] = useState<AuctionStandingRow[]>([]);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        setIsLoggedIn(res.ok && data.authenticated && (data.type === "team" || data.type === "admin" || data.type === "superadmin"));
        if (data.type === "admin" && data.adminLeagueId) setDashboardHref(`/admin/${data.adminLeagueId}`);
        else if (data.type === "superadmin") setDashboardHref("/admin");
      } catch {
        setIsLoggedIn(false);
      }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => {
        const league = (data.leagues || []).find((l: { slug: string; name: string; format?: string }) => l.slug === leagueSlug);
        if (league) {
          setLeagueName(league.name);
          setLeagueFormat(league.format ?? null);
        }
      })
      .catch(() => {});
  }, [leagueSlug]);

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

        if (data.format === "auction") {
          setAuctionStandings(data.standings || []);
          return;
        }

        setGroupA(data.groupA || []);
        setGroupB(data.groupB || []);
        if (data.leagueStageEnd) setLeagueStageEnd(data.leagueStageEnd);
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
  const isTripleCrown = leagueFormat === "triple-crown";
  const isAuction = leagueFormat === "auction";

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueName}
        currentPage="standings"
        format={leagueFormat === "auction" ? "auction" : leagueFormat === "triple-crown" ? "triple-crown" : "tvt"}
        isLoggedIn={isLoggedIn}
        dashboardHref={dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="standings" fullScreen={false} />
        ) : isAuction ? (
          <>
            <div className="text-center mb-10">
              <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">{leagueName || "Auction League"}</h1>
              <p className="text-[#00ff85] text-sm font-semibold uppercase tracking-widest">Auction · Total Points Race</p>
            </div>
            {error ? (
              <div className="text-center text-red-400 py-12">{error}</div>
            ) : auctionStandings.length === 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                  <h2 className="text-xl font-semibold text-white mb-2">No Standings Yet</h2>
                  <p className="text-gray-400">Standings will appear here once the first gameweek has been scored.</p>
                </div>
              </div>
            ) : (
              <div className="max-w-5xl mx-auto">
                <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur">
                  <table className="w-full text-left">
                    <thead className="bg-white/10 text-xs uppercase tracking-wider text-gray-300">
                      <tr>
                        <th className="px-4 py-3">#</th>
                        <th className="px-4 py-3">Team</th>
                        <th className="px-4 py-3 text-right">Total Points</th>
                        <th className="px-4 py-3 text-right">Purse</th>
                        <th className="px-4 py-3 text-right">Squad Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auctionStandings.map((row) => (
                        <tr key={row.teamId} className="border-t border-white/5 hover:bg-white/5 transition">
                          <td className="px-4 py-3 font-bold text-white">{row.rank}</td>
                          <td className="px-4 py-3">
                            <div className="font-semibold text-white">{row.teamName}</div>
                            <div className="text-xs text-gray-400">{row.abbreviation}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-[#00ff85]">{row.totalPoints}</td>
                          <td className="px-4 py-3 text-right font-mono text-green-300">{formatCurrency(row.purse)}</td>
                          <td className="px-4 py-3 text-right font-mono text-gray-200">{formatCurrency(row.squadValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-6 text-center text-xs text-gray-500">
                  Total Points = Cumulative sum of all 14 owned players&apos; gameweek scores · Squad Value = Sum of FMV (purchase price + points-based appreciation)
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-center mb-12">
              <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">
                {isTripleCrown ? leagueName || "League" : "League Standings"}
              </h1>
              {isTripleCrown && (
                <p className="text-[#00ff85] text-sm font-semibold uppercase tracking-widest mb-2">
                  Premier League · 2025/26 Season
                </p>
              )}
              {!isTripleCrown && (
                <p className="text-gray-400">
                  {latestGameweek > 0
                    ? `After Gameweek ${latestGameweek} · League Stage`
                    : totalTeams > 0
                      ? "League Stage · No matches played yet"
                      : "League Stage · Awaiting teams"
                  }
                </p>
              )}
            </div>

            {/* Legend */}
            {!isTripleCrown && (
            <div className="flex flex-wrap items-center justify-center gap-6 mb-8 text-sm">
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
                <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                  <h2 className="text-xl font-semibold text-white mb-2">No Teams Yet</h2>
                  <p className="text-gray-400">Standings will appear here once teams are registered and matches are played.</p>
                </div>
              </div>
            ) : latestGameweek === 0 && totalTeams > 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                  <h2 className="text-xl font-semibold text-white mb-2">Standings Coming Soon</h2>
                  <p className="text-gray-400 mb-4">Standings will be updated once:</p>
                  <ul className="text-gray-400 text-sm space-y-2">
                    <li>✓ {teamSize === 32 ? "Admin assigns teams to groups" : "Teams are registered"}</li>
                    <li>✓ Admin generates fixtures</li>
                    <li>✓ Matches are played</li>
                  </ul>
                </div>
              </div>
            ) : !groupsRevealed && groupB.length > 0 ? (
              /* Groups not yet revealed — show all teams in one table without group labels */
              <div className="max-w-3xl mx-auto">
                <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-center">
                  <p className="text-yellow-300 text-sm font-semibold">Groups have not been revealed yet</p>
                  <p className="text-yellow-400/70 text-xs mt-1">Group assignments will be announced by the admin before the season starts.</p>
                </div>
                <StandingsTable teams={[...groupA, ...groupB]} group={undefined} isTripleCrown={isTripleCrown} />
              </div>
            ) : (
              <div className={`grid gap-8 ${groupB.length > 0 ? "lg:grid-cols-2" : "max-w-2xl mx-auto"}`}>
                <StandingsTable teams={groupA} group={groupB.length > 0 ? "A" : undefined} isTripleCrown={isTripleCrown} />
                {groupB.length > 0 && <StandingsTable teams={groupB} group="B" isTripleCrown={isTripleCrown} />}
              </div>
            )}

            <div className="mt-8 text-center text-sm text-gray-500">
              MP = Matches Played · W = Won · D = Drawn · L = Lost{!isTripleCrown && " · CP/BP = Chips & Bonus Points"} · Pts = League Points · Scores = Total FPL Score
            </div>
          </>
        )}
      </div>
    </div>
  );
}
