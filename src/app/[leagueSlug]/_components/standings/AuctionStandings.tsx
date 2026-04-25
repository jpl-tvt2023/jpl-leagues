"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague } from "@/lib/league-context";

interface AuctionGwHistoryEntry {
  gw: number;
  points: number;
  rank: number;
  payout: number;
}

interface AuctionStandingRow {
  teamId: string;
  teamName: string;
  abbreviation: string;
  totalPoints: number;
  purse: number;
  squadValue: number;
  rank: number;
  gwHistory: AuctionGwHistoryEntry[];
}

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

export function AuctionStandings() {
  const params = useParams();
  const searchParams = useSearchParams();
  const leagueSlug = params.leagueSlug as string;
  const gwParam = searchParams.get("gw");
  const selectedGw = gwParam ? parseInt(gwParam, 10) : null;

  const { league, viewer } = useLeague();
  const leagueName = league.name;
  const isLoggedIn = viewer.authenticated;
  const dashboardHref = viewer.dashboardHref;

  const [auctionStandings, setAuctionStandings] = useState<AuctionStandingRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        setAuctionStandings(data.standings || []);
      } catch (err) {
        console.error("Error fetching standings:", err);
        setError("Failed to load standings. Please try again later.");
      } finally {
        setIsLoading(false);
      }
    };
    if (leagueSlug) fetchStandings();
  }, [leagueSlug]);

  const perGwRows = useMemo(() => {
    if (!selectedGw) return [];
    const rows = auctionStandings
      .map((s) => {
        const entry = s.gwHistory?.find((g) => g.gw === selectedGw);
        if (!entry) return null;
        return {
          teamId: s.teamId,
          teamName: s.teamName,
          abbreviation: s.abbreviation,
          points: entry.points,
          payout: entry.payout,
          gwRank: entry.rank,
          squadValue: s.squadValue,
          purse: s.purse,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    rows.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (a.squadValue !== b.squadValue) return a.squadValue - b.squadValue;
      return b.purse - a.purse;
    });
    return rows.map((r, i) => ({ ...r, rank: i + 1 }));
  }, [selectedGw, auctionStandings]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueName}
        currentPage="standings"
        format="auction"
        isLoggedIn={isLoggedIn}
        dashboardHref={dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="standings" fullScreen={false} />
        ) : (
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
              <div className="max-w-5xl mx-auto space-y-8">
                {selectedGw && perGwRows.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-lg font-bold text-white">Gameweek {selectedGw} Leaderboard</h2>
                      <Link href={`/${leagueSlug}/standings`} className="text-xs text-yellow-400 hover:text-yellow-300">
                        Clear filter →
                      </Link>
                    </div>
                    <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/5 overflow-hidden backdrop-blur">
                      <table className="w-full text-left">
                        <thead className="bg-white/10 text-xs uppercase tracking-wider text-gray-300">
                          <tr>
                            <th className="px-4 py-3">#</th>
                            <th className="px-4 py-3">Team</th>
                            <th className="px-4 py-3 text-right">GW Points</th>
                            <th className="px-4 py-3 text-right">Payout</th>
                            <th className="px-4 py-3 text-right">Squad Value</th>
                            <th className="px-4 py-3 text-right">Purse</th>
                          </tr>
                        </thead>
                        <tbody>
                          {perGwRows.map((r) => (
                            <tr key={r.teamId} className="border-t border-white/5 hover:bg-white/5 transition">
                              <td className="px-4 py-3 font-bold text-white">{r.rank}</td>
                              <td className="px-4 py-3">
                                <div className="font-semibold text-white">{r.teamName}</div>
                                <div className="text-xs text-gray-400">{r.abbreviation}</div>
                              </td>
                              <td className="px-4 py-3 text-right font-mono font-bold text-[#00ff85]">{r.points}</td>
                              <td className="px-4 py-3 text-right font-mono text-green-300">{formatCurrency(r.payout)}</td>
                              <td className="px-4 py-3 text-right font-mono text-gray-200">{formatCurrency(r.squadValue)}</td>
                              <td className="px-4 py-3 text-right font-mono text-gray-200">{formatCurrency(r.purse)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 text-xs text-gray-500 text-center">
                      Tiebreakers: GW points → squad value (lower wins) → purse (higher wins)
                    </div>
                  </div>
                )}

                <div>
                  {selectedGw && (
                    <h2 className="text-lg font-bold text-white mb-3">Season Standings</h2>
                  )}
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
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
