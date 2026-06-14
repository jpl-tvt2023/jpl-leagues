"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague } from "@/lib/league-context";
import { TierChip } from "@/components/TierChip";
import type { TeamClubOwnership } from "@/lib/teams/display-name";
import { getTeamDisplayName } from "@/lib/teams/display-name";
import { formatPts } from "@/lib/format-points";
import { normalizeClubSummary } from "@/lib/formats/auction/club-summary";

interface ClubTooltipCellProps {
  clubResultBonus: number;
  gwHistory: AuctionGwHistoryEntry[];
  currentGwNumber: number;
  liveResult: { summary: string; bonus: number } | null;
  clubName: string;
}

// Cell + popover for the per-team Club column. The popover is portalled to body and positioned via
// the cell's bounding rect so it escapes the table's `overflow-x-auto` clipping context.
function ClubTooltipCell({ clubResultBonus, gwHistory, currentGwNumber, liveResult, clubName }: ClubTooltipCellProps) {
  const ref = useRef<HTMLTableCellElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const show = () => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // Anchor below the cell, right-aligned to the cell's right edge.
    setPos({ top: r.bottom + 6, left: r.right });
  };
  const hide = () => setPos(null);

  const hasPopover = currentGwNumber > 0 && (gwHistory.length > 0 || liveResult);
  const popoverWidth = 320;

  return (
    <td
      ref={ref}
      onMouseEnter={hasPopover ? show : undefined}
      onMouseLeave={hide}
      onFocus={hasPopover ? show : undefined}
      onBlur={hide}
      className={`px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono relative ${clubResultBonus > 0 ? "text-emerald-300 font-bold cursor-help" : "text-gray-600"}`}
    >
      {clubResultBonus > 0 ? `+${clubResultBonus}` : "0"}
      {mounted && pos && hasPopover && createPortal(
        <div
          className="fixed z-50 rounded-xl border border-white/10 bg-slate-800/95 backdrop-blur-xl shadow-xl p-3 text-left pointer-events-none"
          style={{ top: pos.top, left: Math.max(8, pos.left - popoverWidth), width: popoverWidth }}
        >
          <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-2">
            {clubName} — Club result by GW
          </div>
          <table className="w-full text-xs">
            <tbody>
              {Array.from({ length: currentGwNumber }, (_, i) => i + 1).map((gwN) => {
                const h = gwHistory.find((x) => x.gw === gwN);
                const scored = !!h;
                // `liveResult` describes only the in-progress current GW. Earlier unscored GWs
                // (admin hasn't processed them yet) should render as "yet to play", not inherit
                // the current GW's scoreline.
                const live = !scored && gwN === currentGwNumber ? liveResult : null;
                const hasLive = !scored && !!live;
                const summary = scored
                  ? (h!.clubResultSummary ? normalizeClubSummary(h!.clubResultSummary) : null)
                  : (hasLive ? live!.summary : null);
                const labelCls = scored || hasLive ? "text-gray-200" : "text-gray-500 italic";
                const valueCls =
                  (scored && h!.clubResultBonus > 0) || (hasLive && live!.bonus > 0)
                    ? "text-emerald-300 font-bold"
                    : "text-gray-500";
                return (
                  <tr key={gwN} className="border-t border-white/5 first:border-t-0 align-top">
                    <td className="py-1 pr-2 text-gray-400 font-mono w-10">GW{gwN}</td>
                    <td className={`py-1 ${labelCls}`}>
                      {scored ? (
                        // Scored GW. If we have a summary, render it. Otherwise — when bonus > 0
                        // but the backfill couldn't recover the scoreline (FPL outage / pre-club-
                        // auction league) — explain why instead of showing a bare "—".
                        summary ?? (h!.clubResultBonus > 0 ? <span className="text-gray-500 italic">fixture detail unavailable</span> : "—")
                      ) : hasLive ? (
                        <>
                          {summary}
                          <span className="text-[10px] text-amber-300 font-semibold uppercase ml-1">live</span>
                        </>
                      ) : (
                        "yet to play"
                      )}
                    </td>
                    <td className={`py-1 pl-2 text-right font-mono whitespace-nowrap ${valueCls}`}>
                      {scored
                        ? (h!.clubResultBonus > 0 ? `+${h!.clubResultBonus}` : "0")
                        : hasLive
                          ? `+${live!.bonus}`
                          : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>,
        document.body
      )}
    </td>
  );
}

interface AuctionGwHistoryEntry {
  gw: number;
  points: number;            // back-compat alias for totalPoints
  totalPoints: number;
  rawPoints: number;
  synergyBonus: number;
  clubResultBonus: number;
  clubResultSummary: string | null;
  rank: number;
  payout: number;
}

interface AuctionStandingRow {
  teamId: string;
  teamName: string;
  teamLoginId?: string | null;
  totalPoints: number;
  rawPoints: number;
  synergyBonus: number;
  clubResultBonus: number;
  purse: number;
  squadValue: number;
  rank: number;
  previousRank: number | null;
  rankDelta: number | null;
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const leagueSlug = params.leagueSlug as string;
  const gwParam = searchParams.get("gw");
  const selectedGw = gwParam ? parseInt(gwParam, 10) : null;

  const openGwResults = () => router.push(`/${leagueSlug}/gw-results`);
  const onRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openGwResults();
    }
  };

  const { league, viewer } = useLeague();
  const leagueName = league.name;
  const isLoggedIn = viewer.authenticated;
  const dashboardHref = viewer.dashboardHref;

  const [auctionStandings, setAuctionStandings] = useState<AuctionStandingRow[]>([]);
  const [clubByTeamId, setClubByTeamId] = useState<Record<string, TeamClubOwnership>>({});
  const [currentGwNumber, setCurrentGwNumber] = useState<number>(0);
  const [liveClubResultByTeam, setLiveClubResultByTeam] = useState<Record<string, { summary: string; bonus: number } | null>>({});
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
        setClubByTeamId(data.clubByTeamId ?? {});
        setCurrentGwNumber(data.currentGwNumber ?? 0);
        setLiveClubResultByTeam(data.liveClubResultByTeam ?? {});
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
          teamLoginId: s.teamLoginId ?? null,
          points: entry.points,
          payout: entry.payout,
          gwRank: entry.rank,
          squadValue: s.squadValue,
          purse: s.purse,
          synergyBonus: entry.synergyBonus,
          clubResultBonus: entry.clubResultBonus,
          clubResultSummary: normalizeClubSummary(entry.clubResultSummary),
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
        auctionTier={league.auctionTier ?? "complete"}
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
              <p className="text-[11px] text-gray-500 mt-2">▲/▼ shows league rank change vs previous GW</p>
            </div>
            {error ? (
              <div className="text-center text-red-400 py-12">{error}</div>
            ) : auctionStandings.length === 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
                  <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">No Standings Yet</h2>
                  <p className="text-sm sm:text-base text-gray-400">Standings will appear here once the first gameweek has been scored.</p>
                </div>
              </div>
            ) : (
              <div className="max-w-5xl mx-auto space-y-6 sm:space-y-8">
                {selectedGw && perGwRows.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-base sm:text-lg font-bold text-white">Gameweek {selectedGw} Leaderboard</h2>
                      <Link href={`/${leagueSlug}/standings`} className="text-xs text-yellow-400 hover:text-yellow-300">
                        Clear filter →
                      </Link>
                    </div>
                    <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/5 overflow-hidden backdrop-blur">
                      <div className="overflow-x-auto">
                      <table className="w-full text-left min-w-[640px]">
                        <thead className="bg-white/10 text-xs uppercase tracking-wider text-gray-300">
                          <tr>
                            <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm cursor-help" title="Rank for this gameweek (by GW points).">#</th>
                            <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm cursor-help" title="League team — and its owned PL club, if any. Click a row to open GW Results.">Team</th>
                            <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Total FPL points this team's active squad scored this gameweek (before synergy/club bonuses).">GW Points</th>
                            <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="+50% bonus on owned-club players (this GW). Hover the value to see per-player breakdown.">Syn <span className="text-gray-500" aria-hidden>ⓘ</span></th>
                            <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Club W/D bonus (this GW). Hover the value to see per-GW fixture breakdown.">Club <span className="text-gray-500" aria-hidden>ⓘ</span></th>
                            <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Purse credited to this team for its rank this gameweek.">Payout</th>
                            <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Combined fair-market value of all players in the team's squad.">Squad Value</th>
                            <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Cash currently available to bid and trade.">Purse</th>
                          </tr>
                        </thead>
                        <tbody>
                          {perGwRows.map((r) => (
                            <tr
                              key={r.teamId}
                              onClick={openGwResults}
                              onKeyDown={onRowKeyDown}
                              role="button"
                              tabIndex={0}
                              className="border-t border-white/5 hover:bg-white/10 transition cursor-pointer focus:outline-none focus:bg-white/10"
                            >
                              <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm font-bold text-white">{r.rank}</td>
                              <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">
                                <div className="font-semibold text-white flex items-center gap-2 flex-wrap">
                                  <span title={r.teamLoginId ? `Manager: ${r.teamLoginId}` : undefined}>{getTeamDisplayName({ id: r.teamId, name: r.teamName }, clubByTeamId[r.teamId])}</span>
                                  {clubByTeamId[r.teamId] && (
                                    <TierChip
                                      tier={clubByTeamId[r.teamId].tier}
                                      clubName={clubByTeamId[r.teamId].plTeamName}
                                      short={clubByTeamId[r.teamId].plTeamShort}
                                    />
                                  )}
                                </div>
                              </td>
                              <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono font-bold text-[#00ff85]">{formatPts(r.points)}</td>
                              <td className={`px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono ${r.synergyBonus > 0 ? "text-yellow-300 font-bold" : "text-gray-600"}`}>
                                {r.synergyBonus > 0 ? `+${formatPts(r.synergyBonus)}` : "0"}
                              </td>
                              <td
                                className={`px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono ${r.clubResultBonus > 0 ? "text-emerald-300 font-bold cursor-help" : r.clubResultSummary ? "text-gray-400 cursor-help" : "text-gray-600"}`}
                                title={
                                  r.clubResultSummary
                                    ? `${r.clubResultSummary} → +${r.clubResultBonus}`
                                    : r.clubResultBonus > 0
                                      ? `+${r.clubResultBonus} (no fixture detail)`
                                      : undefined
                                }
                              >
                                {r.clubResultBonus > 0 ? `+${r.clubResultBonus}` : "0"}
                              </td>
                              <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono text-green-300">{formatCurrency(r.payout)}</td>
                              <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono text-gray-200">{formatCurrency(r.squadValue)}</td>
                              <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono text-gray-200">{formatCurrency(r.purse)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-gray-500 text-center px-2">
                      Tiebreakers: GW points → squad value (lower wins) → purse (higher wins)
                    </div>
                  </div>
                )}

                <div>
                  {selectedGw && (
                    <h2 className="text-base sm:text-lg font-bold text-white mb-3">Season Standings</h2>
                  )}
                  <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur">
                    <div className="overflow-x-auto">
                    <table className="w-full text-left min-w-[640px]">
                      <thead className="bg-white/10 text-xs uppercase tracking-wider text-gray-300">
                        <tr>
                          <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm cursor-help" title="Overall season rank. The small ▲/▼ shows movement vs the previous gameweek.">#</th>
                          <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm cursor-help" title="League team — and its owned PL club, if any. Click a row to open GW Results.">Team</th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Cumulative raw FPL points">Raw</th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Cumulative +50% bonus on owned-club players. Hover the value to see per-GW breakdown.">Syn <span className="text-gray-500" aria-hidden>ⓘ</span></th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Cumulative club W/D bonus. Hover the value to see per-GW fixtures.">Club <span className="text-gray-500" aria-hidden>ⓘ</span></th>
                          <th className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Raw + Synergy + Club — this is what determines season standings.">Total</th>
                          <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Cash currently available to bid and trade.">Purse</th>
                          <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right cursor-help" title="Combined fair-market value of all players in the team's squad.">Squad Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auctionStandings.map((row) => (
                          <tr
                            key={row.teamId}
                            onClick={openGwResults}
                            onKeyDown={onRowKeyDown}
                            role="button"
                            tabIndex={0}
                            className="border-t border-white/5 hover:bg-white/10 transition cursor-pointer focus:outline-none focus:bg-white/10"
                          >
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm font-bold text-white">
                              <span className="inline-flex items-center gap-1.5">
                                <span>{row.rank}</span>
                                {row.rankDelta != null && row.rankDelta !== 0 ? (
                                  <span
                                    className={`font-mono text-xs font-normal ${row.rankDelta > 0 ? "text-green-400" : "text-red-400"}`}
                                    title={row.previousRank != null ? `Was #${row.previousRank} last GW` : undefined}
                                  >
                                    {row.rankDelta > 0 ? `▲${row.rankDelta}` : `▼${Math.abs(row.rankDelta)}`}
                                  </span>
                                ) : row.rankDelta === 0 ? (
                                  <span className="font-mono text-xs font-normal text-gray-500" title="No change vs previous GW">—</span>
                                ) : null}
                              </span>
                            </td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm">
                              <div className="font-semibold text-white flex items-center gap-2 flex-wrap">
                                <span title={row.teamLoginId ? `Manager: ${row.teamLoginId}` : undefined}>{getTeamDisplayName({ id: row.teamId, name: row.teamName }, clubByTeamId[row.teamId])}</span>
                                {clubByTeamId[row.teamId] && (
                                  <TierChip
                                    tier={clubByTeamId[row.teamId].tier}
                                    clubName={clubByTeamId[row.teamId].plTeamName}
                                    short={clubByTeamId[row.teamId].plTeamShort}
                                  />
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono text-gray-200">{row.rawPoints}</td>
                            <td
                              className={`px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono ${row.synergyBonus > 0 ? "text-yellow-300 font-bold cursor-help" : "text-gray-600"}`}
                              title={
                                row.synergyBonus > 0
                                  ? row.gwHistory
                                      .filter((h) => h.synergyBonus > 0)
                                      .map((h) => `GW${h.gw}: +${formatPts(h.synergyBonus)}`)
                                      .join("\n") || undefined
                                  : undefined
                              }
                            >
                              {row.synergyBonus > 0 ? `+${formatPts(row.synergyBonus)}` : "0"}
                            </td>
                            <ClubTooltipCell
                              clubResultBonus={row.clubResultBonus}
                              gwHistory={row.gwHistory}
                              currentGwNumber={currentGwNumber}
                              liveResult={liveClubResultByTeam[row.teamId] ?? null}
                              clubName={clubByTeamId[row.teamId]?.plTeamName ?? row.teamName}
                            />
                            <td className="px-2 py-2 sm:px-3 sm:py-3 text-xs sm:text-sm text-right font-mono font-bold text-[#00ff85]">{formatPts(row.totalPoints)}</td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono text-green-300">{formatCurrency(row.purse)}</td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-right font-mono text-gray-200">{formatCurrency(row.squadValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                  <div className="mt-4 sm:mt-6 text-center text-xs text-gray-500 px-2">
                    <span className="block mb-1">💡 Hover the Syn or Club value to see the per-GW breakdown.</span>
                    Total = Raw + Synergy + Club result · Synergy = +50% on owned-club players · Club = per-fixture W/D bonus by tier · Squad Value uses RAW points only (synergy doesn&apos;t inflate FMV)
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
