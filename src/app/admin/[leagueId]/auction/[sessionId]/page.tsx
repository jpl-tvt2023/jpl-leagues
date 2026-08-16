"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LoadingScreen } from "@/components/LoadingScreen";
import { Logo } from "@/components/Logo";
import { TierChip } from "@/components/TierChip";
import { AuctionTimerRing } from "@/components/AuctionTimerRing";
import { formatCurrency } from "@/lib/format/currency";
import { effectiveMaxSquadSize } from "@/lib/formats/auction/squad-rules";
import type { ClubTier } from "@/lib/db/schema";

const CLUB_AUCTION_TYPE = "club-auction";
const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const MIN_QUOTA: Record<"GKP" | "DEF" | "MID" | "FWD", number> = { GKP: 1, DEF: 3, MID: 3, FWD: 1 };

interface SessionRow {
  id: string;
  type: "initial" | "mini-auction" | "club-auction";
  cycleNumber: number;
  status: "pending" | "active" | "paused" | "completed";
  snakeOrder: string[];
  currentNominatorIndex: number;
  scheduledAt: string | null;
  createdAt: string;
  bidTimerSeconds: number;
  nominationTimeoutSeconds: number;
  intermissionSeconds: number;
}

interface TeamInfo {
  id: string;
  teamLoginId?: string;
  rawName: string;
  ownedClub?: {
    plTeamId: number;
    plTeamName: string;
    plTeamShort: string;
    tier: ClubTier;
  } | null;
}

interface TeamSummary {
  purse: number;
  penaltySlots: number;
  bonusSlots?: number;
  players: { fplElementId: number; playerName: string; purchasePrice: number }[];
}

interface CurrentBid {
  bidId?: string;
  fplElementId: number;
  playerName: string;
  minBid: number;
  currentHighBid: number;
  currentHighBidderId: string;
  nominatorTeamId: string;
  expiresAt: string;
  tier?: ClubTier | null;
}

interface BootstrapElement {
  id: number;
  element_type: number;
}

interface FeedItem {
  id: string;
  text: string;
  kind: "sold" | "unsold" | "bid" | "info";
  ts: number;
}

interface BidHistoryBid {
  id: string;
  playerName: string;
  currentHighBid: number;
  currentHighBidderId: string;
  nominatorTeamId: string;
  minBid: number;
  status: string;
  updatedAt: string;
  logs?: Array<{ id: string; teamId: string; amount: number; type: string; createdAt: string }>;
}

function teamLabel(team: TeamInfo | undefined, id: string): string {
  return team?.rawName ?? id;
}

function buildFeed(
  bids: BidHistoryBid[],
  penalties: Array<{ id: string; teamId: string; createdAt: string }>,
  teams: Map<string, TeamInfo>
): FeedItem[] {
  const name = (id: string) => teamLabel(teams.get(id), id);
  const groups: { ts: number; items: FeedItem[] }[] = [];
  for (const b of bids) {
    const soldTs = new Date(b.updatedAt).getTime();
    const items: FeedItem[] = [
      {
        id: b.id,
        text:
          b.status === "sold"
            ? `SOLD: ${b.playerName} → ${name(b.currentHighBidderId)} for ${formatCurrency(b.currentHighBid)}`
            : `UNSOLD: ${b.playerName}`,
        kind: b.status === "sold" ? "sold" : "unsold",
        ts: soldTs,
      },
    ];
    if (b.logs && b.logs.length > 0) {
      for (const log of b.logs) {
        if (log.type === "sold" || log.type === "unsold") continue;
        items.push({
          id: log.id,
          text:
            log.type === "nomination"
              ? `${name(log.teamId)} nominated ${b.playerName} — base ${formatCurrency(log.amount)}`
              : `${name(log.teamId)} bid ${formatCurrency(log.amount)} on ${b.playerName}`,
          kind: log.type === "nomination" ? "info" : "bid",
          ts: new Date(log.createdAt).getTime(),
        });
      }
    } else {
      items.push({
        id: `${b.id}-nom`,
        text: `${name(b.nominatorTeamId)} nominated ${b.playerName} — base ${formatCurrency(b.minBid)}`,
        kind: "info",
        ts: soldTs - 1,
      });
    }
    groups.push({ ts: soldTs, items });
  }
  for (const p of penalties) {
    const ts = new Date(p.createdAt).getTime();
    groups.push({ ts, items: [{ id: p.id, text: `${name(p.teamId)} penalised — missed nomination`, kind: "unsold", ts }] });
  }
  groups.sort((a, b) => b.ts - a.ts);
  return groups.flatMap((g) => g.items);
}

