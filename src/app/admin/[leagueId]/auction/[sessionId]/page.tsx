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
import { POSITION_LABELS, POSITION_COLORS, POSITION_ORDER } from "@/lib/fpl/positions";
import { getPlTeamFullName } from "@/lib/data/pl-team-full-names";

const CLUB_AUCTION_TYPE = "club-auction";
/** Rows rendered at once in the available-players panel. ~700 unfiltered players re-rendering on
 *  every 3s poll is wasteful; the count line always reports the true total. */
const POOL_RENDER_CAP = 150;
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

interface TurnEvent {
  id: string;
  teamId: string | null;
  nominatorIndex: number | null;
  event: string;
  actor: string;
  detail: string | null;
  createdAt: string;
}

/** Parse a JSON id-array coming back from the API. */
function safeIds(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
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
  elementType?: number | null;
  plTeamId?: number | null;
  /** Nth player SOLD this session, including this lot. */
  lotNumber?: number | null;
}

interface BootstrapElement {
  id: number;
  element_type: number;
  // The player's real-life PL club. Already on the wire from /api/fpl/bootstrap — this interface
  // simply narrowed it away, which is why the admin room could show no club or tier for a player.
  team: number;
  // Likewise already on the wire and previously discarded. The available-players panel needs a name
  // to show, points to sort by, and a price to display.
  web_name: string;
  total_points: number;
  now_cost: number;
  status: string;
}

interface BootstrapTeam {
  id: number;
  name: string;
  short_name: string;
}

interface FeedItem {
  id: string;
  text: string;
  kind: "sold" | "unsold" | "bid" | "info";
  ts: number;
}

interface BidHistoryBid {
  id: string;
  fplElementId?: number;
  lotNumber?: number | null;
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

/**
 * Position pill + real-life PL club + tier chip for whatever is on the block.
 *
 * The server resolves this (see `lot-meta.ts`), because `fplElementId` means different things in a
 * player auction (a player) and a club auction (a PL club) — but we fall back to the local bootstrap
 * map so the card still renders against a payload from before that change.
 */
function LotIdentity({
  bid,
  elementById,
  plTeams,
  isClubAuction,
}: {
  bid: CurrentBid;
  elementById: Map<number, BootstrapElement>;
  plTeams: Map<number, BootstrapTeam>;
  isClubAuction: boolean;
}) {
  const el = elementById.get(bid.fplElementId);
  const elementType = bid.elementType ?? el?.element_type ?? null;
  const pos = elementType ? POSITION_LABELS[elementType] : null;
  // In a club auction the lot IS the club, so its name is already the heading — only the tier adds
  // anything there.
  const plTeamId = bid.plTeamId ?? (isClubAuction ? bid.fplElementId : el?.team) ?? null;
  const plTeam = plTeamId != null ? plTeams.get(plTeamId) : undefined;
  const clubName =
    plTeamId != null ? getPlTeamFullName(plTeamId, plTeam?.name ?? "", plTeam?.short_name) : null;

  return (
    <>
      {pos && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-white/20 text-gray-300">
          {pos}
        </span>
      )}
      {!isClubAuction && clubName && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-gray-300">
          {clubName}
        </span>
      )}
      {bid.tier && (
        <TierChip
          tier={bid.tier}
          clubName={clubName ?? bid.playerName}
          short={plTeam?.short_name}
          variant={isClubAuction ? "owner" : "player"}
          compact={isClubAuction}
        />
      )}
    </>
  );
}

