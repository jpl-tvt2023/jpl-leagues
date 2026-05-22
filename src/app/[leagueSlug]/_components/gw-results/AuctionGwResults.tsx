"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague } from "@/lib/league-context";
import { TierChip } from "@/components/TierChip";
import type { TeamClubOwnership } from "@/lib/teams/display-name";
import { getTeamDisplayName } from "@/lib/teams/display-name";
import { formatPts } from "@/lib/format-points";
import { normalizeClubSummary } from "@/lib/formats/auction/club-summary";

interface BreakdownPlayer {
  elementId: number;
  name: string;
  /** @deprecated back-compat alias for rawPoints — older code reads `points`. */
  points: number;
  rawPoints: number;
  synergyBonus: number;
  plTeamId: number | null;
  elementType: number | null;
  plTeamShort?: string | null;
}

interface TeamRow {
  teamId: string;
  teamName: string;
  totalPoints: number;
  rawPoints: number;
  synergyBonus: number;
  clubResultBonus: number;
  clubResultSummary: string | null;
  rank: number;
  payout: number;
  leagueRank: number | null;
  prevLeagueRank: number | null;
  rankDelta: number | null;
  players: BreakdownPlayer[];
  /** Fixtures-left-to-play for this team's active roster in the selected GW.
   *  null when the FPL fixtures call failed; 0 when nothing remains. */
  playersLeftToPlay?: number | null;
}

