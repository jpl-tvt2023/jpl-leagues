"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

interface AuctionSession {
  id: string;
  type: "initial" | "mini-auction";
  cycleNumber: number;
  status: "pending" | "active" | "paused" | "completed";
  snakeOrder: string[];
  currentNominatorIndex: number;
}

interface CurrentBid {
  bidId: string;
  fplElementId: number;
  playerName: string;
  currentHighBid: number;
  currentHighBidderId: string;
  nominatorTeamId: string;
  minBid: number;
  expiresAt: string;
  status: string;
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

interface StandingEntry {
  teamId: string;
  teamName: string;
  abbreviation: string;
}

interface BidFeedItem {
  id: string;
  text: string;
  kind: "bid" | "sold" | "unsold" | "waiting" | "info";
  ts: number;
}

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

export default function AuctionRoomPage() {
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myTeamId, setMyTeamId] = useState<string | null>(null);
  const [myPurse, setMyPurse] = useState<number>(0);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [session, setSession] = useState<AuctionSession | null>(null);
  const [currentBid, setCurrentBid] = useState<CurrentBid | null>(null);
  const [teamMap, setTeamMap] = useState<Map<string, StandingEntry>>(new Map());
  const [elements, setElements] = useState<BootstrapElement[]>([]);
  const [plTeams, setPlTeams] = useState<Map<number, BootstrapTeam>>(new Map());
  const [ownedElementIds, setOwnedElementIds] = useState<Set<number>>(new Set());
  const [bidFeed, setBidFeed] = useState<BidFeedItem[]>([]);
  const [timerSec, setTimerSec] = useState<number>(0);
  const [bidInput, setBidInput] = useState<string>("");
  const [placing, setPlacing] = useState(false);
  const [bidError, setBidError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [showNominate, setShowNominate] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [nominating, setNominating] = useState<number | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

  const addFeed = useCallback((text: string, kind: BidFeedItem["kind"]) => {
    setBidFeed((prev) => [{ id: Math.random().toString(36).slice(2), text, kind, ts: Date.now() }, ...prev].slice(0, 20));
  }, []);

  // Initial data load
  const loadInitial = useCallback(async () => {
    setIsLoading(true);
    setError(null);
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
      if (me.type !== "team") {
        setError("Auction room is only available to team accounts.");
        setIsLoading(false);
        return;
      }
      setMyTeamId(me.team.id);

      const leaguesJson = await leaguesRes.json();
      const league = (leaguesJson.leagues || []).find((l: { slug: string; id: string }) => l.slug === leagueSlug);
      if (!league) throw new Error("League not found");
      setLeagueId(league.id);

      if (bootstrapRes.ok) {
        const boot = await bootstrapRes.json();
        setElements(boot.elements ?? []);
        const tMap = new Map<number, BootstrapTeam>();
        for (const t of boot.teams ?? []) tMap.set(t.id, t);
        setPlTeams(tMap);
      }

      const [sessRes, standingsRes, ownedRes, economyRes] = await Promise.all([
        fetch(`/api/auction/session?leagueId=${league.id}`),
        fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`),
        fetch(`/api/auction/league-owned?leagueId=${league.id}`),
        fetch(`/api/auction/economy?teamId=${me.team.id}`),
      ]);

      if (sessRes.ok) {
        const sessJson = await sessRes.json();
        const active = sessJson.activeSession;
        if (active) {
          setSession({
            id: active.id,
            type: active.type,
            cycleNumber: active.cycleNumber ?? 0,
            status: active.status,
            snakeOrder: active.snakeOrder ?? [],
            currentNominatorIndex: active.currentNominatorIndex ?? 0,
          });
          if (active.currentBid) setCurrentBid(active.currentBid);
        } else {
          // Fallback: find pending/paused session
          const fallback = (sessJson.sessions ?? []).find(
            (s: AuctionSession) => s.status === "pending" || s.status === "paused"
          );
          if (fallback) setSession(fallback);
        }
      }

      if (standingsRes.ok) {
        const standingsJson = await standingsRes.json();
        const rows: StandingEntry[] = standingsJson.standings ?? [];
        const map = new Map<string, StandingEntry>();
        for (const r of rows) map.set(r.teamId, r);
        setTeamMap(map);
      }

      if (ownedRes.ok) {
        const ownedJson = await ownedRes.json();
        setOwnedElementIds(new Set(ownedJson.ownedElementIds ?? []));
      }

      if (economyRes.ok) {
        const econ = await economyRes.json();
        setMyPurse(econ.computedPurse ?? 0);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load auction room");
    } finally {
      setIsLoading(false);
    }
  }, [leagueSlug, router]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // SSE subscription
  useEffect(() => {
    if (!session || session.status === "pending" || session.status === "completed") return;

    const es = new EventSource(`/api/auction/session/stream?sessionId=${session.id}`);
    eventSourceRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.addEventListener("auction-state", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(data);
    });
    es.addEventListener("bid-placed", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(data);
      const bidderName = teamMap.get(data.currentHighBidderId)?.teamName ?? "Unknown";
      addFeed(`${bidderName} bid ${formatCurrency(data.currentHighBid)} on ${data.playerName}`, "bid");
    });
    es.addEventListener("sold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const winnerName = data.winnerId ? teamMap.get(data.winnerId)?.teamName ?? "Unknown" : "—";
      addFeed(`SOLD: ${data.playerName} → ${winnerName} for ${formatCurrency(data.finalBid)}`, "sold");
      setCurrentBid(null);
      // Refresh owned + purse
      if (leagueId) {
        fetch(`/api/auction/league-owned?leagueId=${leagueId}`).then((r) => r.json()).then((d) => setOwnedElementIds(new Set(d.ownedElementIds ?? [])));
      }
      if (myTeamId) {
        fetch(`/api/auction/economy?teamId=${myTeamId}`).then((r) => r.json()).then((d) => setMyPurse(d.computedPurse ?? 0));
      }
    });
    es.addEventListener("unsold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      addFeed(`UNSOLD: ${data.playerName}`, "unsold");
      setCurrentBid(null);
    });
    es.addEventListener("session-status", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setSession((prev) => prev ? { ...prev, status: data.status, currentNominatorIndex: data.currentNominatorIndex, snakeOrder: data.snakeOrder } : prev);
    });
    es.addEventListener("session-complete", () => {
      addFeed("Auction session completed", "info");
    });
    es.addEventListener("waiting", () => {
      setCurrentBid(null);
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
      setSseConnected(false);
    };
  }, [session, addFeed, teamMap, leagueId, myTeamId]);

  // Refetch session on intervals (to pick up nominator index changes after sold)
  useEffect(() => {
    if (!leagueId || !session) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/auction/session?leagueId=${leagueId}`);
      if (!res.ok) return;
      const json = await res.json();
      if (json.activeSession) {
        setSession((prev) => prev ? {
          ...prev,
          status: json.activeSession.status,
          currentNominatorIndex: json.activeSession.currentNominatorIndex ?? 0,
          snakeOrder: json.activeSession.snakeOrder ?? prev.snakeOrder,
        } : prev);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [leagueId, session]);

  // Timer countdown
  useEffect(() => {
    if (!currentBid) {
      setTimerSec(0);
      return;
    }
    const tick = () => {
      const ms = new Date(currentBid.expiresAt).getTime() - Date.now();
      setTimerSec(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [currentBid]);

  const currentNominatorId = useMemo(() => {
    if (!session?.snakeOrder?.length) return null;
    return session.snakeOrder[session.currentNominatorIndex] ?? null;
  }, [session]);

  const isMyTurn = currentNominatorId === myTeamId;
  const isHighBidder = currentBid?.currentHighBidderId === myTeamId;
  const minNextBid = currentBid ? Math.max(currentBid.currentHighBid + 100_000, currentBid.minBid) : 0;

  const handlePlaceBid = async () => {
    if (!currentBid || !session) return;
    const amount = parseInt(bidInput.replace(/[^0-9]/g, ""), 10);
    if (isNaN(amount)) {
      setBidError("Enter a valid amount");
      return;
    }
    setPlacing(true);
    setBidError(null);
    try {
      const res = await fetch("/api/auction/bid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, bidAmount: amount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Bid rejected");
      setBidInput("");
    } catch (err) {
      setBidError(err instanceof Error ? err.message : "Bid failed");
    } finally {
      setPlacing(false);
    }
  };

  const handleNominate = async (elementId: number, playerName: string) => {
    if (!session) return;
    setNominating(elementId);
    try {
      const res = await fetch("/api/auction/nominate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, fplElementId: elementId, playerName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Nomination failed");
      setShowNominate(false);
      setSearchTerm("");
    } catch (err) {
      setBidError(err instanceof Error ? err.message : "Nomination failed");
    } finally {
      setNominating(null);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const searchResults = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const lc = searchTerm.toLowerCase();
    return elements
      .filter((el) => !ownedElementIds.has(el.id) && el.web_name.toLowerCase().includes(lc))
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, 20);
  }, [elements, ownedElementIds, searchTerm]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 bg-slate-900/80 backdrop-blur">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">JPL</div>
          <span className="text-xl font-bold text-white hidden sm:inline">Auction Room</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/dashboard" className="text-gray-300 hover:text-white transition">Dashboard</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">Standings</Link>
          <Link href={`/${leagueSlug}/auction`} className="text-yellow-400 font-semibold transition">Auction</Link>
          <Link href={`/${leagueSlug}/squad`} className="text-gray-300 hover:text-white transition">Squad</Link>
          <Link href={`/${leagueSlug}/marketplace`} className="text-gray-300 hover:text-white transition">Marketplace</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">Rules</Link>
          <button onClick={handleSignOut} className="rounded-full bg-white/10 px-6 py-2 font-semibold text-white hover:bg-white/20 transition">Sign Out</button>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10">
        {isLoading ? (
          <LoadingScreen variant="dashboard" fullScreen={false} />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : !session ? (
          <div className="text-center py-16 rounded-2xl border border-white/10 bg-white/5">
            <h2 className="text-xl font-semibold text-white mb-2">No Active Auction Session</h2>
            <p className="text-gray-400">The admin has not yet created or started an auction session.</p>
          </div>
        ) : (
          <>
            {/* Header bar */}
            <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-wrap">
                <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${
                  session.status === "active" ? "bg-green-500/20 text-green-300 border-green-500/40" :
                  session.status === "paused" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
                  session.status === "pending" ? "bg-blue-500/20 text-blue-300 border-blue-500/40" :
                  "bg-white/10 text-gray-300 border-white/20"
                }`}>{session.status}</span>
                <span className="text-white font-semibold capitalize">{session.type.replace("-", " ")}</span>
                {session.cycleNumber > 0 && <span className="text-gray-400 text-sm">Cycle {session.cycleNumber}</span>}
                {sseConnected ? (
                  <span className="text-[10px] text-green-400 flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse"></span>LIVE</span>
                ) : (
                  <span className="text-[10px] text-gray-500">Connecting...</span>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm">
                <div>
                  <div className="text-xs text-gray-400 uppercase">Nominator</div>
                  <div className={`font-semibold ${isMyTurn ? "text-yellow-400" : "text-white"}`}>
                    {currentNominatorId ? teamMap.get(currentNominatorId)?.teamName ?? "—" : "—"}
                    {isMyTurn && " (YOU)"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 uppercase">Your Purse</div>
                  <div className="font-mono font-bold text-green-300">{formatCurrency(myPurse)}</div>
                </div>
              </div>
            </div>

            {session.status === "paused" && (
              <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-center text-yellow-300 text-sm">
                Auction paused by admin
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Main auction card */}
              <div className="lg:col-span-2">
                {currentBid ? (
                  <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-purple-900/40 to-slate-900/40 p-8 backdrop-blur">
                    <div className="text-center mb-6">
                      <div className="text-xs uppercase tracking-widest text-gray-400 mb-1">On the Block</div>
                      <h2 className="text-4xl font-bold text-white mb-2">{currentBid.playerName}</h2>
                      <div className="text-sm text-gray-400">
                        Nominated by {teamMap.get(currentBid.nominatorTeamId)?.teamName ?? "Unknown"}
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4 mb-6 text-center">
                      <div>
                        <div className="text-xs uppercase text-gray-400">Current Bid</div>
                        <div className="text-2xl font-mono font-bold text-[#00ff85]">{formatCurrency(currentBid.currentHighBid)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase text-gray-400">High Bidder</div>
                        <div className={`text-lg font-bold ${isHighBidder ? "text-yellow-400" : "text-white"}`}>
                          {teamMap.get(currentBid.currentHighBidderId)?.abbreviation ?? "—"}
                          {isHighBidder && " (YOU)"}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs uppercase text-gray-400">Timer</div>
                        <div className={`text-2xl font-mono font-bold ${timerSec <= 5 ? "text-red-400" : "text-white"}`}>{timerSec}s</div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder={`Min: ${formatCurrency(minNextBid)}`}
                        value={bidInput}
                        onChange={(e) => setBidInput(e.target.value)}
                        disabled={isHighBidder || session.status !== "active" || timerSec === 0}
                        className="flex-1 rounded-lg bg-white/10 border border-white/20 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none disabled:opacity-50"
                      />
                      <button
                        onClick={handlePlaceBid}
                        disabled={isHighBidder || placing || session.status !== "active" || timerSec === 0}
                        className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
                      >
                        {placing ? "..." : "Place Bid"}
                      </button>
                    </div>
                    {bidError && <div className="mt-3 text-sm text-red-400">{bidError}</div>}
                    {isHighBidder && <div className="mt-3 text-sm text-yellow-400 text-center">You are the high bidder</div>}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur text-center">
                    <div className="text-xs uppercase tracking-widest text-gray-400 mb-2">Waiting for Nomination</div>
                    {isMyTurn && session.status === "active" ? (
                      <>
                        <p className="text-white mb-4">It&apos;s your turn to nominate a player.</p>
                        <button
                          onClick={() => setShowNominate(true)}
                          className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
                        >
                          Nominate a Player
                        </button>
                      </>
                    ) : (
                      <p className="text-gray-400">
                        {currentNominatorId ? `Waiting for ${teamMap.get(currentNominatorId)?.teamName ?? "nominator"}...` : "Waiting for next nomination..."}
                      </p>
                    )}
                    {bidError && <div className="mt-3 text-sm text-red-400">{bidError}</div>}
                  </div>
                )}
              </div>

              {/* Sidebar */}
              <div className="space-y-6">
                {/* Snake order */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-3">Nomination Order</h3>
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {session.snakeOrder.map((tid, idx) => {
                      const team = teamMap.get(tid);
                      const isCurrent = idx === session.currentNominatorIndex;
                      return (
                        <div
                          key={`${tid}-${idx}`}
                          className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${isCurrent ? "bg-yellow-400/20 text-yellow-300 font-bold" : "text-gray-300"}`}
                        >
                          <span className="w-6 text-right text-xs text-gray-500">{idx + 1}.</span>
                          <span>{team?.teamName ?? tid}</span>
                          {isCurrent && <span className="ml-auto text-xs">◄</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Feed */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-3">Live Feed</h3>
                  <div className="space-y-1 max-h-80 overflow-y-auto text-xs">
                    {bidFeed.length === 0 ? (
                      <div className="text-gray-500">No activity yet</div>
                    ) : (
                      bidFeed.map((item) => (
                        <div
                          key={item.id}
                          className={`px-2 py-1 rounded ${
                            item.kind === "sold" ? "text-green-300 font-semibold" :
                            item.kind === "unsold" ? "text-yellow-300" :
                            item.kind === "bid" ? "text-white" :
                            "text-gray-400"
                          }`}
                        >
                          {item.text}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Nomination Modal */}
            {showNominate && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setShowNominate(false)}>
                <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-slate-900 p-6" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-xl font-bold text-white">Nominate a Player</h3>
                    <button onClick={() => setShowNominate(false)} className="text-gray-400 hover:text-white">✕</button>
                  </div>
                  <input
                    type="text"
                    placeholder="Search player name..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    autoFocus
                    className="w-full rounded-lg bg-white/10 border border-white/20 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none mb-4"
                  />
                  <div className="text-xs text-gray-500 mb-3">Opening bid: £500K (fixed)</div>
                  <div className="max-h-96 overflow-y-auto space-y-1">
                    {searchResults.length === 0 ? (
                      <div className="text-sm text-gray-500 py-6 text-center">
                        {searchTerm ? "No matches" : "Start typing to search"}
                      </div>
                    ) : (
                      searchResults.map((el) => {
                        const team = plTeams.get(el.team);
                        return (
                          <button
                            key={el.id}
                            onClick={() => handleNominate(el.id, el.web_name)}
                            disabled={nominating === el.id}
                            className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-left disabled:opacity-50"
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-white/20 bg-white/10 text-gray-300">
                                {POSITION_LABELS[el.element_type]}
                              </span>
                              <div>
                                <div className="text-white font-semibold">{el.web_name}</div>
                                <div className="text-xs text-gray-400">{team?.short_name ?? "—"}</div>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-sm font-mono text-[#00ff85]">{el.total_points} pts</div>
                              {nominating === el.id && <div className="text-xs text-gray-400">Nominating...</div>}
                            </div>
                          </button>
                        );
                      })
                    )}
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
