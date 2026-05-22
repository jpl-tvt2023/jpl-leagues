"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LeagueNav } from "@/components/LeagueNav";
import { useEnforceFormat, useLeague } from "@/lib/league-context";

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  2: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  3: "bg-green-500/20 text-green-300 border-green-500/30",
  4: "bg-red-500/20 text-red-300 border-red-500/30",
};

type SortKey = "webName" | "ownerTeamName" | "position" | "plTeamShort" | "seasonPoints" | "purchasePrice";
type SortDir = "asc" | "desc";

function SortableTh({
  label,
  k,
  sortKey,
  sortDir,
  setSortKey,
  setSortDir,
  className = "",
  align = "left",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  setSortKey: (k: SortKey) => void;
  setSortDir: (d: SortDir) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const active = sortKey === k;
  const onClick = () => {
    if (active) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "webName" || k === "ownerTeamName" || k === "plTeamShort" || k === "position" ? "asc" : "desc"); }
  };
  return (
    <th className={`${className} py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-white transition ${active ? "text-yellow-300" : ""}`}
      >
        {label}
        <span className="text-[9px]">{active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

interface PlayerRow {
  elementId: number;
  webName: string;
  position: number;
  plTeamId: number;
  plTeamShort: string;
  ownerTeamId: string | null;
  ownerTeamName: string | null;
  gwPoints: number;
  seasonPoints: number;
  status: string;
  minutes: number;
  purchasePrice: number | null;
}

interface PLTeam {
  id: number;
  short_name: string;
}

function formatPurchasePrice(value: number): string {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

export default function PlayersPage() {
  useEnforceFormat(["auction"]);
  const { league } = useLeague();
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [myTeamId, setMyTeamId] = useState<string | null>(null);

  // Data
  const [rows, setRows] = useState<PlayerRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [plTeams, setPlTeams] = useState<PLTeam[]>([]);
  const [leagueTeams, setLeagueTeams] = useState<{ id: string; name: string }[]>([]);

  // Filters
  const [gameweek, setGameweek] = useState(1);
  const [maxGw, setMaxGw] = useState(1);
  const [page, setPage] = useState(1);
  const [positionFilter, setPositionFilter] = useState<string>("");
  const [plTeamFilter, setPlTeamFilter] = useState<string>("");
  const [ownershipFilter, setOwnershipFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>("seasonPoints");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const pageSize = 50;

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Init: fetch auth + league info + bootstrap teams + determine current GW
  useEffect(() => {
    async function init() {
      try {
        const [meRes, leaguesRes, bootstrapRes] = await Promise.all([
          fetch("/api/auth/me"),
          fetch("/api/leagues"),
          fetch("/api/fpl/bootstrap"),
        ]);

        const me = await meRes.json();
        if (!me.authenticated) {
          router.push("/signin");
          return;
        }
        if (me.type === "team") setMyTeamId(me.team.id);

        const leaguesJson = await leaguesRes.json();
        const league = (leaguesJson.leagues || []).find((l: { slug: string }) => l.slug === leagueSlug);
        if (!league) {
          setError("League not found");
          setIsLoading(false);
          return;
        }
        setLeagueId(league.id);

        if (bootstrapRes.ok) {
          const boot = await bootstrapRes.json();
          setPlTeams(boot.teams ?? []);
        }

        // Determine current GW from scoring status
        try {
          const statusRes = await fetch(`/api/auction/scoring-status?leagueId=${league.id}`);
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            const gws = (statusData.gameweeks ?? []) as { number: number }[];
            if (gws.length > 0) {
              const maxGwNum = Math.max(...gws.map((g: { number: number }) => g.number));
              setMaxGw(maxGwNum);
              setGameweek(maxGwNum);
            }
          }
        } catch {
          // fallback: GW 1
        }
      } catch (err) {
        console.error(err);
        setError("Failed to initialize");
      } finally {
        setIsLoading(false);
      }
    }

    init();
  }, [leagueSlug, router]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  // Fetch players data when filters change
  const fetchPlayers = useCallback(async () => {
    if (!leagueId || gameweek < 1) return;

    try {
      const params = new URLSearchParams({
        leagueId,
        gameweek: String(gameweek),
        page: String(page),
        pageSize: String(pageSize),
      });
      if (positionFilter) params.set("position", positionFilter);
      if (plTeamFilter) params.set("plTeam", plTeamFilter);
      if (ownershipFilter !== "all") params.set("ownership", ownershipFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);

      const res = await fetch(`/api/auction/players?${params}`);
      if (!res.ok) throw new Error("Failed to fetch players");
      const data = await res.json();
      setRows(data.rows);
      setTotalCount(data.totalCount);
      setTotalPages(data.totalPages);
      if (Array.isArray(data.teams)) setLeagueTeams(data.teams);
    } catch (err) {
      console.error(err);
    }
  }, [leagueId, gameweek, page, positionFilter, plTeamFilter, ownershipFilter, debouncedSearch]);

  useEffect(() => {
    fetchPlayers();
  }, [fetchPlayers]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [positionFilter, plTeamFilter, ownershipFilter, debouncedSearch, gameweek]);

  // Sorted PL teams for dropdown
  const sortedPlTeams = useMemo(
    () => [...plTeams].sort((a, b) => a.short_name.localeCompare(b.short_name)),
    [plTeams]
  );

  // Client-side sort for the visible page
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  if (isLoading) return <LoadingScreen />;
  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center">
        <div className="text-red-400 text-xl">{error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueSlug}
        currentPage="players"
        format="auction"
        auctionTier={league.auctionTier ?? "complete"}
        isLoggedIn={true}
        dashboardHref="/dashboard"
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">Player Stats</h1>
        </div>

        {/* Filters bar */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur mb-6">
          <div className="flex flex-wrap items-center gap-3">
            {/* GW selector */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">GW</label>
              <select
                value={gameweek}
                onChange={(e) => setGameweek(parseInt(e.target.value))}
                className="bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                {Array.from({ length: maxGw }, (_, i) => i + 1).map((gw) => (
                  <option key={gw} value={gw} className="bg-slate-800">
                    GW{gw}
                  </option>
                ))}
              </select>
            </div>

            {/* Position filter */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">Pos</label>
              <select
                value={positionFilter}
                onChange={(e) => setPositionFilter(e.target.value)}
                className="bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                <option value="" className="bg-slate-800">All</option>
                <option value="1" className="bg-slate-800">GKP</option>
                <option value="2" className="bg-slate-800">DEF</option>
                <option value="3" className="bg-slate-800">MID</option>
                <option value="4" className="bg-slate-800">FWD</option>
              </select>
            </div>

            {/* PL Team filter */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">PL Team</label>
              <select
                value={plTeamFilter}
                onChange={(e) => setPlTeamFilter(e.target.value)}
                className="bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                <option value="" className="bg-slate-800">All</option>
                {sortedPlTeams.map((t) => (
                  <option key={t.id} value={t.id} className="bg-slate-800">
                    {t.short_name}
                  </option>
                ))}
              </select>
            </div>

            {/* Ownership filter — my team first (labelled explicitly), then other league teams
                in alphabetical order so the dropdown is easy to scan when the league has 14+ teams. */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">Owner</label>
              <select
                value={ownershipFilter}
                onChange={(e) => setOwnershipFilter(e.target.value)}
                className="bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                <option value="all" className="bg-slate-800">All</option>
                <option value="free" className="bg-slate-800">Free Agents</option>
                {myTeamId && (() => {
                  const myTeam = leagueTeams.find((t) => t.id === myTeamId);
                  return myTeam ? (
                    <option value="mine" className="bg-slate-800">{myTeam.name} (my team)</option>
                  ) : (
                    <option value="mine" className="bg-slate-800">My Squad</option>
                  );
                })()}
                {leagueTeams
                  .filter((t) => t.id !== myTeamId)
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((t) => (
                    <option key={t.id} value={t.id} className="bg-slate-800">
                      {t.name}
                    </option>
                  ))}
              </select>
            </div>

            {/* Search */}
            <div className="flex-1 min-w-[160px]">
              <input
                type="text"
                placeholder="Search player..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-yellow-500/50"
              />
            </div>
          </div>

          <div className="flex items-center justify-between mt-3 text-xs text-gray-400">
            <span>{totalCount} players</span>
            <span>Sorted by {sortKey === "webName" ? "name" : sortKey === "ownerTeamName" ? "owner" : sortKey === "plTeamShort" ? "PL team" : sortKey === "seasonPoints" ? "season points" : sortKey === "purchasePrice" ? "price" : "position"} ({sortDir})</span>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left">
                  <SortableTh label="Player" k="webName" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} className="px-4" />
                  <SortableTh label="Owned By" k="ownerTeamName" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} className="px-3" />
                  <SortableTh label="Pos" k="position" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} className="px-3" />
                  <SortableTh label="PL Team" k="plTeamShort" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} className="px-3" />
                  <SortableTh label="Season" k="seasonPoints" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} className="px-3" align="right" />
                  <SortableTh label="Price" k="purchasePrice" sortKey={sortKey} sortDir={sortDir} setSortKey={setSortKey} setSortDir={setSortDir} className="px-3" align="right" />
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      No players found
                    </td>
                  </tr>
                ) : (
                  sortedRows.map((p) => {
                    const isMine = p.ownerTeamId === myTeamId;
                    return (
                      <tr
                        key={p.elementId}
                        className={`border-b border-white/5 hover:bg-white/[0.03] transition ${isMine ? "bg-yellow-500/[0.04]" : ""}`}
                      >
                        {/* Player name */}
                        <td className="px-4 py-2.5">
                          <span className="text-white font-semibold">{p.webName}</span>
                        </td>

                        {/* Owned by */}
                        <td className="px-3 py-2.5">
                          {p.ownerTeamName ? (
                            <span
                              className={`text-xs font-semibold ${isMine ? "text-yellow-300" : "text-purple-300"}`}
                            >
                              {p.ownerTeamName}
                            </span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>

                        {/* Position */}
                        <td className="px-3 py-2.5">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${POSITION_COLORS[p.position] ?? ""}`}>
                            {POSITION_LABELS[p.position] ?? "?"}
                          </span>
                        </td>

                        {/* PL Team */}
                        <td className="px-3 py-2.5 text-gray-300 text-xs">
                          {p.plTeamShort}
                        </td>

                        {/* Season points */}
                        <td className="px-3 py-2.5 text-right text-gray-300">
                          {p.seasonPoints}
                        </td>

                        {/* Purchase price */}
                        <td className="px-3 py-2.5 text-right">
                          {p.purchasePrice !== null ? (
                            <span className="text-yellow-400 font-mono text-xs">{formatPurchasePrice(p.purchasePrice)}</span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
              >
                Previous
              </button>
              <span className="text-sm text-gray-400">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
