"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague } from "@/lib/league-context";

interface BreakdownPlayer {
  elementId: number;
  name: string;
  points: number;
}

interface TeamRow {
  teamId: string;
  teamName: string;
  totalPoints: number;
  rank: number;
  payout: number;
  players: BreakdownPlayer[];
}

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

export function AuctionGwResults() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const leagueSlug = params.leagueSlug as string;
  const gwParam = searchParams.get("gw");

  const { league, viewer } = useLeague();
  const myTeamId = viewer.type === "team" ? viewer.teamId ?? null : null;

  const [processedGws, setProcessedGws] = useState<number[]>([]);
  const [selectedGw, setSelectedGw] = useState<number | null>(null);
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const fetchData = useCallback(async () => {
    if (!leagueSlug) return;
    setIsLoading(true);
    try {
      const url = new URL("/api/auction/gw-summary", window.location.origin);
      url.searchParams.set("leagueSlug", leagueSlug);
      if (gwParam) url.searchParams.set("gw", gwParam);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Failed to fetch gameweek results");
      const data = await res.json();
      setProcessedGws(data.processedGameweeks ?? []);
      setSelectedGw(data.selectedGw ?? null);
      setRows(data.rows ?? []);
      setExpanded(new Set());
    } catch (err) {
      console.error("Error fetching GW results:", err);
      setError("Failed to load gameweek results. Please try again later.");
    } finally {
      setIsLoading(false);
    }
  }, [leagueSlug, gwParam]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const goToGw = (gw: number) => {
    const sp = new URLSearchParams();
    sp.set("gw", String(gw));
    router.push(`/${leagueSlug}/gw-results?${sp.toString()}`);
  };

  const toggleExpand = (teamId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });
  };

  const currentIdx = selectedGw != null ? processedGws.indexOf(selectedGw) : -1;
  const prevGw = currentIdx > 0 ? processedGws[currentIdx - 1] : null;
  const nextGw = currentIdx >= 0 && currentIdx < processedGws.length - 1 ? processedGws[currentIdx + 1] : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="gw-results"
        format="auction"
        isLoggedIn={viewer.authenticated}
        dashboardHref={viewer.dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="gw-results" fullScreen={false} />
        ) : (
          <>
            <div className="text-center mb-8">
              <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">{league.name || "Auction League"}</h1>
              <p className="text-[#00ff85] text-sm font-semibold uppercase tracking-widest">GW Results</p>
            </div>

            {error ? (
              <div className="text-center text-red-400 py-12">{error}</div>
            ) : processedGws.length === 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
                  <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">No Processed Gameweeks Yet</h2>
                  <p className="text-sm sm:text-base text-gray-400">
                    Gameweek results will appear here once at least one GW has been scored.
                  </p>
                </div>
              </div>
            ) : (
              <div className="max-w-5xl mx-auto">
                <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => prevGw != null && goToGw(prevGw)}
                      disabled={prevGw == null}
                      className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
                    >
                      ← Prev
                    </button>
                    <select
                      value={selectedGw ?? ""}
                      onChange={(e) => goToGw(parseInt(e.target.value, 10))}
                      className="bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white"
                    >
                      {processedGws.map((gw) => (
                        <option key={gw} value={gw}>
                          GW{gw}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => nextGw != null && goToGw(nextGw)}
                      disabled={nextGw == null}
                      className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
                    >
                      Next →
                    </button>
                  </div>
                  <div className="text-xs text-gray-400">
                    {rows.length} teams · click a row to view scoring players
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left min-w-[560px]">
                      <thead className="bg-white/10 text-xs uppercase tracking-wider text-gray-300">
                        <tr>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">#</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">Team</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">GW Points</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">Payout</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">Scorers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                              No results for this gameweek.
                            </td>
                          </tr>
                        ) : (
                          rows.map((row) => {
                            const isMine = row.teamId === myTeamId;
                            const isExpanded = expanded.has(row.teamId);
                            const scorers = row.players.filter((p) => p.points > 0);
                            return (
                              <Fragment key={row.teamId}>
                                <tr
                                  onClick={() => toggleExpand(row.teamId)}
                                  className={`border-t border-white/5 hover:bg-white/[0.07] transition cursor-pointer ${isMine ? "bg-yellow-500/[0.04]" : ""}`}
                                >
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm font-bold text-white">{row.rank || "—"}</td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">
                                    <div className={`font-semibold ${isMine ? "text-yellow-300" : "text-white"}`}>
                                      {row.teamName}
                                      {isMine && <span className="ml-2 text-[10px] uppercase tracking-wider text-yellow-400">you</span>}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono font-bold text-[#00ff85]">
                                    {row.totalPoints}
                                  </td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono text-green-300">
                                    {formatCurrency(row.payout)}
                                  </td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right text-gray-400">
                                    <span className="inline-flex items-center gap-1">
                                      {scorers.length}
                                      <span className="text-[10px]">{isExpanded ? "▲" : "▼"}</span>
                                    </span>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr className="bg-black/30 border-t border-white/5">
                                    <td colSpan={5} className="px-4 py-3">
                                      {row.players.length === 0 ? (
                                        <div className="text-xs text-gray-500 italic">No player breakdown recorded for this gameweek.</div>
                                      ) : (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
                                          {row.players.map((p) => (
                                            <div key={p.elementId} className="flex items-center justify-between text-xs text-gray-200">
                                              <span className={p.points === 0 ? "text-gray-500" : ""}>{p.name}</span>
                                              <span className={`font-mono ${p.points >= 8 ? "text-[#00ff85]" : p.points > 0 ? "text-gray-200" : "text-gray-600"}`}>
                                                {p.points}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="mt-4 text-center text-xs text-gray-500">
                  Showing GW{selectedGw} · {processedGws.length} gameweek{processedGws.length === 1 ? "" : "s"} processed so far
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
