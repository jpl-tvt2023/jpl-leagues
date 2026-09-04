"use client";

import { useEffect, useState, useCallback, Fragment } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { GwNavigator } from "@/components/GwNavigator";
import { LiveFreshness } from "@/components/LiveFreshness";
import { useLeague } from "@/lib/league-context";
import { RankPill, type AwardGroup, type MonthOption } from "../fpl-classic/awards-shared";

interface StandingsRow {
  entrantId: string;
  fplEntryId: number;
  entryName: string;
  playerName: string;
  rank: number;
  isTied: boolean;
  previousRank: number | null;
  total: number;
  eventTotal: number | null;
  isLive: boolean;
}
interface BoardRow {
  entrantId: string;
  entryName: string;
  playerName: string;
  rank: number;
  isTied: boolean;
  netPoints: number;
}
interface Payload {
  league: {
    slug: string; name: string; season: string; fplLeagueId: number; fplLeagueName: string | null;
    scoringMetric: "net" | "gross"; winnerCutPercent: number;
  };
  standings: {
    rows: StandingsRow[]; gw: number; isLive: boolean; source: "fpl" | "db"; isStale: boolean;
    updatedAt: string; truncated: boolean; winnerCutRank: number;
  };
  gameweekBoard: { gw: number; isLive: boolean; availableGws: number[]; source: "live" | "settled" | "none"; rows: BoardRow[] };
  monthlyBoard: { monthKey: string | null; label: string | null; months: MonthOption[]; rows: BoardRow[] };
  awards: AwardGroup[];
  sync: { entrantsSyncedAt: string | null; settledThroughGw: number; lastSyncError: string | null };
}

const ALL_GWS = Array.from({ length: 38 }, (_, i) => i + 1);

function RankDelta({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null || previous === current) return <span className="text-gray-600 text-xs">–</span>;
  const better = current < previous;
  return (
    <span className={`text-xs font-semibold ${better ? "text-green-400" : "text-red-400"}`}>
      {better ? "▲" : "▼"} {Math.abs(current - previous)}
    </span>
  );
}