const SESSION_LABEL: Record<SessionRow["type"], (cycle: number) => string> = {
  initial: () => "Initial Auction",
  "club-auction": () => "Club Auction",
  "mini-auction": (cycle) => `Mini-Auction #${cycle}`,
};

const STATUS_STYLE: Record<SessionRow["status"], string> = {
  pending: "bg-white/10 text-gray-300 border-white/20",
  active: "bg-green-500/20 text-green-300 border-green-500/40",
  paused: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
  completed: "bg-purple-500/20 text-purple-300 border-purple-500/40",
};

export default function AdminAuctionRoomPage() {
  const params = useParams();
  const leagueSlug = params.leagueId as string;
  const sessionId = params.sessionId as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [leagueDbId, setLeagueDbId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [teams, setTeams] = useState<Map<string, TeamInfo>>(new Map());
  const [teamSummaries, setTeamSummaries] = useState<Record<string, TeamSummary>>({});
  const [elements, setElements] = useState<BootstrapElement[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [currentBid, setCurrentBid] = useState<CurrentBid | null>(null);
  const [nominationDeadline, setNominationDeadline] = useState<string | null>(null);
  const [intermissionUntil, setIntermissionUntil] = useState<string | null>(null);
  const [timerSec, setTimerSec] = useState(0);
  const [nominationSec, setNominationSec] = useState(0);
  const [sseConnected, setSseConnected] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [undoingBidId, setUndoingBidId] = useState<string | null>(null);

  const leagueDbIdRef = useRef<string | null>(null);
  const teamsRef = useRef<Map<string, TeamInfo>>(new Map());
  useEffect(() => { leagueDbIdRef.current = leagueDbId; }, [leagueDbId]);
  useEffect(() => { teamsRef.current = teams; }, [teams]);

  const session = sessions.find((s) => s.id === sessionId) ?? null;

  const elementById = useMemo(() => {
    const m = new Map<number, BootstrapElement>();
    for (const el of elements) m.set(el.id, el);
    return m;
  }, [elements]);

  const refreshTeamsAndSquads = useCallback(async () => {
    const lid = leagueDbIdRef.current;
    const [teamsRes, ownedRes] = await Promise.all([
      fetch(`/api/admin/${leagueSlug}/create-team`),
      lid ? fetch(`/api/auction/league-owned?leagueId=${lid}`) : Promise.resolve(null),
    ]);
    if (teamsRes.ok) {
      const d = await teamsRes.json();
      const map = new Map<string, TeamInfo>();
      for (const t of d.teams ?? []) {
        map.set(t.id, { id: t.id, teamLoginId: t.teamLoginId, rawName: t.rawName ?? t.name, ownedClub: t.ownedClub ?? null });
      }
      setTeams(map);
    }
    if (ownedRes && ownedRes.ok) {
      const d = await ownedRes.json();
      setTeamSummaries(d.teamSummaries ?? {});
    }
  }, [leagueSlug]);

  const refreshFeed = useCallback(async () => {
    const res = await fetch(`/api/auction/bid-history?sessionId=${sessionId}`);
    if (!res.ok) return;
    const d = await res.json();
    setFeed(buildFeed(d.bids ?? [], d.penalties ?? [], teamsRef.current));
  }, [sessionId]);

  const refreshSessions = useCallback(async () => {
    const lid = leagueDbIdRef.current;
    if (!lid) return;
    const res = await fetch(`/api/auction/session?leagueId=${lid}`);
    if (!res.ok) return;
    const d = await res.json();
    setSessions(d.sessions ?? []);
    if (d.activeSession && d.activeSession.id === sessionId) {
      setCurrentBid(d.activeSession.currentBid ?? null);
      setNominationDeadline(d.activeSession.nominationDeadline ?? null);
      setIntermissionUntil(d.activeSession.intermissionUntil ?? null);
    }
  }, [sessionId]);

  const loadInitial = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const leaguesRes = await fetch("/api/admin/my-leagues");
      if (leaguesRes.status === 401 || leaguesRes.status === 403) {
        window.location.href = "/signin";
        return;
      }
      const leaguesJson = await leaguesRes.json();
      const league = (leaguesJson.leagues ?? []).find((l: { slug: string }) => l.slug === leagueSlug);
      if (!league) throw new Error("League not found");
      setLeagueDbId(league.id);
      leagueDbIdRef.current = league.id;

      const [sessRes, teamsRes, ownedRes, histRes, bootstrapRes] = await Promise.all([
        fetch(`/api/auction/session?leagueId=${league.id}`),
        fetch(`/api/admin/${leagueSlug}/create-team`),
        fetch(`/api/auction/league-owned?leagueId=${league.id}`),
        fetch(`/api/auction/bid-history?sessionId=${sessionId}`),
        fetch("/api/fpl/bootstrap"),
      ]);

      let teamMap = new Map<string, TeamInfo>();
      if (teamsRes.ok) {
        const d = await teamsRes.json();
        teamMap = new Map(
          (d.teams ?? []).map((t: { id: string; teamLoginId?: string; rawName?: string; name: string; ownedClub: TeamInfo["ownedClub"] }) => [
            t.id,
            { id: t.id, teamLoginId: t.teamLoginId, rawName: t.rawName ?? t.name, ownedClub: t.ownedClub ?? null },
          ])
        );
        setTeams(teamMap);
        teamsRef.current = teamMap;
      }
      if (ownedRes.ok) {
        const d = await ownedRes.json();
        setTeamSummaries(d.teamSummaries ?? {});
      }
      if (sessRes.ok) {
        const d = await sessRes.json();
        setSessions(d.sessions ?? []);
        if (d.activeSession && d.activeSession.id === sessionId) {
          setCurrentBid(d.activeSession.currentBid ?? null);
          setNominationDeadline(d.activeSession.nominationDeadline ?? null);
          setIntermissionUntil(d.activeSession.intermissionUntil ?? null);
        }
        if (!(d.sessions ?? []).some((s: SessionRow) => s.id === sessionId)) {
          throw new Error("Session not found");
        }
      }
      if (histRes.ok) {
        const d = await histRes.json();
        setFeed(buildFeed(d.bids ?? [], d.penalties ?? [], teamMap));
      }
      if (bootstrapRes.ok) {
        const d = await bootstrapRes.json();
        setElements(d.elements ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load auction room");
    } finally {
      setIsLoading(false);
    }
  }, [leagueSlug, sessionId]);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  // Live SSE — only while this session is actually on the clock.
  const sessionStatus = session?.status ?? null;
  useEffect(() => {
    if (!sessionId || sessionStatus !== "active") return;
    const es = new EventSource(`/api/auction/session/stream?sessionId=${sessionId}`);
    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);
    es.addEventListener("heartbeat", () => {});
    es.addEventListener("auction-state", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(data);
      setIntermissionUntil(null);
    });
    es.addEventListener("bid-placed", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(data);
    });
    es.addEventListener("sold", () => {
      setCurrentBid(null);
      refreshSessions();
      refreshTeamsAndSquads();
      refreshFeed();
    });
    es.addEventListener("unsold", () => {
      setCurrentBid(null);
      refreshFeed();
    });
    es.addEventListener("auto-nominated", () => { refreshFeed(); });
    es.addEventListener("penalised", () => { refreshFeed(); refreshTeamsAndSquads(); });
    es.addEventListener("session-status", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status: data.status, currentNominatorIndex: data.currentNominatorIndex, snakeOrder: data.snakeOrder ?? s.snakeOrder } : s))
      );
      setNominationDeadline(data.nominationDeadline ?? null);
    });
    es.addEventListener("session-complete", () => {
      refreshSessions();
    });
    es.addEventListener("waiting", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(null);
      setNominationDeadline(data.nominationDeadline ?? null);
      setIntermissionUntil(null);
    });
    es.addEventListener("intermission", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setCurrentBid(null);
      setIntermissionUntil(data.intermissionUntil ?? null);
    });
    return () => es.close();
  }, [sessionId, sessionStatus, refreshSessions, refreshTeamsAndSquads, refreshFeed]);

  // Fallback poll — the SSE "sold"/"unsold"/"auto-nominated"/"penalised" events are singlecast to
  // whichever of the N connected clients' poll cycle wins the DB claim race (see stream route); the
  // admin tab usually loses that race against the many participant tabs, so without this poll the
  // feed/undo-list/nomination-purse panels can go stale indefinitely. Mirrors the participant room's
  // fallback poll (src/app/[leagueSlug]/auction/[sessionId]/page.tsx).
  useEffect(() => {
    if (!sessionId || sessionStatus === "pending" || sessionStatus === "completed" || !sessionStatus) return;
    const t = setInterval(() => { refreshFeed(); refreshTeamsAndSquads(); }, 3000);
    return () => clearInterval(t);
  }, [sessionId, sessionStatus, refreshFeed, refreshTeamsAndSquads]);

  // Countdown ticks
  useEffect(() => {
    const t = setInterval(() => {
      setTimerSec(currentBid?.expiresAt ? Math.max(0, Math.ceil((new Date(currentBid.expiresAt).getTime() - Date.now()) / 1000)) : 0);
      setNominationSec(nominationDeadline ? Math.max(0, Math.ceil((new Date(nominationDeadline).getTime() - Date.now()) / 1000)) : 0);
    }, 200);
    return () => clearInterval(t);
  }, [currentBid?.expiresAt, nominationDeadline]);

  const doSessionAction = async (action: "start" | "pause" | "resume" | "complete") => {
    if (!session || !leagueDbId) return;
    const confirmMsg: Record<string, string> = {
      start: "Start this auction? Bidding will open for all teams.",
      pause: "Pause this auction? Bidding stops for all teams until resumed.",
      resume: "Resume this auction? Bidding reopens for all teams.",
      complete: "Complete this auction? This permanently ends bidding and cannot be undone.",
    };
    if (!confirm(confirmMsg[action])) return;
    setActionLoading(action);
    try {
      const res = await fetch("/api/auction/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: leagueDbId, action, sessionId: session.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `Session ${action}ed successfully` });
        refreshSessions();
      } else {
        setMessage({ type: "error", text: data.error || `Failed to ${action} session` });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setActionLoading(null);
    }
  };

  const undoSale = async (bidId: string) => {
    if (!confirm("Undo this sale? The player/club will become available for re-nomination.")) return;
    setUndoingBidId(bidId);
    try {
      const res = await fetch(`/api/admin/${leagueSlug}/auction-corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo-sale", bidId }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        refreshFeed();
        refreshTeamsAndSquads();
      } else {
        setMessage({ type: "error", text: data.error });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setUndoingBidId(null);
    }
  };

  if (isLoading) return <LoadingScreen />;

  if (error || !session) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-6">
        <div className="text-center">
          <div className="text-2xl text-white font-bold mb-2">Couldn&apos;t load this auction room</div>
          <div className="text-gray-400 mb-4">{error ?? "Session not found"}</div>
          <Link href={`/admin/${leagueSlug}`} className="text-yellow-400 hover:underline">← Back to Admin Dashboard</Link>
        </div>
      </div>
    );
  }

  const isClubAuction = session.type === CLUB_AUCTION_TYPE;
  const sched = session.scheduledAt ? new Date(session.scheduledAt) : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/admin" className="flex items-center gap-2">
          <Logo />
          <span className="text-xl font-bold text-white hidden sm:inline">Admin Dashboard</span>
        </Link>
        <Link href={`/admin/${leagueSlug}`} className="text-yellow-400 font-semibold transition">
          ← Back to {leagueSlug}
        </Link>
      </nav>

      <div className="mx-auto max-w-[1600px] px-4 sm:px-6 py-6 sm:py-8">
        {message && (
          <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${message.type === "success" ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-red-500/30 bg-red-500/10 text-red-300"}`}>
            {message.text}
          </div>
        )}

        {/* Session header */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur mb-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-white">{SESSION_LABEL[session.type](session.cycleNumber)}</h1>
              <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold tracking-wider border ${STATUS_STYLE[session.status]}`}>
                {session.status}
              </span>
              {session.status === "active" && (
                <span className="inline-flex items-center gap-1.5 text-[10px] text-gray-400">
                  <span className={`w-1.5 h-1.5 rounded-full ${sseConnected ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
                  {sseConnected ? "live" : "reconnecting…"}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {session.status === "pending" && (
                <button onClick={() => doSessionAction("start")} disabled={actionLoading !== null} className="px-4 py-2 rounded-lg bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30 text-sm font-medium disabled:opacity-50 transition">
                  Start Session
                </button>
              )}
              {session.status === "active" && (
                <>
                  <button onClick={() => doSessionAction("pause")} disabled={actionLoading !== null} className="px-4 py-2 rounded-lg bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 text-sm font-medium disabled:opacity-50 transition">
                    Pause
                  </button>
                  <button onClick={() => doSessionAction("complete")} disabled={actionLoading !== null} className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 text-sm font-medium disabled:opacity-50 transition">
                    Complete
                  </button>
                </>
              )}
              {session.status === "paused" && (
                <>
                  <button onClick={() => doSessionAction("resume")} disabled={actionLoading !== null} className="px-4 py-2 rounded-lg bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30 text-sm font-medium disabled:opacity-50 transition">
                    Resume
                  </button>
                  <button onClick={() => doSessionAction("complete")} disabled={actionLoading !== null} className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 text-sm font-medium disabled:opacity-50 transition">
                    Complete
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-400">
            {sched && <span>Scheduled: {sched.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>}
            <span>Bid timer: {session.bidTimerSeconds}s</span>
            <span>Nomination timeout: {session.nominationTimeoutSeconds}s</span>
            <span>Intermission: {session.intermissionSeconds}s</span>
            <span>{session.snakeOrder.length} teams</span>
          </div>
        </div>

        {session.status === "pending" ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur text-center mb-6">
            <div className="text-3xl mb-2">⏳</div>
            <div className="text-white font-semibold mb-1">Not started yet</div>
            <div className="text-sm text-gray-400">Click &quot;Start Session&quot; above to open bidding.</div>
          </div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-4 mb-6">
            <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              {session.status === "completed" ? (
                <div className="text-center py-8">
                  <div className="text-3xl mb-2">🏁</div>
                  <div className="text-white font-semibold">Session completed</div>
                  <div className="text-sm text-gray-400 mt-1">Final results below.</div>
                </div>
              ) : currentBid ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">On the Block</div>
                      <div className="text-lg font-bold text-white flex items-center gap-2">
                        {currentBid.playerName}
                        {isClubAuction && currentBid.tier && <TierChip tier={currentBid.tier} clubName={currentBid.playerName} compact />}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        Nominated by {teamLabel(teams.get(currentBid.nominatorTeamId), currentBid.nominatorTeamId)} · Base {formatCurrency(currentBid.minBid)}
                      </div>
                    </div>
                    <AuctionTimerRing seconds={timerSec} max={session.bidTimerSeconds} size={96} stroke={9} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-white/5 px-4 py-2">
                    <div>
                      <div className="text-xs text-gray-400">High Bid</div>
                      <div className="text-xl font-bold text-yellow-400">{formatCurrency(currentBid.currentHighBid)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-gray-400">Leader</div>
                      <div className="text-sm font-semibold text-white">{teamLabel(teams.get(currentBid.currentHighBidderId), currentBid.currentHighBidderId)}</div>
                    </div>
                  </div>
                </div>
              ) : intermissionUntil && new Date(intermissionUntil).getTime() > Date.now() ? (
                <div className="flex flex-col items-center justify-center py-6 gap-2">
                  <div className="text-[10px] uppercase tracking-widest text-yellow-300/80">Lot sold — next up</div>
                  <AuctionTimerRing seconds={Math.max(0, Math.ceil((new Date(intermissionUntil).getTime() - Date.now()) / 1000))} max={5} size={88} stroke={8} label="next" />
                </div>
              ) : (
                <div className="text-center py-8">
                  <div className="text-sm text-gray-400">Waiting for nomination</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Current turn: {session.snakeOrder[session.currentNominatorIndex] ? teamLabel(teams.get(session.snakeOrder[session.currentNominatorIndex]), session.snakeOrder[session.currentNominatorIndex]) : "—"}
                  </div>
                  {nominationDeadline && <div className="text-xs text-yellow-400 font-mono mt-2">Auto-pick in {nominationSec}s</div>}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Nomination Order</h3>
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
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
                      const isCurrent = idx === session.currentNominatorIndex && session.status !== "completed";
                      const team = teams.get(tid);
                      const summary = teamSummaries[tid];
                      const players = summary?.players ?? [];

                      const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
                      for (const p of players) {
                        const el = elementById.get(p.fplElementId);
                        if (el) {
                          const pos = POSITION_LABELS[el.element_type];
                          if (pos && pos in counts) counts[pos as keyof typeof counts]++;
                        }
                      }
                      const cellClass = (pos: keyof typeof counts) =>
                        counts[pos] >= MIN_QUOTA[pos] ? "text-green-400" : "text-red-400";

                      return (
                        <tr key={tid} className={`border-b border-white/5 ${isCurrent ? "bg-yellow-500/15" : ""}`}>
                          <td className="py-1.5 px-2 text-gray-500">
                            {isCurrent ? <span className="text-yellow-400 font-bold">►</span> : <span>{idx + 1}</span>}
                          </td>
                          <td className={`py-1.5 px-2 font-semibold ${isCurrent ? "text-yellow-300" : "text-white"}`}>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="truncate">{teamLabel(team, tid)}</span>
                              {isClubAuction && team?.ownedClub && (
                                <TierChip tier={team.ownedClub.tier} clubName={team.ownedClub.plTeamName} short={team.ownedClub.plTeamShort} compact />
                              )}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-green-300">
                            {summary ? formatCurrency(summary.purse) : "—"}
                          </td>
                          <td className={`py-1.5 px-1 text-center font-mono ${cellClass("GKP")}`}>{counts.GKP}<span className="text-gray-500">/{MIN_QUOTA.GKP}</span></td>
                          <td className={`py-1.5 px-1 text-center font-mono ${cellClass("DEF")}`}>{counts.DEF}<span className="text-gray-500">/{MIN_QUOTA.DEF}</span></td>
                          <td className={`py-1.5 px-1 text-center font-mono ${cellClass("MID")}`}>{counts.MID}<span className="text-gray-500">/{MIN_QUOTA.MID}</span></td>
                          <td className={`py-1.5 px-1 text-center font-mono ${cellClass("FWD")}`}>{counts.FWD}<span className="text-gray-500">/{MIN_QUOTA.FWD}</span></td>
                          <td className="py-1.5 px-1 text-center text-white font-semibold">
                            {players.length}<span className="text-gray-500">/{effectiveMaxSquadSize(summary?.penaltySlots ?? 0, summary?.bonusSlots ?? 0)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Feed */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur mb-6">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
            {session.status === "completed" ? "Final Results" : "Live Feed"}
          </h3>
          <div className="space-y-1 max-h-96 overflow-y-auto text-sm">
            {feed.length === 0 ? (
              <div className="text-gray-500 py-4 text-center text-xs">No activity yet</div>
            ) : (
              feed.map((item) => (
                <div key={item.id} className={`flex items-start gap-2 px-2 py-1.5 rounded-lg ${
                  item.kind === "sold" ? "text-green-300 font-semibold bg-green-500/5" :
                  item.kind === "unsold" ? "text-yellow-300 bg-yellow-500/5" :
                  item.kind === "bid" ? "text-white" : "text-gray-400"
                }`}>
                  <span className="text-[10px] text-gray-500 font-mono whitespace-nowrap mt-0.5">
                    {new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span>{item.text}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Corrections — undo a sale from this session */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-3">Undo Sale</h3>
          {(() => {
            const soldFromFeed = feed.filter((f) => f.kind === "sold");
            if (soldFromFeed.length === 0) {
              return <div className="text-sm text-gray-500">No sold lots to undo</div>;
            }
            return (
              <div className="space-y-2">
                {soldFromFeed.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/5 text-sm">
                    <span className="text-gray-300">{f.text}</span>
                    <button
                      onClick={() => undoSale(f.id)}
                      disabled={undoingBidId === f.id}
                      className="px-3 py-1 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30 text-xs font-medium disabled:opacity-50 transition shrink-0"
                    >
                      {undoingBidId === f.id ? "Undoing…" : "Undo"}
                    </button>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
