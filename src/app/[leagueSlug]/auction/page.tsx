"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LeagueNav } from "@/components/LeagueNav";
import { TierChip } from "@/components/TierChip";
import { SlotStatus } from "@/components/SlotStatus";
import type { ClubTier } from "@/lib/db/schema";
import { useEnforceFormat, useLeague } from "@/lib/league-context";
import { MAX_SQUAD_SIZE, effectiveMaxSquadSize } from "@/lib/formats/auction/squad-rules";

const CLUB_AUCTION_TYPE = "club-auction";

interface AuctionSession {
  id: string;
  type: "initial" | "mini-auction" | "club-auction";
  cycleNumber: number;
  status: "pending" | "active" | "paused" | "completed";
  snakeOrder: string[];
  currentNominatorIndex: number;
  scheduledAt?: string | null;
}

interface WishlistEntry {
  id: string;
  fplElementId: number;
  playerName: string;
  priority: number;
}

interface CurrentBid {
  bidId: string;
  fplElementId: number;        // For club-auction, this holds a PL team ID (re-purposed).
  playerName: string;          // For club-auction, this holds the PL club name.
  currentHighBid: number;
  currentHighBidderId: string;
  nominatorTeamId: string;
  minBid: number;
  expiresAt: string;
  status: string;
  tier?: ClubTier | null;      // Populated by server for club-auction sessions only.
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
  ownedClub?: {
    plTeamId: number;
    plTeamName: string;
    plTeamShort: string;
    tier: "top8" | "mid" | "promoted";
  } | null;
}

interface BidFeedItem {
  id: string;
  text: string;
  kind: "bid" | "sold" | "unsold" | "waiting" | "info";
  ts: number;
  bidId?: string; // Links feed entries to a specific auction item
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
  if (currentHighBid >= 10_000_000) return [minNext]; // No more jumps once we're past £10M
  const milestones = [2_000_000, 5_000_000, 10_000_000];
  const jumps = milestones.filter((m) => m > minNext);
  return [minNext, ...jumps.slice(0, 3)];
}

function ScheduledCountdown({ scheduledAt }: { scheduledAt: string }) {
  // Lazy initializer keeps Date.now() out of the render path (React purity rule).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const target = new Date(scheduledAt).getTime();
  const diff = target - now;
  if (diff <= 0) {
    return (
      <div className="text-2xl font-bold text-green-300">
        Starting any moment — waiting for admin to open the room
      </div>
    );
  }
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const Segment = ({ value, label }: { value: number; label: string }) => (
    <div className="flex flex-col items-center px-4">
      <div className="text-4xl sm:text-5xl font-mono font-bold text-white tabular-nums">{String(value).padStart(2, "0")}</div>
      <div className="text-[10px] uppercase tracking-widest text-gray-400 mt-1">{label}</div>
    </div>
  );
  return (
    <div className="flex items-center justify-center gap-2 sm:gap-4 flex-wrap">
      {days > 0 && <><Segment value={days} label="Days" /><div className="text-3xl text-gray-600">:</div></>}
      <Segment value={hours} label="Hours" />
      <div className="text-3xl text-gray-600">:</div>
      <Segment value={minutes} label="Minutes" />
      <div className="text-3xl text-gray-600">:</div>
      <Segment value={seconds} label="Seconds" />
    </div>
  );
}

function RedeemPenaltyButton({ teamId, onRedeemed }: { teamId: string; onRedeemed: () => void }) {
  const [loading, setLoading] = useState(false);
  const [cost, setCost] = useState<number | null>(null);
  const [penaltyId, setPenaltyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/auction/redeem-slot?teamId=${teamId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.penalties && data.penalties.length > 0) {
          const cheapest = [...data.penalties].sort((a, b) => a.cost - b.cost)[0];
          setCost(cheapest.cost);
          setPenaltyId(cheapest.id);
        } else if (data.legacyUnledgeredSlots > 0) {
          setCost(data.legacyCost);
          setPenaltyId(null);
        } else {
          setCost(null);
        }
      } catch {
        // ignore
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, [teamId]);

  const redeem = async () => {
    if (cost === null) return;
    if (!confirm(`Redeem one penalty slot for £${(cost / 1_000_000).toFixed(2)}M?`)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auction/redeem-slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, penaltyId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Redemption failed");
      onRedeemed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Redemption failed");
    } finally {
      setLoading(false);
    }
  };

  if (cost === null) return null;

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={redeem}
        disabled={loading}
        className="rounded-lg bg-red-500/20 border border-red-500/40 text-red-200 text-xs font-semibold px-3 py-1 hover:bg-red-500/30 transition disabled:opacity-50"
        title="Buy back one penalty slot to restore squad capacity"
      >
        {loading ? "Redeeming…" : `Redeem Penalty Slot (£${(cost / 1_000_000).toFixed(2)}M)`}
      </button>
      {error && <div className="text-[10px] text-red-300 mt-1">{error}</div>}
    </div>
  );
}