export function FplClassicStandings() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;
  const { league } = useLeague();

  const [data, setData] = useState<Payload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gwOverride, setGwOverride] = useState<number | null>(null);
  const [monthOverride, setMonthOverride] = useState<string | null>(null);
  const [isRefreshingBoard, setIsRefreshingBoard] = useState(false);

  const fetchStandings = useCallback(async (gw?: number | null, month?: string | null) => {
    try {
      const qs = new URLSearchParams({ leagueSlug });
      if (gw != null) qs.set("gw", String(gw));
      if (month) qs.set("month", month);
      const res = await fetch(`/api/fpl-classic/standings?${qs.toString()}`);
      if (!res.ok) throw new Error("Failed to load standings");
      const payload: Payload = await res.json();
      setData(payload);
      setError(null);
    } catch {
      setError("Failed to load standings. Please try again later.");
    } finally {
      setIsLoading(false);
      setIsRefreshingBoard(false);
    }
  }, [leagueSlug]);

  useEffect(() => {
    if (leagueSlug) fetchStandings(null, null);
  }, [leagueSlug, fetchStandings]);

  const handleGwChange = (gw: number) => {
    setGwOverride(gw);
    setIsRefreshingBoard(true);
    fetchStandings(gw, monthOverride);
  };
  const handleMonthChange = (key: string) => {
    setMonthOverride(key);
    setIsRefreshingBoard(true);
    fetchStandings(gwOverride, key);
  };

  if (isLoading) return <LoadingScreen variant="standings" fullScreen={false} />;

  return (
    <div data-testid="fpl-classic-standings" className="min-h-screen">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="standings"
        format="fpl-classic"
        isLoggedIn={false}
        dashboardHref="/"
        onSignOut={() => {}}
      />

      {/* Full-bleed: the league table is the widest thing on the site and the two boards sit
          beside it, so a 1024px cap wasted most of a desktop screen. Capped generously rather than
          unbounded so line lengths stay readable on an ultrawide. */}
      <div className="mx-auto max-w-[1800px] px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">{data?.league.fplLeagueName ?? league.name}</h1>
          <p className="text-sm text-gray-400">
            Public standings · mirrors FPL classic league #{data?.league.fplLeagueId ?? "…"}
          </p>
        </div>

        {error && <div className="text-center text-red-400 py-8">{error}</div>}

        {data && (
          /* League table on the left, the two boards stacked on the right.
             `items-start` stops the right rail stretching to the league table's height (237 rows
             here); `min-w-0` on each cell is required or the tables' own overflow-x-auto wrappers
             widen the grid track instead of scrolling inside it. */
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 items-start">
            {/* ── Live standings ─────────────────────────────────────────── */}
            <section className="min-w-0 rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <h2 className="text-lg sm:text-xl font-bold text-white">Standings</h2>
                <div className="flex items-center gap-2">
                  {data.standings.isLive && (
                    <span className="px-2 py-0.5 rounded-full bg-white/10 text-gray-300 text-xs font-medium flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Live · GW{data.standings.gw}
                    </span>
                  )}
                  <LiveFreshness updatedAt={data.standings.updatedAt} isRefreshing={false} />
                </div>
              </div>
              {data.standings.source === "db" && (
                <p className="text-xs text-amber-400/80 mb-3">
                  FPL is temporarily unreachable — showing the last known standings.
                </p>
              )}
              {/* Height-capped with a sticky header: a full league runs to hundreds of rows, which
                  would leave the right-hand boards stranded at the top of a very long page. */}
              <div className="overflow-x-auto overflow-y-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-white/10">
                      <th className="py-2 pr-2">Rank</th>
                      <th className="py-2 pr-2">Team</th>
                      <th className="py-2 pr-2 hidden sm:table-cell">Manager</th>
                      <th className="py-2 pr-2 text-right">GW{data.standings.gw}</th>
                      <th className="py-2 pr-2 text-right">Total</th>
                      <th className="py-2 pl-2 text-right hidden sm:table-cell">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.standings.rows.map((row, i) => {
                      // The divider renders once per rank BOUNDARY, not once per row — a tie at
                      // the cut (several rows sharing rank === winnerCutRank) must not print the
                      // same "Top N% cutoff" line once per tied row. Only the LAST row still at
                      // or before the cut rank (i.e. the next row's rank has moved past it, or
                      // this is the final row) draws it.
                      const nextRank = data.standings.rows[i + 1]?.rank;
                      const isLastAtCut = row.rank === data.standings.winnerCutRank && nextRank !== data.standings.winnerCutRank;
                      return (
                        <Fragment key={row.entrantId}>
                          <tr
                            className={`border-b border-white/5 ${row.rank <= data.standings.winnerCutRank ? "bg-sky-500/5" : ""}`}
                          >
                            <td className="py-2 pr-2"><RankPill rank={row.rank} isTied={row.isTied} /></td>
                            <td className="py-2 pr-2 text-white font-medium truncate max-w-[160px]">{row.entryName}</td>
                            <td className="py-2 pr-2 text-gray-400 hidden sm:table-cell truncate max-w-[160px]">{row.playerName}</td>
                            <td className="py-2 pr-2 text-right text-gray-200">
                              {row.eventTotal ?? "—"}
                              {row.isLive && <span className="ml-1 text-emerald-400 text-[10px] align-top">●</span>}
                            </td>
                            <td className="py-2 pr-2 text-right font-semibold text-white">{row.total}</td>
                            <td className="py-2 pl-2 text-right hidden sm:table-cell">
                              <RankDelta current={row.rank} previous={row.previousRank} />
                            </td>
                          </tr>
                          {isLastAtCut && (
                            <tr>
                              <td colSpan={6} className="py-1">
                                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-sky-300">
                                  <div className="h-px flex-1 bg-sky-400/40" />
                                  Top {data.league.winnerCutPercent}% cutoff
                                  <div className="h-px flex-1 bg-sky-400/40" />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {data.standings.truncated && (
                <p className="text-xs text-amber-400/80 mt-3">
                  This league has more entrants than could be loaded in one sync — standings may be incomplete.
                </p>
              )}
            </section>

            {/* ── Right rail: Manager of the Gameweek, then Manager of the Month ── */}
            <div className="min-w-0 space-y-6">
            {/* ── Manager of the Gameweek ────────────────────────────────── */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
                  Manager of the Gameweek
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-200 tracking-wide">MOTGW</span>
                </h2>
                <GwNavigator
                  gws={ALL_GWS}
                  value={data.gameweekBoard.gw}
                  onChange={handleGwChange}
                  disabled={isRefreshingBoard}
                  selectLabel="Gameweek leaderboard"
                  badge={data.gameweekBoard.isLive ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">LIVE</span>
                  ) : undefined}
                />
              </div>
              <Top10Table rows={data.gameweekBoard.rows} emptyLabel={
                data.gameweekBoard.source === "none" ? "No data for this gameweek yet." : "No scores yet."
              } />
            </section>

            {/* ── Manager of the Month ───────────────────────────────────── */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
                  Manager of the Month
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-200 tracking-wide">MOTM</span>
                </h2>
                {data.monthlyBoard.months.length > 0 && (
                  <select
                    aria-label="Month"
                    value={data.monthlyBoard.monthKey ?? ""}
                    onChange={(e) => handleMonthChange(e.target.value)}
                    disabled={isRefreshingBoard}
                    className="bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm disabled:opacity-40"
                  >
                    {data.monthlyBoard.months.map((m) => (
                      <option key={m.key} value={m.key} className="bg-slate-800">
                        {m.label}{!m.isComplete ? " (in progress)" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <Top10Table
                rows={data.monthlyBoard.rows}
                emptyLabel="No gameweeks settled for this month yet."
              />
            </section>

            {/* Winners moved to their own page — see _components/winners/FplClassicWinners.tsx.
                A cramped strip here could only ever show the handful of already-decided awards;
                the dedicated page also carries the ones still being led. */}
            {data.awards.length > 0 && (
              <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                <h2 className="text-base font-bold text-white mb-1">Winners</h2>
                <p className="text-xs text-gray-500 mb-3">
                  Season, monthly and gameweek winners — including who is currently leading the ones
                  still to be decided.
                </p>
                <Link
                  href={`/${leagueSlug}/winners`}
                  className="inline-block text-sm text-sky-300 hover:text-sky-200 underline underline-offset-4"
                >
                  View all winners →
                </Link>
              </section>
            )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Top10Table({ rows, emptyLabel }: { rows: BoardRow[]; emptyLabel: string }) {
  if (rows.length === 0) {
    return <p className="text-center text-gray-500 text-sm py-8">{emptyLabel}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-white/10">
            <th className="py-2 pr-2">Rank</th>
            <th className="py-2 pr-2">Team</th>
            {/* 2xl, not sm: these tables now live in the right rail, which is far narrower than
                the viewport breakpoint implies. */}
            <th className="py-2 pr-2 hidden 2xl:table-cell">Manager</th>
            <th className="py-2 pl-2 text-right">Points</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.entrantId} className="border-b border-white/5">
              <td className="py-2 pr-2"><RankPill rank={row.rank} isTied={row.isTied} /></td>
              <td className="py-2 pr-2 text-white font-medium truncate max-w-[160px]">{row.entryName}</td>
              <td className="py-2 pr-2 text-gray-400 hidden 2xl:table-cell truncate max-w-[160px]">{row.playerName}</td>
              <td className="py-2 pl-2 text-right font-semibold text-white">{row.netPoints}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