const GW_POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const GW_POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  2: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  3: "bg-green-500/20 text-green-300 border-green-500/30",
  4: "bg-red-500/20 text-red-300 border-red-500/30",
};

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
  const [liveGameweek, setLiveGameweek] = useState<number | null>(null);
  const [selectedGw, setSelectedGw] = useState<number | null>(null);
  const [isLive, setIsLive] = useState<boolean>(false);
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [clubByTeamId, setClubByTeamId] = useState<Record<string, TeamClubOwnership>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  // `silent` = don't flash the loading screen (used for background polling).
  const fetchData = useCallback(async (silent: boolean = false) => {
    if (!leagueSlug) return;
    if (!silent) setIsLoading(true);
    try {
      const url = new URL("/api/auction/gw-summary", window.location.origin);
      url.searchParams.set("leagueSlug", leagueSlug);
      if (gwParam) url.searchParams.set("gw", gwParam);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Failed to fetch gameweek results");
      const data = await res.json();
      setProcessedGws(data.processedGameweeks ?? []);
      setLiveGameweek(typeof data.liveGameweek === "number" ? data.liveGameweek : null);
      setSelectedGw(data.selectedGw ?? null);
      setIsLive(!!data.isLive);
      setRows(data.rows ?? []);
      setClubByTeamId(data.clubByTeamId ?? {});
      if (!silent) setExpanded(new Set());
    } catch (err) {
      console.error("Error fetching GW results:", err);
      if (!silent) setError("Failed to load gameweek results. Please try again later.");
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [leagueSlug, gwParam]);

  useEffect(() => {
    fetchData(false);
  }, [fetchData]);

  // Visibility-aware 60s polling while in live mode. Pauses when the tab is
  // backgrounded so we don't burn FPL quota on hidden tabs.
  useEffect(() => {
    if (!isLive) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer != null) return;
      timer = setInterval(() => {
        if (document.visibilityState === "visible") {
          fetchData(true);
        }
      }, 60_000);
    };
    const stop = () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        // Immediate refresh on becoming visible, then resume interval.
        fetchData(true);
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isLive, fetchData]);

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

  // Selectable list includes processed GWs + the in-flight GW (if any).
  const selectableGws = (() => {
    if (liveGameweek != null && !processedGws.includes(liveGameweek)) {
      return [...processedGws, liveGameweek].sort((a, b) => a - b);
    }
    return processedGws;
  })();
  const currentIdx = selectedGw != null ? selectableGws.indexOf(selectedGw) : -1;
  const prevGw = currentIdx > 0 ? selectableGws[currentIdx - 1] : null;
  const nextGw = currentIdx >= 0 && currentIdx < selectableGws.length - 1 ? selectableGws[currentIdx + 1] : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="gw-results"
        format="auction"
        auctionTier={league.auctionTier ?? "complete"}
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
            ) : selectableGws.length === 0 ? (
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
                      {selectableGws.map((gw) => (
                        <option key={gw} value={gw}>
                          GW{gw}{gw === liveGameweek ? " · LIVE" : ""}
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
                    {isLive && (
                      <span className="ml-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/20 border border-green-500/30 text-green-400 text-[11px] font-bold uppercase tracking-wider">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                        Live
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400">
                    {rows.length} teams · click a row to view scoring players · ▲/▼ shows league rank change vs previous GW
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left min-w-[560px]">
                      <thead className="bg-white/10 text-xs uppercase tracking-wider text-gray-300">
                        <tr>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">#</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">Team</th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right" title="Raw FPL points">Raw</th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="+50% bonus on owned-club players. Hover the value to see per-player breakdown.">Syn <span className="text-gray-500" aria-hidden>ⓘ</span></th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Per-fixture bonus when owned club wins/draws. Hover the value to see the fixture scoreline.">Club <span className="text-gray-500" aria-hidden>ⓘ</span></th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right" title="Total = Raw + Synergy + Club">Total</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">Payout</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">Rank</th>
                          <th className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">Left</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                              No results for this gameweek.
                            </td>
                          </tr>
                        ) : (
                          rows.map((row) => {
                            const isMine = row.teamId === myTeamId;
                            const isExpanded = expanded.has(row.teamId);
                            return (
                              <Fragment key={row.teamId}>
                                <tr
                                  onClick={() => toggleExpand(row.teamId)}
                                  className={`border-t border-white/5 hover:bg-white/[0.07] transition cursor-pointer ${isMine ? "bg-yellow-500/[0.04]" : ""}`}
                                >
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm font-bold text-white">{row.rank || "—"}</td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">
                                    <div className={`font-semibold ${isMine ? "text-yellow-300" : "text-white"} flex items-center gap-2 flex-wrap`}>
                                      <span>{getTeamDisplayName({ id: row.teamId, name: row.teamName }, clubByTeamId[row.teamId])}</span>
                                      {clubByTeamId[row.teamId] && (
                                        <TierChip
                                          tier={clubByTeamId[row.teamId].tier}
                                          clubName={clubByTeamId[row.teamId].plTeamName}
                                          short={clubByTeamId[row.teamId].plTeamShort}
                                        />
                                      )}
                                      {isMine && <span className="ml-1 text-[10px] uppercase tracking-wider text-yellow-400">you</span>}
                                    </div>
                                  </td>
                                  <td className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono text-gray-200">{row.rawPoints}</td>
                                  <td
                                    className={`px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono ${row.synergyBonus > 0 ? "text-yellow-300 font-bold cursor-help" : "text-gray-600"}`}
                                    title={
                                      row.synergyBonus > 0
                                        ? row.players
                                            .filter((p) => p.synergyBonus > 0)
                                            // Show raw × 1.5 = boosted so admins/teams can verify the math at a glance.
                                            // e.g. "Salah: 6 × 1.5 = +9"
                                            .map((p) => `${p.name}: ${p.rawPoints} × 1.5 = +${formatPts(p.rawPoints + p.synergyBonus)}`)
                                            .join("\n") || undefined
                                        : undefined
                                    }
                                  >
                                    {row.synergyBonus > 0 ? `+${formatPts(row.synergyBonus)}` : "0"}
                                  </td>
                                  <td
                                    className={`px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono ${row.clubResultBonus > 0 ? "text-emerald-300 font-bold cursor-help" : "text-gray-600"}`}
                                    title={
                                      row.clubResultSummary
                                        ? `${normalizeClubSummary(row.clubResultSummary)} points`
                                        : row.clubResultBonus > 0
                                        ? `+${row.clubResultBonus} (no fixture detail)`
                                        : undefined
                                    }
                                  >
                                    {row.clubResultBonus > 0 ? `+${row.clubResultBonus}` : "0"}
                                  </td>
                                  <td className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono font-bold text-[#00ff85]">
                                    {formatPts(row.totalPoints)}
                                  </td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono text-green-300">
                                    {formatCurrency(row.payout)}
                                  </td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">
                                    <span className="inline-flex items-center justify-end gap-2">
                                      <span className="font-mono font-bold text-white">
                                        {row.leagueRank != null ? `#${row.leagueRank}` : "—"}
                                      </span>
                                      {row.rankDelta != null && row.rankDelta !== 0 ? (
                                        <span
                                          className={`font-mono text-xs ${row.rankDelta > 0 ? "text-green-400" : "text-red-400"}`}
                                          title={
                                            row.prevLeagueRank != null
                                              ? `Was #${row.prevLeagueRank} after GW${selectedGw != null ? selectedGw - 1 : "?"}`
                                              : undefined
                                          }
                                        >
                                          {row.rankDelta > 0 ? `▲${row.rankDelta}` : `▼${Math.abs(row.rankDelta)}`}
                                        </span>
                                      ) : row.rankDelta === 0 ? (
                                        <span className="font-mono text-xs text-gray-500" title="No change vs previous GW">—</span>
                                      ) : null}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right">
                                    <span className="inline-flex items-center justify-end gap-2">
                                      <span
                                        className={`font-mono ${
                                          row.playersLeftToPlay == null
                                            ? "text-gray-500"
                                            : row.playersLeftToPlay > 0
                                            ? "text-yellow-400 font-bold"
                                            : "text-gray-400"
                                        }`}
                                        title="Fixtures left to play for this team's active roster in the selected GW"
                                      >
                                        {row.playersLeftToPlay == null ? "—" : row.playersLeftToPlay}
                                      </span>
                                      <span className="text-[10px] text-gray-500">{isExpanded ? "▲" : "▼"}</span>
                                    </span>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr className="bg-black/30 border-t border-white/5">
                                    <td colSpan={9} className="px-4 py-3">
                                      {row.players.length === 0 ? (
                                        <div className="text-xs text-gray-500 italic">No player breakdown recorded for this gameweek.</div>
                                      ) : (
                                        <>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                          {([1, 2, 3, 4] as const).map((posType) => {
                                            const players = row.players
                                              .filter((p) => p.elementType === posType)
                                              .sort((a, b) => (b.rawPoints + b.synergyBonus) - (a.rawPoints + a.synergyBonus));
                                            return (
                                              <div key={posType} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                                                <div className="flex items-center justify-between mb-2.5">
                                                  <span className={`text-xs font-bold px-2 py-0.5 rounded border ${GW_POSITION_COLORS[posType]}`}>
                                                    {GW_POSITION_LABELS[posType]}
                                                  </span>
                                                  <span className="text-xs text-gray-500">{players.length}</span>
                                                </div>
                                                {players.length === 0 ? (
                                                  <div className="text-xs text-gray-600 text-center py-3">—</div>
                                                ) : (
                                                  <div className="space-y-1.5">
                                                    {players.map((p) => {
                                                      const eff = p.rawPoints + p.synergyBonus;
                                                      return (
                                                      <div key={p.elementId} className="flex items-center justify-between text-sm min-w-0">
                                                        <span className={`truncate ${p.rawPoints === 0 ? "text-gray-500" : "text-gray-200"}`}>
                                                          {p.name}
                                                          {p.plTeamShort && (
                                                            <span className="ml-1 text-[10px] text-gray-500">({p.plTeamShort})</span>
                                                          )}
                                                        </span>
                                                        <span className="font-mono shrink-0 ml-2 flex items-baseline gap-1">
                                                          <span className={`${eff >= 8 ? "text-[#00ff85] font-bold" : eff > 0 ? "text-gray-200" : "text-gray-600"}`}>
                                                            {p.rawPoints}
                                                          </span>
                                                          {p.synergyBonus > 0 && (
                                                            <span className="text-yellow-300 text-[11px]" title="Synergy bonus from owned PL club">+{formatPts(p.synergyBonus)}</span>
                                                          )}
                                                        </span>
                                                      </div>);
                                                    })}
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })}
                                        </div>
                                        {(row.clubResultBonus > 0 || row.clubResultSummary) && (
                                          <div className="mt-3 pt-3 border-t border-white/5 text-xs text-gray-400">
                                            <span className="text-emerald-300 font-semibold">Club result:</span>{" "}
                                            {normalizeClubSummary(row.clubResultSummary) ?? `Owned club bonus this GW = +${row.clubResultBonus}`}
                                          </div>
                                        )}
                                        </>
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
                  <span className="block mb-1">💡 Hover the Syn or Club value to see the per-player / fixture breakdown.</span>
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
