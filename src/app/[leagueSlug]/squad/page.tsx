"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

interface SquadPlayer {
  ownershipId: string;
  fplElementId: number;
  playerName: string;
  purchasePrice: number;
  acquiredGw: number;
  status: "active" | "deadwood" | "released";
  totalPoints: number;
  fmv: number;
}

interface SquadResponse {
  teamId: string;
  teamName: string;
  leagueId: string;
  squad: SquadPlayer[];
  activeCount: number;
  deadwoodCount: number;
}

interface EconomyResponse {
  teamId: string;
  teamName: string;
  initialBudget: number;
  currentPurse: number;
  computedPurse: number;
  totalSpent: number;
  totalIncome: number;
  totalRefunds: number;
}

interface BootstrapElement {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  total_points: number;
  status: string;
}

interface BootstrapTeam {
  id: number;
  name: string;
  short_name: string;
}

interface AuctionSession {
  id: string;
  type: "initial" | "mini-auction";
  status: "pending" | "active" | "paused" | "completed";
}

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const POSITION_COLORS: Record<number, string> = {
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

export default function SquadPage() {
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [squadData, setSquadData] = useState<SquadResponse | null>(null);
  const [economy, setEconomy] = useState<EconomyResponse | null>(null);
  const [elements, setElements] = useState<Map<number, BootstrapElement>>(new Map());
  const [teamsMap, setTeamsMap] = useState<Map<number, BootstrapTeam>>(new Map());
  const [session, setSession] = useState<AuctionSession | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const meRes = await fetch("/api/auth/me");
      const me = await meRes.json();
      if (!me.authenticated) {
        router.push("/signin");
        return;
      }
      if (me.type !== "team") {
        setError("Squad view is only available to team accounts.");
        setIsLoading(false);
        return;
      }
      const teamId = me.team.id;

      const [squadRes, economyRes, bootstrapRes] = await Promise.all([
        fetch(`/api/auction/squad?teamId=${teamId}`),
        fetch(`/api/auction/economy?teamId=${teamId}`),
        fetch("/api/fpl/bootstrap"),
      ]);

      if (!squadRes.ok) throw new Error("Failed to load squad");
      if (!economyRes.ok) throw new Error("Failed to load economy");

      const squadJson: SquadResponse = await squadRes.json();
      const economyJson: EconomyResponse = await economyRes.json();
      setSquadData(squadJson);
      setEconomy(economyJson);

      if (bootstrapRes.ok) {
        const boot = await bootstrapRes.json();
        const elMap = new Map<number, BootstrapElement>();
        for (const el of boot.elements ?? []) elMap.set(el.id, el);
        setElements(elMap);
        const tMap = new Map<number, BootstrapTeam>();
        for (const t of boot.teams ?? []) tMap.set(t.id, t);
        setTeamsMap(tMap);
      }

      // Fetch active auction session to determine release window
      const sessRes = await fetch(`/api/auction/session?leagueId=${squadJson.leagueId}`);
      if (sessRes.ok) {
        const sessJson = await sessRes.json();
        const active = sessJson.sessions?.find(
          (s: AuctionSession) => s.status === "active" || s.status === "paused"
        );
        setSession(active ?? null);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load squad");
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const canRelease = session?.type === "mini-auction" && session?.status === "active";

  const handleRelease = async (ownershipId: string, playerName: string) => {
    if (!confirm(`Release ${playerName}? You will receive a 50% refund of the purchase price.`)) return;
    setReleasing(ownershipId);
    setReleaseError(null);
    try {
      const res = await fetch("/api/auction/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownershipId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Release failed");
      await loadAll();
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "Release failed");
    } finally {
      setReleasing(null);
    }
  };

  const netPL = economy ? economy.totalIncome - economy.totalSpent + economy.totalRefunds : 0;
  const squadValue = squadData?.squad.reduce((sum, p) => sum + p.fmv, 0) ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 bg-slate-900/80 backdrop-blur">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">JPL</div>
          <span className="text-xl font-bold text-white hidden sm:inline">Squad</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/dashboard" className="text-gray-300 hover:text-white transition">Dashboard</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">Standings</Link>
          <Link href={`/${leagueSlug}/auction`} className="text-gray-300 hover:text-white transition">Auction</Link>
          <Link href={`/${leagueSlug}/squad`} className="text-yellow-400 font-semibold transition">Squad</Link>
          <Link href={`/${leagueSlug}/marketplace`} className="text-gray-300 hover:text-white transition">Marketplace</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">Rules</Link>
          <button onClick={handleSignOut} className="rounded-full bg-white/10 px-6 py-2 font-semibold text-white hover:bg-white/20 transition">Sign Out</button>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="dashboard" fullScreen={false} />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : !squadData || !economy ? (
          <div className="text-center text-gray-400 py-12">No squad data available.</div>
        ) : (
          <>
            <div className="mb-8">
              <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">{squadData.teamName}</h1>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="rounded-full bg-white/10 px-3 py-1 text-white">
                  {squadData.activeCount}/14 active
                </span>
                {squadData.deadwoodCount > 0 && (
                  <span className="rounded-full bg-yellow-500/20 text-yellow-300 px-3 py-1 border border-yellow-500/30">
                    {squadData.deadwoodCount} deadwood
                  </span>
                )}
                <span className="rounded-full bg-green-500/20 text-green-300 px-3 py-1 border border-green-500/30">
                  Purse {formatCurrency(economy.computedPurse)}
                </span>
                {canRelease && (
                  <span className="rounded-full bg-blue-500/20 text-blue-300 px-3 py-1 border border-blue-500/30">
                    Release window open
                  </span>
                )}
              </div>
            </div>

            {releaseError && (
              <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {releaseError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-10">
              {squadData.squad.map((p) => {
                const el = elements.get(p.fplElementId);
                const position = el ? POSITION_LABELS[el.element_type] : "—";
                const positionColor = el ? POSITION_COLORS[el.element_type] : "bg-white/10 text-gray-300 border-white/20";
                const team = el ? teamsMap.get(el.team) : null;
                const pnl = p.fmv - p.purchasePrice;
                return (
                  <div
                    key={p.ownershipId}
                    className={`rounded-xl border ${p.status === "deadwood" ? "border-yellow-500/40 bg-yellow-500/5" : "border-white/10 bg-white/5"} p-4 backdrop-blur hover:bg-white/10 transition`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="font-bold text-white">{p.playerName}</div>
                        <div className="text-xs text-gray-400">{team?.short_name ?? "—"}</div>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${positionColor}`}>{position}</span>
                    </div>
                    <div className="space-y-1 text-xs text-gray-300">
                      <div className="flex justify-between"><span>Purchase</span><span className="font-mono">{formatCurrency(p.purchasePrice)}</span></div>
                      <div className="flex justify-between"><span>FMV</span><span className="font-mono text-white">{formatCurrency(p.fmv)}</span></div>
                      <div className="flex justify-between">
                        <span>P&amp;L</span>
                        <span className={`font-mono ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
                        </span>
                      </div>
                      <div className="flex justify-between"><span>Points</span><span className="font-mono text-[#00ff85]">{p.totalPoints}</span></div>
                      <div className="flex justify-between"><span>Acquired</span><span className="font-mono">GW{p.acquiredGw}</span></div>
                    </div>
                    {p.status === "deadwood" && (
                      <div className="mt-2 text-[10px] uppercase tracking-wider text-yellow-400 font-bold">Deadwood</div>
                    )}
                    {canRelease && p.status !== "released" && (
                      <button
                        onClick={() => handleRelease(p.ownershipId, p.playerName)}
                        disabled={releasing === p.ownershipId}
                        className="mt-3 w-full rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 text-xs font-semibold py-1.5 hover:bg-red-500/30 transition disabled:opacity-50"
                      >
                        {releasing === p.ownershipId ? "Releasing..." : `Release (+${formatCurrency(Math.floor(p.purchasePrice * 0.5))})`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {squadData.squad.length === 0 && (
              <div className="text-center py-12 rounded-2xl border border-white/10 bg-white/5">
                <p className="text-gray-400">No players in your squad yet. Head to the auction to bid on players.</p>
              </div>
            )}

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="text-lg font-bold text-white mb-4">Economy Summary</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 text-sm">
                <div><div className="text-xs text-gray-400 uppercase">Initial Budget</div><div className="font-mono text-white">{formatCurrency(economy.initialBudget)}</div></div>
                <div><div className="text-xs text-gray-400 uppercase">Total Spent</div><div className="font-mono text-red-300">{formatCurrency(economy.totalSpent)}</div></div>
                <div><div className="text-xs text-gray-400 uppercase">Total Income</div><div className="font-mono text-green-300">{formatCurrency(economy.totalIncome)}</div></div>
                <div><div className="text-xs text-gray-400 uppercase">Net P&amp;L</div><div className={`font-mono ${netPL >= 0 ? "text-green-300" : "text-red-300"}`}>{netPL >= 0 ? "+" : ""}{formatCurrency(netPL)}</div></div>
                <div><div className="text-xs text-gray-400 uppercase">Squad Value</div><div className="font-mono text-white">{formatCurrency(squadValue)}</div></div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
