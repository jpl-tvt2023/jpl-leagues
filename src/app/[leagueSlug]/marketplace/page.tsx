"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useEnforceFormat, useLeague } from "@/lib/league-context";
import { isPrimary } from "@/lib/formats/auction/tier";

interface TradeProposal {
  id: string;
  proposerTeamId: string;
  targetTeamId: string;
  offeredPlayerIds: string[];
  requestedPlayerIds: string[];
  cashOffered: number;
  status: "pending" | "accepted" | "rejected" | "vetoed" | "expired" | "completed";
  vetoDeadline: string | null;
  vetoVotes: Record<string, "veto" | "approve">;
  createdAt: number;
}

interface SquadPlayer {
  ownershipId: string;
  fplElementId: number;
  playerName: string;
  elementType: number | null;
  purchasePrice: number;
  fmv: number;
  status: string;
  plTeamShort?: string | null;
}

const MARKET_POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const MARKET_POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  2: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  3: "bg-green-500/20 text-green-300 border-green-500/30",
  4: "bg-red-500/20 text-red-300 border-red-500/30",
};

interface StandingEntry {
  teamId: string;
  teamName: string;
}

type Tab = "incoming" | "outgoing" | "live" | "releases" | "history";

const TRADE_EXPIRY_MS = 24 * 60 * 60 * 1000;

function ExpiryCountdown({ createdAt }: { createdAt: number | string }) {
  // Lazy initializer keeps Date.now() out of the render path (React purity rule).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const created = typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt;
  const remaining = created + TRADE_EXPIRY_MS - now;
  if (remaining <= 0) return <span className="text-[10px] text-red-300 uppercase tracking-wider font-bold">Expiring…</span>;
  const hrs = Math.floor(remaining / (60 * 60 * 1000));
  const mins = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
  return (
    <span className="text-[10px] text-gray-400 uppercase tracking-wider" title={`Created ${new Date(created).toLocaleString()}`}>
      Expires in {hrs}h {mins}m
    </span>
  );
}

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

