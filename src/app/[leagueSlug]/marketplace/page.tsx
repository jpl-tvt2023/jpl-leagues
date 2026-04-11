"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

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
  purchasePrice: number;
  fmv: number;
  status: string;
}

interface StandingEntry {
  teamId: string;
  teamName: string;
  abbreviation: string;
}

type Tab = "incoming" | "outgoing" | "veto" | "history";

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

export default function MarketplacePage() {
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myTeamId, setMyTeamId] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [proposals, setProposals] = useState<TradeProposal[]>([]);
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

      const [proposalsRes, standingsRes] = await Promise.all([
        fetch(`/api/auction/trade?leagueId=${league.id}`),
        fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`),
      ]);

      if (proposalsRes.ok) {
        const json = await proposalsRes.json();
        setProposals(json.proposals ?? []);
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

  useEffect(() => { load(); }, [load]);

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
    const now = Date.now();
    return proposals.filter((p) => {
      if (tab === "incoming") return p.status === "pending" && p.targetTeamId === myTeamId;
      if (tab === "outgoing") return p.status === "pending" && p.proposerTeamId === myTeamId;
      if (tab === "veto") return p.status === "accepted" && p.vetoDeadline && new Date(p.vetoDeadline).getTime() > now;
      return ["rejected", "vetoed", "expired", "completed"].includes(p.status) ||
        (p.status === "accepted" && p.vetoDeadline && new Date(p.vetoDeadline).getTime() <= now);
    });
  }, [proposals, myTeamId, tab]);

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

  const handleVote = async (proposalId: string, vote: "veto" | "approve") => {
    setActionError(null);
    try {
      const res = await fetch("/api/auction/trade/veto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId, vote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Vote failed");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Vote failed");
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
    const isInvolved = p.proposerTeamId === myTeamId || p.targetTeamId === myTeamId;
    const votesArr = Object.entries(p.vetoVotes);
    const approves = votesArr.filter(([, v]) => v === "approve").length;
    const vetos = votesArr.filter(([, v]) => v === "veto").length;
    const myVote = myTeamId ? p.vetoVotes[myTeamId] : null;

    return (
      <div key={p.id} className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-gray-400">
            <span className="text-white font-semibold">{teamName(p.proposerTeamId)}</span>
            {" → "}
            <span className="text-white font-semibold">{teamName(p.targetTeamId)}</span>
          </div>
          <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded border ${
            p.status === "pending" ? "bg-blue-500/20 text-blue-300 border-blue-500/40" :
            p.status === "accepted" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
            p.status === "completed" ? "bg-green-500/20 text-green-300 border-green-500/40" :
            p.status === "rejected" || p.status === "vetoed" || p.status === "expired" ? "bg-red-500/20 text-red-300 border-red-500/40" :
            "bg-white/10 text-gray-300 border-white/20"
          }`}>{p.status}</span>
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

        {tab === "incoming" && p.status === "pending" && isIncoming && (
          <div className="flex gap-2">
            <button onClick={() => handleRespond(p.id, "accept")} className="flex-1 rounded-lg bg-green-500/20 border border-green-500/40 text-green-300 font-semibold py-2 hover:bg-green-500/30 transition">Accept</button>
            <button onClick={() => handleRespond(p.id, "reject")} className="flex-1 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 font-semibold py-2 hover:bg-red-500/30 transition">Reject</button>
          </div>
        )}

        {tab === "veto" && p.status === "accepted" && !isInvolved && (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-gray-400">
              Votes: {approves} approve / {vetos} veto
              {p.vetoDeadline && ` · Closes ${new Date(p.vetoDeadline).toLocaleString()}`}
            </div>
            {myVote ? (
              <div className="text-xs text-yellow-400">You voted: {myVote}</div>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => handleVote(p.id, "approve")} className="flex-1 rounded-lg bg-green-500/20 border border-green-500/40 text-green-300 font-semibold py-2 hover:bg-green-500/30 transition text-sm">Approve</button>
                <button onClick={() => handleVote(p.id, "veto")} className="flex-1 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 font-semibold py-2 hover:bg-red-500/30 transition text-sm">Veto</button>
              </div>
            )}
          </div>
        )}

        {tab === "veto" && p.status === "accepted" && isInvolved && (
          <div className="text-xs text-gray-400">
            Awaiting veto vote ({approves} approve / {vetos} veto)
            {p.vetoDeadline && ` · Closes ${new Date(p.vetoDeadline).toLocaleString()}`}
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
      <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 bg-slate-900/80 backdrop-blur">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">JPL</div>
          <span className="text-xl font-bold text-white hidden sm:inline">Marketplace</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/dashboard" className="text-gray-300 hover:text-white transition">Dashboard</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">Standings</Link>
          <Link href={`/${leagueSlug}/auction`} className="text-gray-300 hover:text-white transition">Auction</Link>
          <Link href={`/${leagueSlug}/squad`} className="text-gray-300 hover:text-white transition">Squad</Link>
          <Link href={`/${leagueSlug}/marketplace`} className="text-yellow-400 font-semibold transition">Marketplace</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">Rules</Link>
          <button onClick={handleSignOut} className="rounded-full bg-white/10 px-6 py-2 font-semibold text-white hover:bg-white/20 transition">Sign Out</button>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">
        {isLoading ? (
          <LoadingScreen variant="dashboard" fullScreen={false} />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
              <h1 className="text-3xl sm:text-4xl font-bold text-white">Marketplace</h1>
              <button
                onClick={() => setShowCreate(true)}
                className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-5 py-2 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
              >
                + New Proposal
              </button>
            </div>

            <div className="mb-6 flex gap-2 flex-wrap border-b border-white/10">
              {(["incoming", "outgoing", "veto", "history"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2 font-semibold capitalize transition ${tab === t ? "text-yellow-400 border-b-2 border-yellow-400" : "text-gray-400 hover:text-white"}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {actionError && <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{actionError}</div>}

            <div className="space-y-4">
              {filtered.length === 0 ? (
                <div className="text-center text-gray-400 py-12 rounded-2xl border border-white/10 bg-white/5">
                  No {tab} proposals
                </div>
              ) : (
                filtered.map(renderProposalCard)
              )}
            </div>

            {/* Create Proposal Modal */}
            {showCreate && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setShowCreate(false)}>
                <div className="w-full max-w-3xl rounded-2xl border border-white/10 bg-slate-900 p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
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
                      <div className="max-h-60 overflow-y-auto space-y-1 rounded-lg border border-white/10 p-2">
                        {mySquad.map((p) => (
                          <label key={p.ownershipId} className="flex items-center gap-2 text-sm text-white hover:bg-white/5 px-2 py-1 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={offeredIds.has(p.ownershipId)}
                              onChange={() => toggle(offeredIds, p.ownershipId, setOfferedIds)}
                            />
                            <span className="flex-1">{p.playerName}</span>
                            <span className="font-mono text-xs text-gray-400">{formatCurrency(p.fmv)}</span>
                          </label>
                        ))}
                      </div>
                      <div className="mt-1 text-xs text-gray-400">FMV: {formatCurrency(offeredFMVPreview)}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase text-gray-400 mb-2">Request from target</div>
                      <div className="max-h-60 overflow-y-auto space-y-1 rounded-lg border border-white/10 p-2">
                        {!targetId ? (
                          <div className="text-xs text-gray-500 p-2">Select a target first</div>
                        ) : targetSquad.length === 0 ? (
                          <div className="text-xs text-gray-500 p-2">Loading...</div>
                        ) : (
                          targetSquad.map((p) => (
                            <label key={p.ownershipId} className="flex items-center gap-2 text-sm text-white hover:bg-white/5 px-2 py-1 rounded cursor-pointer">
                              <input
                                type="checkbox"
                                checked={requestedIds.has(p.ownershipId)}
                                onChange={() => toggle(requestedIds, p.ownershipId, setRequestedIds)}
                              />
                              <span className="flex-1">{p.playerName}</span>
                              <span className="font-mono text-xs text-gray-400">{formatCurrency(p.fmv)}</span>
                            </label>
                          ))
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
