"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  2: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  3: "bg-green-500/20 text-green-300 border-green-500/30",
  4: "bg-red-500/20 text-red-300 border-red-500/30",
};

const STATUS_ICONS: Record<string, { icon: string; color: string; label: string }> = {
  a: { icon: "", color: "", label: "" },
  i: { icon: "🏥", color: "text-orange-400", label: "Injured" },
  s: { icon: "🟥", color: "text-red-400", label: "Suspended" },
  u: { icon: "❌", color: "text-red-400", label: "Unavailable" },
  d: { icon: "❓", color: "text-yellow-400", label: "Doubtful" },
  n: { icon: "📰", color: "text-blue-400", label: "News" },
};

interface PlayerRow {
  elementId: number;
  webName: string;
  position: number;
  plTeamId: number;
  plTeamShort: string;
  ownerTeamId: string | null;
  ownerAbbreviation: string | null;
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

  // Filters
  const [gameweek, setGameweek] = useState(1);
  const [maxGw, setMaxGw] = useState(1);
  const [page, setPage] = useState(1);
  const [positionFilter, setPositionFilter] = useState<string>("");
  const [plTeamFilter, setPlTeamFilter] = useState<string>("");
  const [ownershipFilter, setOwnershipFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

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
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            JPL
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">Players</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/dashboard" className="text-gray-300 hover:text-white transition">Dashboard</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">Standings</Link>
          <Link href={`/${leagueSlug}/auction`} className="text-gray-300 hover:text-white transition">Auction</Link>
          <Link href={`/${leagueSlug}/squad`} className="text-gray-300 hover:text-white transition">Squad</Link>
          <Link href={`/${leagueSlug}/players`} className="text-yellow-400 font-semibold transition">Players</Link>
          <Link href={`/${leagueSlug}/marketplace`} className="text-gray-300 hover:text-white transition">Marketplace</Link>
          <Link href={`/${leagueSlug}/finance`} className="text-gray-300 hover:text-white transition">Finance</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">Rules</Link>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">Player Stats</h1>
          <p className="text-sm text-gray-400">
            All FPL players with per-gameweek points and JPL ownership.
            Team score = sum of all owned players&apos; individual GW points (no captain, no chips).
          </p>
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
              <label className="text-xs text-gray-400 uppercase tracking-wider">Team</label>
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

            {/* Ownership filter */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 uppercase tracking-wider">Owner</label>
              <select
                value={ownershipFilter}
                onChange={(e) => setOwnershipFilter(e.target.value)}
                className="bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white"
              >
                <option value="all" className="bg-slate-800">All</option>
                <option value="owned" className="bg-slate-800">Owned</option>
                <option value="free" className="bg-slate-800">Free Agents</option>
                {myTeamId && <option value="mine" className="bg-slate-800">My Squad</option>}
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
            <span>Sorted by GW{gameweek} points</span>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left">
                  <th className="px-4 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold">Player</th>
                  <th className="px-3 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold">Owned By</th>
                  <th className="px-3 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold">Pos</th>
                  <th className="px-3 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold">PL Team</th>
                  <th className="px-3 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold text-right">GW{gameweek}</th>
                  <th className="px-3 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold text-right">Season</th>
                  <th className="px-3 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold text-right">Price</th>
                  <th className="px-3 py-3 text-xs text-gray-400 uppercase tracking-wider font-semibold text-center hidden md:table-cell">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                      No players found
                    </td>
                  </tr>
                ) : (
                  rows.map((p) => {
                    const st = STATUS_ICONS[p.status] ?? STATUS_ICONS.a;
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
                          {p.ownerAbbreviation ? (
                            <span
                              className={`px-2 py-0.5 rounded text-xs font-bold ${isMine ? "bg-yellow-500/20 text-yellow-300" : "bg-purple-500/20 text-purple-300"}`}
                              title={p.ownerTeamName ?? ""}
                            >
                              {p.ownerAbbreviation}
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

                        {/* GW points */}
                        <td className="px-3 py-2.5 text-right">
                          <span className={`font-bold ${p.gwPoints > 0 ? "text-green-400" : p.gwPoints < 0 ? "text-red-400" : "text-gray-400"}`}>
                            {p.gwPoints}
                          </span>
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

                        {/* Status */}
                        <td className="px-3 py-2.5 text-center hidden md:table-cell">
                          {st.icon && (
                            <span className={st.color} title={st.label}>
                              {st.icon}
                            </span>
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