export default function MarketplacePage() {
  useEnforceFormat(["auction"]);
  const { league } = useLeague();
  const isPrimaryTier = isPrimary(league.auctionTier);
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myTeamId, setMyTeamId] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [auctionLive, setAuctionLive] = useState(false);
  const [proposals, setProposals] = useState<TradeProposal[]>([]);
  const [liveOffers, setLiveOffers] = useState<TradeProposal[]>([]);
  const [teamList, setTeamList] = useState<StandingEntry[]>([]);
  const [ownershipMap, setOwnershipMap] = useState<Map<string, SquadPlayer & { teamId: string }>>(new Map());
  const [tab, setTab] = useState<Tab>("incoming");
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [mySquad, setMySquad] = useState<SquadPlayer[]>([]);

  // Create-proposal state
  const [targetId, setTargetId] = useState<string>("");
  const [targetSquad, setTargetSquad] = useState<SquadPlayer[]>([]);
  const [offeredIds, setOfferedIds] = useState<Set<string>>(new Set());
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());
  const [cashOffered, setCashOffered] = useState<string>("0");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
        setError("Marketplace is only available to team accounts.");
        setIsLoading(false);
        return;
      }
      setMyTeamId(me.team.id);

      const leaguesRes = await fetch("/api/leagues");
      const leaguesJson = await leaguesRes.json();
      const league = (leaguesJson.leagues || []).find((l: { slug: string; id: string }) => l.slug === leagueSlug);
      if (!league) throw new Error("League not found");
      setLeagueId(league.id);

      try {
        const liveRes = await fetch(`/api/auction/live-status?leagueId=${league.id}`);
        if (liveRes.ok) {
          const liveJson = await liveRes.json();
          setAuctionLive(!!liveJson.live);
        }
      } catch {
        // ignore
      }

      const [proposalsRes, liveOffersRes, standingsRes] = await Promise.all([
        fetch(`/api/auction/trade?leagueId=${league.id}`),
        fetch(`/api/auction/trade?leagueId=${league.id}&scope=public`),
        fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`),
      ]);

      if (proposalsRes.ok) {
        const json = await proposalsRes.json();
        setProposals(json.proposals ?? []);
      }

      if (liveOffersRes.ok) {
        const json = await liveOffersRes.json();
        setLiveOffers(json.proposals ?? []);
      }

      let teams: StandingEntry[] = [];
      if (standingsRes.ok) {
        const standings = await standingsRes.json();
        teams = standings.standings ?? [];
        setTeamList(teams);
      }

      // Fetch squads for all teams in the league in parallel to resolve ownership IDs
      const squadResponses = await Promise.all(
        teams.map((t) => fetch(`/api/auction/squad?teamId=${t.teamId}`).then((r) => r.ok ? r.json() : null))
      );
      const omap = new Map<string, SquadPlayer & { teamId: string }>();
      squadResponses.forEach((sq, idx) => {
        if (!sq) return;
        for (const p of sq.squad ?? []) {
          omap.set(p.ownershipId, { ...p, teamId: teams[idx].teamId });
        }
      });
      setOwnershipMap(omap);

      // My squad
      const mySquadRes = await fetch(`/api/auction/squad?teamId=${me.team.id}`);
      if (mySquadRes.ok) {
        const myJson = await mySquadRes.json();
        setMySquad((myJson.squad ?? []).filter((p: SquadPlayer) => p.status === "active"));
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load marketplace");
    } finally {
      setIsLoading(false);
    }
  }, [leagueSlug, router]);

  useEffect(() => {
    // Skip the fetch when the league is on the Primary tier — the page renders a placeholder
    // and the trade endpoints would 403 anyway.
    if (!isPrimaryTier) load();
  }, [load, isPrimaryTier]);

  // When user picks a target in the create modal, fetch their squad
  useEffect(() => {
    if (!targetId) {
      setTargetSquad([]);
      return;
    }
    fetch(`/api/auction/squad?teamId=${targetId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json) => {
        if (json) setTargetSquad((json.squad ?? []).filter((p: SquadPlayer) => p.status === "active"));
      });
  }, [targetId]);

  const filtered = useMemo(() => {
    if (!myTeamId) return [];
    return proposals.filter((p) => {
      if (tab === "incoming") return (p.status === "pending" || p.status === "accepted") && p.targetTeamId === myTeamId;
      if (tab === "outgoing") return (p.status === "pending" || p.status === "accepted") && p.proposerTeamId === myTeamId;
      if (tab === "releases") return false;
      return ["rejected", "vetoed", "expired", "completed", "cancelled"].includes(p.status);
    });
  }, [proposals, myTeamId, tab]);

  const pendingReleases = useMemo(() => {
    const arr: (SquadPlayer & { teamId: string })[] = [];
    for (const p of ownershipMap.values()) {
      if (p.status === "pending_release") arr.push(p);
    }
    return arr;
  }, [ownershipMap]);

  // Active = pending|accepted, matching the `filtered` predicate so the tab count never lies about
  // what the tab will render. Computed once per proposal-list change rather than per-tab-render.
  const tabCounts = useMemo(() => {
    if (!myTeamId) return { incoming: 0, outgoing: 0 };
    let incoming = 0, outgoing = 0;
    for (const p of proposals) {
      const active = p.status === "pending" || p.status === "accepted";
      if (!active) continue;
      if (p.targetTeamId === myTeamId) incoming++;
      else if (p.proposerTeamId === myTeamId) outgoing++;
    }
    return { incoming, outgoing };
  }, [proposals, myTeamId]);

  const teamName = (tid: string) => teamList.find((t) => t.teamId === tid)?.teamName ?? tid.slice(0, 6);

  const resolvePlayers = (ids: string[]): SquadPlayer[] => {
    return ids.map((id) => ownershipMap.get(id)).filter((p): p is SquadPlayer & { teamId: string } => !!p);
  };

  const handleRespond = async (proposalId: string, action: "accept" | "reject") => {
    setActionError(null);
    try {
      const res = await fetch("/api/auction/trade", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    }
  };

  const handleCreate = async () => {
    if (!leagueId || !targetId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const cash = parseInt(cashOffered.replace(/[^0-9-]/g, ""), 10) || 0;
      const res = await fetch("/api/auction/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leagueId,
          targetTeamId: targetId,
          offeredPlayerIds: Array.from(offeredIds),
          requestedPlayerIds: Array.from(requestedIds),
          cashOffered: cash,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const details = Array.isArray(data.details) ? ` — ${data.details.join("; ")}` : "";
        throw new Error((data.error || "Create failed") + details);
      }
      setShowCreate(false);
      setTargetId("");
      setOfferedIds(new Set());
      setRequestedIds(new Set());
      setCashOffered("0");
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const toggle = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const renderProposalCard = (p: TradeProposal) => {
    const offered = resolvePlayers(p.offeredPlayerIds);
    const requested = resolvePlayers(p.requestedPlayerIds);
    const offeredFMV = offered.reduce((s, x) => s + x.fmv, 0);
    const requestedFMV = requested.reduce((s, x) => s + x.fmv, 0);
    const isIncoming = p.targetTeamId === myTeamId;

    return (
      <div key={p.id} className={`rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur ${p.status === "expired" ? "opacity-60" : ""}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-gray-400">
            <span className="text-white font-semibold">{teamName(p.proposerTeamId)}</span>
            {" → "}
            <span className="text-white font-semibold">{teamName(p.targetTeamId)}</span>
          </div>
          <div className="flex items-center gap-2">
            {p.status === "pending" && <ExpiryCountdown createdAt={p.createdAt} />}
            <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded border ${
              p.status === "pending" ? "bg-blue-500/20 text-blue-300 border-blue-500/40" :
              p.status === "accepted" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
              p.status === "completed" ? "bg-green-500/20 text-green-300 border-green-500/40" :
              p.status === "rejected" || p.status === "vetoed" || p.status === "expired" ? "bg-red-500/20 text-red-300 border-red-500/40" :
              "bg-white/10 text-gray-300 border-white/20"
            }`}>{p.status}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="text-xs uppercase text-gray-400 mb-1">Offered</div>
            <div className="space-y-1">
              {offered.map((pl) => (
                <div key={pl.ownershipId} className="text-sm text-white flex justify-between">
                  <span>{pl.playerName}</span>
                  <span className="font-mono text-gray-400">{formatCurrency(pl.fmv)}</span>
                </div>
              ))}
              {offered.length === 0 && <div className="text-xs text-gray-500">None</div>}
            </div>
            <div className="mt-2 text-xs text-gray-400">FMV: {formatCurrency(offeredFMV)}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-gray-400 mb-1">Requested</div>
            <div className="space-y-1">
              {requested.map((pl) => (
                <div key={pl.ownershipId} className="text-sm text-white flex justify-between">
                  <span>{pl.playerName}</span>
                  <span className="font-mono text-gray-400">{formatCurrency(pl.fmv)}</span>
                </div>
              ))}
              {requested.length === 0 && <div className="text-xs text-gray-500">None</div>}
            </div>
            <div className="mt-2 text-xs text-gray-400">FMV: {formatCurrency(requestedFMV)}</div>
          </div>
        </div>

        {p.cashOffered !== 0 && (
          <div className="mb-4 text-sm">
            <span className="text-gray-400">Cash: </span>
            <span className={`font-mono font-bold ${p.cashOffered > 0 ? "text-green-300" : "text-red-300"}`}>
              {p.cashOffered > 0 ? "+" : ""}{formatCurrency(p.cashOffered)}
            </span>
            <span className="text-xs text-gray-500 ml-2">({p.cashOffered > 0 ? "proposer pays" : "proposer receives"})</span>
          </div>
        )}

        {p.status === "pending" && isIncoming && (
          <div className="flex gap-2">
            <button onClick={() => handleRespond(p.id, "accept")} className="flex-1 rounded-lg bg-green-500/20 border border-green-500/40 text-green-300 font-semibold py-2 hover:bg-green-500/30 transition">Accept</button>
            <button onClick={() => handleRespond(p.id, "reject")} className="flex-1 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 font-semibold py-2 hover:bg-red-500/30 transition">Reject</button>
          </div>
        )}

        {p.status === "accepted" && (
          <div className="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2">
            Awaiting admin approval
          </div>
        )}
      </div>
    );
  };

  const offeredFMVPreview = useMemo(() => {
    return Array.from(offeredIds).reduce((sum, id) => sum + (mySquad.find((p) => p.ownershipId === id)?.fmv ?? 0), 0);
  }, [offeredIds, mySquad]);
  const requestedFMVPreview = useMemo(() => {
    return Array.from(requestedIds).reduce((sum, id) => sum + (targetSquad.find((p) => p.ownershipId === id)?.fmv ?? 0), 0);
  }, [requestedIds, targetSquad]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueSlug}
        currentPage="marketplace"
        format="auction"
        auctionTier={league.auctionTier ?? "complete"}
        isLoggedIn={true}
        dashboardHref="/dashboard"
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">
        {isPrimaryTier ? (
          <div className="rounded-2xl border border-purple-500/30 bg-purple-500/10 p-5 sm:p-8 text-center">
            <h1 className="text-2xl sm:text-3xl font-bold text-purple-200 mb-2">Trades not available in Primary tier</h1>
            <p className="text-gray-300">
              This league was created in the Primary tier, which excludes the Marketplace.
              Upgrading to Complete unlocks player trades and slot expansion.
            </p>
            <Link
              href="/dashboard"
              className="mt-6 inline-block rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-5 py-2 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
            >
              Back to Dashboard
            </Link>
          </div>
        ) : isLoading ? (
          <LoadingScreen variant="default" fullScreen={false} label="Loading Marketplace" />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : auctionLive ? (
          <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-5 sm:p-8 text-center">
            <h1 className="text-2xl sm:text-3xl font-bold text-yellow-300 mb-2">Marketplace closed</h1>
            <p className="text-gray-300">
              The marketplace is locked while a live auction is in progress. Trades and proposals will reopen
              once the current auction session ends.
            </p>
            <p className="text-xs text-gray-500 mt-4">
              All previously pending trades were cancelled when the auction started.
            </p>
            <Link
              href={`/${leagueSlug}/auction`}
              className="mt-6 inline-block rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-5 py-2 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
            >
              Go to Auction
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
              <h1 className="text-2xl sm:text-4xl font-bold text-white">Marketplace</h1>
              <button
                onClick={() => setShowCreate(true)}
                className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-5 py-2 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
              >
                + New Proposal
              </button>
            </div>

            <div className="mb-6 flex gap-1 sm:gap-2 overflow-x-auto whitespace-nowrap border-b border-white/10 [&>*]:shrink-0">
              {(["incoming", "outgoing", "live", "releases", "history"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold capitalize transition ${tab === t ? "text-yellow-400 border-b-2 border-yellow-400" : "text-gray-400 hover:text-white"}`}
                >
                  {t === "releases"
                    ? `Pending Releases (${pendingReleases.length})`
                    : t === "live"
                      ? `Live Offers (${liveOffers.length})`
                      : t === "incoming"
                        ? `Incoming (${tabCounts.incoming})`
                        : t === "outgoing"
                          ? `Outgoing (${tabCounts.outgoing})`
                          : t}
                </button>
              ))}
            </div>

            {actionError && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{actionError}</div>}

            {tab === "live" ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-gray-400">
                  League-wide trades currently in progress (read-only). Use this to see which players other teams are negotiating over.
                </div>
                {liveOffers.length === 0 ? (
                  <div className="text-center text-gray-400 py-12 rounded-2xl border border-white/10 bg-white/5">
                    No live offers between other teams
                  </div>
                ) : (
                  liveOffers.map(renderProposalCard)
                )}
              </div>
            ) : tab === "releases" ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-xs text-gray-400 mb-3">
                  Players marked for release across the league. Release finalizes at the next GW 10/20/30 boundary — 50% refund is credited then. Player continues scoring for the owning team until then.
                </p>
                {pendingReleases.length === 0 ? (
                  <div className="text-center text-gray-400 py-8">No pending releases</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-white/10 text-xs uppercase text-gray-400">
                          <th className="text-left py-2 px-2">Player</th>
                          <th className="text-left py-2 px-2">Owning Team</th>
                          <th className="text-right py-2 px-2">Purchase Price</th>
                          <th className="text-right py-2 px-2">Projected Refund</th>
                          <th className="text-right py-2 px-2">Forfeit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingReleases.map((p) => {
                          const refund = Math.floor(p.purchasePrice * 0.5);
                          const forfeit = p.purchasePrice - refund;
                          return (
                            <tr key={p.ownershipId} className="border-b border-white/5">
                              <td className="py-2 px-2 text-white font-semibold">{p.playerName}</td>
                              <td className="py-2 px-2 text-gray-300">{teamName(p.teamId)}</td>
                              <td className="py-2 px-2 text-right font-mono text-white">{formatCurrency(p.purchasePrice)}</td>
                              <td className="py-2 px-2 text-right font-mono text-green-300">+{formatCurrency(refund)}</td>
                              <td className="py-2 px-2 text-right font-mono text-red-300">-{formatCurrency(forfeit)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {filtered.length === 0 ? (
                  <div className="text-center text-gray-400 py-12 rounded-2xl border border-white/10 bg-white/5">
                    No {tab} proposals
                  </div>
                ) : (
                  filtered.map(renderProposalCard)
                )}
              </div>
            )}

            {/* Create Proposal Modal */}
            {showCreate && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setShowCreate(false)}>
                <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-900 p-4 sm:p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-bold text-white">New Trade Proposal</h3>
                    <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-white">✕</button>
                  </div>

                  <div className="mb-4">
                    <label className="block text-xs uppercase text-gray-400 mb-1">Target Team</label>
                    <select
                      value={targetId}
                      onChange={(e) => { setTargetId(e.target.value); setRequestedIds(new Set()); }}
                      className="w-full rounded-lg bg-white/10 border border-white/20 px-3 py-2 text-white"
                    >
                      <option value="">Select a team...</option>
                      {teamList.filter((t) => t.teamId !== myTeamId).map((t) => (
                        <option key={t.teamId} value={t.teamId}>{t.teamName}</option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <div className="text-xs uppercase text-gray-400 mb-2">Offer from your squad</div>
                      <div className="max-h-60 overflow-y-auto rounded-lg border border-white/10 p-2 space-y-3">
                        {([1, 2, 3, 4] as const).map((posType) => {
                          const players = mySquad
                            .filter((p) => p.elementType === posType)
                            .sort((a, b) => b.fmv - a.fmv);
                          if (players.length === 0) return null;
                          return (
                            <div key={posType}>
                              <div className="flex items-center justify-between mb-1 px-1">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${MARKET_POSITION_COLORS[posType]}`}>
                                  {MARKET_POSITION_LABELS[posType]}
                                </span>
                                <span className="text-[10px] text-gray-500">{players.length}</span>
                              </div>
                              <div className="space-y-0.5">
                                {players.map((p) => (
                                  <label key={p.ownershipId} className="flex items-center gap-2 text-sm text-white hover:bg-white/5 px-2 py-1 rounded cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={offeredIds.has(p.ownershipId)}
                                      onChange={() => toggle(offeredIds, p.ownershipId, setOfferedIds)}
                                    />
                                    <span className="flex-1">
                                      {p.playerName}
                                      {p.plTeamShort && (
                                        <span className="ml-1 text-[10px] text-gray-500">({p.plTeamShort})</span>
                                      )}
                                    </span>
                                    <span className="font-mono text-xs text-gray-400">{formatCurrency(p.fmv)}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-1 text-xs text-gray-400">FMV: {formatCurrency(offeredFMVPreview)}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-gray-400 mb-2">Request from target</div>
                      <div className="max-h-60 overflow-y-auto rounded-lg border border-white/10 p-2 space-y-3">
                        {!targetId ? (
                          <div className="text-xs text-gray-500 p-2">Select a target first</div>
                        ) : targetSquad.length === 0 ? (
                          <div className="text-xs text-gray-500 p-2">Loading...</div>
                        ) : (
                          ([1, 2, 3, 4] as const).map((posType) => {
                            const players = targetSquad
                              .filter((p) => p.elementType === posType)
                              .sort((a, b) => b.fmv - a.fmv);
                            if (players.length === 0) return null;
                            return (
                              <div key={posType}>
                                <div className="flex items-center justify-between mb-1 px-1">
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${MARKET_POSITION_COLORS[posType]}`}>
                                    {MARKET_POSITION_LABELS[posType]}
                                  </span>
                                  <span className="text-[10px] text-gray-500">{players.length}</span>
                                </div>
                                <div className="space-y-0.5">
                                  {players.map((p) => (
                                    <label key={p.ownershipId} className="flex items-center gap-2 text-sm text-white hover:bg-white/5 px-2 py-1 rounded cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={requestedIds.has(p.ownershipId)}
                                        onChange={() => toggle(requestedIds, p.ownershipId, setRequestedIds)}
                                      />
                                      <span className="flex-1">
                                        {p.playerName}
                                        {p.plTeamShort && (
                                          <span className="ml-1 text-[10px] text-gray-500">({p.plTeamShort})</span>
                                        )}
                                      </span>
                                      <span className="font-mono text-xs text-gray-400">{formatCurrency(p.fmv)}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                      <div className="mt-1 text-xs text-gray-400">FMV: {formatCurrency(requestedFMVPreview)}</div>
                    </div>
                  </div>

                  <div className="mb-4">
                    <label className="block text-xs uppercase text-gray-400 mb-1">
                      Cash Offered (positive = you pay, negative = you receive)
                    </label>
                    <input
                      type="text"
                      value={cashOffered}
                      onChange={(e) => setCashOffered(e.target.value)}
                      className="w-full rounded-lg bg-white/10 border border-white/20 px-3 py-2 text-white font-mono"
                      placeholder="0"
                    />
                  </div>

                  <div className="mb-4 text-xs text-gray-400 bg-white/5 border border-white/10 rounded-lg p-3">
                    FMV floor check: each side must receive ≥80% of what they give.
                    <div className="mt-1">You give: <span className="text-white font-mono">{formatCurrency(offeredFMVPreview + Math.max(0, parseInt(cashOffered, 10) || 0))}</span></div>
                    <div>You receive: <span className="text-white font-mono">{formatCurrency(requestedFMVPreview + Math.max(0, -(parseInt(cashOffered, 10) || 0)))}</span></div>
                  </div>

                  {createError && <div className="mb-3 text-sm text-red-400">{createError}</div>}

                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowCreate(false)}
                      className="flex-1 rounded-lg bg-white/10 border border-white/20 text-white py-2 hover:bg-white/20 transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreate}
                      disabled={creating || !targetId || (offeredIds.size === 0 && requestedIds.size === 0)}
                      className="flex-1 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-4 py-2 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
                    >
                      {creating ? "Submitting..." : "Submit Proposal"}
                    </button>
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
