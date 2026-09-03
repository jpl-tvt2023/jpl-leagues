"use client";

import { useEffect, useState, useCallback, Fragment } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { GwNavigator } from "@/components/GwNavigator";
import { LiveFreshness } from "@/components/LiveFreshness";
import { useLeague } from "@/lib/league-context";

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
interface MonthOption {
  key: string;
  label: string;
  gws: number[];
  isComplete: boolean;
}
interface AwardWinnerRow {
  entrantId: string;
  entryName: string;
  playerName: string;
  position: number;
  value: number;
  isTied: boolean;
  detail: Record<string, unknown> | null;
}
interface AwardGroup {
  key: string;
  label: string;
  scope: "season" | "gameweek" | "month" | "special";
  scopeKey: string;
  isFrozen: boolean;
  winners: AwardWinnerRow[];
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

/** "gw:14" -> "GW14", "month:2025-11" -> the human label if given, else the raw key, "season" -> "Season". */
function scopeLabel(group: AwardGroup, monthLabelByKey: Map<string, string>): string {
  if (group.scope === "gameweek") return `GW${group.scopeKey.split(":")[1]}`;
  if (group.scope === "month") {
    const key = group.scopeKey.split(":").slice(1).join(":");
    return monthLabelByKey.get(key) ?? key;
  }
  return "Season";
}

const ALL_GWS = Array.from({ length: 38 }, (_, i) => i + 1);

function RankPill({ rank, isTied }: { rank: number; isTied: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-sm text-gray-300">
      {isTied && <span className="text-gray-500">T</span>}
      {rank}
    </span>
  );
}

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
    <div data-testid="fpl-classic-standings" className="min-h-screen bg-gradient-to-b from-slate-900 via-sky-900/40 to-slate-900">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="standings"
        format="fpl-classic"
        isLoggedIn={false}
        dashboardHref="/"
        onSignOut={() => {}}
      />

      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">{data?.league.fplLeagueName ?? league.name}</h1>
          <p className="text-sm text-gray-400">
            Public standings · mirrors FPL classic league #{data?.league.fplLeagueId ?? "…"}
          </p>
        </div>

        {error && <div className="text-center text-red-400 py-8">{error}</div>}

        {data && (
          <>
            {/* ── Live standings ─────────────────────────────────────────── */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur mb-8">
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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
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

            {/* ── Gameweek leaderboard ───────────────────────────────────── */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur mb-8">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="text-lg sm:text-xl font-bold text-white">Gameweek Leaderboard</h2>
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

            {/* ── Monthly leaderboard ────────────────────────────────────── */}
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="text-lg sm:text-xl font-bold text-white">Monthly Leaderboard</h2>
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

            {/* ── Winners ────────────────────────────────────────────────── */}
            {data.awards.length > 0 && (
              <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur mt-8">
                <h2 className="text-lg sm:text-xl font-bold text-white mb-1">Winners</h2>
                <p className="text-xs text-gray-500 mb-4">
                  Announced here as they're decided. No prizes are listed on this page.
                </p>
                <AwardsList awards={data.awards} months={data.monthlyBoard.months} />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Season/special awards first (they matter most and there are only a few), then months and
 * gameweeks most-recent-first — a reader is far more likely to want last week's winner than
 * GW1's. Frozen and provisional are both shown; the badge is the only thing that tells them
 * apart, exactly as the API distinguishes them.
 */
function AwardsList({ awards, months }: { awards: AwardGroup[]; months: MonthOption[] }) {
  const monthLabelByKey = new Map(months.map((m) => [m.key, m.label]));

  const scopeSortKey = (g: AwardGroup): number => {
    if (g.scope === "season" || g.scope === "special") return -2;
    if (g.scope === "month") return -1;
    return Number(g.scopeKey.split(":")[1] ?? 0); // gameweek: higher gw sorts later, reversed below
  };
  const sorted = [...awards].sort((a, b) => {
    const av = scopeSortKey(a);
    const bv = scopeSortKey(b);
    if (av < 0 || bv < 0) return av - bv; // season/special/month buckets first, in that order
    return bv - av; // gameweeks: most recent first
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {sorted.map((group) => (
        <div key={`${group.key}::${group.scopeKey}`} className="rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-wide text-sky-300">{scopeLabel(group, monthLabelByKey)}</span>
            <span
              className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                group.isFrozen ? "bg-sky-500/20 text-sky-200" : "border border-amber-400/40 text-amber-400"
              }`}
            >
              {group.isFrozen ? "Final" : "Provisional"}
            </span>
          </div>
          <div className="text-xs text-gray-400 mb-1">{group.label}</div>
          {group.winners.map((w) => (
            <div key={w.entrantId} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-white font-medium truncate">
                {/* Only worth labelling the position when there's more than one winner (the
                    season podium) — a single-winner award repeating "1st" everywhere is noise. */}
                {group.winners.length > 1 && <span className="text-gray-500 mr-1">{w.position}.</span>}
                {w.entryName}
                {w.isTied && <span className="text-gray-500 text-[10px] ml-1">(tied)</span>}
              </span>
              <span className="text-gray-400 shrink-0">{w.value}</span>
            </div>
          ))}
        </div>
      ))}
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
            <th className="py-2 pr-2 hidden sm:table-cell">Manager</th>
            <th className="py-2 pl-2 text-right">Points</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.entrantId} className="border-b border-white/5">
              <td className="py-2 pr-2"><RankPill rank={row.rank} isTied={row.isTied} /></td>
              <td className="py-2 pr-2 text-white font-medium truncate max-w-[160px]">{row.entryName}</td>
              <td className="py-2 pr-2 text-gray-400 hidden sm:table-cell truncate max-w-[160px]">{row.playerName}</td>
              <td className="py-2 pl-2 text-right font-semibold text-white">{row.netPoints}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
