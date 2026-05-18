"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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

interface SquadPlayer {
  ownershipId: string;
  fplElementId: number;
  playerName: string;
  elementType: number | null;
  purchasePrice: number;
  acquiredGw: number;
  status: string;
  totalPoints: number;
  fmv: number;
  plTeamShort?: string | null;
}

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  2: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  3: "bg-green-500/20 text-green-300 border-green-500/30",
  4: "bg-red-500/20 text-red-300 border-red-500/30",
};

interface SquadResponse {
  teamId: string;
  teamName: string;
  squad: SquadPlayer[];
  activeCount: number;
  deadwoodCount: number;
}

type SortKey = "rank" | "name" | "totalPoints" | "purse" | "squadValue" | "squadSize";
type SortDir = "asc" | "desc";

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

function rankStyle(rank: number): string {
  if (rank === 1) return "bg-gradient-to-br from-yellow-300 to-yellow-600 text-slate-900";
  if (rank === 2) return "bg-gradient-to-br from-slate-200 to-slate-400 text-slate-900";
  if (rank === 3) return "bg-gradient-to-br from-orange-400 to-amber-700 text-white";
  return "bg-purple-500/30 text-purple-200 border border-purple-400/40";
}

function SortableTh({
  label,
  k,
  sortKey,
  sortDir,
  setSortKey,
  setSortDir,
  align = "left",
  className = "",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  setSortKey: (k: SortKey) => void;
  setSortDir: (d: SortDir) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sortKey === k;
  const onClick = () => {
    if (active) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      // numeric columns default to desc, name/rank default to asc
      setSortDir(k === "rank" || k === "name" ? "asc" : "desc");
    }
  };
  return (
    <th className={`px-2 py-2 sm:px-4 sm:py-3 text-xs uppercase tracking-wider font-semibold ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 transition hover:text-white ${active ? "text-yellow-300" : "text-gray-300"}`}
      >
        {label}
        <span className="text-[9px]">{active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

export default function TeamsPage() {
  useEnforceFormat(["auction"]);
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamList, setTeamList] = useState<TeamCard[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [squadByTeam, setSquadByTeam] = useState<Map<string, SquadResponse>>(new Map());
  const [loadingSquads, setLoadingSquads] = useState<Set<string>>(new Set());

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

  const fetchSquad = useCallback(async (teamId: string) => {
    if (squadByTeam.has(teamId) || loadingSquads.has(teamId)) return;
    setLoadingSquads((prev) => {
      const next = new Set(prev);
      next.add(teamId);
      return next;
    });
    try {
      const res = await fetch(`/api/auction/squad?teamId=${teamId}`);
      if (!res.ok) throw new Error("Failed to load squad");
      const json = (await res.json()) as SquadResponse;
      setSquadByTeam((prev) => {
        const next = new Map(prev);
        next.set(teamId, json);
        return next;
      });
    } catch {
      // Best-effort — leave squad unloaded; user can collapse + retry by re-expanding.
    } finally {
      setLoadingSquads((prev) => {
        const next = new Set(prev);
        next.delete(teamId);
        return next;
      });
    }
  }, [squadByTeam, loadingSquads]);

  const toggleExpand = (teamId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) {
        next.delete(teamId);
      } else {
        next.add(teamId);
        fetchSquad(teamId);
      }
      return next;
    });
  };

  const expandAll = () => {
    const all = new Set(teamList.map((t) => t.teamId));
    setExpanded(all);
    for (const t of teamList) fetchSquad(t.teamId);
  };

  const collapseAll = () => setExpanded(new Set());

  const sortedTeams = useMemo(() => {
    const arr = [...teamList];
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case "rank": av = a.rank; bv = b.rank; break;
        case "name": av = a.name; bv = b.name; break;
        case "totalPoints": av = a.totalPoints; bv = b.totalPoints; break;
        case "purse": av = a.purse; bv = b.purse; break;
        case "squadValue": av = a.squadValue; bv = b.squadValue; break;
        case "squadSize": av = a.squadSize; bv = b.squadSize; break;
      }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return arr;
  }, [teamList, sortKey, sortDir]);

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
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-2xl sm:text-4xl font-bold text-white">League Teams</h1>
                <p className="text-sm text-gray-400 mt-1">
                  {teamList.length} {teamList.length === 1 ? "team" : "teams"} competing · click a row to view squad
                </p>
              </div>
              {teamList.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={expandAll}
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 hover:bg-white/20 transition"
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    onClick={collapseAll}
                    className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 hover:bg-white/20 transition"
                  >
                    Collapse all
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur">
              <div className="overflow-x-auto">
                <table className="w-full text-left min-w-[760px]">
                  <thead className="bg-white/10 text-xs uppercase tracking-wider">
                    <tr>
                      <SortableTh label="#" k="rank" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} />
                      <SortableTh label="Team" k="name" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} />
                      <SortableTh label="Points" k="totalPoints" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} align="right" />
                      <SortableTh label="Purse" k="purse" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} align="right" />
                      <SortableTh label="Squad Value" k="squadValue" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} align="right" />
                      <SortableTh label="Squad" k="squadSize" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} align="right" />
                      <th className="px-2 py-2 sm:px-4 sm:py-3 text-xs uppercase tracking-wider font-semibold text-right text-gray-300">Top Scorer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTeams.map((t) => {
                      const isExpanded = expanded.has(t.teamId);
                      const squad = squadByTeam.get(t.teamId);
                      const isLoadingSquad = loadingSquads.has(t.teamId);
                      return (
                        <Fragment key={t.teamId}>
                          <tr
                            onClick={() => toggleExpand(t.teamId)}
                            className={`border-t border-white/5 hover:bg-white/[0.06] transition cursor-pointer ${t.isMine ? "bg-yellow-500/[0.05]" : ""}`}
                          >
                            <td className="px-2 py-2 sm:px-4 sm:py-3">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex h-7 min-w-[28px] items-center justify-center rounded-md text-xs font-bold px-1.5 ${rankStyle(t.rank)}`}>
                                  #{t.rank}
                                </span>
                                <span className="text-[10px] text-gray-500">{isExpanded ? "▲" : "▼"}</span>
                              </div>
                            </td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3">
                              <div className="flex items-center gap-2">
                                <span className={`text-sm font-semibold ${t.isMine ? "text-yellow-300" : "text-white"}`}>{t.name}</span>
                                {t.isMine && (
                                  <span className="rounded-full bg-yellow-400 text-slate-900 text-[10px] font-bold px-2 py-0.5">YOU</span>
                                )}
                              </div>
                            </td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-right font-mono font-bold text-[#00ff85]">{t.totalPoints}</td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-right font-mono text-green-300">{formatCurrency(t.purse)}</td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-right font-mono text-blue-300">{formatCurrency(t.squadValue)}</td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-right font-mono text-white">{t.squadSize}/14</td>
                            <td className="px-2 py-2 sm:px-4 sm:py-3 text-right text-xs text-gray-200 truncate max-w-[180px]">
                              {t.topPerformer ? (
                                <>
                                  {t.topPerformer.name}{" "}
                                  <span className="text-yellow-300">({t.topPerformer.points})</span>
                                </>
                              ) : (
                                <span className="text-gray-600">—</span>
                              )}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-black/30 border-t border-white/5">
                              <td colSpan={7} className="px-4 py-3">
                                {isLoadingSquad ? (
                                  <div className="text-xs text-gray-400 italic">Loading squad…</div>
                                ) : !squad ? (
                                  <div className="text-xs text-gray-500 italic">No squad data available.</div>
                                ) : squad.squad.length === 0 ? (
                                  <div className="text-xs text-gray-500 italic">No players in squad yet.</div>
                                ) : (
                                  <>
                                    <div className="flex flex-wrap items-center gap-2 mb-3 text-[11px]">
                                      <span className="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                                        {squad.activeCount} active
                                      </span>
                                      {squad.deadwoodCount > 0 && (
                                        <span className="px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
                                          {squad.deadwoodCount} deadwood
                                        </span>
                                      )}
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                      {([1, 2, 3, 4] as const).map((posType) => {
                                        const players = squad.squad
                                          .filter((p) => p.elementType === posType)
                                          .sort((a, b) => b.totalPoints - a.totalPoints);
                                        return (
                                          <div key={posType} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                                            <div className="flex items-center justify-between mb-2.5">
                                              <span className={`text-xs font-bold px-2 py-0.5 rounded border ${POSITION_COLORS[posType]}`}>
                                                {POSITION_LABELS[posType]}
                                              </span>
                                              <span className="text-xs text-gray-500">{players.length}</span>
                                            </div>
                                            {players.length === 0 ? (
                                              <div className="text-xs text-gray-600 text-center py-3">—</div>
                                            ) : (
                                              <div className="space-y-2">
                                                {players.map((p) => (
                                                  <div key={p.ownershipId} className="text-sm min-w-0">
                                                    <div className="flex items-center gap-1.5 min-w-0">
                                                      <span className={`h-2 w-2 rounded-full shrink-0 ${p.status === "active" ? "bg-green-400" : "bg-orange-400"}`} />
                                                      <span className="text-gray-200 truncate flex-1">
                                                        {p.playerName}
                                                        {p.plTeamShort && (
                                                          <span className="ml-1 text-[10px] text-gray-500">({p.plTeamShort})</span>
                                                        )}
                                                      </span>
                                                      <span className="font-mono text-[#00ff85] shrink-0">{p.totalPoints}p</span>
                                                    </div>
                                                    <div className="flex items-center justify-between mt-0.5 pl-3.5 text-xs">
                                                      <span className="font-mono text-gray-400">{(p.purchasePrice / 1_000_000).toFixed(1)}M</span>
                                                      <span className="font-mono font-semibold text-cyan-300">£{(p.fmv / 1_000_000).toFixed(1)}M</span>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
