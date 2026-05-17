"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useEnforceFormat } from "@/lib/league-context";

interface TeamCard {
  teamId: string;
  name: string;
  rank: number;
  totalPoints: number;
  purse: number;
  squadValue: number;
  squadSize: number;
  topPerformer: { name: string; points: number } | null;
  isMine: boolean;
}

type SortKey = "rank" | "purse" | "squadValue";

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

function rankStyle(rank: number): { badge: string; ring: string } {
  if (rank === 1) return { badge: "bg-gradient-to-br from-yellow-300 to-yellow-600 text-slate-900", ring: "ring-yellow-400/30" };
  if (rank === 2) return { badge: "bg-gradient-to-br from-slate-200 to-slate-400 text-slate-900", ring: "ring-slate-300/30" };
  if (rank === 3) return { badge: "bg-gradient-to-br from-orange-400 to-amber-700 text-white", ring: "ring-orange-400/30" };
  return { badge: "bg-purple-500/30 text-purple-200 border border-purple-400/40", ring: "ring-purple-500/20" };
}

export default function TeamsPage() {
  useEnforceFormat(["auction"]);
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamList, setTeamList] = useState<TeamCard[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const meRes = await fetch("/api/auth/me");
      const me = await meRes.json().catch(() => ({}));
      setIsLoggedIn(!!me.authenticated);

      const leaguesRes = await fetch("/api/leagues");
      const leaguesJson = await leaguesRes.json();
      const league = (leaguesJson.leagues || []).find(
        (l: { slug: string; id: string }) => l.slug === leagueSlug
      );
      if (!league) throw new Error("League not found");

      const res = await fetch(`/api/auction/teams?leagueId=${league.id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load teams");
      }
      const json = await res.json();
      setTeamList(json.teams ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load teams");
    } finally {
      setIsLoading(false);
    }
  }, [leagueSlug]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const sortedTeams = useMemo(() => {
    const arr = [...teamList];
    if (sortKey === "rank") arr.sort((a, b) => a.rank - b.rank);
    else if (sortKey === "purse") arr.sort((a, b) => b.purse - a.purse);
    else if (sortKey === "squadValue") arr.sort((a, b) => b.squadValue - a.squadValue);
    return arr;
  }, [teamList, sortKey]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueSlug}
        currentPage="teams"
        format="auction"
        isLoggedIn={isLoggedIn}
        dashboardHref="/dashboard"
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="default" fullScreen={false} label="Loading Teams" />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl sm:text-4xl font-bold text-white">League Teams</h1>
                <p className="text-sm text-gray-400 mt-1">
                  {teamList.length} {teamList.length === 1 ? "team" : "teams"} competing
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-400">Sort by</span>
                {([
                  ["rank", "Rank"],
                  ["purse", "Purse"],
                  ["squadValue", "Squad Value"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setSortKey(k)}
                    className={
                      sortKey === k
                        ? "rounded-full bg-yellow-400/20 border border-yellow-400/60 text-yellow-300 px-3 py-1 font-semibold"
                        : "rounded-full bg-white/5 border border-white/10 text-gray-300 px-3 py-1 hover:bg-white/10 transition"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {sortedTeams.map((t) => {
                const rs = rankStyle(t.rank);
                return (
                  <div
                    key={t.teamId}
                    className={`relative rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-4 transition hover:bg-white/[0.08] ${
                      t.isMine ? "ring-2 ring-yellow-500/40" : ""
                    }`}
                  >
                    {t.isMine && (
                      <span className="absolute -top-2 -right-2 rounded-full bg-yellow-400 text-slate-900 text-[10px] font-bold px-2 py-0.5 shadow">
                        YOU
                      </span>
                    )}

                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold ${rs.badge}`}>
                            #{t.rank}
                          </span>
                        </div>
                        <h3 className="mt-2 text-base font-semibold text-white truncate">{t.name}</h3>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-2xl font-bold text-white leading-none">{t.totalPoints}</div>
                        <div className="text-[10px] text-gray-400 uppercase tracking-wider mt-0.5">pts</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center border-t border-white/10 pt-3">
                      <div>
                        <div className="text-[10px] text-gray-400 uppercase tracking-wider">Purse</div>
                        <div className="text-xs font-semibold text-green-300 mt-0.5">{formatCurrency(t.purse)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-400 uppercase tracking-wider">Squad Val</div>
                        <div className="text-xs font-semibold text-blue-300 mt-0.5">{formatCurrency(t.squadValue)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-400 uppercase tracking-wider">Squad</div>
                        <div className="text-xs font-semibold text-white mt-0.5">{t.squadSize}/14</div>
                      </div>
                    </div>

                    {t.topPerformer && (
                      <div className="mt-3 flex items-center justify-between text-[11px] border-t border-white/5 pt-2">
                        <span className="text-gray-400">⭐ Top</span>
                        <span className="text-gray-200 font-medium truncate ml-2">
                          {t.topPerformer.name}{" "}
                          <span className="text-yellow-300">({t.topPerformer.points})</span>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