export default function AuctionRoomPage() {
  useEnforceFormat(["auction"]);
  const { league } = useLeague();
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
  const [mySlotStatus, setMySlotStatus] = useState<import("@/components/SlotStatus").SlotStatusData | null>(null);
  const [teamSummaries, setTeamSummaries] = useState<Record<string, {
    purse: number;
    penaltySlots: number;
    bonusSlots?: number;
    players: { fplElementId: number; playerName: string; purchasePrice: number }[];
  }>>({});
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const [bidFeed, setBidFeed] = useState<BidFeedItem[]>([]);
  const [expandedFeedBidId, setExpandedFeedBidId] = useState<string | null>(null);
  const [timerSec, setTimerSec] = useState<number>(0);
  const [placing, setPlacing] = useState(false);
  const [bidError, setBidError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [showNominate, setShowNominate] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [positionFilter, setPositionFilter] = useState<number | null>(null);
  const [nominating, setNominating] = useState<number | null>(null);
  const [wishlist, setWishlist] = useState<WishlistEntry[]>([]);
  const [wlPositionFilter, setWlPositionFilter] = useState<number | null>(null);
  const [wlTeamFilter, setWlTeamFilter] = useState<number | null>(null);
  // Tabbed panel: "wishlist" (existing list) vs "unsold" (players nominated this session but received
  // no bid). The Unsold tab supports multi-select + bulk add to wishlist.
  const [wishlistTab, setWishlistTab] = useState<"wishlist" | "unsold">("wishlist");
  const [unsoldPlayers, setUnsoldPlayers] = useState<Array<{ bidId: string; fplElementId: number; playerName: string; nominatedAt: string }>>([]);
  const [unsoldSelections, setUnsoldSelections] = useState<Set<number>>(new Set());
  const [bulkAddingWishlist, setBulkAddingWishlist] = useState(false);
  const [nominationDeadlineSec, setNominationDeadlineSec] = useState<number>(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const teamMapRef = useRef<Map<string, StandingEntry>>(new Map());
  const leagueIdRef = useRef<string | null>(null);
  const myTeamIdRef = useRef<string | null>(null);
  const currentBidRef = useRef<CurrentBid | null>(null);
  const lastBidIdRef = useRef<string | null>(null);
  const elementByIdRef = useRef<Map<number, BootstrapElement>>(new Map());
  const plTeamsRef = useRef<Map<number, BootstrapTeam>>(new Map());
  // Track the current session type so feed handlers can branch their formatting without re-binding.
  const sessionTypeRef = useRef<string | null>(null);

  useEffect(() => { teamMapRef.current = teamMap; }, [teamMap]);
  useEffect(() => { leagueIdRef.current = leagueId; }, [leagueId]);
  useEffect(() => { myTeamIdRef.current = myTeamId; }, [myTeamId]);
  useEffect(() => { currentBidRef.current = currentBid; }, [currentBid]);
  useEffect(() => { sessionTypeRef.current = session?.type ?? null; }, [session]);

  /** Build "[POS·TEAM]" suffix from an FPL element id, or empty string. For club-auction sessions
   *  the same ID is a PL team ID, not an element ID — skip the tag entirely; the bid feed already
   *  shows the club name and that's enough context. */
  const playerTag = useCallback((fplElementId: number | undefined | null): string => {
    if (!fplElementId) return "";
    if (sessionTypeRef.current === CLUB_AUCTION_TYPE) return "";
    const el = elementByIdRef.current.get(fplElementId);
    if (!el) return "";
    const pos = POSITION_LABELS[el.element_type];
    const plTeam = plTeamsRef.current.get(el.team);
    const parts = [pos, plTeam?.short_name].filter(Boolean);
    return parts.length ? ` [${parts.join("·")}]` : "";
  }, []);

  const addFeed = useCallback((text: string, kind: BidFeedItem["kind"], bidId?: string) => {
    setBidFeed((prev) => [{ id: Math.random().toString(36).slice(2), text, kind, ts: Date.now(), bidId }, ...prev]);
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

      const [sessRes, standingsRes, ownedRes, economyRes, wishlistRes, squadRes] = await Promise.all([
        fetch(`/api/auction/session?leagueId=${league.id}`),
        fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`),
        fetch(`/api/auction/league-owned?leagueId=${league.id}`),
        fetch(`/api/auction/economy?teamId=${me.team.id}`),
        fetch(`/api/auction/wishlist?teamId=${me.team.id}`),
        // Pull my squad's slot status so we can render <SlotStatus> with redeem/unlock costs.
        fetch(`/api/auction/squad?teamId=${me.team.id}`),
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
            scheduledAt: active.scheduledAt ?? null,
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
        // /api/standings returns `clubByTeamId` map separately; thread it onto each row so the
        // auction page has owned-club info inline with team identity (drives short codes + tier chip).
        const clubByTeamId: Record<string, StandingEntry["ownedClub"]> = standingsJson.clubByTeamId ?? {};
        for (const r of rows) {
          standingsMap.set(r.teamId, { ...r, ownedClub: clubByTeamId[r.teamId] ?? null });
        }
        setTeamMap(standingsMap);
      }

      if (ownedRes.ok) {
        const ownedJson = await ownedRes.json();
        setOwnedElementIds(new Set(ownedJson.ownedElementIds ?? []));
        setTeamSummaries(ownedJson.teamSummaries ?? {});
      }

      if (economyRes.ok) {
        const econ = await economyRes.json();
        setMyPurse(econ.computedPurse ?? 0);
      }

      if (wishlistRes.ok) {
        const wl = await wishlistRes.json();
        setWishlist(wl.wishlist ?? []);
      }

      if (squadRes.ok) {
        const sqJson = await squadRes.json();
        setMySlotStatus(sqJson.slotStatus ?? null);
      }

      // Load historical bid feed (persists across page reloads)
      if (activeSessionId) {
        const histRes = await fetch(`/api/auction/bid-history?sessionId=${activeSessionId}`);
        if (histRes.ok) {
          const histJson = await histRes.json();
          const histFeed: BidFeedItem[] = [];
          for (const b of histJson.bids ?? []) {
            // Sold/unsold entry (shown in feed)
            histFeed.push({
              id: b.id,
              text: b.status === "sold"
                ? `SOLD: ${b.playerName} → ${standingsMap.get(b.currentHighBidderId)?.teamName ?? "Unknown"} for ${formatCurrency(b.currentHighBid)}`
                : `UNSOLD: ${b.playerName}`,
              kind: (b.status === "sold" ? "sold" : "unsold") as BidFeedItem["kind"],
              ts: new Date(b.updatedAt).getTime(),
              bidId: b.id,
            });
            // Sub-entries from persisted logs (nomination + bids)
            if (b.logs && b.logs.length > 0) {
              for (const log of b.logs) {
                if (log.type === "sold" || log.type === "unsold") continue; // already the main entry
                const teamName = standingsMap.get(log.teamId)?.teamName ?? "Unknown";
                const text = log.type === "nomination"
                  ? `${teamName} nominated ${b.playerName} — base ${formatCurrency(log.amount)}`
                  : `${teamName} bid ${formatCurrency(log.amount)} on ${b.playerName}`;
                histFeed.push({
                  id: log.id,
                  text,
                  kind: log.type === "nomination" ? "info" : "bid",
                  ts: new Date(log.createdAt).getTime(),
                  bidId: b.id,
                });
              }
            } else {
              // Legacy fallback: no logs persisted yet, synthesize nomination sub-entry
              histFeed.push({
                id: `${b.id}-nom`,
                text: `${standingsMap.get(b.nominatorTeamId)?.teamName ?? "Unknown"} nominated ${b.playerName} — base ${formatCurrency(b.minBid)}`,
                kind: "info",
                ts: new Date(b.updatedAt).getTime() - 1,
                bidId: b.id,
              });
            }
          }
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
      setBidError(null); // Clear stale error — buttons re-render with correct amounts
      // New nomination detected — bidId changed
      if (data.bidId && data.bidId !== lastBidIdRef.current) {
        lastBidIdRef.current = data.bidId;
        const nominatorName = teamMapRef.current.get(data.nominatorTeamId)?.teamName ?? "Unknown";
        addFeed(`${nominatorName} nominated ${data.playerName}${playerTag(data.fplElementId)} — base ${formatCurrency(data.minBid)}`, "info", data.bidId);
      }
    });
    es.addEventListener("bid-placed", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(data);
      setBidError(null);
      const bidderName = teamMapRef.current.get(data.currentHighBidderId)?.teamName ?? "Unknown";
      addFeed(`${bidderName} bid ${formatCurrency(data.currentHighBid)} on ${data.playerName}${playerTag(data.fplElementId)}`, "bid", data.bidId);
    });
    es.addEventListener("sold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const winnerName = data.winnerId ? teamMapRef.current.get(data.winnerId)?.teamName ?? "Unknown" : "—";
      addFeed(`SOLD: ${data.playerName}${playerTag(data.fplElementId)} → ${winnerName} for ${formatCurrency(data.finalBid)}`, "sold", data.bidId);
      setCurrentBid(null);
      // Immediately sync session (advanceNominator already ran server-side before this event)
      refreshSessionState();
      // Refresh owned + purse
      const lid = leagueIdRef.current;
      const mtid = myTeamIdRef.current;
      if (lid) {
        fetch(`/api/auction/league-owned?leagueId=${lid}`).then((r) => r.json()).then((d) => {
          setOwnedElementIds(new Set(d.ownedElementIds ?? []));
          setTeamSummaries(d.teamSummaries ?? {});
        });
      }
      if (mtid) {
        fetch(`/api/auction/economy?teamId=${mtid}`).then((r) => r.json()).then((d) => setMyPurse(d.computedPurse ?? 0));
        // Refresh wishlist — sold player was removed server-side
        fetch(`/api/auction/wishlist?teamId=${mtid}`).then((r) => r.json()).then((d) => setWishlist(d.wishlist ?? []));
      }
    });
    es.addEventListener("unsold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      addFeed(`UNSOLD: ${data.playerName}${playerTag(data.fplElementId)}`, "unsold", data.bidId);
      setCurrentBid(null);
      // Keep the Unsold tab fresh — a new unsold-bid row exists on the server.
      const lid = leagueIdRef.current;
      if (lid) {
        fetch(`/api/auction/unsold?leagueId=${lid}`).then((r) => r.json()).then((d) => setUnsoldPlayers(d.unsold ?? []));
      }
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
    es.addEventListener("skipped-full", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const teamName = teamMapRef.current.get(data.teamId)?.teamName ?? "Team";
      addFeed(`${teamName} skipped — squad full`, "info");
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
      setSseConnected(false);
    };
  }, [sessionId, sessionStatus, addFeed, refreshSessionState]);

  // Refetch session + currentBid on intervals (SSE fallback). Also refresh
  // cross-team summaries and my purse so penalty/spend changes from other
  // teams (e.g. SOLD events on other clients) propagate without a hard reload.
  useEffect(() => {
    if (!leagueId || !sessionId) return;
    const tick = () => {
      refreshSessionState();
      const lid = leagueIdRef.current;
      const mtid = myTeamIdRef.current;
      if (lid) {
        fetch(`/api/auction/league-owned?leagueId=${lid}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => {
            if (!d) return;
            setOwnedElementIds(new Set(d.ownedElementIds ?? []));
            setTeamSummaries(d.teamSummaries ?? {});
          })
          .catch(() => {});
      }
      if (mtid) {
        fetch(`/api/auction/economy?teamId=${mtid}`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => { if (d) setMyPurse(d.computedPurse ?? 0); })
          .catch(() => {});
      }
    };
    const t = setInterval(tick, 3000);
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

  // For the "Nominate a Player" CTA: gate the button on squad-full / purse so
  // the user gets the same answer the server would give (avoids click → 400).
  const NOMINATE_MIN_BID = 500_000;
  const mySummary = myTeamId ? teamSummaries[myTeamId] : null;
  const myActiveCount = mySummary?.players?.length ?? 0;
  const myPenaltySlots = mySummary?.penaltySlots ?? 0;
  const myBonusSlots = mySummary?.bonusSlots ?? 0;
  // Squad-full check via the shared helper: base MAX_SQUAD_SIZE + bonus unlocks − penalty slots.
  const mySquadFull = myActiveCount >= effectiveMaxSquadSize(myPenaltySlots, myBonusSlots);
  const cannotAffordNomination = myPurse < NOMINATE_MIN_BID;
  const nominateBlockedReason = mySquadFull
    ? "Squad full"
    : cannotAffordNomination
      ? `Need ${formatCurrency(NOMINATE_MIN_BID)} purse`
      : null;

  // Map fplElementId → element for position lookups in nomination table
  const elementById = useMemo(() => {
    const m = new Map<number, BootstrapElement>();
    for (const el of elements) m.set(el.id, el);
    return m;
  }, [elements]);

  // Mirror into refs so SSE handlers (registered once) can read the latest maps
  useEffect(() => { elementByIdRef.current = elementById; }, [elementById]);
  useEffect(() => { plTeamsRef.current = plTeams; }, [plTeams]);

  const filteredWishlist = useMemo(() => {
    return wishlist.filter((entry) => {
      const el = elementById.get(entry.fplElementId);
      if (!el) return true; // show if element data missing
      if (wlPositionFilter !== null && el.element_type !== wlPositionFilter) return false;
      if (wlTeamFilter !== null && el.team !== wlTeamFilter) return false;
      return true;
    });
  }, [wishlist, wlPositionFilter, wlTeamFilter, elementById]);

  const wlTeamOptions = useMemo(() => {
    const teamIds = new Set<number>();
    for (const entry of wishlist) {
      const el = elementById.get(entry.fplElementId);
      if (el) teamIds.add(el.team);
    }
    return Array.from(teamIds)
      .map((id) => ({ id, name: plTeams.get(id)?.short_name ?? `Team ${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [wishlist, elementById, plTeams]);

  const isWlFiltered = wlPositionFilter !== null || wlTeamFilter !== null;

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
      if (currentBidRef.current?.fplElementId === el.id) return false; // Currently being auctioned
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

  // Fetch the league's unsold players for the most-recent auction session — populates the Unsold
  // tab in the wishlist panel. Lazy-loaded when the user switches tabs.
  const refreshUnsold = useCallback(async () => {
    if (!leagueId) return;
    const res = await fetch(`/api/auction/unsold?leagueId=${leagueId}`);
    if (res.ok) {
      const data = await res.json();
      setUnsoldPlayers(data.unsold ?? []);
    }
  }, [leagueId]);

  const handleBulkAddToWishlist = async () => {
    if (!leagueId || !myTeamId || unsoldSelections.size === 0 || bulkAddingWishlist) return;
    setBulkAddingWishlist(true);
    try {
      const players = unsoldPlayers
        .filter((p) => unsoldSelections.has(p.fplElementId))
        .map((p) => ({ fplElementId: p.fplElementId, playerName: p.playerName }));
      const res = await fetch("/api/auction/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId, teamId: myTeamId, players }),
      });
      if (res.ok) {
        setUnsoldSelections(new Set());
        await refreshWishlist();
      }
    } finally {
      setBulkAddingWishlist(false);
    }
  };

  // Pulls the current league-wide owned-players list. Called explicitly when the nominate modal
  // opens so a freshly-sold player is filtered out immediately, before the user can attempt to
  // nominate them. SSE events also drive this set but can be in-flight on slow networks.
  const refreshOwned = useCallback(async () => {
    if (!leagueId) return;
    const res = await fetch(`/api/auction/league-owned?leagueId=${leagueId}`);
    if (res.ok) {
      const data = await res.json();
      setOwnedElementIds(new Set(data.ownedElementIds ?? []));
      if (data.teamSummaries) setTeamSummaries(data.teamSummaries);
    }
  }, [leagueId]);

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
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueSlug}
        currentPage="auction"
        format="auction"
        auctionTier={league.auctionTier ?? "complete"}
        isLoggedIn={true}
        dashboardHref="/dashboard"
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10">
        {isLoading ? (
          <LoadingScreen variant="default" fullScreen={false} label="Loading Auction" />
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

            {/* Always-visible squad-slot summary: open / penalty / locked. Replaces the old
                conditional "Penalty slots: N" + RedeemPenaltyButton pair so users see slot economy
                even when they're at the default 15 cap with no penalties. */}
            {mySlotStatus && (
              <div className="mb-4">
                <SlotStatus
                  slotStatus={mySlotStatus}
                  auctionTier={league.auctionTier ?? "complete"}
                  onUnlock={async () => {
                    if (!myTeamId) return;
                    const cost = mySlotStatus.nextUnlockCost;
                    if (!cost) return;
                    if (!confirm(`Unlock slot ${MAX_SQUAD_SIZE + mySlotStatus.bonusSlots + 1} for £${(cost / 1_000_000).toFixed(1)}M? This is non-refundable.`)) return;
                    try {
                      const res = await fetch(`/api/auction/unlock-slot`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ teamId: myTeamId }),
                      });
                      const data = await res.json();
                      if (!res.ok) { alert(data?.error ?? "Unlock failed"); return; }
                      // Refresh slot status + economy.
                      const [sq, econ] = await Promise.all([
                        fetch(`/api/auction/squad?teamId=${myTeamId}`).then(r => r.ok ? r.json() : null),
                        fetch(`/api/auction/economy?teamId=${myTeamId}`).then(r => r.ok ? r.json() : null),
                      ]);
                      if (sq) setMySlotStatus(sq.slotStatus ?? null);
                      if (econ) setMyPurse(econ.computedPurse ?? 0);
                    } catch (e) {
                      alert(`Unlock failed: ${e instanceof Error ? e.message : "unknown"}`);
                    }
                  }}
                  onRedeem={async () => {
                    if (!myTeamId) return;
                    const cost = mySlotStatus.redeemableCost;
                    if (cost == null) return;
                    if (!confirm(`Redeem penalty slot for £${(cost / 1_000_000).toFixed(1)}M?`)) return;
                    try {
                      const res = await fetch(`/api/auction/redeem-slot`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ teamId: myTeamId }),
                      });
                      const data = await res.json();
                      if (!res.ok) { alert(data?.error ?? "Redeem failed"); return; }
                      const [sq, econ] = await Promise.all([
                        fetch(`/api/auction/squad?teamId=${myTeamId}`).then(r => r.ok ? r.json() : null),
                        fetch(`/api/auction/economy?teamId=${myTeamId}`).then(r => r.ok ? r.json() : null),
                      ]);
                      if (sq) setMySlotStatus(sq.slotStatus ?? null);
                      if (econ) setMyPurse(econ.computedPurse ?? 0);
                      refreshSessionState();
                    } catch (e) {
                      alert(`Redeem failed: ${e instanceof Error ? e.message : "unknown"}`);
                    }
                  }}
                />
              </div>
            )}

            {session.status === "paused" && (
              <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-center text-yellow-300 text-sm">
                Auction paused by admin
              </div>
            )}

            {session.status === "pending" && (
              <div className="mb-4 rounded-2xl border border-blue-500/30 bg-gradient-to-br from-blue-500/10 to-purple-500/10 p-6 text-center backdrop-blur">
                <div className="text-[11px] uppercase tracking-widest text-blue-300 mb-2">Auction Scheduled</div>
                {session.scheduledAt ? (
                  <>
                    <ScheduledCountdown scheduledAt={session.scheduledAt} />
                    <div className="text-xs text-gray-400 mt-2">
                      Starts {new Date(session.scheduledAt).toLocaleString([], { dateStyle: "full", timeStyle: "short" })}
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="text-2xl font-bold text-white mb-1">Awaiting Start</h2>
                    <p className="text-sm text-gray-400">The admin has created this auction. It will begin when they click Start.</p>
                  </>
                )}
              </div>
            )}

            {/* Row 1: Bid card + Nomination Order table */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-2">
                {currentBid ? (
                  <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-purple-900/40 to-slate-900/40 p-5 backdrop-blur h-full">
                    {(() => {
                      const isClubAuction = session.type === CLUB_AUCTION_TYPE;
                      if (isClubAuction) {
                        // For club-auction, `fplElementId` is a PL team ID and `playerName` is the
                        // PL club name. Skip the FPL element lookup; render the tier chip instead.
                        const plTeam = plTeams.get(currentBid.fplElementId);
                        return (
                          <div className="text-center mb-4">
                            <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">Club on the Block</div>
                            <h2 className="text-xl sm:text-2xl font-bold text-white mb-1 break-words">{currentBid.playerName}</h2>
                            <div className="flex items-center justify-center gap-1.5 mb-1">
                              {currentBid.tier && (
                                <TierChip
                                  tier={currentBid.tier}
                                  clubName={currentBid.playerName}
                                  short={plTeam?.short_name}
                                />
                              )}
                              {plTeam && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-gray-300">{plTeam.short_name}</span>}
                            </div>
                            <div className="text-xs text-gray-400">
                              System-nominated · Base {formatCurrency(currentBid.minBid)}
                            </div>
                          </div>
                        );
                      }
                      const el = elementById.get(currentBid.fplElementId);
                      const pos = el ? POSITION_LABELS[el.element_type] : null;
                      const plTeam = el ? plTeams.get(el.team) : null;
                      return (
                        <div className="text-center mb-4">
                          <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">On the Block</div>
                          <h2 className="text-xl sm:text-2xl font-bold text-white mb-1 break-words">{currentBid.playerName}</h2>
                          <div className="flex items-center justify-center gap-1.5 mb-1">
                            {pos && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-white/20 text-gray-300">{pos}</span>}
                            {plTeam && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-gray-300">{plTeam.short_name}</span>}
                          </div>
                          <div className="text-xs text-gray-400">
                            Nominated by {teamMap.get(currentBid.nominatorTeamId)?.teamName ?? "Unknown"} · Base {formatCurrency(currentBid.minBid)}
                          </div>
                        </div>
                      );
                    })()}
                    <div className="grid grid-cols-3 gap-3 mb-4 text-center">
                      <div>
                        <div className="text-[10px] uppercase text-gray-400">Bid</div>
                        <div className="text-lg sm:text-2xl font-mono font-bold text-[#00ff85]">{formatCurrency(currentBid.currentHighBid)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-gray-400">Leader</div>
                        <div className={`text-sm font-bold ${isHighBidder ? "text-yellow-400" : "text-white"}`}>
                          {teamMap.get(currentBid.currentHighBidderId)?.teamName ?? "—"}
                          {isHighBidder && " (YOU)"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-gray-400">Timer</div>
                        <div className={`text-3xl sm:text-5xl font-mono font-bold ${timerSec <= 5 ? "text-red-400 animate-pulse" : "text-amber-300"}`}>{timerSec}s</div>
                      </div>
                    </div>
                    {isHighBidder ? (
                      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 py-2 text-center text-xs font-semibold text-yellow-400">
                        You are the high bidder
                      </div>
                    ) : session.status === "active" && timerSec > 0 ? (
                      <div>
                        <div className="flex flex-wrap gap-2">
                          {getJumpBidOptions(currentBid.currentHighBid).map((amount, i) => (
                            <button
                              key={amount}
                              onClick={() => handlePlaceBid(amount)}
                              disabled={placing || amount > myPurse}
                              className={`flex-1 min-w-[80px] rounded-lg px-2 py-2.5 font-bold transition disabled:opacity-50 ${
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
                    {bidError && <div className="mt-2 text-xs text-red-400">{bidError}</div>}
                  </div>
                ) : session.type === CLUB_AUCTION_TYPE ? (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur text-center h-full flex flex-col items-center justify-center">
                    <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-2">Waiting for next club</div>
                    <p className="text-gray-300 text-sm">
                      The system auto-nominates one PL club at a time. The next club will appear shortly.
                    </p>
                    {bidError && <div className="mt-2 text-xs text-red-400">{bidError}</div>}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur text-center h-full flex flex-col items-center justify-center">
                    <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-2">Waiting for Nomination</div>
                    {isMyTurn && session.status === "active" ? (
                      <>
                        <p className="text-white text-sm mb-2">It&apos;s your turn to nominate a player.</p>
                        {nominationDeadlineSec > 0 && (
                          <div className={`mb-3 text-sm font-mono ${nominationDeadlineSec <= 10 ? "text-red-400" : "text-yellow-300"}`}>
                            Auto-nom in {nominationDeadlineSec}s
                          </div>
                        )}
                        <button
                          onClick={() => { void refreshOwned(); setShowNominate(true); }}
                          disabled={!!nominateBlockedReason}
                          className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-5 py-2.5 font-bold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Nominate a Player
                        </button>
                        {nominateBlockedReason && (
                          <div className="mt-2 text-[11px] text-red-400">{nominateBlockedReason} — you can&apos;t nominate</div>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-gray-400 text-sm">
                          {currentNominatorId ? `Waiting for ${teamMap.get(currentNominatorId)?.teamName ?? "nominator"}...` : "Waiting for next nomination..."}
                        </p>
                        {nominationDeadlineSec > 0 && (
                          <div className="mt-1 text-xs font-mono text-gray-500">
                            Auto-nom in {nominationDeadlineSec}s
                          </div>
                        )}
                      </>
                    )}
                    {bidError && <div className="mt-2 text-xs text-red-400">{bidError}</div>}
                  </div>
                )}
              </div>

              {/* Nomination Order Table */}
              <div className="lg:col-span-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-3">Nomination Order</h3>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-900/95 z-10">
                        <tr className="text-gray-400 uppercase tracking-wider border-b border-white/10">
                          <th className="text-left py-2 px-2 w-8">#</th>
                          <th className="text-left py-2 px-2">Team</th>
                          <th className="text-right py-2 px-2">Purse</th>
                          <th className="text-center py-2 px-1">GKP</th>
                          <th className="text-center py-2 px-1">DEF</th>
                          <th className="text-center py-2 px-1">MID</th>
                          <th className="text-center py-2 px-1">FWD</th>
                          <th className="text-center py-2 px-1">Tot</th>
                        </tr>
                      </thead>
                      <tbody>
                        {session.snakeOrder.map((tid, idx) => {
                          const team = teamMap.get(tid);
                          const isCurrent = idx === session.currentNominatorIndex;
                          const isMe = tid === myTeamId;
                          const summary = teamSummaries[tid];
                          const players = summary?.players ?? [];
                          const isExpanded = expandedTeamId === tid;

                          const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
                          for (const p of players) {
                            const el = elementById.get(p.fplElementId);
                            if (el) {
                              const pos = POSITION_LABELS[el.element_type];
                              if (pos && pos in counts) counts[pos as keyof typeof counts]++;
                            }
                          }
                          const MIN_QUOTA: Record<keyof typeof counts, number> = { GKP: 1, DEF: 3, MID: 3, FWD: 1 };
                          const cellClass = (pos: keyof typeof counts) =>
                            counts[pos] >= MIN_QUOTA[pos] ? "text-green-400" : "text-red-400";

                          return (
                            <React.Fragment key={`${tid}-${idx}`}>
                              <tr
                                onClick={() => setExpandedTeamId(isExpanded ? null : tid)}
                                className={`cursor-pointer border-b border-white/5 transition hover:bg-white/5 ${
                                  isCurrent ? "bg-yellow-400/10" : ""
                                } ${isMe ? "bg-purple-500/10" : ""}`}
                              >
                                <td className="py-1.5 px-2 text-gray-500">
                                  {isCurrent ? <span className="text-yellow-400 font-bold">►</span> : <span>{idx + 1}</span>}
                                </td>
                                <td className={`py-1.5 px-2 font-semibold ${isCurrent ? "text-yellow-300" : isMe ? "text-purple-300" : "text-white"}`}>
                                  <span className="inline-flex items-center gap-1.5">
                                    <span>{team?.teamName ?? tid}</span>
                                    {team?.ownedClub && (
                                      <span
                                        title={`${team.ownedClub.plTeamName} · ${team.ownedClub.tier}`}
                                        className={`text-[9px] font-bold px-1 py-0.5 rounded border ${
                                          team.ownedClub.tier === "top8" ? "bg-yellow-500/20 text-yellow-200 border-yellow-500/40"
                                          : team.ownedClub.tier === "mid" ? "bg-blue-500/20 text-blue-200 border-blue-500/40"
                                          : "bg-emerald-500/20 text-emerald-200 border-emerald-500/40"
                                        }`}
                                      >
                                        {team.ownedClub.plTeamShort}
                                      </span>
                                    )}
                                    {isMe && <span className="text-[10px] text-purple-400">(you)</span>}
                                  </span>
                                </td>
                                <td className="py-1.5 px-2 text-right font-mono text-green-300">
                                  {summary ? formatCurrency(summary.purse) : "—"}
                                </td>
                                <td className={`py-1.5 px-1 text-center font-mono ${cellClass("GKP")}`}>{counts.GKP}<span className="text-gray-500">/{MIN_QUOTA.GKP}</span></td>
                                <td className={`py-1.5 px-1 text-center font-mono ${cellClass("DEF")}`}>{counts.DEF}<span className="text-gray-500">/{MIN_QUOTA.DEF}</span></td>
                                <td className={`py-1.5 px-1 text-center font-mono ${cellClass("MID")}`}>{counts.MID}<span className="text-gray-500">/{MIN_QUOTA.MID}</span></td>
                                <td className={`py-1.5 px-1 text-center font-mono ${cellClass("FWD")}`}>{counts.FWD}<span className="text-gray-500">/{MIN_QUOTA.FWD}</span></td>
                                <td className="py-1.5 px-1 text-center text-white font-semibold">{players.length}</td>
                              </tr>
                              {isExpanded && players.length > 0 && (
                                <tr>
                                  <td colSpan={8} className="px-2 py-2 bg-white/[0.02]">
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                                      {players.map((p) => {
                                        const el = elementById.get(p.fplElementId);
                                        const pos = el ? POSITION_LABELS[el.element_type] : "—";
                                        const plTeam = el ? plTeams.get(el.team) : null;
                                        return (
                                          <div key={p.fplElementId} className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 text-[11px]">
                                            <span className="text-[9px] font-bold px-1 py-0.5 rounded border border-white/15 text-gray-400">{pos}</span>
                                            <span className="text-white truncate flex-1">{p.playerName}</span>
                                            {plTeam && <span className="text-gray-500 text-[9px]">{plTeam.short_name}</span>}
                                            <span className="text-green-400 font-mono text-[10px]">{formatCurrency(p.purchasePrice)}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    {summary && (summary.penaltySlots > 0 || (summary.bonusSlots ?? 0) > 0) && (
                                      <div className="mt-1 text-[10px] flex items-center gap-2">
                                        {summary.penaltySlots > 0 && (
                                          <span className="text-red-400">✕ {summary.penaltySlots} penalty {summary.penaltySlots === 1 ? "slot" : "slots"}</span>
                                        )}
                                        {(summary.bonusSlots ?? 0) > 0 && (
                                          <span className="text-purple-300">+{summary.bonusSlots} unlocked</span>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                              {isExpanded && players.length === 0 && (
                                <tr>
                                  <td colSpan={8} className="px-4 py-2 text-[10px] text-gray-500 bg-white/[0.02]">
                                    No players owned yet
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            {/* Row 2: Wishlist + Live Feed — full width, side by side */}
            <div className="mt-4 grid grid-cols-1 lg:grid-cols-5 gap-4">
              {/* Wishlist / Unsold tabs (2 cols) */}
              <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <div className="flex items-center gap-1 mb-3 border-b border-white/10">
                  <button
                    onClick={() => setWishlistTab("wishlist")}
                    className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition ${
                      wishlistTab === "wishlist" ? "border-yellow-400 text-yellow-300" : "border-transparent text-gray-400 hover:text-white"
                    }`}
                  >
                    Wishlist <span className="text-[10px] text-gray-500 ml-1">({wishlist.length})</span>
                  </button>
                  <button
                    onClick={() => { setWishlistTab("unsold"); void refreshUnsold(); }}
                    className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border-b-2 -mb-px transition ${
                      wishlistTab === "unsold" ? "border-yellow-400 text-yellow-300" : "border-transparent text-gray-400 hover:text-white"
                    }`}
                  >
                    Unsold <span className="text-[10px] text-gray-500 ml-1">({unsoldPlayers.length})</span>
                  </button>
                </div>

                {wishlistTab === "wishlist" ? (
                  <>
                    {wishlist.length > 0 && (
                      <div className="flex gap-1.5 mb-2">
                        <select
                          value={wlPositionFilter ?? ""}
                          onChange={(e) => setWlPositionFilter(e.target.value ? Number(e.target.value) : null)}
                          className="flex-1 bg-white/10 border border-white/20 text-white text-[10px] rounded px-1.5 py-1 outline-none"
                        >
                          <option value="">All Positions</option>
                          <option value="1">GKP</option>
                          <option value="2">DEF</option>
                          <option value="3">MID</option>
                          <option value="4">FWD</option>
                        </select>
                        <select
                          value={wlTeamFilter ?? ""}
                          onChange={(e) => setWlTeamFilter(e.target.value ? Number(e.target.value) : null)}
                          className="flex-1 bg-white/10 border border-white/20 text-white text-[10px] rounded px-1.5 py-1 outline-none"
                        >
                          <option value="">All Teams</option>
                          {wlTeamOptions.map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {wishlist.length === 0 ? (
                      <div className="text-[10px] text-gray-500 py-2 text-center">
                        Empty — add players from the nomination modal or the Unsold tab.
                      </div>
                    ) : filteredWishlist.length === 0 ? (
                      <div className="text-[10px] text-gray-500 py-2 text-center">
                        No players match filters.
                      </div>
                    ) : (
                      <div className="space-y-0.5 max-h-52 overflow-y-auto">
                        {filteredWishlist.map((entry) => {
                          const el = elementById.get(entry.fplElementId);
                          const realIdx = wishlist.findIndex((w) => w.id === entry.id);
                          return (
                            <div
                              key={entry.id}
                              className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-white/5"
                            >
                              <span className="w-4 text-right text-[10px] text-gray-500">{entry.priority}.</span>
                              {el && <span className="text-[9px] text-gray-500 w-6">{POSITION_LABELS[el.element_type] ?? ""}</span>}
                              <span className="flex-1 truncate text-white">{entry.playerName}</span>
                              {el && <span className="text-[9px] text-gray-500">{plTeams.get(el.team)?.short_name ?? ""}</span>}
                              {!isWlFiltered && (
                                <>
                                  <button onClick={() => handleReorderWishlist(realIdx, realIdx - 1)} disabled={realIdx === 0} className="text-gray-400 hover:text-white disabled:opacity-30 text-[10px]" title="Move up">▲</button>
                                  <button onClick={() => handleReorderWishlist(realIdx, realIdx + 1)} disabled={realIdx === wishlist.length - 1} className="text-gray-400 hover:text-white disabled:opacity-30 text-[10px]" title="Move down">▼</button>
                                </>
                              )}
                              <button onClick={() => handleRemoveFromWishlist(entry.id)} className="text-red-400 hover:text-red-300 text-[10px]" title="Remove">✕</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {unsoldPlayers.length === 0 ? (
                      <div className="text-[10px] text-gray-500 py-2 text-center">
                        No unsold players in the current session yet.
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-gray-400 hover:text-white select-none">
                            <input
                              type="checkbox"
                              className="accent-yellow-400"
                              checked={unsoldPlayers.length > 0 && unsoldPlayers.every((p) => unsoldSelections.has(p.fplElementId) || wishlistElementIds.has(p.fplElementId))}
                              onChange={(ev) => {
                                if (ev.target.checked) {
                                  setUnsoldSelections(new Set(unsoldPlayers.filter((p) => !wishlistElementIds.has(p.fplElementId)).map((p) => p.fplElementId)));
                                } else {
                                  setUnsoldSelections(new Set());
                                }
                              }}
                            />
                            Select all
                          </label>
                          <button
                            onClick={handleBulkAddToWishlist}
                            disabled={unsoldSelections.size === 0 || bulkAddingWishlist}
                            className="rounded-md bg-yellow-400/20 hover:bg-yellow-400/30 text-yellow-200 text-[10px] font-bold uppercase px-2 py-1 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            {bulkAddingWishlist ? "Adding…" : `Add ${unsoldSelections.size} to wishlist`}
                          </button>
                        </div>
                        <div className="space-y-0.5 max-h-52 overflow-y-auto">
                          {unsoldPlayers.map((p) => {
                            const el = elementById.get(p.fplElementId);
                            const inWl = wishlistElementIds.has(p.fplElementId);
                            const selected = unsoldSelections.has(p.fplElementId);
                            return (
                              <div key={p.bidId} className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${selected ? "bg-yellow-400/10" : "bg-white/5"}`}>
                                <input
                                  type="checkbox"
                                  className="accent-yellow-400 cursor-pointer"
                                  checked={selected}
                                  disabled={inWl}
                                  onChange={(ev) => {
                                    setUnsoldSelections((prev) => {
                                      const next = new Set(prev);
                                      if (ev.target.checked) next.add(p.fplElementId);
                                      else next.delete(p.fplElementId);
                                      return next;
                                    });
                                  }}
                                />
                                {el && <span className="text-[9px] text-gray-500 w-6">{POSITION_LABELS[el.element_type] ?? ""}</span>}
                                <span className="flex-1 truncate text-white">{p.playerName}</span>
                                {el && <span className="text-[9px] text-gray-500">{plTeams.get(el.team)?.short_name ?? ""}</span>}
                                {inWl && <span className="text-yellow-400 text-[10px]" title="Already in wishlist">★</span>}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Live Feed (3 cols) — expandable sold/unsold entries */}
              <div className="lg:col-span-3 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-2">Live Feed</h3>
                <div className="space-y-0.5 max-h-52 overflow-y-auto text-[11px]">
                  {bidFeed.length === 0 ? (
                    <div className="text-gray-500 py-2 text-center text-[10px]">No activity yet</div>
                  ) : (
                    bidFeed
                      .filter((item) => {
                        if (item.kind === "sold" || item.kind === "unsold") return true;
                        if (!item.bidId) return true;
                        return expandedFeedBidId === item.bidId;
                      })
                      .map((item) => {
                        const isSoldOrUnsold = item.kind === "sold" || item.kind === "unsold";
                        const isExpanded = isSoldOrUnsold && expandedFeedBidId === item.bidId;
                        const hasSubEntries = isSoldOrUnsold && item.bidId && bidFeed.some((f) => f.bidId === item.bidId && f.id !== item.id);
                        const isSubEntry = !isSoldOrUnsold && item.bidId && expandedFeedBidId === item.bidId;

                        return (
                          <div
                            key={item.id}
                            onClick={isSoldOrUnsold && hasSubEntries ? () => setExpandedFeedBidId(isExpanded ? null : item.bidId!) : undefined}
                            className={`flex items-start gap-1.5 px-1.5 py-1 rounded ${
                              item.kind === "sold" ? "text-green-300 font-semibold bg-green-500/5" :
                              item.kind === "unsold" ? "text-yellow-300 bg-yellow-500/5" :
                              item.kind === "bid" ? "text-white" :
                              "text-gray-400"
                            } ${isSoldOrUnsold && hasSubEntries ? "cursor-pointer hover:bg-white/5" : ""} ${isSubEntry ? "ml-4 border-l border-white/10 pl-2" : ""}`}
                          >
                            <span className="text-[9px] text-gray-500 font-mono whitespace-nowrap mt-0.5">
                              {new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                            </span>
                            <span className="flex-1">{item.text}</span>
                            {isSoldOrUnsold && hasSubEntries && (
                              <span className="text-[9px] text-gray-500 ml-1">{isExpanded ? "▾" : "▸"}</span>
                            )}
                          </div>
                        );
                      })
                  )}
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
                    <span className="text-xs text-gray-500">Opening bid: £500K (fixed) • Showing top {searchResults.length} by points • Owned players excluded (refreshed live)</span>
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
