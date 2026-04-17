"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";

type TransactionType =
  | "initial_budget"
  | "purchase"
  | "release_refund"
  | "pending_release"
  | "gw_payout"
  | "trade_cash_out"
  | "trade_cash_in"
  | "transfer_fee";

interface TransactionEntry {
  id: string;
  type: TransactionType;
  date: string;
  gw: number | null;
  description: string;
  amount: number;
  runningBalance: number;
  isPending: boolean;
  metadata?: {
    playerName?: string;
    purchasePrice?: number;
    refundAmount?: number;
    forfeitAmount?: number;
    rank?: number;
    payout?: number;
    counterpartyTeam?: string;
  };
}

interface LedgerResponse {
  teamId: string;
  teamName: string;
  initialBudget: number;
  currentPurse: number;
  summary: {
    totalSpent: number;
    totalIncome: number;
    totalRefunds: number;
    totalForfeited: number;
    netPnL: number;
  };
  ledger: TransactionEntry[];
}

type Filter = "all" | "purchase" | "release" | "gw_payout" | "trade";

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

const TYPE_STYLES: Record<TransactionType, { label: string; badge: string }> = {
  initial_budget: { label: "Initial", badge: "bg-gray-500/20 text-gray-300 border-gray-500/40" },
  purchase: { label: "Purchase", badge: "bg-red-500/20 text-red-300 border-red-500/40" },
  release_refund: { label: "Refund", badge: "bg-green-500/20 text-green-300 border-green-500/40" },
  pending_release: { label: "Pending Release", badge: "bg-orange-500/20 text-orange-300 border-orange-500/40" },
  gw_payout: { label: "GW Payout", badge: "bg-blue-500/20 text-blue-300 border-blue-500/40" },
  trade_cash_out: { label: "Trade Out", badge: "bg-purple-500/20 text-purple-300 border-purple-500/40" },
  trade_cash_in: { label: "Trade In", badge: "bg-purple-500/20 text-purple-300 border-purple-500/40" },
  transfer_fee: { label: "Trade Tax", badge: "bg-red-500/20 text-red-300 border-red-500/40" },
};

export default function FinancePage() {
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
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
        setError("Finance page is only available to team accounts.");
        setIsLoading(false);
        return;
      }

      const res = await fetch(`/api/auction/finance?teamId=${me.team.id}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to load finance");
      }
      const json: LedgerResponse = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load finance");
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.ledger.filter((e) => {
      if (filter === "all") return true;
      if (filter === "purchase") return e.type === "purchase";
      if (filter === "release") return e.type === "release_refund" || e.type === "pending_release";
      if (filter === "gw_payout") return e.type === "gw_payout";
      if (filter === "trade") return e.type === "trade_cash_in" || e.type === "trade_cash_out";
      return true;
    });
  }, [data, filter]);

  const netPL = data?.summary.netPnL ?? 0;
  const totalEarned = (data?.summary.totalIncome ?? 0) + (data?.summary.totalRefunds ?? 0);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueSlug}
        currentPage="finance"
        format="auction"
        isLoggedIn={true}
        dashboardHref="/dashboard"
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="dashboard" fullScreen={false} />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : !data ? (
          <div className="text-center text-gray-400 py-12">No finance data available.</div>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">{data.teamName} — Finance Ledger</h1>
              <p className="text-sm text-gray-400">Every transaction from initial auction onward.</p>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
              <SummaryCard label="Initial Budget" value={formatCurrency(data.initialBudget)} color="text-white" />
              <SummaryCard label="Current Purse" value={formatCurrency(data.currentPurse)} color="text-green-300" />
              <SummaryCard label="Total Spent" value={formatCurrency(data.summary.totalSpent)} color="text-red-300" />
              <SummaryCard label="Total Earned" value={formatCurrency(totalEarned)} color="text-blue-300" />
              <SummaryCard label="Net P&L" value={`${netPL >= 0 ? "+" : ""}${formatCurrency(netPL)}`} color={netPL >= 0 ? "text-green-300" : "text-red-300"} />
            </div>

            {/* Filter pills */}
            <div className="flex flex-wrap gap-2 mb-4">
              {(["all", "purchase", "release", "gw_payout", "trade"] as Filter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase border transition ${
                    filter === f
                      ? "bg-yellow-400 text-slate-900 border-yellow-400"
                      : "bg-white/5 text-gray-300 border-white/20 hover:bg-white/10"
                  }`}
                >
                  {f === "gw_payout" ? "GW Payouts" : f === "all" ? "All" : f}
                </button>
              ))}
            </div>

            {/* Ledger table */}
            <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-xs uppercase text-gray-400 bg-white/5">
                      <th className="text-left py-3 px-3">GW</th>
                      <th className="text-left py-3 px-3">Date</th>
                      <th className="text-left py-3 px-3">Type</th>
                      <th className="text-left py-3 px-3">Description</th>
                      <th className="text-right py-3 px-3">Amount</th>
                      <th className="text-right py-3 px-3">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center text-gray-400 py-8">No transactions</td>
                      </tr>
                    ) : (
                      filtered.map((e) => {
                        const style = TYPE_STYLES[e.type];
                        return (
                          <tr
                            key={e.id}
                            className={`border-b border-white/5 ${e.isPending ? "opacity-60 border-dashed" : ""}`}
                          >
                            <td className="py-2 px-3 text-gray-400 font-mono">{e.gw ?? "—"}</td>
                            <td className="py-2 px-3 text-gray-400 text-xs whitespace-nowrap">
                              {new Date(e.date).toLocaleDateString()}
                            </td>
                            <td className="py-2 px-3">
                              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${style.badge}`}>
                                {style.label}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-white">{e.description}</td>
                            <td
                              className={`py-2 px-3 text-right font-mono ${
                                e.amount > 0 ? "text-green-300" : e.amount < 0 ? "text-red-300" : "text-gray-500"
                              }`}
                            >
                              {e.amount === 0 ? "—" : `${e.amount > 0 ? "+" : ""}${formatCurrency(e.amount)}`}
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-white">
                              {formatCurrency(e.runningBalance)}
                            </td>
                          </tr>
                        );
                      })
                    )}
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

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3 backdrop-blur">
      <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg sm:text-xl font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}
