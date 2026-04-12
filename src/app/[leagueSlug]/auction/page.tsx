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

interface WishlistEntry {
  id: string;
  fplElementId: number;
  playerName: string;
  priority: number;
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

/** Compute the next bid based on the current high bid amount. */
function getNextBidAmount(currentHighBid: number): number {
  if (currentHighBid < 2_000_000) return currentHighBid + 100_000;
  if (currentHighBid < 5_000_000) return currentHighBid + 250_000;
  return currentHighBid + 500_000;
}

function getIncrementLabel(currentHighBid: number): string {
  if (currentHighBid < 2_000_000) return "+£100K";
  if (currentHighBid < 5_000_000) return "+£250K";
  return "+£500K";
}

function getJumpBidOptions(currentHighBid: number): number[] {
  const minNext = getNextBidAmount(currentHighBid);
  const milestones = [2_000_000, 5_000_000, 10_000_000, 15_000_000, 20_000_000, 30_000_000, 50_000_000];
  const jumps = milestones.filter((m) => m > minNext);
  return [minNext, ...jumps.slice(0, 2)];
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
  const [nominationDeadline, setNominationDeadline] = useState<string | null>(null);
  const [currentBid, setCurrentBid] = useState<CurrentBid | null>(null);
  const [teamMap, setTeamMap] = useState<Map<string, StandingEntry>>(new Map());
  const [elements, setElements] = useState<BootstrapElement[]>([]);
  const [plTeams, setPlTeams] = useState<Map<number, BootstrapTeam>>(new Map());
  const [ownedElementIds, setOwnedElementIds] = useState<Set<number>>(new Set());
  const [bidFeed, setBidFeed] = useState<BidFeedItem[]>([]);
  const [timerSec, setTimerSec] = useState<number>(0);
  const [placing, setPlacing] = useState(false);
  const [bidError, setBidError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [showNominate, setShowNominate] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [positionFilter, setPositionFilter] = useState<number | null>(null);
  const [nominating, setNominating] = useState<number | null>(null);
  const [wishlist, setWishlist] = useState<WishlistEntry[]>([]);
  const [nominationDeadlineSec, setNominationDeadlineSec] = useState<number>(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const teamMapRef = useRef<Map<string, StandingEntry>>(new Map());
  const leagueIdRef = useRef<string | null>(null);
  const myTeamIdRef = useRef<string | null>(null);
  const currentBidRef = useRef<CurrentBid | null>(null);
  const lastBidIdRef = useRef<string | null>(null);

  useEffect(() => { teamMapRef.current = teamMap; }, [teamMap]);
  useEffect(() => { leagueIdRef.current = leagueId; }, [leagueId]);
  useEffect(() => { myTeamIdRef.current = myTeamId; }, [myTeamId]);
  useEffect(() => { currentBidRef.current = currentBid; }, [currentBid]);

  const addFeed = useCallback((text: string, kind: BidFeedItem["kind"]) => {
    setBidFeed((prev) => [{ id: Math.random().toString(36).slice(2), text, kind, ts: Date.now() }, ...prev]);
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

      const [sessRes, standingsRes, ownedRes, economyRes, wishlistRes] = await Promise.all([
        fetch(`/api/auction/session?leagueId=${league.id}`),
        fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`),
        fetch(`/api/auction/league-owned?leagueId=${league.id}`),
        fetch(`/api/auction/economy?teamId=${me.team.id}`),
        fetch(`/api/auction/wishlist?teamId=${me.team.id}`),
      ]);

      let activeSessionId: string | null = null;
      const standingsMap = new Map<string, StandingEntry>();

      if (sessRes.ok) {
        const sessJson = await sessRes.json();
        const active = sessJson.activeSession;
        if (active) {
          activeSessionId = active.id;
          setSession({
            id: active.id,
            type: active.type,
            cycleNumber: active.cycleNumber ?? 0,
            status: active.status,
            snakeOrder: active.snakeOrder ?? [],
            currentNominatorIndex: active.currentNominatorIndex ?? 0,
          });
          setNominationDeadline(active.nominationDeadline ?? null);
          if (active.currentBid) setCurrentBid(active.currentBid);
        } else {
          // Fallback: find pending/paused session
          const fallback = (sessJson.sessions ?? []).find(
            (s: AuctionSession) => s.status === "pending" || s.status === "paused"
          );
          if (fallback) {
            activeSessionId = fallback.id;
            setSession(fallback);
          }
        }
      }

      if (standingsRes.ok) {
        const standingsJson = await standingsRes.json();
        const rows: StandingEntry[] = standingsJson.standings ?? [];
        for (const r of rows) standingsMap.set(r.teamId, r);
        setTeamMap(standingsMap);
      }

      if (ownedRes.ok) {
        const ownedJson = await ownedRes.json();
        setOwnedElementIds(new Set(ownedJson.ownedElementIds ?? []));
      }

      if (economyRes.ok) {
        const econ = await economyRes.json();
        setMyPurse(econ.computedPurse ?? 0);
      }

      if (wishlistRes.ok) {
        const wl = await wishlistRes.json();
        setWishlist(wl.wishlist ?? []);
      }

      // Load historical bid feed (persists across page reloads)
      if (activeSessionId) {
        const histRes = await fetch(`/api/auction/bid-history?sessionId=${activeSessionId}`);
        if (histRes.ok) {
          const histJson = await histRes.json();
          const histFeed: BidFeedItem[] = (histJson.bids ?? []).map(
            (b: { id: string; playerName: string; currentHighBid: number; currentHighBidderId: string; status: string; updatedAt: string }) => ({
              id: b.id,
              text:
                b.status === "sold"
                  ? `SOLD: ${b.playerName} → ${standingsMap.get(b.currentHighBidderId)?.teamName ?? "Unknown"} for ${formatCurrency(b.currentHighBid)}`
                  : `UNSOLD: ${b.playerName}`,
              kind: (b.status === "sold" ? "sold" : "unsold") as BidFeedItem["kind"],
              ts: new Date(b.updatedAt).getTime(),
            })
          );
          setBidFeed(histFeed);
        }
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

  // Helper to refetch the active session + currentBid from the REST endpoint.
  // Guards setSession behind a shallow compare so reference identity is stable
  // when nothing meaningful changed — critical for SSE useEffect stability.
  const refreshSessionState = useCallback(async () => {
    const lid = leagueIdRef.current;
    if (!lid) return;
    const res = await fetch(`/api/auction/session?leagueId=${lid}`);
    if (!res.ok) return;
    const json = await res.json();
    if (!json.activeSession) return;

    const a = json.activeSession;
    setSession((prev) => {
      if (!prev) return prev;
      const snakeOrderChanged =
        prev.snakeOrder.length !== (a.snakeOrder?.length ?? 0) ||
        prev.snakeOrder.some((t, i) => t !== a.snakeOrder?.[i]);
      if (
        prev.status === a.status &&
        prev.currentNominatorIndex === (a.currentNominatorIndex ?? 0) &&
        !snakeOrderChanged
      ) {
        return prev; // no change — keep same reference
      }
      return {
        ...prev,
        status: a.status,
        currentNominatorIndex: a.currentNominatorIndex ?? 0,
        snakeOrder: a.snakeOrder ?? prev.snakeOrder,
      };
    });

    setNominationDeadline((prev) => (prev === (a.nominationDeadline ?? null) ? prev : (a.nominationDeadline ?? null)));

    if (a.currentBid) {
      setCurrentBid(a.currentBid);
    } else {
      setCurrentBid((prev) => (prev === null ? prev : null));
    }
  }, []);

  // SSE subscription — depends only on session id + status (primitives) so it
  // doesn't tear down every time nominationDeadline or currentNominatorIndex
  // ticks. Handlers read changing values via refs.
  const sessionId = session?.id ?? null;
  const sessionStatus = session?.status ?? null;
  useEffect(() => {
    if (!sessionId || sessionStatus === "pending" || sessionStatus === "completed" || !sessionStatus) return;

    const es = new EventSource(`/api/auction/session/stream?sessionId=${sessionId}`);
    eventSourceRef.current = es;

    // Fresh REST sync on connect — belt & braces against SSE initial-poll race
    refreshSessionState();

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.addEventListener("auction-state", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(data);
      // New nomination detected — bidId changed
      if (data.bidId && data.bidId !== lastBidIdRef.current) {
        lastBidIdRef.current = data.bidId;
        const nominatorName = teamMapRef.current.get(data.nominatorTeamId)?.teamName ?? "Unknown";
        addFeed(`${nominatorName} nominated ${data.playerName} — base ${formatCurrency(data.minBid)}`, "info");
      }
    });
    es.addEventListener("bid-placed", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(data);
      const bidderName = teamMapRef.current.get(data.currentHighBidderId)?.teamName ?? "Unknown";
      addFeed(`${bidderName} bid ${formatCurrency(data.currentHighBid)} on ${data.playerName}`, "bid");
    });
    es.addEventListener("sold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const winnerName = data.winnerId ? teamMapRef.current.get(data.winnerId)?.teamName ?? "Unknown" : "—";
      addFeed(`SOLD: ${data.playerName} → ${winnerName} for ${formatCurrency(data.finalBid)}`, "sold");
      setCurrentBid(null);
      // Immediately sync session (advanceNominator already ran server-side before this event)
      refreshSessionState();
      // Refresh owned + purse
      const lid = leagueIdRef.current;
      const mtid = myTeamIdRef.current;
      if (lid) {
        fetch(`/api/auction/league-owned?leagueId=${lid}`).then((r) => r.json()).then((d) => setOwnedElementIds(new Set(d.ownedElementIds ?? [])));
      }
      if (mtid) {
        fetch(`/api/auction/economy?teamId=${mtid}`).then((r) => r.json()).then((d) => setMyPurse(d.computedPurse ?? 0));
        // Refresh wishlist — sold player was removed server-side
        fetch(`/api/auction/wishlist?teamId=${mtid}`).then((r) => r.json()).then((d) => setWishlist(d.wishlist ?? []));
      }
    });
    es.addEventListener("unsold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      addFeed(`UNSOLD: ${data.playerName}`, "unsold");
      setCurrentBid(null);
    });
    es.addEventListener("session-status", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setSession((prev) => {
        if (!prev) return prev;
        if (prev.status === data.status && prev.currentNominatorIndex === data.currentNominatorIndex) return prev;
        return { ...prev, status: data.status, currentNominatorIndex: data.currentNominatorIndex, snakeOrder: data.snakeOrder };
      });
      setNominationDeadline((prev) => (prev === (data.nominationDeadline ?? null) ? prev : (data.nominationDeadline ?? null)));
    });
    es.addEventListener("session-complete", () => {
      addFeed("Auction session completed", "info");
    });
    es.addEventListener("waiting", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      // Only clear currentBid if it was set — avoids spurious re-renders
      if (currentBidRef.current !== null) setCurrentBid(null);
      setNominationDeadline((prev) => (prev === (data.nominationDeadline ?? null) ? prev : (data.nominationDeadline ?? null)));
    });
    es.addEventListener("auto-nominated", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const teamName = teamMapRef.current.get(data.teamId)?.teamName ?? "Team";
      addFeed(`${teamName} auto-nominated from wishlist`, "info");
    });
    es.addEventListener("penalised", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const teamName = teamMapRef.current.get(data.teamId)?.teamName ?? "Team";
      addFeed(`${teamName} penalised — missed nomination (wishlist empty)`, "unsold");
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
      setSseConnected(false);
    };
  }, [sessionId, sessionStatus, addFeed, refreshSessionState]);

  // Refetch session + currentBid on intervals (SSE fallback)
  useEffect(() => {
    if (!leagueId || !sessionId) return;
    const t = setInterval(() => refreshSessionState(), 3000);
    return () => clearInterval(t);
  }, [leagueId, sessionId, refreshSessionState]);

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

  // Nomination deadline countdown (only when no currentBid)
  useEffect(() => {
    if (currentBid || !nominationDeadline) {
      setNominationDeadlineSec(0);
      return;
    }
    const tick = () => {
      const ms = new Date(nominationDeadline).getTime() - Date.now();
      setNominationDeadlineSec(Math.max(0, Math.ceil(ms / 1000)));
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [currentBid, nominationDeadline]);

  const currentNominatorId = useMemo(() => {
    if (!session?.snakeOrder?.length) return null;
    return session.snakeOrder[session.currentNominatorIndex] ?? null;
  }, [session]);

  const isMyTurn = currentNominatorId === myTeamId;
  const isHighBidder = currentBid?.currentHighBidderId === myTeamId;

  const handlePlaceBid = async (bidAmount?: number) => {
    if (!currentBid || !session) return;
    const amount = bidAmount ?? getNextBidAmount(currentBid.currentHighBid);
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
      // Optimistically update the bid card — don't wait for SSE round-trip
      if (myTeamId) {
        setCurrentBid((prev) =>
          prev ? { ...prev, currentHighBid: data.bidAmount, currentHighBidderId: data.bidderId, expiresAt: data.expiresAt } : prev
        );
      }
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
      // Immediately refresh to pick up the new bid (don't rely solely on SSE)
      await refreshSessionState();
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
    const lc = searchTerm.trim().toLowerCase();
    const filtered = elements.filter((el) => {
      if (ownedElementIds.has(el.id)) return false;
      if (positionFilter !== null && el.element_type !== positionFilter) return false;
      if (lc && !el.web_name.toLowerCase().includes(lc)) return false;
      return true;
    });
    return filtered
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, 30);
  }, [elements, ownedElementIds, searchTerm, positionFilter]);

  const refreshWishlist = useCallback(async () => {
    if (!myTeamId) return;
    const res = await fetch(`/api/auction/wishlist?teamId=${myTeamId}`);
    if (res.ok) {
      const data = await res.json();
      setWishlist(data.wishlist ?? []);
    }
  }, [myTeamId]);

  const handleAddToWishlist = async (elementId: number, playerName: string) => {
    if (!leagueId || !myTeamId) return;
    const res = await fetch("/api/auction/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueId, teamId: myTeamId, fplElementId: elementId, playerName }),
    });
    if (res.ok) await refreshWishlist();
  };

  const handleRemoveFromWishlist = async (id: string) => {
    if (!myTeamId) return;
    const res = await fetch("/api/auction/wishlist", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, teamId: myTeamId }),
    });
    if (res.ok) await refreshWishlist();
  };

  const handleReorderWishlist = async (fromIdx: number, toIdx: number) => {
    if (!myTeamId || toIdx < 0 || toIdx >= wishlist.length) return;
    const next = [...wishlist];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    // Optimistic update
    setWishlist(next.map((e, i) => ({ ...e, priority: i + 1 })));
    const items = next.map((e, i) => ({ id: e.id, priority: i + 1 }));
    await fetch("/api/auction/wishlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: myTeamId, items }),
    });
  };

  const wishlistElementIds = useMemo(() => new Set(wishlist.map((w) => w.fplElementId)), [wishlist]);

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
                          {teamMap.get(currentBid.currentHighBidderId)?.teamName ?? "—"}
                          {isHighBidder && " (YOU)"}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs uppercase text-gray-400">Timer</div>
                        <div className={`text-2xl font-mono font-bold ${timerSec <= 5 ? "text-red-400" : "text-white"}`}>{timerSec}s</div>
                      </div>
                    </div>
                    {isHighBidder ? (
                      <div className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 py-3 text-center text-sm font-semibold text-yellow-400">
                        You are the high bidder
                      </div>
                    ) : session.status === "active" && timerSec > 0 ? (
                      <div className="mt-2">
                        <div className="mb-2 text-center text-xs text-gray-400">Place your bid</div>
                        <div className="flex gap-2">
                          {getJumpBidOptions(currentBid.currentHighBid).map((amount, i) => (
                            <button
                              key={amount}
                              onClick={() => handlePlaceBid(amount)}
                              disabled={placing || amount > myPurse}
                              className={`flex-1 rounded-lg px-3 py-3 font-bold transition disabled:opacity-50 ${
                                i === 0
                                  ? "bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 hover:from-yellow-300 hover:to-orange-400"
                                  : "bg-white/10 text-white border border-white/20 hover:bg-white/20"
                              }`}
                            >
                              <div className="text-sm">{formatCurrency(amount)}</div>
                              {i === 0 && <div className="text-[10px] opacity-70">{getIncrementLabel(currentBid.currentHighBid)}</div>}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {bidError && <div className="mt-3 text-sm text-red-400">{bidError}</div>}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur text-center">
                    <div className="text-xs uppercase tracking-widest text-gray-400 mb-2">Waiting for Nomination</div>
                    {isMyTurn && session.status === "active" ? (
                      <>
                        <p className="text-white mb-2">It&apos;s your turn to nominate a player.</p>
                        {nominationDeadlineSec > 0 && (
                          <div className={`mb-4 text-sm font-mono ${nominationDeadlineSec <= 10 ? "text-red-400" : "text-yellow-300"}`}>
                            Auto-nom from wishlist in {nominationDeadlineSec}s
                          </div>
                        )}
                        <button
                          onClick={() => setShowNominate(true)}
                          className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
                        >
                          Nominate a Player
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="text-gray-400">
                          {currentNominatorId ? `Waiting for ${teamMap.get(currentNominatorId)?.teamName ?? "nominator"}...` : "Waiting for next nomination..."}
                        </p>
                        {nominationDeadlineSec > 0 && (
                          <div className="mt-2 text-xs font-mono text-gray-500">
                            Auto-nom in {nominationDeadlineSec}s
                          </div>
                        )}
                      </>
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

                {/* Wishlist */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider">Your Wishlist</h3>
                    <span className="text-xs text-gray-500">{wishlist.length}</span>
                  </div>
                  {wishlist.length === 0 ? (
                    <div className="text-xs text-gray-500 py-3 text-center">
                      Empty — add players from the nomination modal. If you miss your turn with an empty list, you&apos;ll lose a squad slot.
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-60 overflow-y-auto">
                      {wishlist.map((entry, idx) => (
                        <div
                          key={entry.id}
                          className="flex items-center gap-2 px-2 py-1 rounded text-sm bg-white/5"
                        >
                          <span className="w-5 text-right text-xs text-gray-500">{idx + 1}.</span>
                          <span className="flex-1 truncate text-white">{entry.playerName}</span>
                          <button
                            onClick={() => handleReorderWishlist(idx, idx - 1)}
                            disabled={idx === 0}
                            className="text-gray-400 hover:text-white disabled:opacity-30 text-xs"
                            title="Move up"
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => handleReorderWishlist(idx, idx + 1)}
                            disabled={idx === wishlist.length - 1}
                            className="text-gray-400 hover:text-white disabled:opacity-30 text-xs"
                            title="Move down"
                          >
                            ▼
                          </button>
                          <button
                            onClick={() => handleRemoveFromWishlist(entry.id)}
                            className="text-red-400 hover:text-red-300 text-xs"
                            title="Remove"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            </div>

            {/* Live Auction Feed — always visible, full width */}
            <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-3">Auction History</h3>
              <div className="space-y-1 max-h-96 overflow-y-auto text-xs">
                {bidFeed.length === 0 ? (
                  <div className="text-gray-500 py-3 text-center">No activity yet</div>
                ) : (
                  bidFeed.map((item) => (
                    <div
                      key={item.id}
                      className={`flex items-start gap-2 px-2 py-1.5 rounded ${
                        item.kind === "sold" ? "text-green-300 font-semibold bg-green-500/5" :
                        item.kind === "unsold" ? "text-yellow-300 bg-yellow-500/5" :
                        item.kind === "bid" ? "text-white" :
                        "text-gray-400"
                      }`}
                    >
                      <span className="text-[10px] text-gray-500 font-mono whitespace-nowrap mt-0.5">
                        {new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span>{item.text}</span>
                    </div>
                  ))
                )}
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
                    className="w-full rounded-lg bg-white/10 border border-white/20 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none mb-3"
                  />
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    {([
                      [null, "ALL"],
                      [1, "GKP"],
                      [2, "DEF"],
                      [3, "MID"],
                      [4, "FWD"],
                    ] as [number | null, string][]).map(([pos, label]) => (
                      <button
                        key={label}
                        onClick={() => setPositionFilter(pos)}
                        className={`px-3 py-1 rounded-full text-xs font-bold uppercase border transition ${
                          positionFilter === pos
                            ? "bg-yellow-400 text-slate-900 border-yellow-400"
                            : "bg-white/5 text-gray-300 border-white/20 hover:bg-white/10"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="mb-3">
                    <span className="text-xs text-gray-500">Opening bid: £500K (fixed) • Showing top {searchResults.length} by points</span>
                  </div>
                  <div className="max-h-80 overflow-y-auto space-y-1">
                    {searchResults.length === 0 ? (
                      <div className="text-sm text-gray-500 py-6 text-center">No matches</div>
                    ) : (
                      searchResults.map((el) => {
                        const team = plTeams.get(el.team);
                        const inWishlist = wishlistElementIds.has(el.id);
                        return (
                          <div
                            key={el.id}
                            className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition"
                          >
                            <button
                              onClick={() => handleNominate(el.id, el.web_name)}
                              disabled={nominating === el.id}
                              className="flex items-center gap-3 flex-1 text-left disabled:opacity-50"
                            >
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded border border-white/20 bg-white/10 text-gray-300">
                                {POSITION_LABELS[el.element_type]}
                              </span>
                              <div>
                                <div className="text-white font-semibold">{el.web_name}</div>
                                <div className="text-xs text-gray-400">{team?.short_name ?? "—"}</div>
                              </div>
                            </button>
                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <div className="text-sm font-mono text-[#00ff85]">{el.total_points} pts</div>
                                {nominating === el.id && <div className="text-xs text-gray-400">Nominating...</div>}
                              </div>
                              {inWishlist ? (
                                <span className="h-7 w-7 flex items-center justify-center rounded-full text-xs bg-yellow-400/20 text-yellow-400" title="In wishlist">★</span>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleAddToWishlist(el.id, el.web_name); }}
                                  className="h-7 w-7 flex items-center justify-center rounded-full text-xs bg-white/10 text-gray-300 hover:bg-purple-500/30 hover:text-purple-300 transition"
                                  title="Add to wishlist"
                                >
                                  +
                                </button>
                              )}
                            </div>
                          </div>
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