function buildFeed(
  bids: BidHistoryBid[],
  penalties: Array<{ id: string; teamId: string; createdAt: string }>,
  teams: Map<string, TeamInfo>,
  /** Renders a POS-CLUB suffix; supplied once the bootstrap maps have loaded. */
  tag: (fplElementId: number | undefined | null) => string = () => ""
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
            ? `${b.lotNumber != null ? `#${b.lotNumber} ` : ""}SOLD: ${b.playerName}${tag(b.fplElementId)} → ${name(b.currentHighBidderId)} for ${formatCurrency(b.currentHighBid)}`
            : `UNSOLD: ${b.playerName}${tag(b.fplElementId)}`,
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
              ? `${name(log.teamId)} nominated ${b.playerName}${tag(b.fplElementId)} — base ${formatCurrency(log.amount)}`
              : `${name(log.teamId)} bid ${formatCurrency(log.amount)} on ${b.playerName}`,
          kind: log.type === "nomination" ? "info" : "bid",
          ts: new Date(log.createdAt).getTime(),
        });
      }
    } else {
      items.push({
        id: `${b.id}-nom`,
        text: `${name(b.nominatorTeamId)} nominated ${b.playerName}${tag(b.fplElementId)} — base ${formatCurrency(b.minBid)}`,
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

/**
 * Element ids that were nominated this session and closed with no bids. buildFeed renders these as
 * text lines and drops the id, so the available-players panel derives its own set from the same
 * already-polled payload.
 */
function passedIdsFrom(bids: BidHistoryBid[]): Set<number> {
  const ids = new Set<number>();
  for (const b of bids) {
    if (b.status === "unsold" && b.fplElementId) ids.add(b.fplElementId);
  }
  return ids;
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
  const [plTeams, setPlTeams] = useState<Map<number, BootstrapTeam>>(new Map());
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
  const [showCorrectPanel, setShowCorrectPanel] = useState(false);
  const [turnActionLoading, setTurnActionLoading] = useState<string | null>(null);
  const [turnEvents, setTurnEvents] = useState<TurnEvent[]>([]);
  const [makeupQueue, setMakeupQueue] = useState<string[]>([]);
  const [ringReturnIndex, setRingReturnIndex] = useState<number | null>(null);
  const [grantTeamId, setGrantTeamId] = useState<string>("");

  // Available-players panel. `ownedElementIds` rides along on the league-owned response that
  // refreshTeamsAndSquads already polls every 3s, so the pool stays live for free.
  const [ownedElementIds, setOwnedElementIds] = useState<Set<number>>(new Set());
  const [passedElementIds, setPassedElementIds] = useState<Set<number>>(new Set());
  const [poolPositionFilter, setPoolPositionFilter] = useState<number | null>(null);
  const [poolClubFilter, setPoolClubFilter] = useState<number | null>(null);
  const [poolSearch, setPoolSearch] = useState("");

  const leagueDbIdRef = useRef<string | null>(null);
  const teamsRef = useRef<Map<string, TeamInfo>>(new Map());
  useEffect(() => { leagueDbIdRef.current = leagueDbId; }, [leagueDbId]);
  useEffect(() => { teamsRef.current = teams; }, [teams]);

  // Mirrored into refs so the feed builder — called from callbacks and SSE handlers registered once
  // — always reads the latest maps without re-registering.
  const elementByIdRef = useRef<Map<number, BootstrapElement>>(new Map());
  const plTeamsRef = useRef<Map<number, BootstrapTeam>>(new Map());
  const sessionTypeRef = useRef<string | null>(null);

  const session = sessions.find((s) => s.id === sessionId) ?? null;
  useEffect(() => { sessionTypeRef.current = session?.type ?? null; }, [session?.type]);

  /** ` [MID-ARS]` suffix for a feed line. Empty for club auctions, where the lot IS the club. */
  const playerTag = useCallback((fplElementId: number | undefined | null): string => {
    if (!fplElementId) return "";
    if (sessionTypeRef.current === CLUB_AUCTION_TYPE) return "";
    const el = elementByIdRef.current.get(fplElementId);
    if (!el) return "";
    const parts = [POSITION_LABELS[el.element_type], plTeamsRef.current.get(el.team)?.short_name].filter(Boolean);
    return parts.length ? ` [${parts.join("-")}]` : "";
  }, []);

  const elementById = useMemo(() => {
    const m = new Map<number, BootstrapElement>();
    for (const el of elements) m.set(el.id, el);
    return m;
  }, [elements]);
  useEffect(() => { elementByIdRef.current = elementById; }, [elementById]);
  useEffect(() => { plTeamsRef.current = plTeams; }, [plTeams]);

  // Clubs for the pool filter dropdown, alphabetical.
  const poolClubOptions = useMemo(
    () => [...plTeams.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [plTeams]
  );

  // Everyone not yet owned by a team — i.e. still available to be nominated. Mirrors the participant
  // room's nomination picker, minus the "hide the lot on the block" rule: the admin wants to see it,
  // badged, rather than have it vanish.
  const availablePlayers = useMemo(() => {
    const lc = poolSearch.trim().toLowerCase();
    return elements
      .filter((el) => {
        if (ownedElementIds.has(el.id)) return false;
        if (poolPositionFilter !== null && el.element_type !== poolPositionFilter) return false;
        if (poolClubFilter !== null && el.team !== poolClubFilter) return false;
        if (lc && !el.web_name.toLowerCase().includes(lc)) return false;
        return true;
      })
      .sort((a, b) => b.total_points - a.total_points);
  }, [elements, ownedElementIds, poolPositionFilter, poolClubFilter, poolSearch]);

  const totalAvailable = useMemo(
    () => elements.reduce((n, el) => (ownedElementIds.has(el.id) ? n : n + 1), 0),
    [elements, ownedElementIds]
  );

  const poolFiltered = poolPositionFilter !== null || poolClubFilter !== null || poolSearch.trim() !== "";

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
      setOwnedElementIds(new Set<number>(d.ownedElementIds ?? []));
    }
  }, [leagueSlug]);

  const refreshFeed = useCallback(async () => {
    const res = await fetch(`/api/auction/bid-history?sessionId=${sessionId}`);
    if (!res.ok) return;
    const d = await res.json();
    const bids: BidHistoryBid[] = d.bids ?? [];
    setFeed(buildFeed(bids, d.penalties ?? [], teamsRef.current, playerTag));
    setPassedElementIds(passedIdsFrom(bids));
  }, [sessionId, playerTag]);

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
        setOwnedElementIds(new Set<number>(d.ownedElementIds ?? []));
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
        const bids: BidHistoryBid[] = d.bids ?? [];
        setFeed(buildFeed(bids, d.penalties ?? [], teamMap, playerTag));
        setPassedElementIds(passedIdsFrom(bids));
      }
      if (bootstrapRes.ok) {
        const d = await bootstrapRes.json();
        setElements(d.elements ?? []);
        // The teams map was already in this response and was being thrown away, so keeping it costs
        // nothing on the wire.
        const tMap = new Map<number, BootstrapTeam>();
        for (const t of d.teams ?? []) tMap.set(t.id, t);
        setPlTeams(tMap);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load auction room");
    } finally {
      setIsLoading(false);
    }
  }, [leagueSlug, sessionId, playerTag]);

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

  // ---- Turn rectification ----
  //
  // All of these require a paused session (the API enforces it too). Pausing freezes every SSE poll
  // loop and the mutating REST safety net, which is what makes a correction atomic instead of a race
  // against ~20 concurrent writers.
  const turnAction = async (
    action: "cancel-nomination" | "grant-turn" | "dequeue-makeup" | "set-nominator",
    payload: Record<string, unknown> = {},
    confirmMsg?: string,
  ) => {
    if (!session) return;
    if (confirmMsg && !confirm(confirmMsg)) return;
    setTurnActionLoading(action);
    try {
      const res = await fetch(`/api/admin/${leagueSlug}/auction-corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sessionId: session.id, ...payload }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message ?? "Turn order updated" });
        refreshSessions();
        refreshTurnState();
        refreshFeed();
      } else {
        setMessage({ type: "error", text: data.error ?? "Correction failed" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setTurnActionLoading(null);
    }
  };

  const refreshTurnState = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch(`/api/auction/turn-events?sessionId=${session.id}&limit=40`);
      if (!res.ok) return;
      const data = await res.json();
      setTurnEvents(data.events ?? []);
      setMakeupQueue(safeIds(data.turnState?.makeupQueue));
      setRingReturnIndex(data.turnState?.ringReturnIndex ?? null);
    } catch {
      /* diagnostic panel only — never surface a failure here */
    }
  }, [session]);

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

        {/* Turn rectification — corrects a skipped or mis-fired nomination turn. */}
        {session.status !== "pending" && session.status !== "completed" && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur mb-6">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Correct turn</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Give back a skipped nomination, or void the lot on the block. Requires the auction to be paused.
                </p>
              </div>
              <div className="flex gap-2">
                {session.status === "active" && (
                  <button
                    onClick={() => doSessionAction("pause")}
                    disabled={actionLoading !== null}
                    className="rounded-lg bg-amber-500/20 border border-amber-400/30 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    Pause &amp; correct
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowCorrectPanel((v) => !v);
                    if (!showCorrectPanel) refreshTurnState();
                  }}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10"
                >
                  {showCorrectPanel ? "Hide" : "Show"} controls
                </button>
              </div>
            </div>

            {showCorrectPanel && (
              <div className="mt-4 grid lg:grid-cols-2 gap-4">
                <div className="space-y-3">
                  {session.status !== "paused" && (
                    <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      Pause the auction to enable these controls. Pausing stops every client&apos;s poll loop, so the
                      correction lands atomically instead of racing them.
                    </div>
                  )}

                  {/* Void the current lot. Nothing has been paid yet — ownership and purse are only
                      written when a bid expires — so this is just a status flip. */}
                  <div className="rounded-lg bg-black/20 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1.5">On the block</div>
                    {currentBid ? (
                      <>
                        <div className="text-sm text-white font-semibold flex items-center gap-1.5 flex-wrap">
                          {currentBid.lotNumber != null && <span className="text-yellow-400/80">#{currentBid.lotNumber}</span>}
                          {currentBid.playerName}
                          <LotIdentity bid={currentBid} elementById={elementById} plTeams={plTeams} isClubAuction={isClubAuction} />
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          Nominated by {teamLabel(teams.get(currentBid.nominatorTeamId), currentBid.nominatorTeamId)} · high bid{" "}
                          {formatCurrency(currentBid.currentHighBid)} from{" "}
                          {teamLabel(teams.get(currentBid.currentHighBidderId), currentBid.currentHighBidderId)}
                        </div>
                        <button
                          onClick={() =>
                            turnAction(
                              "cancel-nomination",
                              { restoreNominator: true },
                              `Void ${currentBid.playerName}? No purse moves — the lot has not been paid for. The nominator gets their turn back.`,
                            )
                          }
                          disabled={session.status !== "paused" || turnActionLoading !== null}
                          className="mt-2 rounded-lg bg-red-500/20 border border-red-400/30 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/30 disabled:opacity-40"
                        >
                          Void this nomination
                        </button>
                      </>
                    ) : (
                      <div className="text-xs text-gray-500">Nothing on the block.</div>
                    )}
                  </div>

                  {/* Owe a team a make-up turn. Does NOT move the ring cursor. */}
                  <div className="rounded-lg bg-black/20 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1.5">Owe a make-up turn</div>
                    <div className="flex gap-2 flex-wrap">
                      <select
                        value={grantTeamId}
                        onChange={(e) => setGrantTeamId(e.target.value)}
                        className="flex-1 min-w-[10rem] rounded-lg border border-white/15 bg-slate-800 px-2 py-1.5 text-xs text-white"
                      >
                        <option value="">Select team…</option>
                        {session.snakeOrder.map((tid) => (
                          <option key={tid} value={tid}>
                            {teamLabel(teams.get(tid), tid)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => turnAction("grant-turn", { teamId: grantTeamId, position: "front" })}
                        disabled={!grantTeamId || session.status !== "paused" || turnActionLoading !== null}
                        className="rounded-lg bg-emerald-500/20 border border-emerald-400/30 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-40"
                      >
                        Next
                      </button>
                      <button
                        onClick={() => turnAction("grant-turn", { teamId: grantTeamId, position: "back" })}
                        disabled={!grantTeamId || session.status !== "paused" || turnActionLoading !== null}
                        className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10 disabled:opacity-40"
                      >
                        Queue
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] text-gray-500">
                      A make-up turn is inserted, not swapped in — the nomination order carries on from exactly where
                      it stopped once the queue drains.
                    </p>
                    {makeupQueue.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {makeupQueue.map((tid, i) => (
                          <div key={`${tid}-${i}`} className="flex items-center justify-between rounded bg-white/5 px-2 py-1">
                            <span className="text-xs text-emerald-200">
                              {i + 1}. {teamLabel(teams.get(tid), tid)}
                            </span>
                            <button
                              onClick={() => turnAction("dequeue-makeup", { teamId: tid })}
                              disabled={session.status !== "paused" || turnActionLoading !== null}
                              className="text-[11px] text-gray-400 hover:text-red-300 disabled:opacity-40"
                            >
                              remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Hard cursor move — for when the ring itself is wrong. */}
                  <div className="rounded-lg bg-black/20 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1.5">Move the order itself</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() =>
                          turnAction("set-nominator", { direction: "back" }, "Move the nomination order back one team?")
                        }
                        disabled={session.status !== "paused" || turnActionLoading !== null}
                        className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10 disabled:opacity-40"
                      >
                        ← Back one
                      </button>
                      <button
                        onClick={() =>
                          turnAction("set-nominator", { direction: "forward" }, "Move the nomination order forward one team?")
                        }
                        disabled={session.status !== "paused" || turnActionLoading !== null}
                        className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10 disabled:opacity-40"
                      >
                        Forward one →
                      </button>
                      <span className="text-xs text-gray-400">
                        Now: {teamLabel(teams.get(session.snakeOrder[session.currentNominatorIndex]), session.snakeOrder[session.currentNominatorIndex])}
                      </span>
                    </div>
                    {ringReturnIndex != null && (
                      <p className="mt-2 text-[11px] text-yellow-300/80">
                        Mid make-up sequence — the ring resumes at{" "}
                        {teamLabel(teams.get(session.snakeOrder[ringReturnIndex]), session.snakeOrder[ringReturnIndex])}.
                      </p>
                    )}
                  </div>
                </div>

                {/* Turn event log — the audit trail that did not exist when turns went missing. */}
                <div className="rounded-lg bg-black/20 p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-[10px] uppercase tracking-widest text-gray-400">Turn log</div>
                    <button onClick={refreshTurnState} className="text-[11px] text-gray-400 hover:text-white">
                      refresh
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto space-y-1">
                    {turnEvents.length === 0 ? (
                      <div className="text-xs text-gray-500">No turn events recorded yet.</div>
                    ) : (
                      turnEvents.map((ev) => (
                        <div key={ev.id} className="flex items-baseline gap-2 text-[11px] border-b border-white/5 pb-1">
                          <span className="font-mono text-gray-500 shrink-0">
                            {new Date(ev.createdAt).toLocaleTimeString([], { hour12: false })}
                          </span>
                          <span
                            className={
                              ev.event === "penalised" || ev.event === "nomination-cancelled"
                                ? "text-red-300"
                                : ev.event.startsWith("makeup") || ev.event === "admin-rewind"
                                  ? "text-emerald-300"
                                  : "text-gray-300"
                            }
                          >
                            {ev.event}
                          </span>
                          <span className="text-gray-400 truncate">
                            {ev.teamId ? teamLabel(teams.get(ev.teamId), ev.teamId) : "—"}
                          </span>
                          <span className="ml-auto text-gray-600 shrink-0">{ev.actor}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {session.status === "pending" ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur text-center mb-6">
            <div className="text-3xl mb-2">⏳</div>
            <div className="text-white font-semibold mb-1">Not started yet</div>
            <div className="text-sm text-gray-400">Click &quot;Start Session&quot; above to open bidding.</div>
          </div>
        ) : (
          <div className="grid lg:grid-cols-5 gap-4 mb-6">
            <div className="lg:col-span-3 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
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
                      <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">
                        On the Block
                        {currentBid.lotNumber != null && <span className="ml-1 text-yellow-400/80">#{currentBid.lotNumber}</span>}
                      </div>
                      <div className="text-lg font-bold text-white flex items-center gap-2 flex-wrap">
                        {currentBid.playerName}
                        <LotIdentity bid={currentBid} elementById={elementById} plTeams={plTeams} isClubAuction={isClubAuction} />
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

            <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
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

        {/* Who's still available. Club auctions bid on PL clubs, not players, so a player pool is
            meaningless there. */}
        {session.type !== CLUB_AUCTION_TYPE && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur mb-6">
            <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                Available Players
              </h3>
              <span className="text-xs text-gray-400">
                <span className="font-mono text-white">{totalAvailable}</span> unsold
                {poolFiltered && (
                  <> · showing <span className="font-mono text-white">{availablePlayers.length}</span></>
                )}
              </span>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="flex gap-1">
                <button
                  onClick={() => setPoolPositionFilter(null)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition ${
                    poolPositionFilter === null
                      ? "bg-white/15 text-white border-white/25"
                      : "bg-white/5 text-gray-400 border-white/10 hover:bg-white/10"
                  }`}
                >
                  ALL
                </button>
                {POSITION_ORDER.map((pos) => (
                  <button
                    key={pos}
                    onClick={() => setPoolPositionFilter(poolPositionFilter === pos ? null : pos)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition ${
                      poolPositionFilter === pos
                        ? "bg-white/15 text-white border-white/25"
                        : "bg-white/5 text-gray-400 border-white/10 hover:bg-white/10"
                    }`}
                  >
                    {POSITION_LABELS[pos]}
                  </button>
                ))}
              </div>

              <select
                value={poolClubFilter ?? ""}
                onChange={(e) => setPoolClubFilter(e.target.value === "" ? null : Number(e.target.value))}
                className="rounded-lg border border-white/15 bg-slate-800 px-2 py-1.5 text-xs text-white"
              >
                <option value="" className="bg-slate-800">All clubs</option>
                {poolClubOptions.map((t) => (
                  <option key={t.id} value={t.id} className="bg-slate-800">
                    {getPlTeamFullName(t.id, t.name, t.short_name)}
                  </option>
                ))}
              </select>

              <input
                type="text"
                value={poolSearch}
                onChange={(e) => setPoolSearch(e.target.value)}
                placeholder="Search player…"
                className="rounded-lg border border-white/15 bg-slate-800 px-2 py-1.5 text-xs text-white placeholder-gray-500 w-40"
              />

              {poolFiltered && (
                <button
                  onClick={() => { setPoolPositionFilter(null); setPoolClubFilter(null); setPoolSearch(""); }}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10 transition"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-900/95 z-10">
                  <tr className="text-gray-400 uppercase tracking-wider border-b border-white/10">
                    <th className="text-left py-2 px-2">Pos</th>
                    <th className="text-left py-2 px-2">Player</th>
                    <th className="text-left py-2 px-2">Club</th>
                    <th className="text-right py-2 px-2">Price</th>
                    <th className="text-right py-2 px-2">Pts</th>
                    <th className="text-left py-2 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {availablePlayers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-gray-500 py-6 text-center">
                        {totalAvailable === 0 ? "No players left" : "No players match these filters"}
                      </td>
                    </tr>
                  ) : (
                    availablePlayers.slice(0, POOL_RENDER_CAP).map((el) => {
                      const onBlock = currentBid?.fplElementId === el.id;
                      const passed = passedElementIds.has(el.id);
                      const club = plTeams.get(el.team);
                      return (
                        <tr
                          key={el.id}
                          className={`border-b border-white/5 ${onBlock ? "bg-yellow-500/15" : ""}`}
                        >
                          <td className={`py-1.5 px-2 font-semibold ${POSITION_COLORS[el.element_type] ?? "text-gray-400"}`}>
                            {POSITION_LABELS[el.element_type]}
                          </td>
                          <td className="py-1.5 px-2 text-white">{el.web_name}</td>
                          <td className="py-1.5 px-2 text-gray-400">{club?.short_name ?? `Team ${el.team}`}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-gray-300">
                            {formatCurrency(el.now_cost * 100_000)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-gray-300">{el.total_points}</td>
                          <td className="py-1.5 px-2">
                            <div className="flex gap-1">
                              {onBlock && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full uppercase font-bold tracking-wider border border-yellow-500/30 bg-yellow-500/10 text-yellow-300">
                                  On block
                                </span>
                              )}
                              {passed && !onBlock && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full uppercase font-bold tracking-wider border border-orange-500/30 bg-orange-500/10 text-orange-300">
                                  Passed
                                </span>
                              )}
                              {el.status !== "a" && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full uppercase font-bold tracking-wider border border-red-500/30 bg-red-500/10 text-red-300">
                                  {el.status === "i" ? "Injured" : el.status === "s" ? "Susp" : "Unavail"}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {availablePlayers.length > POOL_RENDER_CAP && (
              <div className="text-[10px] text-gray-500 mt-2">
                Showing top {POOL_RENDER_CAP} by points — filter by club or position to narrow.
              </div>
            )}
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
