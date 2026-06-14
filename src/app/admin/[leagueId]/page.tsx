"use client";

import { Fragment, useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import * as XLSX from "xlsx";
import { LoadingScreen } from "@/components/LoadingScreen";
import { TierChip } from "@/components/TierChip";
import { AuctionTimerRing } from "@/components/AuctionTimerRing";
import { formatCurrency } from "@/lib/format/currency";
import { FeedbackTab } from "./FeedbackTab";

interface Team {
  id: string;
  teamLoginId?: string;
  name: string;          // Display name — renamed to the owned PL club's name when applicable.
  rawName?: string;      // Original `teams.name` value — used in edit forms where the underlying name matters.
  group: string;
  players: { id: string; name: string; fplId: string }[];
  needsPasswordChange: boolean;
  isProfileComplete: boolean;
  ownedClub?: {
    plTeamId: number;
    plTeamName: string;
    plTeamShort: string;
    tier: "top8" | "mid" | "promoted";
  } | null;
}

interface TeamWithPlayers {
  id: string;
  name: string;
  group: string;
  players: { id: string; name: string; fplId: string; captaincyChipsUsed: number }[];
}

interface Gameweek {
  id: string;
  number: number;
  deadline: string;
}

interface CaptainData {
  teamId: string;
  teamName: string;
  gameweek: number;
  playerName: string;
  playerId: string;
  isValid: boolean;
}

interface ChipInfo {
  used: boolean;
  name: string;
  gameweek: number | null;
  wasted: boolean;
  points: number;
}

interface ChipTeam {
  id: string;
  name: string;
  group: string;
  chips: {
    set1: {
      doublePointer: ChipInfo;
      challengeChip: ChipInfo;
      winWin: ChipInfo;
    };
    set2: {
      doublePointer: ChipInfo;
      challengeChip: ChipInfo;
      winWin: ChipInfo;
    };
  };
}

interface BulkUploadResult {
  message: string;
  created: number;
  failed: number;
  details: {
    success: string[];
    errors: string[];
  };
}

interface GameweekStatus {
  number: number;
  fixturesCount: number;
  resultsProcessed: number;
  isPending: boolean;
  survivalCount?: number;
  survivalRanked?: number;
}

interface H2HMatchResult {
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  homeMatchPoints: number;
  awayMatchPoints: number;
}

interface AuctionTeamResult {
  teamId: string;
  teamName: string;
  totalPoints: number;
  rank: number;
  payout: number;
}

interface ScoringResult {
  gameweek: number;
  processed: number;
  failed: number;
  // TVT/triple-crown return H2H matches; auction returns per-team point rows.
  results: (H2HMatchResult | AuctionTeamResult)[];
  errors?: ({ homeTeam: string; awayTeam: string; error: string } | string)[];
}

interface CacheStats {
  totalEntries: number;
  gameweeks: { gameweek: number; entries: number }[];
}

type TabType = "teams" | "groups" | "captain" | "bulkUpload" | "scoring" | "playoffs" | "settings" | "auction" | "finance" | "marketplace" | "feedback";

// Auction-specific interfaces
interface AuctionSessionInfo {
  id: string;
  type: string;
  cycleNumber: number;
  status: string;
  snakeOrder: string[];
  currentNominatorIndex: number;
  scheduledAt: string | null;
  createdAt: string;
  bidTimerSeconds?: number;
}

interface AuctionSquadPlayer {
  ownershipId: string;
  fplElementId: number;
  playerName: string;
  elementType: number | null;
  purchasePrice: number;
  acquiredGw: number;
  status: string;
  totalPoints: number;
  fmv: number;
  plTeamShort?: string | null;
}

const SQUAD_POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const SQUAD_POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  2: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  3: "bg-green-500/20 text-green-300 border-green-500/30",
  4: "bg-red-500/20 text-red-300 border-red-500/30",
};

interface AuctionTeamSquad {
  teamId: string;
  teamName: string;
  squad: AuctionSquadPlayer[];
  activeCount: number;
  deadwoodCount: number;
  ownedClub?: {
    plTeamId: number;
    plTeamName: string;
    plTeamShort: string;
    tier: "top8" | "mid" | "promoted";
  } | null;
}

interface AuctionTradeProposal {
  id: string;
  proposerTeamId: string;
  targetTeamId: string;
  offeredPlayerIds: string[];
  requestedPlayerIds: string[];
  cashOffered: number;
  status: string;
  createdAt: string;
}

export default function AdminDashboard() {
  const params = useParams<{ leagueId: string }>();
  const leagueId = params.leagueId;

  const [activeTab, setActiveTab] = useState<TabType>("teams");
  const [teams, setTeams] = useState<Team[]>([]);
  const [leagueConfig, setLeagueConfig] = useState<{ leagueDbId?: string; teamSize: number; groupCount: number; playoffStartGw: number; enabledChips: string[]; format?: string; clubAuctionEnabled?: boolean }>({
    teamSize: 32, groupCount: 2, playoffStartGw: 31, enabledChips: ["D", "W", "C"],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    teamLoginId: "",
    teamName: "",
    password: "",
    player1Name: "",
    player1FplId: "",
    player2Name: "",
    player2FplId: "",
    group: "A",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string; credentials?: { loginId: string; password: string } } | null>(null);

  // Captain Override State
  const [captainTeams, setCaptainTeams] = useState<TeamWithPlayers[]>([]);
  const [gameweeks, setGameweeks] = useState<Gameweek[]>([]);
  const [currentCaptains, setCurrentCaptains] = useState<CaptainData[]>([]);
  const [captainOverride, setCaptainOverride] = useState({
    teamId: "",
    playerId: "",
    gameweekNumber: "",
    reason: "",
  });
  const [captainLoading, setCaptainLoading] = useState(false);

  // Captain Filter State
  const [captainFilterGw, setCaptainFilterGw] = useState<string>("");
  const [captainFilterTeam, setCaptainFilterTeam] = useState<string>("");

  // Chips Override State
  const [chipTeams, setChipTeams] = useState<ChipTeam[]>([]);
  const [chipsLoading, setChipsLoading] = useState(false);
  const [chipFilterTeam, setChipFilterTeam] = useState<string>("");
  const [chipOverride, setChipOverride] = useState({
    teamId: "",
    chipType: "",
    status: "available" as "available" | "used" | "wasted",
    gameweek: "",
    reason: "",
  });

  // Bulk Upload State
  const [fixturesData, setFixturesData] = useState<Record<string, string>[]>([]);
  const [captainsData, setCaptainsData] = useState<Record<string, string>[]>([]);
  const [chipsData, setChipsData] = useState<Record<string, string>[]>([]);
  const [teamsData, setTeamsData] = useState<Record<string, string>[]>([]);
  const [fixturesFileName, setFixturesFileName] = useState("");
  const [captainsFileName, setCaptainsFileName] = useState("");
  const [chipsFileName, setChipsFileName] = useState("");
  const [teamsFileName, setTeamsFileName] = useState("");
  const [bulkUploadResult, setBulkUploadResult] = useState<BulkUploadResult | null>(null);
  const [bulkUploading, setBulkUploading] = useState(false);

  // Scoring State
  const [gameweekStatuses, setGameweekStatuses] = useState<GameweekStatus[]>([]);
  const [scoringLoading, setScoringLoading] = useState(false);
  const [processingGW, setProcessingGW] = useState<number | null>(null);
  const [scoringResults, setScoringResults] = useState<ScoringResult[]>([]);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);

  // Playoffs State
  const [playoffsGenerated, setPlayoffsGenerated] = useState(false);
  const [playoffsLoading, setPlayoffsLoading] = useState(false);
  const [advancingGW, setAdvancingGW] = useState<number | null>(null);

  // Triple Crown State
  const [cupGroupsGenerated, setCupGroupsGenerated] = useState(false);
  const [bracketsGenerated, setBracketsGenerated] = useState(false);
  const [cupGroupsLoading, setCupGroupsLoading] = useState(false);
  const [bracketsLoading, setBracketsLoading] = useState(false);

  // Group Assignment State (32-team TVT)
  const [groupAssignments, setGroupAssignments] = useState<Record<string, string>>({});
  const [savingGroups, setSavingGroups] = useState(false);

  // Settings State
  const [captainAnnouncementEnabled, setCaptainAnnouncementEnabled] = useState(true);
  const [chipAnnouncementEnabled, setChipAnnouncementEnabled] = useState(true);
  const [groupsRevealed, setGroupsRevealed] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Auction Management State
  const [auctionSessions, setAuctionSessions] = useState<AuctionSessionInfo[]>([]);
  const [auctionActiveSession, setAuctionActiveSession] = useState<AuctionSessionInfo | null>(null);
  const [auctionTeamSquads, setAuctionTeamSquads] = useState<AuctionTeamSquad[]>([]);
  const [expandedSquads, setExpandedSquads] = useState<Set<string>>(new Set());
  // Squad Overview table sort (local to this view).
  const [squadSort, setSquadSort] = useState<{ key: "team" | "spent" | "points"; dir: "asc" | "desc" }>({ key: "team", dir: "asc" });
  const [auctionTrades, setAuctionTrades] = useState<AuctionTradeProposal[]>([]);
  const [auctionLoading, setAuctionLoading] = useState(false);
  const [auctionSessionCreating, setAuctionSessionCreating] = useState(false);
  const [auctionSessionAction, setAuctionSessionAction] = useState<string | null>(null);
  const [showCreateSessionModal, setShowCreateSessionModal] = useState<string | null>(null); // "initial" | "mini-auction" | "club-auction" | null
  const [newSessionScheduledAt, setNewSessionScheduledAt] = useState("");
  const [newSessionBidTimer, setNewSessionBidTimer] = useState("20");
  const [newSessionNominationTimer, setNewSessionNominationTimer] = useState("60");

  // Live Auction Monitor State
  const [liveCurrentBid, setLiveCurrentBid] = useState<{
    bidId: string; fplElementId: number; playerName: string;
    currentHighBid: number; currentHighBidderId: string;
    nominatorTeamId: string; minBid: number; expiresAt: string; status: string;
  } | null>(null);
  const [liveFeed, setLiveFeed] = useState<{ id: string; text: string; kind: string; ts: number }[]>([]);
  const [liveTimerSec, setLiveTimerSec] = useState(0);
  const [liveNominationDeadline, setLiveNominationDeadline] = useState<string | null>(null);
  const [liveIntermissionUntil, setLiveIntermissionUntil] = useState<string | null>(null);
  const liveEsRef = useRef<EventSource | null>(null);
  const lastLiveBidIdRef = useRef<string | null>(null);
  const liveCurrentBidRef = useRef<typeof liveCurrentBid>(null);
  useEffect(() => { liveCurrentBidRef.current = liveCurrentBid; }, [liveCurrentBid]);
  // Holds the latest fetchSoldBids so SSE handlers (defined before fetchSoldBids) can refresh the
  // Corrections / Undo-Sale list when a lot resolves, without re-subscribing the stream.
  const fetchSoldBidsRef = useRef<(() => void) | null>(null);

  // Auction Reset State
  const [auctionResetting, setAuctionResetting] = useState(false);
  const [showAuctionResetConfirm, setShowAuctionResetConfirm] = useState(false);
  const [auctionResetTarget, setAuctionResetTarget] = useState("initial");

  // Auction Corrections State
  const [undoingBid, setUndoingBid] = useState<string | null>(null);
  const [soldBids, setSoldBids] = useState<{ id: string; playerName: string; currentHighBid: number; currentHighBidderId: string; fplElementId: number }[]>([]);
  const [transferOwnershipId, setTransferOwnershipId] = useState<string | null>(null);
  const [transferToTeamId, setTransferToTeamId] = useState("");
  const [transferring, setTransferring] = useState(false);

  const isAuctionFormat = leagueConfig.format === "auction";

  // Reset Season State
  const [resetPassword, setResetPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Edit Team State
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [editFormData, setEditFormData] = useState({
    teamId: "",
    teamLoginId: "",
    teamName: "",
    password: "",
    player1Id: "",
    player1Name: "",
    player1FplId: "",
    player2Id: "",
    player2Name: "",
    player2FplId: "",
    group: "A",
  });

  // Delete Team State
  const [deletingTeam, setDeletingTeam] = useState<Team | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Bulk Select State
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Superadmin detection — show "← Platform Admin" link if superadmin is viewing
  const [isSuperadminViewer, setIsSuperadminViewer] = useState(false);
  useEffect(() => {
    fetch("/api/auth/me").then(r => r.json()).then(d => {
      if (d.type === "superadmin") setIsSuperadminViewer(true);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (leagueId) fetchTeams();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId]);

  useEffect(() => {
    if (activeTab === "captain") {
      fetchCaptainData();
    } else if (activeTab === "scoring") {
      fetchGameweekStatuses();
      fetchCacheStats();
    } else if (activeTab === "playoffs") {
      fetchPlayoffStatus();
    } else if (activeTab === "settings") {
      fetchSettings();
    } else if (activeTab === "groups") {
      fetchSettings();
    } else if (activeTab === "auction") {
      fetchAuctionData();
    }
  }, [activeTab]);

  const fetchTeams = async () => {
    try {
      const response = await fetch(`/api/admin/${leagueId}/create-team`);
      if (response.status === 401 || response.status === 403) {
        window.location.href = "/signin";
        return;
      }
      const data = await response.json();
      setTeams(data.teams || []);
      // Seed group assignments from current team groups
      const initialAssignments: Record<string, string> = {};
      for (const t of (data.teams || [])) {
        initialAssignments[t.id] = t.group || "A";
      }
      setGroupAssignments(initialAssignments);
    } catch (error) {
      console.error("Failed to fetch teams:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch league config for dynamic capacity display
  useEffect(() => {
    if (!leagueId) return;
    fetch("/api/admin/my-leagues")
      .then(r => r.json())
      .then(data => {
        const league = (data.leagues || []).find((l: { slug: string }) => l.slug === leagueId);
        if (league) {
          let enabledChips: string[] = ["D", "W", "C"];
          try { enabledChips = JSON.parse(league.enabledChips ?? '["D","W","C"]'); } catch { /* keep default */ }
          setLeagueConfig({
            leagueDbId: league.id,
            teamSize: league.teamSize ?? 32,
            groupCount: league.groupCount ?? 2,
            playoffStartGw: league.playoffStartGw ?? 31,
            enabledChips,
            format: league.format,
            clubAuctionEnabled: Boolean(league.clubAuctionEnabled),
          });
        }
      })
      .catch(() => {});
  }, [leagueId]);

  const fetchCaptainData = async () => {
    setCaptainLoading(true);
    try {
      const response = await fetch(`/api/admin/${leagueId}/override-captain`);
      if (response.ok) {
        const data = await response.json();
        // Sort teams alphabetically
        const sortedTeams = (data.teams || []).sort((a: TeamWithPlayers, b: TeamWithPlayers) => a.name.localeCompare(b.name));
        setCaptainTeams(sortedTeams);
        const gws = data.gameweeks || [];
        setGameweeks(gws);
        const captains: CaptainData[] = data.currentCaptains || [];
        setCurrentCaptains(captains);
        // Default GW filter to the latest GW that has captain entries (not just any existing GW)
        if (gws.length > 0 && !captainFilterGw) {
          const maxGwWithCaptains = captains.length
            ? Math.max(...captains.map((c: CaptainData) => c.gameweek))
            : Math.max(...gws.map((g: Gameweek) => g.number));
          setCaptainFilterGw(String(maxGwWithCaptains));
        }
      }
    } catch (error) {
      console.error("Failed to fetch captain data:", error);
    } finally {
      setCaptainLoading(false);
    }
  };

  const fetchChipsData = async () => {
    setChipsLoading(true);
    try {
      const response = await fetch(`/api/admin/${leagueId}/override-chips`);
      if (response.ok) {
        const data = await response.json();
        // Sort teams alphabetically by name (ascending)
        const sortedTeams = (data.teams || []).sort((a: ChipTeam, b: ChipTeam) => 
          a.name.localeCompare(b.name)
        );
        setChipTeams(sortedTeams);
      }
    } catch (error) {
      console.error("Failed to fetch chips data:", error);
    } finally {
      setChipsLoading(false);
    }
  };

  const fetchGameweekStatuses = async () => {
    setScoringLoading(true);
    try {
      // Auction format: use dedicated scoring-status endpoint
      if (isAuctionFormat && leagueConfig.leagueDbId) {
        const response = await fetch(`/api/auction/scoring-status?leagueId=${leagueConfig.leagueDbId}`);
        if (response.ok) {
          const data = await response.json();
          const statuses: GameweekStatus[] = (data.statuses || []).map((s: { number: number; totalManagers: number; scored: number; isPending: boolean }) => ({
            number: s.number,
            fixturesCount: s.totalManagers,
            resultsProcessed: s.scored,
            isPending: s.isPending,
          }));
          setGameweekStatuses(statuses);
        }
        setScoringLoading(false);
        return;
      }

      const statuses: GameweekStatus[] = [];
      // Fetch status for GW1-38 (or until we find gameweeks with no fixtures)
      for (let gw = 1; gw <= 38; gw++) {
        const response = await fetch(`/api/gameweeks/${gw}?leagueId=${leagueId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.gameweek && data.gameweek.fixturesCount > 0) {
            const survivalCount = data.gameweek.survivalCount ?? 0;
            const survivalRanked = data.gameweek.survivalRanked ?? 0;
            const fixturesPending = data.gameweek.resultsProcessed < data.gameweek.fixturesCount;
            const survivalPending = survivalCount > 0 && survivalRanked < survivalCount;
            statuses.push({
              number: data.gameweek.number,
              fixturesCount: data.gameweek.fixturesCount,
              resultsProcessed: data.gameweek.resultsProcessed,
              isPending: fixturesPending || survivalPending,
              survivalCount,
              survivalRanked,
            });
          }
        } else if (response.status === 404) {
          // No more gameweeks
          break;
        }
      }
      setGameweekStatuses(statuses);
    } catch (error) {
      console.error("Failed to fetch gameweek statuses:", error);
    } finally {
      setScoringLoading(false);
    }
  };

  const fetchCacheStats = async () => {
    try {
      const response = await fetch(`/api/admin/${leagueId}/fpl-cache`);
      if (response.ok) {
        const data = await response.json();
        setCacheStats(data);
      }
    } catch (error) {
      console.error("Failed to fetch cache stats:", error);
    }
  };

  const clearCache = async (gameweek?: number) => {
    try {
      const url = gameweek 
        ? `/api/admin/${leagueId}/fpl-cache?gw=${gameweek}`
        : `/api/admin/${leagueId}/fpl-cache`;
      const response = await fetch(url, { method: "DELETE" });
      if (response.ok) {
        setMessage({ type: "success", text: gameweek ? `Cleared cache for GW${gameweek}` : "Cleared all cache" });
        fetchCacheStats();
      }
    } catch (error) {
      setMessage({ type: "error", text: "Failed to clear cache" });
    }
  };

  const processGameweek = async (gwNumber: number, force: boolean = false) => {
    setProcessingGW(gwNumber);
    setMessage(null);

    try {
      const url = force 
        ? `/api/gameweeks/${gwNumber}?leagueId=${leagueId}&force=true`
        : `/api/gameweeks/${gwNumber}?leagueId=${leagueId}`;
      const response = await fetch(url, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || `Failed to process GW${gwNumber}` });
        return;
      }

      setScoringResults(prev => [...prev, data as ScoringResult]);
      setMessage({ 
        type: "success", 
        text: `GW${gwNumber}: Processed ${data.processed} fixtures, ${data.failed} failed` 
      });
      
      // Refresh the gameweek statuses and cache stats
      fetchGameweekStatuses();
      fetchCacheStats();
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setProcessingGW(null);
    }
  };

  const processAllPendingGameweeks = async () => {
    const pendingGWs = gameweekStatuses.filter(gw => gw.isPending);
    if (pendingGWs.length === 0) {
      setMessage({ type: "error", text: "No pending gameweeks to process" });
      return;
    }

    setScoringResults([]);
    
    for (const gw of pendingGWs) {
      await processGameweek(gw.number);
    }

    setMessage({ 
      type: "success", 
      text: `Finished processing ${pendingGWs.length} gameweeks` 
    });
  };

  const reprocessAllGameweeks = async () => {
    if (gameweekStatuses.length === 0) {
      setMessage({ type: "error", text: "No gameweeks to reprocess" });
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to reprocess all ${gameweekStatuses.length} gameweeks? This will recalculate all scores.`
    );
    if (!confirmed) return;

    setScoringResults([]);
    
    for (const gw of gameweekStatuses) {
      await processGameweek(gw.number, true);
    }

    setMessage({ 
      type: "success", 
      text: `Finished reprocessing ${gameweekStatuses.length} gameweeks` 
    });
  };

  const createGameweeks = async () => {
    setScoringLoading(true);
    try {
      const res = await fetch(`/api/admin/${leagueId}/create-gameweeks`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `Created ${data.created} gameweeks (${data.skipped} already existed)` });
        fetchGameweekStatuses();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to create gameweeks" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setScoringLoading(false);
    }
  };

  // Playoff functions
  const fetchPlayoffStatus = async () => {
    setPlayoffsLoading(true);
    try {
      const res = await fetch(`/api/admin/${leagueId}/generate-playoffs`);
      if (res.ok) {
        const data = await res.json();
        setPlayoffsGenerated(data.generated === true);
      }
      // For Triple Crown, also fetch cup group + UCL/UEL bracket status in parallel
      if (leagueConfig.format === "triple-crown") {
        const [cupRes, bracketsRes] = await Promise.all([
          fetch(`/api/admin/${leagueId}/generate-cup-groups`),
          fetch(`/api/admin/${leagueId}/generate-brackets`),
        ]);
        if (cupRes.ok) {
          const cupData = await cupRes.json();
          setCupGroupsGenerated(cupData.cupGroupsSeeded === true);
        }
        if (bracketsRes.ok) {
          const bracketsData = await bracketsRes.json();
          setBracketsGenerated(bracketsData.bracketsGenerated === true);
        }
      }
    } catch {
      // ignore
    } finally {
      setPlayoffsLoading(false);
    }
  };

  const generatePlayoffs = async () => {
    const { teamSize, playoffStartGw } = leagueConfig;
    const bracketLabel = teamSize === 8 ? "SF" : teamSize === 16 ? "Group Stage" : "RO16 + C-31";
    const standingsGw = playoffStartGw - 1;
    if (!window.confirm(`Generate initial playoff bracket (${bracketLabel}) from current GW${standingsGw} standings?`)) return;
    setPlayoffsLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/generate-playoffs`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to generate playoffs" });
      } else {
        setMessage({ type: "success", text: data.message || "Playoffs generated successfully" });
        setPlayoffsGenerated(true);
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setPlayoffsLoading(false);
    }
  };

  const regeneratePlayoffs = async () => {
    if (!window.confirm("This will DELETE all existing RO16 and C-31 fixtures/results and regenerate them from current standings. Continue?")) return;
    setPlayoffsLoading(true);
    setMessage(null);
    try {
      // Step 1: Delete existing RO16 + C-31
      const delRes = await fetch(`/api/admin/${leagueId}/generate-playoffs`, { method: "DELETE" });
      const delData = await delRes.json();
      if (!delRes.ok) {
        setMessage({ type: "error", text: delData.error || "Failed to delete existing playoffs" });
        return;
      }
      // Step 2: Regenerate from current standings
      const genRes = await fetch(`/api/admin/${leagueId}/generate-playoffs`, { method: "POST" });
      const genData = await genRes.json();
      if (!genRes.ok) {
        setMessage({ type: "error", text: genData.error || "Failed to regenerate playoffs" });
      } else {
        setMessage({ type: "success", text: `Playoffs regenerated: ${genData.message}` });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setPlayoffsLoading(false);
    }
  };

  const advancePlayoffs = async (gw: number) => {
    if (!window.confirm(`Advance playoffs for GW${gw}? This will resolve current round and generate next fixtures.`)) return;
    setAdvancingGW(gw);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/advance-playoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameweek: gw }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || `Failed to advance GW${gw}` });
      } else {
        setMessage({ type: "success", text: data.message || `GW${gw} playoffs advanced successfully` });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setAdvancingGW(null);
    }
  };

  const seedCupGroups = async () => {
    if (!window.confirm("Seed cup groups from GW5 standings? This will create 4 cup groups and Ghost teams.")) return;
    setCupGroupsLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/generate-cup-groups`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to seed cup groups" });
      } else {
        setMessage({ type: "success", text: data.message || "Cup groups seeded successfully" });
        setCupGroupsGenerated(true);
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setCupGroupsLoading(false);
    }
  };

  const deleteCupGroups = async () => {
    if (!window.confirm("Delete all cup groups, ghost teams, and cup fixtures? This cannot be undone. You can re-seed after.")) return;
    setCupGroupsLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/generate-cup-groups`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to delete cup groups" });
      } else {
        setMessage({ type: "success", text: data.message || "Cup groups deleted successfully. You can now re-seed." });
        setCupGroupsGenerated(false);
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setCupGroupsLoading(false);
    }
  };

  const generateBrackets = async () => {
    if (!window.confirm("Generate UCL/UEL brackets from GW24 standings? This will create knockout ties for QF round.")) return;
    setBracketsLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/generate-brackets`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to generate brackets" });
      } else {
        setMessage({ type: "success", text: data.message || "Brackets generated successfully" });
        setBracketsGenerated(true);
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setBracketsLoading(false);
    }
  };

  const regenerateBrackets = async () => {
    if (!window.confirm("Delete existing UCL/UEL brackets and regenerate from GW24 standings? All knockout ties, fixtures, and results will be removed.")) return;
    setBracketsLoading(true);
    setMessage(null);
    try {
      const delRes = await fetch(`/api/admin/${leagueId}/generate-brackets`, { method: "DELETE" });
      const delData = await delRes.json();
      if (!delRes.ok) {
        setMessage({ type: "error", text: delData.error || "Failed to delete existing brackets" });
        setBracketsLoading(false);
        return;
      }
      const genRes = await fetch(`/api/admin/${leagueId}/generate-brackets`, { method: "POST" });
      const genData = await genRes.json();
      if (!genRes.ok) {
        setMessage({ type: "error", text: genData.error || "Deleted but failed to regenerate brackets" });
      } else {
        setMessage({ type: "success", text: genData.message || "Brackets regenerated successfully" });
        setBracketsGenerated(true);
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setBracketsLoading(false);
    }
  };

  const saveGroupAssignments = async () => {
    const assignments = Object.entries(groupAssignments).map(([teamId, group]) => ({ teamId, group }));
    if (assignments.length === 0) return;
    setSavingGroups(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/assign-groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to save group assignments" });
      } else {
        setMessage({ type: "success", text: data.message || "Groups saved" });
        fetchTeams(); // refresh team list
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setSavingGroups(false);
    }
  };

  const fetchSettings = async () => {
    setSettingsLoading(true);
    try {
      const res = await fetch(`/api/admin/${leagueId}/settings`);
      const data = await res.json();
      if (res.ok) {
        setCaptainAnnouncementEnabled(data.captainAnnouncementEnabled);
        setChipAnnouncementEnabled(data.chipAnnouncementEnabled);
        setGroupsRevealed(data.groupsRevealed ?? false);
      }
    } catch {
      // ignore
    } finally {
      setSettingsLoading(false);
    }
  };

  const toggleSetting = async (key: string, value: boolean) => {
    try {
      const res = await fetch(`/api/admin/${leagueId}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (res.ok) {
        if (key === "captainAnnouncementEnabled") setCaptainAnnouncementEnabled(value);
        if (key === "chipAnnouncementEnabled") setChipAnnouncementEnabled(value);
        if (key === "groupsRevealed") setGroupsRevealed(value);
        const label = key === "captainAnnouncementEnabled" ? "Captain announcements"
          : key === "chipAnnouncementEnabled" ? "Chip announcements"
          : "Groups";
        setMessage({ type: "success", text: `${label} ${value ? "enabled" : "disabled"}` });
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to update setting" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    }
  };

  // ============= Auction Management Functions =============

  const fetchAuctionData = async () => {
    setAuctionLoading(true);
    try {
      // Fetch sessions
      const auctionDbId = leagueConfig.leagueDbId;
      if (!auctionDbId) return;
      const sessionRes = await fetch(`/api/auction/session?leagueId=${auctionDbId}`);
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        setAuctionSessions(sessionData.sessions || []);
        setAuctionActiveSession(sessionData.activeSession || null);
      }

      // Fetch all team squads
      const squads: AuctionTeamSquad[] = [];
      for (const team of teams) {
        try {
          const squadRes = await fetch(`/api/auction/squad?teamId=${team.id}`);
          if (squadRes.ok) {
            const squadData = await squadRes.json();
            squads.push(squadData);
          }
        } catch { /* skip */ }
      }
      squads.sort((a, b) => {
        const an = parseInt(a.teamName.match(/\d+/)?.[0] ?? "0", 10);
        const bn = parseInt(b.teamName.match(/\d+/)?.[0] ?? "0", 10);
        if (an !== bn) return an - bn;
        return a.teamName.localeCompare(b.teamName);
      });
      setAuctionTeamSquads(squads);

      // Fetch trades
      const tradeRes = await fetch(`/api/auction/trade?leagueId=${auctionDbId}`);
      if (tradeRes.ok) {
        const tradeData = await tradeRes.json();
        setAuctionTrades(tradeData.proposals || []);
      }
    } catch (error) {
      console.error("Failed to fetch auction data:", error);
    } finally {
      setAuctionLoading(false);
    }
  };

  const createAuctionSession = async (type: string, scheduledAt?: string) => {
    setAuctionSessionCreating(true);
    try {
      const res = await fetch("/api/auction/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leagueId: leagueConfig.leagueDbId,
          action: "create",
          type,
          cycleNumber: type === "initial" ? 0 : undefined,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
          bidTimerSeconds: parseInt(newSessionBidTimer) || 20,
          nominationTimeoutSeconds: parseInt(newSessionNominationTimer) || 60,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `Auction session created (${type})` });
        setShowCreateSessionModal(null);
        setNewSessionScheduledAt("");
        setNewSessionBidTimer("20");
        setNewSessionNominationTimer("60");
        fetchAuctionData();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to create session" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setAuctionSessionCreating(false);
    }
  };

  const rescheduleAuctionSession = async (sessionId: string, scheduledAt: string) => {
    try {
      const res = await fetch("/api/auction/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leagueId: leagueConfig.leagueDbId,
          action: "schedule",
          sessionId,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Schedule updated" });
        fetchAuctionData();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to update schedule" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    }
  };

  const updateAuctionSession = async (sessionId: string, action: string) => {
    // Confirm disruptive controls on an in-progress auction before acting.
    const confirmMsg: Record<string, string> = {
      start: "Start/resume the auction? Bidding will be open for all teams.",
      pause: "Pause the auction? Bidding stops for all teams until you resume.",
      resume: "Resume the auction? Bidding reopens for all teams.",
      complete: "Complete the auction? This permanently ends bidding for all teams and cannot be undone.",
    };
    if (confirmMsg[action] && !confirm(confirmMsg[action])) return;
    setAuctionSessionAction(action);
    try {
      const res = await fetch("/api/auction/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId: leagueConfig.leagueDbId, action, sessionId }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.simulated) {
          setMessage({ type: "success", text: `Simulation complete! ${data.playersAssigned} players auto-assigned via snake draft.` });
        } else {
          setMessage({ type: "success", text: `Session ${action}ed successfully` });
        }
        fetchAuctionData();
      } else {
        setMessage({ type: "error", text: data.error || `Failed to ${action} session` });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setAuctionSessionAction(null);
    }
  };

  // ---- Live Auction Monitor helpers ----

  const formatAuctionCurrency = formatCurrency;

  const addLiveFeed = useCallback((text: string, kind: string) => {
    setLiveFeed((prev) => [{ id: Math.random().toString(36).slice(2), text, kind, ts: Date.now() }, ...prev]);
  }, []);

  const teamNameById = useCallback((id: string) => {
    return teams.find((t) => t.id === id)?.name ?? id;
  }, [teams]);

  // Heartbeat watchdog ref — tracks last "heartbeat" event timestamp so we can detect a silently
  // dropped SSE connection (e.g. Vercel edge timeout, browser tab suspension) and force a reconnect.
  // Without this, the admin live monitor would freeze on a stale timer until manual refresh.
  const lastHeartbeatRef = useRef<number>(Date.now());
  const reconnectTickRef = useRef<number>(0);

  // SSE connection for live monitor
  useEffect(() => {
    if (!isAuctionFormat || !auctionActiveSession || auctionActiveSession.status !== "active") {
      if (liveEsRef.current) { liveEsRef.current.close(); liveEsRef.current = null; }
      return;
    }

    lastHeartbeatRef.current = Date.now();
    const es = new EventSource(`/api/auction/session/stream?sessionId=${auctionActiveSession.id}`);
    liveEsRef.current = es;

    // The stream emits "heartbeat" every 15s. Track it so we can detect connection death.
    es.addEventListener("heartbeat", () => {
      lastHeartbeatRef.current = Date.now();
    });

    es.addEventListener("auction-state", (e) => {
      lastHeartbeatRef.current = Date.now();
      const data = JSON.parse((e as MessageEvent).data);
      setLiveCurrentBid(data);
      if (data.bidId && data.bidId !== lastLiveBidIdRef.current) {
        lastLiveBidIdRef.current = data.bidId;
        const nominatorName = teams.find((t) => t.id === data.nominatorTeamId)?.name ?? "Unknown";
        addLiveFeed(`${nominatorName} nominated ${data.playerName} — base ${formatAuctionCurrency(data.minBid)}`, "info");
      }
    });
    es.addEventListener("bid-placed", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setLiveCurrentBid(data);
      const bidderName = teams.find((t) => t.id === data.currentHighBidderId)?.name ?? "Unknown";
      addLiveFeed(`${bidderName} bid ${formatAuctionCurrency(data.currentHighBid)} on ${data.playerName}`, "bid");
    });
    es.addEventListener("sold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const winnerName = data.winnerId ? teams.find((t) => t.id === data.winnerId)?.name ?? "Unknown" : "—";
      addLiveFeed(`SOLD: ${data.playerName} → ${winnerName} for ${formatAuctionCurrency(data.finalBid)}`, "sold");
      setLiveCurrentBid(null);
      fetchAuctionData();
      // Refresh the Corrections / Undo-Sale list so newly-sold lots (incl. club auctions) appear live.
      fetchSoldBidsRef.current?.();
    });
    es.addEventListener("unsold", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      addLiveFeed(`UNSOLD: ${data.playerName}`, "unsold");
      setLiveCurrentBid(null);
      fetchSoldBidsRef.current?.();
    });
    es.addEventListener("auto-nominated", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const tName = teams.find((t) => t.id === data.teamId)?.name ?? "Team";
      addLiveFeed(`${tName} auto-nominated from wishlist`, "info");
    });
    es.addEventListener("penalised", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const tName = teams.find((t) => t.id === data.teamId)?.name ?? "Team";
      addLiveFeed(`${tName} penalised — missed nomination`, "unsold");
    });
    es.addEventListener("session-status", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setAuctionActiveSession((prev) => prev ? { ...prev, status: data.status, currentNominatorIndex: data.currentNominatorIndex, snakeOrder: data.snakeOrder } : prev);
      setLiveNominationDeadline(data.nominationDeadline ?? null);
    });
    es.addEventListener("session-complete", () => {
      addLiveFeed("Auction session completed", "info");
      setLiveCurrentBid(null);
      fetchAuctionData();
      fetchSoldBidsRef.current?.();
    });
    es.addEventListener("waiting", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (liveCurrentBidRef.current !== null) setLiveCurrentBid(null);
      setLiveNominationDeadline(data.nominationDeadline ?? null);
      setLiveIntermissionUntil(null);
    });
    es.addEventListener("intermission", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (liveCurrentBidRef.current !== null) setLiveCurrentBid(null);
      setLiveIntermissionUntil(data.intermissionUntil ?? null);
    });
    es.addEventListener("auction-state", () => { setLiveIntermissionUntil(null); });

    return () => { es.close(); liveEsRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuctionFormat, auctionActiveSession?.id, auctionActiveSession?.status]);

  // Timer countdown for live monitor
  useEffect(() => {
    const interval = setInterval(() => {
      if (liveCurrentBid?.expiresAt) {
        const diff = Math.max(0, Math.ceil((new Date(liveCurrentBid.expiresAt).getTime() - Date.now()) / 1000));
        setLiveTimerSec(diff);
      } else {
        setLiveTimerSec(0);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [liveCurrentBid?.expiresAt]);

  // SSE heartbeat watchdog. If no event (heartbeat or otherwise) lands for > 25s while the session
  // is supposed to be active, the connection is presumed dead — force-reopen by bumping a tick
  // counter the SSE-setup effect depends on. Server emits a heartbeat every 15s so 25s is a safe
  // bound. Bumping the tick triggers cleanup + reconnect via the existing useEffect dependency.
  useEffect(() => {
    if (!isAuctionFormat || !auctionActiveSession || auctionActiveSession.status !== "active") return;
    const watchdog = setInterval(() => {
      if (Date.now() - lastHeartbeatRef.current > 25_000) {
        console.warn("[admin SSE] no heartbeat in 25s — reconnecting");
        if (liveEsRef.current) { liveEsRef.current.close(); liveEsRef.current = null; }
        reconnectTickRef.current += 1;
        lastHeartbeatRef.current = Date.now();
        // Trigger reconnect by re-running the SSE setup effect via a fetch (cheap, also re-syncs
        // the auctionActiveSession state if the session closed during the silent period).
        fetchAuctionData();
      }
    }, 5000);
    return () => clearInterval(watchdog);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuctionFormat, auctionActiveSession?.id, auctionActiveSession?.status]);

  // ---- Auction Corrections helpers ----

  const fetchSoldBids = useCallback(async () => {
    if (!auctionActiveSession) return;
    try {
      const res = await fetch(`/api/auction/bid-history?sessionId=${auctionActiveSession.id}`);
      if (res.ok) {
        const data = await res.json();
        setSoldBids((data.bids ?? []).filter((b: { status: string }) => b.status === "sold"));
      }
    } catch { /* ignore */ }
  }, [auctionActiveSession]);

  useEffect(() => { fetchSoldBidsRef.current = fetchSoldBids; }, [fetchSoldBids]);

  useEffect(() => {
    if (isAuctionFormat && auctionActiveSession) fetchSoldBids();
  }, [isAuctionFormat, auctionActiveSession, fetchSoldBids]);

  const handleUndoSale = async (bidId: string) => {
    if (!confirm("Are you sure you want to undo this sale? The player will become available for re-nomination.")) return;
    setUndoingBid(bidId);
    try {
      const res = await fetch(`/api/admin/${params.leagueId}/auction-corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "undo-sale", bidId }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        fetchAuctionData();
        fetchSoldBids();
      } else {
        setMessage({ type: "error", text: data.error });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setUndoingBid(null);
    }
  };

  const handleManualTransfer = async (ownershipId: string, toTeamId: string) => {
    if (!confirm("Are you sure you want to transfer this player?")) return;
    setTransferring(true);
    try {
      const res = await fetch(`/api/admin/${params.leagueId}/auction-corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "manual-transfer", ownershipId, toTeamId }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        setTransferOwnershipId(null);
        setTransferToTeamId("");
        fetchAuctionData();
      } else {
        setMessage({ type: "error", text: data.error });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setTransferring(false);
    }
  };

  const handleAuctionReset = async () => {
    setAuctionResetting(true);
    try {
      const res = await fetch(`/api/admin/${params.leagueId}/reset-auction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetTo: auctionResetTarget }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        setShowAuctionResetConfirm(false);
        fetchAuctionData();
        fetchSoldBids();
      } else {
        setMessage({ type: "error", text: data.error });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setAuctionResetting(false);
    }
  };

  const resetSeason = async () => {
    if (!resetPassword) {
      setMessage({ type: "error", text: "Please enter your admin password" });
      return;
    }
    setResetLoading(true);
    try {
      const res = await fetch(`/api/admin/${leagueId}/reset-season`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message });
        setShowResetConfirm(false);
        setResetPassword("");
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset season" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
    } finally {
      setResetLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/${leagueId}/create-team`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to create team" });
        return;
      }

      setMessage({ 
        type: "success", 
        text: "Team created successfully!", 
        credentials: data.credentials 
      });
      
      // Reset form
      setFormData({
        teamLoginId: "",
        teamName: "",
        password: "",
        player1Name: "",
        player1FplId: "",
        player2Name: "",
        player2FplId: "",
        group: "A",
      });
      
      // Refresh teams list
      fetchTeams();
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCaptainOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/${leagueId}/override-captain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(captainOverride),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to override captain" });
        return;
      }

      setMessage({ type: "success", text: data.message });
      setCaptainOverride({ teamId: "", playerId: "", gameweekNumber: "", reason: "" });
      fetchCaptainData();
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChipsOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/${leagueId}/override-chips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chipOverride),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to override chips" });
        return;
      }

      setMessage({ type: "success", text: data.message });
      setChipOverride({ teamId: "", chipType: "", status: "available", gameweek: "", reason: "" });
      fetchChipsData();
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const handleBulkUploadFixtures = async () => {
    if (fixturesData.length === 0) {
      setMessage({ type: "error", text: "Please upload an Excel file with fixtures data" });
      return;
    }
    setBulkUploading(true);
    setBulkUploadResult(null);
    setMessage(null);
    
    try {
      // Map Excel columns to expected format
      const fixtures = fixturesData.map(row => ({
        gameweek: row["Gameweek"] || row["gameweek"] || row["GW"] || "",
        homeTeam: row["Home Team"] || row["homeTeam"] || row["Home"] || "",
        awayTeam: row["Away Team"] || row["awayTeam"] || row["Away"] || "",
      }));

      const response = await fetch(`/api/admin/${leagueId}/bulk-upload-fixtures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixtures }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to upload fixtures" });
      } else {
        setBulkUploadResult(data);
        setMessage({ type: "success", text: `Fixtures uploaded: ${data.created} created, ${data.failed} failed` });
        setFixturesData([]);
        setFixturesFileName("");
      }
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setBulkUploading(false);
    }
  };

  const handleBulkUploadTeams = async () => {
    if (teamsData.length === 0) {
      setMessage({ type: "error", text: "Please upload an Excel file with teams data" });
      return;
    }
    const confirmed = window.confirm(
      `WARNING: This will permanently delete ALL existing teams in this league (and all their players, fixtures, results, chip plays, and captain assignments) and replace them with ${teamsData.length} team(s) from the uploaded file. This cannot be undone. Continue?`
    );
    if (!confirmed) return;

    setBulkUploading(true);
    setBulkUploadResult(null);
    setMessage(null);

    try {
      const rows = teamsData.map(row => ({
        teamLoginId: String(row["Team ID"] ?? row["teamLoginId"] ?? row["Team Login ID"] ?? row["TeamLoginId"] ?? "").trim(),
        teamName: String(row["Team Name"] ?? row["teamName"] ?? row["TeamName"] ?? "").trim(),
        password: String(row["Password"] ?? row["password"] ?? "").trim(),
        player1Name: String(row["Player1 Name"] ?? row["Player 1 Name"] ?? row["player1Name"] ?? row["Player1Name"] ?? "").trim(),
        player1FplId: String(row["Player1 FPL ID"] ?? row["Player 1 FPL ID"] ?? row["player1FplId"] ?? row["Player1FplId"] ?? "").trim(),
        player2Name: String(row["Player2 Name"] ?? row["Player 2 Name"] ?? row["player2Name"] ?? row["Player2Name"] ?? "").trim(),
        player2FplId: String(row["Player2 FPL ID"] ?? row["Player 2 FPL ID"] ?? row["player2FplId"] ?? row["Player2FplId"] ?? "").trim(),
        group: (() => {
          const raw = String(row["Group"] ?? row["group"] ?? "").trim().toUpperCase();
          return raw === "A" || raw === "B" ? raw : null;
        })(),
      }));

      const response = await fetch(`/api/admin/${leagueId}/bulk-upload-teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teams: rows }),
      });
      const data = await response.json();

      if (!response.ok) {
        const header = data.error || "Failed to upload teams";
        const detail = Array.isArray(data.details) && data.details.length > 0
          ? `\n\n${data.details.join("\n")}`
          : "";
        setMessage({ type: "error", text: `${header}${detail}` });
      } else {
        setMessage({ type: "success", text: data.message || `Uploaded ${data.created} teams` });
        setTeamsData([]);
        setTeamsFileName("");
        await fetchTeams();
      }
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setBulkUploading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: "fixtures" | "captains" | "chips" | "teams") => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.name.endsWith(".xlsx") && !file.name.endsWith(".xls")) {
      setMessage({ type: "error", text: "Please upload an Excel file (.xlsx or .xls)" });
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = event.target?.result;
        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        // Convert to JSON array with headers
        const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);
        
        if (type === "fixtures") {
          setFixturesData(jsonData);
          setFixturesFileName(file.name);
        } else if (type === "captains") {
          setCaptainsData(jsonData);
          setCaptainsFileName(file.name);
        } else if (type === "chips") {
          setChipsData(jsonData);
          setChipsFileName(file.name);
        } else if (type === "teams") {
          setTeamsData(jsonData);
          setTeamsFileName(file.name);
        }
      } catch {
        setMessage({ type: "error", text: "Failed to parse Excel file. Please check the format." });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleImportCaptains = async () => {
    if (captainsData.length === 0) {
      setMessage({ type: "error", text: "Please upload an Excel file with captain data" });
      return;
    }
    setBulkUploading(true);
    setBulkUploadResult(null);
    setMessage(null);
    
    try {
      // Map Excel columns to expected format
      const captains = captainsData.map(row => ({
        teamName: row["Team"] || row["team"] || row["Team Name"] || "",
        playerName: row["Players"] || row["Player"] || row["player"] || row["Player Name"] || "",
        ...row, // Include all GW columns as-is
      }));

      const response = await fetch(`/api/admin/${leagueId}/import-captains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captains }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to import captains" });
      } else {
        setBulkUploadResult(data);
        setMessage({ type: "success", text: `Captains imported: ${data.created} processed, ${data.failed} failed` });
        setCaptainsData([]);
        setCaptainsFileName("");
      }
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setBulkUploading(false);
    }
  };

  // Saved historical snapshots — auto-snapshots (per-GW + per-auction-session) + admin-triggered manual snapshots.
  // Parses the trigger string into a friendly label for the UI.
  function formatBackupTrigger(trigger: string): string {
    if (trigger === "gw1-lock") return "GW1 lock-in";
    if (trigger === "manual") return "Manual";
    const gw = /^gw(\d+)-auto$/.exec(trigger);
    if (gw) return `GW${gw[1]} (auto)`;
    if (trigger === "auction-initial-c0") return "Initial auction complete";
    if (trigger === "auction-club-c0") return "Club auction complete";
    const mini = /^auction-mini-c(\d+)$/.exec(trigger);
    if (mini) return `Mini-auction cycle ${mini[1]} complete`;
    return trigger;
  }

  type SavedBackup = {
    id: string;
    trigger: string;
    createdAt: string | number | Date;
    includes: {
      teams: boolean;
      fixtures: boolean;
      captains: boolean;
      chips: boolean;
      auctionTeamsState?: boolean;
      auctionSquads?: boolean;
      auctionClubs?: boolean;
      gameweeks?: boolean;
    };
  };
  const [savedBackups, setSavedBackups] = useState<SavedBackup[]>([]);
  const [downloadingSnapshotId, setDownloadingSnapshotId] = useState<string | null>(null);
  const [takingBackupNow, setTakingBackupNow] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restoreBackupId, setRestoreBackupId] = useState<string | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoringAuction, setRestoringAuction] = useState(false);

  // Fetch saved-backup list whenever the bulkUpload tab is active.
  useEffect(() => {
    if (activeTab !== "bulkUpload") return;
    let cancelled = false;
    fetch(`/api/admin/${leagueId}/backups`, { credentials: "include" })
      .then(r => r.ok ? r.json() : { backups: [] })
      .then((data: { backups?: SavedBackup[] }) => {
        if (!cancelled) setSavedBackups(data.backups ?? []);
      })
      .catch(() => { if (!cancelled) setSavedBackups([]); });
    return () => { cancelled = true; };
  }, [activeTab, leagueId]);

  const handleDownloadSnapshot = async (backupId: string) => {
    if (downloadingSnapshotId) return;
    setDownloadingSnapshotId(backupId);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/backups/${backupId}`, { credentials: "include" });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        const errMsg = ct.includes("application/json")
          ? (await res.json()).error ?? "Snapshot download failed"
          : `Snapshot download failed (HTTP ${res.status})`;
        setMessage({ type: "error", text: errMsg });
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") ?? "";
      const m = cd.match(/filename="?([^"]+)"?/);
      const filename = m?.[1] ?? `snapshot-${backupId}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMessage({ type: "error", text: `Network error: ${e instanceof Error ? e.message : "unknown"}` });
    } finally {
      setDownloadingSnapshotId(null);
    }
  };

  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const handleDownloadBackup = async () => {
    if (downloadingBackup) return;
    setDownloadingBackup(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/backup`, { credentials: "include" });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        const errMsg = ct.includes("application/json")
          ? (await res.json()).error ?? "Backup failed"
          : `Backup failed (HTTP ${res.status})`;
        setMessage({ type: "error", text: errMsg });
        return;
      }
      const blob = await res.blob();
      // Pull filename from Content-Disposition; fall back to a sensible default
      const cd = res.headers.get("content-disposition") ?? "";
      const m = cd.match(/filename="?([^"]+)"?/);
      const filename = m?.[1] ?? `backup-${leagueId}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setMessage({ type: "success", text: `Downloaded ${filename}` });
    } catch (e) {
      setMessage({ type: "error", text: `Network error: ${e instanceof Error ? e.message : "unknown"}` });
    } finally {
      setDownloadingBackup(false);
    }
  };

  // POST /api/admin/[leagueId]/backups — persist a manual snapshot. Distinct from the .zip download
  // above (that's stateless); this writes a row to `backups` so it survives league resets and can be
  // used by the restore endpoint later.
  const handleTakeBackupNow = async () => {
    if (takingBackupNow) return;
    setTakingBackupNow(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/${leagueId}/backups`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data?.error ?? "Backup failed" });
        return;
      }
      // Refresh the saved-snapshots list so the new row appears in-place.
      try {
        const list = await fetch(`/api/admin/${leagueId}/backups`, { credentials: "include" });
        if (list.ok) {
          const j = await list.json();
          setSavedBackups(j.backups ?? []);
        }
      } catch { /* non-fatal */ }
      const c = data.counts ?? {};
      setMessage({
        type: "success",
        text: `Backup taken: ${c.fixtures ?? 0} fixtures, ${c.auctionSquads ?? c.teams ?? 0} ${c.auctionSquads ? "squads" : "teams"}, ${c.auctionClubs ?? 0} clubs.`,
      });
    } catch (e) {
      setMessage({ type: "error", text: `Network error: ${e instanceof Error ? e.message : "unknown"}` });
    } finally {
      setTakingBackupNow(false);
    }
  };

  // POST /api/admin/[leagueId]/restore-{format} — accepts either a backup ID (from saved snapshots)
  // or a multipart file upload of the original .zip. Dispatch by league format:
  //   - auction: wipes auction state + rebuilds ownership/clubs; admin reprocesses GWs.
  //   - tvt: preserves teams, wipes+restores fixtures (captains/chips deferred).
  //   - triple-crown: same as tvt; cup-fixtures/UEFA not in backup yet.
  // Cross-league + format guards enforced server-side (meta.json + leagueId match).
  const handleRestoreAuction = async () => {
    if (restoringAuction) return;
    if (!restoreBackupId && !restoreFile) {
      setMessage({ type: "error", text: "Choose a saved snapshot or upload a .zip file." });
      return;
    }
    const format = leagueConfig?.format ?? "";
    const endpoint =
      format === "auction" ? "restore-auction"
      : format === "tvt" ? "restore-tvt"
      : format === "triple-crown" ? "restore-triple-crown"
      : null;
    if (!endpoint) {
      setMessage({ type: "error", text: `Restore is not supported for ${format || "this"} league format.` });
      return;
    }
    const confirmMsg = format === "auction"
      ? "This will wipe the league's current auction state (sessions, bids, ownership, clubs, trades, scores) and rebuild from the backup. Reprocess each GW after restore to regenerate scores. Continue?"
      : "This will wipe and re-import fixtures from the backup. Teams + accounts are preserved. Captains/Chips restore is a follow-up — use the Import blocks if those need to be applied. Continue?";
    if (!confirm(confirmMsg)) return;
    setRestoringAuction(true);
    setMessage(null);
    try {
      let res: Response;
      if (restoreFile) {
        const form = new FormData();
        form.append("file", restoreFile);
        res = await fetch(`/api/admin/${leagueId}/${endpoint}`, {
          method: "POST",
          credentials: "include",
          body: form,
        });
      } else {
        res = await fetch(`/api/admin/${leagueId}/${endpoint}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backupId: restoreBackupId }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data?.error ?? "Restore failed" });
        return;
      }
      // Auction response: { restored: { squads, clubs, teamsState } }
      // TVT/TC response: { fixturesInserted, warnings, message }
      const successText = format === "auction"
        ? `Restored: ${(data.restored?.squads ?? 0)} squad rows · ${(data.restored?.clubs ?? 0)} clubs · ${(data.restored?.teamsState ?? 0)} team-state rows. Reprocess each GW from the Scoring tab to regenerate scores.`
        : data.message ?? `Restored ${data.fixturesInserted ?? 0} fixture(s).`;
      setMessage({ type: "success", text: successText });
      setShowRestoreModal(false);
      setRestoreBackupId(null);
      setRestoreFile(null);
    } catch (e) {
      setMessage({ type: "error", text: `Network error: ${e instanceof Error ? e.message : "unknown"}` });
    } finally {
      setRestoringAuction(false);
    }
  };

  const handleImportChips = async () => {
    if (chipsData.length === 0) {
      setMessage({ type: "error", text: "Please upload an Excel file with TVT chips data" });
      return;
    }
    setBulkUploading(true);
    setBulkUploadResult(null);
    setMessage(null);
    
    try {
      // Map Excel columns to expected format - pass entire row
      const chips = chipsData.map(row => ({
        teamName: row["Team Name"] || row["Team"] || row["team"] || row["team name"] || "",
        ...row, // Include all GW columns as-is (1, 2, 3... with W/D/C markers)
      }));

      const response = await fetch(`/api/admin/${leagueId}/import-chips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chips }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to import chips" });
      } else {
        setBulkUploadResult(data);
        setMessage({ type: "success", text: data.message || `Chips imported: ${data.created || 0} processed, ${data.failed || 0} failed` });
        setChipsData([]);
        setChipsFileName("");
      }
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setBulkUploading(false);
    }
  };

  const openEditModal = (team: Team) => {
    setEditingTeam(team);
    setEditFormData({
      teamId: team.id,
      teamLoginId: team.teamLoginId || "",
      teamName: team.name,
      password: "",
      player1Id: team.players[0]?.id || "",
      player1Name: team.players[0]?.name || "",
      player1FplId: team.players[0]?.fplId || "",
      player2Id: team.players[1]?.id || "",
      player2Name: team.players[1]?.name || "",
      player2FplId: team.players[1]?.fplId || "",
      group: team.group,
    });
    setMessage(null);
  };

  const handleEditTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    try {
      // Only send `group` when the Group field is actually editable in the modal
      // (groupCount === 2 → Group A/B selector renders). For TVT-32 / Triple Crown
      // the field is hidden and the team's existing group must not be overwritten
      // with the modal's unchanged value (which can be "Cup-A", "C", etc. and
      // would fail the server's A/B validator).
      const payload: Record<string, unknown> = { ...editFormData };
      if (leagueConfig.groupCount !== 2) {
        delete payload.group;
      }
      const response = await fetch(`/api/admin/${leagueId}/update-team`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to update team" });
        return;
      }

      setMessage({ type: "success", text: "Team updated successfully!" });
      setEditingTeam(null);
      fetchTeams();
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteTeam = async () => {
    if (!deletingTeam) return;
    setIsDeleting(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/${leagueId}/delete-team`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId: deletingTeam.id }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to delete team" });
        return;
      }

      setMessage({ type: "success", text: data.message });
      setDeletingTeam(null);
      fetchTeams();
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkDeleteTeams = async () => {
    if (selectedTeamIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedTeamIds.size} team(s)? This cannot be undone and will delete all players, fixtures, results, and captain data.`)) return;

    setIsBulkDeleting(true);
    setMessage(null);

    let deletedCount = 0;
    let failedCount = 0;

    for (const teamId of Array.from(selectedTeamIds)) {
      try {
        const response = await fetch(`/api/admin/${leagueId}/delete-team`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId }),
        });

        if (response.ok) {
          deletedCount++;
        } else {
          failedCount++;
        }
      } catch {
        failedCount++;
      }
    }

    setSelectedTeamIds(new Set());
    setMessage({
      type: failedCount === 0 ? "success" : "error",
      text: `Deleted ${deletedCount} team(s)${failedCount > 0 ? `, ${failedCount} failed` : ""}`,
    });
    setIsBulkDeleting(false);
    fetchTeams();
  };

  const toggleTeamSelection = (teamId: string) => {
    setSelectedTeamIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(teamId)) {
        newSet.delete(teamId);
      } else {
        newSet.add(teamId);
      }
      return newSet;
    });
  };

  const groupATeams = leagueConfig.groupCount === 2 ? teams.filter(t => t.group === "A") : teams;
  const groupBTeams = teams.filter(t => t.group === "B");
  const teamsPerGroup = Math.round(leagueConfig.teamSize / leagueConfig.groupCount);
  const setupCompleteCount = teams.filter(t => t.isProfileComplete).length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Delete Team Confirmation Modal */}
      {deletingTeam && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-md">
            <div className="text-center">
              <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <span className="text-2xl">⚠️</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-2">{isAuctionFormat ? "Remove Manager" : "Delete Team"}</h2>
              <p className="text-gray-400 mb-6">
                Are you sure you want to {isAuctionFormat ? "remove" : "delete"} <span className="text-white font-semibold">{deletingTeam.name}</span>?
                {isAuctionFormat
                  ? "This will remove the manager and all their auction ownership data."
                  : "This will also delete all players, fixtures, results, and captain data associated with this team."}
              </p>
              <p className="text-red-400 text-sm mb-6">This action cannot be undone.</p>
              
              <div className="flex gap-4">
                <button
                  onClick={() => setDeletingTeam(null)}
                  disabled={isDeleting}
                  className="flex-1 rounded-lg border border-white/10 px-6 py-3 font-semibold text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteTeam}
                  disabled={isDeleting}
                  className="flex-1 rounded-lg bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-700 transition disabled:opacity-50"
                >
                  {isDeleting ? "Deleting..." : isAuctionFormat ? "Remove Manager" : "Delete Team"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Team Modal */}
      {editingTeam && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">{isAuctionFormat ? "Edit Manager" : "Edit Team"}</h2>
              <button
                onClick={() => setEditingTeam(null)}
                className="text-gray-400 hover:text-white text-2xl"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleEditTeam} className="space-y-6">
              {/* Team Details */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">{isAuctionFormat ? "Login ID" : "Team Login ID"}</label>
                  <input
                    type="text"
                    disabled
                    value={editFormData.teamLoginId}
                    className="w-full rounded-lg border border-white/20 bg-white/5 px-4 py-3 text-gray-400 placeholder-gray-600 cursor-not-allowed opacity-60"
                  />
                  <p className="text-gray-500 text-xs mt-1">{isAuctionFormat ? "Used for login (cannot be changed)" : "Used for team login (cannot be changed)"}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">{isAuctionFormat ? "Manager Name" : "Team Name"}</label>
                  <input
                    type="text"
                    required
                    value={editFormData.teamName}
                    onChange={(e) => setEditFormData({ ...editFormData, teamName: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                  <p className="text-gray-500 text-xs mt-1">{isAuctionFormat ? "Manager display name. Unique within this league." : "Display name. Unique within this league."}</p>
                </div>
              </div>

              {/* Password and Group */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">New Password (leave blank to keep current)</label>
                  <input
                    type="text"
                    value={editFormData.password}
                    onChange={(e) => setEditFormData({ ...editFormData, password: e.target.value })}
                    placeholder="Enter new password"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
                {leagueConfig.groupCount === 2 && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Group</label>
                  <select
                    value={editFormData.group}
                    onChange={(e) => setEditFormData({ ...editFormData, group: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:border-yellow-500 focus:outline-none"
                  >
                    <option value="A" className="bg-slate-800">Group A</option>
                    <option value="B" className="bg-slate-800">Group B</option>
                  </select>
                </div>
                )}
              </div>

              {/* Player 1 — hidden for auction format */}
              {!isAuctionFormat && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 1 Name</label>
                  <input
                    type="text"
                    required
                    value={editFormData.player1Name}
                    onChange={(e) => setEditFormData({ ...editFormData, player1Name: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 1 FPL ID</label>
                  <input
                    type="text"
                    required
                    value={editFormData.player1FplId}
                    onChange={(e) => setEditFormData({ ...editFormData, player1FplId: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
              </div>
              )}

              {/* Player 2 — hidden for auction format */}
              {!isAuctionFormat && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 2 Name</label>
                  <input
                    type="text"
                    required
                    value={editFormData.player2Name}
                    onChange={(e) => setEditFormData({ ...editFormData, player2Name: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 2 FPL ID</label>
                  <input
                    type="text"
                    required
                    value={editFormData.player2FplId}
                    onChange={(e) => setEditFormData({ ...editFormData, player2FplId: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
              </div>
              )}

              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setEditingTeam(null)}
                  className="flex-1 rounded-lg border border-white/10 px-6 py-3 font-semibold text-gray-300 hover:bg-white/5 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
                >
                  {isSubmitting ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/admin" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            TVT
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">Admin Dashboard</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          {isSuperadminViewer && (
            <Link href="/superadmin" className="text-orange-400 font-semibold transition">
              ← Platform Admin
            </Link>
          )}
          <Link href="/admin" className="text-yellow-400 font-semibold transition">
            ← Leagues
          </Link>
          {leagueConfig.format === "triple-crown" ? (
            <>
              <Link href={`/${leagueId}/standings`} className="text-gray-300 hover:text-white transition">
                PL Standings
              </Link>
              <Link href={`/${leagueId}/fixtures`} className="text-gray-300 hover:text-white transition">
                PL Fixtures
              </Link>
              <Link href={`/${leagueId}/uefa-standings`} className="text-gray-300 hover:text-white transition">
                UEFA Standings
              </Link>
              <Link href={`/${leagueId}/uefa-fixtures`} className="text-gray-300 hover:text-white transition">
                UEFA Fixtures
              </Link>
              <Link href={`/${leagueId}/playoffs`} className="text-gray-300 hover:text-white transition">
                Playoffs
              </Link>
            </>
          ) : isAuctionFormat ? (
            <>
              <Link href={`/${leagueId}/standings`} className="text-gray-300 hover:text-white transition">
                Standings
              </Link>
            </>
          ) : (
            <>
              <Link href={`/${leagueId}/standings`} className="text-gray-300 hover:text-white transition">
                Standings
              </Link>
              <Link href={`/${leagueId}/fixtures`} className="text-gray-300 hover:text-white transition">
                Fixtures
              </Link>
              <Link href={`/${leagueId}/playoffs`} className="text-gray-300 hover:text-white transition">
                Playoffs
              </Link>
            </>
          )}
          <Link href={`/admin/${leagueId}/help`} className="text-gray-300 hover:text-white transition">
            Help
          </Link>
          <button
            onClick={handleSignOut}
            className="text-gray-300 hover:text-white transition"
          >
            Sign Out
          </button>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
        {/* Tabs */}
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-8 border-b border-white/10 pb-4">
          <div className="flex gap-2 sm:gap-4 min-w-max">
          <button
            onClick={() => { setActiveTab("teams"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "teams"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            {isAuctionFormat ? "Manager Management" : "Team Management"}
          </button>
          {leagueConfig.format === "tvt" && leagueConfig.groupCount >= 2 && (
          <button
            onClick={() => { setActiveTab("groups"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "groups"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Groups
          </button>
          )}
          {!isAuctionFormat && (
          <button
            onClick={() => { setActiveTab("captain"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "captain"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Captain Override
          </button>
          )}
          <button
            onClick={() => { setActiveTab("bulkUpload"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "bulkUpload"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Backup
          </button>
          <button
            onClick={() => { setActiveTab("scoring"); setMessage(null); setScoringResults([]); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "scoring"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Scoring
          </button>
          {isAuctionFormat && (
          <button
            onClick={() => { setActiveTab("auction"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "auction"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Auction
          </button>
          )}
          {isAuctionFormat && (
          <button
            onClick={() => { setActiveTab("marketplace"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "marketplace"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Marketplace
          </button>
          )}
          {isAuctionFormat && (
          <button
            onClick={() => { setActiveTab("finance"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "finance"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Finance
          </button>
          )}
          {!isAuctionFormat && (
          <button
            onClick={() => { setActiveTab("playoffs"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "playoffs"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Playoffs
          </button>
          )}
          <button
            onClick={() => { setActiveTab("settings"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "settings"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Settings
          </button>
          <button
            onClick={() => { setActiveTab("feedback"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "feedback"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Feedback
          </button>
          </div>
        </div>

        {/* Global Message */}
        {message && (
          <div
            className={`mb-6 rounded-lg p-4 ${
              message.type === "success"
                ? "bg-green-500/10 border border-green-500/30 text-green-400"
                : "bg-red-500/10 border border-red-500/30 text-red-400"
            }`}
          >
            <p>{message.text}</p>
            {message.credentials && (
              <div className="mt-4 p-4 bg-slate-800 rounded-lg">
                <p className="font-semibold text-yellow-400 mb-2">📋 Share these credentials with the team:</p>
                <p className="font-mono text-white">Login ID: {message.credentials.loginId}</p>
                <p className="font-mono text-white">Password: {message.credentials.password}</p>
                <p className="text-sm text-gray-400 mt-2">Team members must change password on first login.</p>
              </div>
            )}
          </div>
        )}

        {/* Team Management Tab */}
        {activeTab === "teams" && (
          <>
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold text-white">{isAuctionFormat ? "Manager Management" : "Team Management"}</h1>
                <p className="text-gray-400 mt-1">{isAuctionFormat ? "Create and manage managers in the league" : "Create and manage teams in the league"}</p>
              </div>
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
              >
                {showCreateForm ? "Cancel" : isAuctionFormat ? "+ Add Manager" : "+ Create Team"}
              </button>
            </div>

            {/* Create Team Form */}
            {showCreateForm && (
              <div className="mb-8 rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                <h2 className="text-xl font-bold text-white mb-6">{isAuctionFormat ? "Add New Manager" : "Create New Team"}</h2>

                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Team Details */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">{isAuctionFormat ? "Login ID" : "Team Login ID"}</label>
                      <input
                        type="text"
                        required
                        value={formData.teamLoginId}
                        onChange={(e) => setFormData({ ...formData, teamLoginId: e.target.value })}
                        placeholder={isAuctionFormat ? "rahul-mgr" : "team-123"}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                      />
                      <p className="text-xs text-gray-500 mt-1">Used for login. 3–20 alphanumeric/underscore/hyphen.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">{isAuctionFormat ? "Manager Name" : "Team Name"}</label>
                      <input
                        type="text"
                        required
                        value={formData.teamName}
                        onChange={(e) => setFormData({ ...formData, teamName: e.target.value })}
                        placeholder={isAuctionFormat ? "Rahul" : "DM — Rahul"}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                      />
                      <p className="text-xs text-gray-500 mt-1">{isAuctionFormat ? "Manager display name. Unique within this league." : "Display name. Unique within this league."}</p>
                    </div>
                  </div>

              {/* Password and Group */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Initial Password</label>
                  <input
                    type="text"
                    required
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="Enter initial password"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">Team must change this on first login</p>
                </div>
                {leagueConfig.groupCount === 2 && (
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Group</label>
                  <select
                    value={formData.group}
                    onChange={(e) => setFormData({ ...formData, group: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:border-yellow-500 focus:outline-none"
                  >
                    <option value="A" className="bg-slate-800">Group A ({groupATeams.length}/{teamsPerGroup})</option>
                    <option value="B" className="bg-slate-800">Group B ({groupBTeams.length}/{teamsPerGroup})</option>
                  </select>
                </div>
                )}
              </div>

              {/* Player 1 — hidden for auction format (players acquired via auction) */}
              {!isAuctionFormat && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 1 Name</label>
                  <input
                    type="text"
                    required
                    value={formData.player1Name}
                    onChange={(e) => setFormData({ ...formData, player1Name: e.target.value })}
                    placeholder="Player name"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 1 FPL ID</label>
                  <input
                    type="text"
                    required
                    value={formData.player1FplId}
                    onChange={(e) => setFormData({ ...formData, player1FplId: e.target.value })}
                    placeholder="1234567"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
              </div>
              )}

              {/* Player 2 — hidden for auction format */}
              {!isAuctionFormat && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 2 Name</label>
                  <input
                    type="text"
                    required
                    value={formData.player2Name}
                    onChange={(e) => setFormData({ ...formData, player2Name: e.target.value })}
                    placeholder="Player name"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Player 2 FPL ID</label>
                  <input
                    type="text"
                    required
                    value={formData.player2FplId}
                    onChange={(e) => setFormData({ ...formData, player2FplId: e.target.value })}
                    placeholder="7654321"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
              </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
              >
                {isSubmitting ? "Creating..." : isAuctionFormat ? "Add Manager" : "Create Team"}
              </button>
            </form>
          </div>
        )}

        {/* Stats */}
        <div className={`grid grid-cols-2 ${leagueConfig.groupCount === 2 ? "md:grid-cols-4" : "md:grid-cols-3"} gap-4 mb-8`}>
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
            <div className="text-2xl sm:text-3xl font-bold text-yellow-400">{teams.length}</div>
            <div className="text-sm text-gray-400">{isAuctionFormat ? "Total Managers" : "Total Teams"}</div>
          </div>
          {leagueConfig.groupCount === 2 ? (
            <>
              <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
                <div className="text-2xl sm:text-3xl font-bold text-blue-400">{groupATeams.length}/{teamsPerGroup}</div>
                <div className="text-sm text-gray-400">Group A</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
                <div className="text-2xl sm:text-3xl font-bold text-purple-400">{groupBTeams.length}/{teamsPerGroup}</div>
                <div className="text-sm text-gray-400">Group B</div>
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
              <div className="text-2xl sm:text-3xl font-bold text-blue-400">{setupCompleteCount}/{teams.length}</div>
              <div className="text-sm text-gray-400">Setup Complete</div>
            </div>
          )}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
            <div className="text-2xl sm:text-3xl font-bold text-green-400">{leagueConfig.groupCount === 2 ? setupCompleteCount : leagueConfig.teamSize - teams.length}</div>
            <div className="text-sm text-gray-400">{leagueConfig.groupCount === 2 ? "Setup Complete" : "Spots Left"}</div>
          </div>
        </div>

        {/* Teams List */}
        {isLoading ? (
          <LoadingScreen variant="admin" fullScreen={false} />
        ) : (
          <>
            {/* Bulk Delete Toolbar */}
            {selectedTeamIds.size > 0 && (
              <div className="mb-6 rounded-lg border border-red-500/50 bg-red-500/10 p-4 flex items-center justify-between">
                <div className="text-sm text-red-300">
                  {selectedTeamIds.size} team(s) selected
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedTeamIds(new Set())}
                    className="px-4 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition text-sm"
                  >
                    Clear Selection
                  </button>
                  <button
                    onClick={handleBulkDeleteTeams}
                    disabled={isBulkDeleting}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50 text-sm font-semibold"
                  >
                    {isBulkDeleting ? "Deleting..." : `Delete ${selectedTeamIds.size}`}
                  </button>
                </div>
              </div>
            )}

            <div className={`grid ${leagueConfig.groupCount === 2 ? "md:grid-cols-2" : "md:grid-cols-1"} gap-8`}>
              {/* Group A */}
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-bold text-blue-400">{isAuctionFormat ? "Managers" : leagueConfig.groupCount === 2 ? "Group A" : "League"} ({groupATeams.length}/{leagueConfig.groupCount === 2 ? teamsPerGroup : leagueConfig.teamSize})</h3>
                  {groupATeams.length > 0 && (
                    <button
                      onClick={() => {
                        const allSelected = groupATeams.every(t => selectedTeamIds.has(t.id));
                        setSelectedTeamIds(prev => {
                          const newSet = new Set(prev);
                          groupATeams.forEach(t => {
                            if (allSelected) newSet.delete(t.id);
                            else newSet.add(t.id);
                          });
                          return newSet;
                        });
                      }}
                      className="text-xs px-3 py-1 rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition"
                    >
                      {groupATeams.every(t => selectedTeamIds.has(t.id)) ? "Deselect All" : "Select All"}
                    </button>
                  )}
                </div>
                {groupATeams.length === 0 ? (
                  <p className="text-gray-500">No teams yet</p>
                ) : (
                  <div className="space-y-3">
                    {groupATeams.map((team, index) => (
                      <div key={team.id} className={`flex items-center justify-between p-3 rounded-lg transition ${
                        selectedTeamIds.has(team.id) ? "bg-red-500/20 border border-red-500/50" : "bg-white/5"
                      }`}>
                        <div className="flex items-center gap-3 flex-1">
                          <button
                            onClick={() => toggleTeamSelection(team.id)}
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition ${
                              selectedTeamIds.has(team.id)
                                ? "bg-red-500 border-red-500"
                                : "border-gray-500 hover:border-red-500"
                            }`}
                          >
                            {selectedTeamIds.has(team.id) && (
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                          <span className="text-gray-500 w-6">{index + 1}.</span>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold text-white">{team.name}</div>
                              {team.teamLoginId && (
                                <span className="text-xs bg-purple-500/30 text-purple-300 px-2 py-0.5 rounded">
                                  ID: {team.teamLoginId}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-400">
                              {team.isProfileComplete
                                ? isAuctionFormat
                                  ? "Squad via auction"
                                  : team.players.map(p => p.name).join(" & ")
                                : isAuctionFormat ? "Setup Pending" : "Profile Setup Pending"}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-2">
                          <button
                            onClick={() => openEditModal(team)}
                            className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setDeletingTeam(team)}
                            className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                          >
                            Delete
                          </button>
                          <span className={`text-xs px-2 py-1 rounded ${
                            team.needsPasswordChange && !team.isProfileComplete
                              ? "bg-orange-500/20 text-orange-400"
                              : !team.isProfileComplete
                              ? "bg-yellow-500/20 text-yellow-400"
                              : "bg-green-500/20 text-green-400"
                          }`}>
                            {team.needsPasswordChange && !team.isProfileComplete
                              ? "Awaiting Login"
                              : !team.isProfileComplete
                              ? "Setup Pending"
                              : "Active"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Group B — only shown for 2-group leagues */}
              {leagueConfig.groupCount === 2 && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-bold text-purple-400">Group B ({groupBTeams.length}/{teamsPerGroup})</h3>
                  {groupBTeams.length > 0 && (
                    <button
                      onClick={() => {
                        const allSelected = groupBTeams.every(t => selectedTeamIds.has(t.id));
                        setSelectedTeamIds(prev => {
                          const newSet = new Set(prev);
                          groupBTeams.forEach(t => {
                            if (allSelected) newSet.delete(t.id);
                            else newSet.add(t.id);
                          });
                          return newSet;
                        });
                      }}
                      className="text-xs px-3 py-1 rounded bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition"
                    >
                      {groupBTeams.every(t => selectedTeamIds.has(t.id)) ? "Deselect All" : "Select All"}
                    </button>
                  )}
                </div>
                {groupBTeams.length === 0 ? (
                  <p className="text-gray-500">No teams yet</p>
                ) : (
                  <div className="space-y-3">
                    {groupBTeams.map((team, index) => (
                      <div key={team.id} className={`flex items-center justify-between p-3 rounded-lg transition ${
                        selectedTeamIds.has(team.id) ? "bg-red-500/20 border border-red-500/50" : "bg-white/5"
                      }`}>
                        <div className="flex items-center gap-3 flex-1">
                          <button
                            onClick={() => toggleTeamSelection(team.id)}
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition ${
                              selectedTeamIds.has(team.id)
                                ? "bg-red-500 border-red-500"
                                : "border-gray-500 hover:border-red-500"
                            }`}
                          >
                            {selectedTeamIds.has(team.id) && (
                              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                          <span className="text-gray-500 w-6">{index + 1}.</span>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold text-white">{team.name}</div>
                              {team.teamLoginId && (
                                <span className="text-xs bg-purple-500/30 text-purple-300 px-2 py-0.5 rounded">
                                  ID: {team.teamLoginId}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-400">
                              {team.isProfileComplete
                                ? isAuctionFormat
                                  ? "Squad via auction"
                                  : team.players.map(p => p.name).join(" & ")
                                : isAuctionFormat ? "Setup Pending" : "Profile Setup Pending"}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-2">
                          <button
                            onClick={() => openEditModal(team)}
                            className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setDeletingTeam(team)}
                            className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                          >
                            Delete
                          </button>
                          <span className={`text-xs px-2 py-1 rounded ${
                            team.needsPasswordChange && !team.isProfileComplete
                              ? "bg-orange-500/20 text-orange-400"
                              : !team.isProfileComplete
                              ? "bg-yellow-500/20 text-yellow-400"
                              : "bg-green-500/20 text-green-400"
                          }`}>
                            {team.needsPasswordChange && !team.isProfileComplete
                              ? "Awaiting Login"
                              : !team.isProfileComplete
                              ? "Setup Pending"
                              : "Active"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}
            </div>
          </>
        )}

        {/* Quick Actions — not shown for auction format (no fixtures) */}
        {!isAuctionFormat && (
        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <h3 className="text-lg font-bold text-white mb-4">Quick Actions</h3>
          <div className="flex flex-wrap gap-4">
            <Link
              href={`/api/admin/${leagueId}/generate-fixtures`}
              className="px-4 py-2 rounded-lg bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition"
            >
              Check Fixture Status
            </Link>
            <button
              onClick={async () => {
                const res = await fetch(`/api/admin/${leagueId}/generate-fixtures`, { method: "POST" });
                const data = await res.json();
                alert(data.message || data.error);
              }}
              className="px-4 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition"
            >
              Generate Fixtures
            </button>
            <button
              onClick={async () => {
                if (!window.confirm("Delete all league-stage fixtures and gameweeks? You can then regenerate them. Playoff fixtures will be preserved.")) return;
                const res = await fetch(`/api/admin/${leagueId}/generate-fixtures`, { method: "DELETE" });
                const data = await res.json();
                alert(data.message || data.error);
              }}
              className="px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition"
            >
              Delete Fixtures
            </button>
          </div>
        </div>
        )}
          </>
        )}

        {/* Groups Tab — TVT multi-group leagues only */}
        {activeTab === "groups" && leagueConfig.format === "tvt" && leagueConfig.groupCount >= 2 && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
            <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
              <div>
                <h3 className="text-lg font-bold text-white">Group Assignments</h3>
                <p className="text-gray-400 text-sm">Assign each team to a group. Teams won&apos;t see their group until you reveal groups below.</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => {
                    const teamIds = teams.map(t => t.id);
                    const shuffled = [...teamIds];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                      const j = Math.floor(Math.random() * (i + 1));
                      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                    const groupNames = leagueConfig.groupCount === 2 ? ["A", "B"] : ["A"];
                    const perGroup = Math.ceil(shuffled.length / groupNames.length);
                    const next: Record<string, string> = {};
                    shuffled.forEach((tid, idx) => {
                      const gIdx = Math.min(Math.floor(idx / perGroup), groupNames.length - 1);
                      next[tid] = groupNames[gIdx];
                    });
                    setGroupAssignments(next);
                  }}
                  disabled={groupsRevealed || savingGroups}
                  className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition"
                  title={groupsRevealed ? "Groups are revealed — toggle off to edit" : "Randomize allocation"}
                >
                  Re-shuffle
                </button>
                <button
                  onClick={saveGroupAssignments}
                  disabled={savingGroups || groupsRevealed}
                  className="px-5 py-2 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-bold hover:from-yellow-300 hover:to-orange-400 disabled:opacity-50 disabled:cursor-not-allowed transition text-sm"
                >
                  {savingGroups ? "Saving..." : "Save Groups"}
                </button>
              </div>
            </div>

            <div className="mb-6 flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10">
              <div>
                <div className="font-semibold text-white">Reveal Groups to Teams</div>
                <div className="text-sm text-gray-400">When enabled, teams can see their group assignment and group standings. Edits and re-shuffle are locked while revealed.</div>
              </div>
              <button
                onClick={() => toggleSetting("groupsRevealed", !groupsRevealed)}
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                  groupsRevealed ? "bg-green-500" : "bg-gray-600"
                }`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  groupsRevealed ? "translate-x-6" : "translate-x-1"
                }`} />
              </button>
            </div>

            {groupsRevealed && (
              <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
                Groups are revealed to teams. Toggle off above to edit assignments or re-shuffle.
              </div>
            )}

            {teams.length === 0 ? (
              <div className="text-gray-400 italic text-sm">No teams yet.</div>
            ) : (() => {
              const target = Math.ceil(teams.length / 2);
              const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
              const sorted = [...teams].sort((a, b) => collator.compare(a.name, b.name));
              const inGroup = (g: "A" | "B") => sorted.filter(t => (groupAssignments[t.id] || "A") === g);
              const groupA = inGroup("A");
              const groupB = inGroup("B");
              const flip = (teamId: string) => {
                if (groupsRevealed) return;
                setGroupAssignments(prev => ({ ...prev, [teamId]: (prev[teamId] || "A") === "A" ? "B" : "A" }));
              };
              const Column = ({ label, accent, members, moveLabel }: {
                label: "A" | "B"; accent: { border: string; text: string; chipHover: string }; members: typeof sorted; moveLabel: string;
              }) => {
                const over = members.length > target;
                return (
                  <div className={`rounded-xl border ${accent.border} bg-white/5 p-4`}>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className={`font-bold ${accent.text}`}>Group {label}</h4>
                      <span className={`text-sm font-mono ${over ? "text-red-400" : "text-gray-300"}`} title={over ? "Over the balanced size" : ""}>
                        {members.length} / {target}
                      </span>
                    </div>
                    {members.length === 0 ? (
                      <div className="text-gray-500 italic text-sm py-6 text-center">No teams assigned</div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {members.map(team => (
                          <button
                            key={team.id}
                            onClick={() => flip(team.id)}
                            disabled={groupsRevealed}
                            title={groupsRevealed ? "Groups are revealed — toggle off to edit" : `Move to Group ${moveLabel}`}
                            className={`group flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-left text-sm text-white transition ${groupsRevealed ? "opacity-60 cursor-not-allowed" : `${accent.chipHover} cursor-pointer`}`}
                          >
                            <span className="font-medium truncate">{team.name}</span>
                            <span className={`ml-2 text-xs text-gray-400 ${groupsRevealed ? "" : "group-hover:text-white"}`}>
                              → {moveLabel}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              };
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Column
                    label="A"
                    accent={{ border: "border-blue-500/40", text: "text-blue-400", chipHover: "hover:bg-blue-500/10 hover:border-blue-500/40" }}
                    members={groupA}
                    moveLabel="B"
                  />
                  <Column
                    label="B"
                    accent={{ border: "border-purple-500/40", text: "text-purple-400", chipHover: "hover:bg-purple-500/10 hover:border-purple-500/40" }}
                    members={groupB}
                    moveLabel="A"
                  />
                </div>
              );
            })()}
          </div>
        )}

        {/* Captain Override Tab */}
        {activeTab === "captain" && (
          <>
            <div className="mb-8">
              <h1 className="text-2xl sm:text-3xl font-bold text-white">Captain Override</h1>
              <p className="text-gray-400 mt-1">Override captain picks for teams in case of technical issues</p>
            </div>

            {captainLoading ? (
              <div className="text-center text-gray-400 py-12">Loading captain data...</div>
            ) : (
              <>
                {/* Override Form */}
                <div className="mb-8 rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                  <h2 className="text-xl font-bold text-white mb-6">Set/Change Captain</h2>

                  <form onSubmit={handleCaptainOverride} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Select Team</label>
                        <select
                          required
                          value={captainOverride.teamId}
                          onChange={(e) => {
                            setCaptainOverride({ ...captainOverride, teamId: e.target.value, playerId: "" });
                          }}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:border-yellow-500 focus:outline-none"
                        >
                          <option value="" className="bg-slate-800">Select a team...</option>
                          {captainTeams.map((team) => (
                            <option key={team.id} value={team.id} className="bg-slate-800">
                              {team.name} (Group {team.group})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Select Captain</label>
                        <select
                          required
                          value={captainOverride.playerId}
                          onChange={(e) => setCaptainOverride({ ...captainOverride, playerId: e.target.value })}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:border-yellow-500 focus:outline-none"
                          disabled={!captainOverride.teamId}
                        >
                          <option value="" className="bg-slate-800">Select a player...</option>
                          {captainTeams
                            .find((t) => t.id === captainOverride.teamId)
                            ?.players.map((player) => (
                              <option key={player.id} value={player.id} className="bg-slate-800">
                                {player.name} (Chips used: {player.captaincyChipsUsed})
                              </option>
                            ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Gameweek</label>
                        <select
                          required
                          value={captainOverride.gameweekNumber}
                          onChange={(e) => setCaptainOverride({ ...captainOverride, gameweekNumber: e.target.value })}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:border-yellow-500 focus:outline-none"
                        >
                          <option value="" className="bg-slate-800">Select gameweek...</option>
                          {gameweeks.map((gw) => (
                            <option key={gw.id} value={gw.number} className="bg-slate-800">
                              GW{gw.number}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Reason (optional)</label>
                        <input
                          type="text"
                          value={captainOverride.reason}
                          onChange={(e) => setCaptainOverride({ ...captainOverride, reason: e.target.value })}
                          placeholder="e.g., App crash, network error"
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
                    >
                      {isSubmitting ? "Overriding..." : "Override Captain"}
                    </button>
                  </form>
                </div>

                {/* Current Captains */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h3 className="text-xl font-bold text-white mb-4">Current Captain Picks</h3>
                  
                  {/* Filters */}
                  <div className="flex flex-wrap gap-4 mb-4">
                    <div className="min-w-[140px]">
                      <label className="block text-xs text-gray-400 mb-1">Gameweek</label>
                      <select
                        value={captainFilterGw}
                        onChange={(e) => setCaptainFilterGw(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-yellow-500 focus:outline-none"
                      >
                        <option value="" className="bg-slate-800">All GWs</option>
                        {gameweeks.map((gw) => (
                          <option key={gw.id} value={String(gw.number)} className="bg-slate-800">
                            GW{gw.number}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="min-w-[180px]">
                      <label className="block text-xs text-gray-400 mb-1">Team</label>
                      <select
                        value={captainFilterTeam}
                        onChange={(e) => setCaptainFilterTeam(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-yellow-500 focus:outline-none"
                      >
                        <option value="" className="bg-slate-800">All Teams</option>
                        {captainTeams.map((team) => (
                          <option key={team.id} value={team.id} className="bg-slate-800">
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {currentCaptains.length === 0 ? (
                    <p className="text-gray-500">No captain picks yet</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="text-left text-gray-400 border-b border-white/10">
                            <th className="pb-3 px-2">Team</th>
                            <th className="pb-3 px-2">GW</th>
                            <th className="pb-3 px-2">Captain</th>
                            <th className="pb-3 px-2">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentCaptains
                            .filter((cap) => {
                              if (captainFilterGw && String(cap.gameweek) !== captainFilterGw) return false;
                              if (captainFilterTeam && cap.teamId !== captainFilterTeam) return false;
                              return true;
                            })
                            .sort((a, b) => a.teamName.localeCompare(b.teamName))
                            .map((cap, idx) => (
                              <tr key={idx} className="border-b border-white/5">
                                <td className="py-3 px-2 text-white">{cap.teamName}</td>
                                <td className="py-3 px-2 text-gray-300">GW{cap.gameweek}</td>
                                <td className="py-3 px-2 text-gray-300">{cap.playerName}</td>
                                <td className="py-3 px-2">
                                  <span className={cap.isValid ? "text-green-400" : "text-red-400"}>
                                    {cap.isValid ? "Valid" : "Invalid (Late)"}
                                  </span>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}


        {/* Bulk Upload Tab */}
        {activeTab === "bulkUpload" && (
          <>
            <div className="mb-8">
              <h1 className="text-2xl sm:text-3xl font-bold text-white">Bulk Upload</h1>
              <p className="text-gray-400 mt-1">Upload teams and fixtures via Excel (.xlsx)</p>
            </div>

            {/* Backup section — always available, generates importable .xlsx files */}
            <div className="mb-8 rounded-2xl border border-blue-500/30 bg-blue-500/5 p-6 backdrop-blur">
              <h3 className="text-xl font-bold text-white mb-2">Backup Current Data</h3>
              <p className="text-gray-400 text-sm mb-2">
                Downloads a .zip with up to 4 .xlsx files (teams, fixtures, captains, chips) reflecting current league state.
                Each file is ready to re-import via the blocks below — useful for disaster recovery, migration, or end-of-season archiving.
              </p>
              <p className="text-gray-500 text-xs mb-4">
                Captains and chips files are only included if your league uses them. Passwords in the teams file are
                emitted as <code className="text-gray-300">RESET_REQUIRED</code> placeholders — bcrypt hashes can&apos;t be reversed,
                so you&apos;ll need to set new passwords on restore.
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleDownloadBackup}
                  disabled={downloadingBackup}
                  className="rounded-lg bg-gradient-to-r from-blue-500 to-cyan-600 px-6 py-3 font-semibold text-white hover:from-blue-400 hover:to-cyan-500 transition disabled:opacity-50"
                >
                  {downloadingBackup ? "Generating..." : "Download Backup (.zip)"}
                </button>
                <button
                  onClick={handleTakeBackupNow}
                  disabled={takingBackupNow}
                  title={isAuctionFormat
                    ? "Persists a snapshot row in the database so it survives league resets. Recommended right after the auction concludes."
                    : "Persists a snapshot row in the database so it survives league resets. Recommended after major changes (fixtures, captains, chips)."}
                  className="rounded-lg bg-gradient-to-r from-emerald-500/30 to-green-600/30 border border-emerald-500/40 px-6 py-3 font-semibold text-emerald-200 hover:from-emerald-500/40 hover:to-green-600/40 transition disabled:opacity-50"
                >
                  {takingBackupNow ? "Saving..." : "Take Backup Now"}
                </button>
                {/* Restore from Backup — available on every format. Server-side guards reject
                    cross-league or wrong-format restore before any destructive operation. */}
                <button
                  onClick={() => setShowRestoreModal(true)}
                  className="rounded-lg bg-gradient-to-r from-purple-500/30 to-fuchsia-600/30 border border-purple-500/40 px-6 py-3 font-semibold text-purple-200 hover:from-purple-500/40 hover:to-fuchsia-600/40 transition"
                >
                  Restore from Backup
                </button>
              </div>

              {/* Saved snapshots — auto-archived at GW1 lock-in (or future manual archives) */}
              {savedBackups.length > 0 && (
                <div className="mt-6 pt-6 border-t border-blue-500/20">
                  <h4 className="text-sm font-semibold text-white mb-2">Saved snapshots</h4>
                  <p className="text-gray-500 text-xs mb-3">
                    Historical archives. Each is a .zip with the same 4 .xlsx files captured at the moment the snapshot was taken.
                  </p>
                  <ul className="space-y-2">
                    {savedBackups.map(snap => {
                      const created = new Date(snap.createdAt);
                      const triggerLabel = formatBackupTrigger(snap.trigger);
                      const includedParts = [
                        snap.includes.teams && "teams",
                        snap.includes.fixtures && "fixtures",
                        snap.includes.captains && "captains",
                        snap.includes.chips && "chips",
                        snap.includes.auctionTeamsState && "teams-state",
                        snap.includes.auctionSquads && "squads",
                        snap.includes.auctionClubs && "clubs",
                        snap.includes.gameweeks && "gameweeks",
                      ].filter(Boolean).join(", ");
                      const isDownloading = downloadingSnapshotId === snap.id;
                      // Restore button appears on every format. For auction, the snapshot must
                      // contain squads/clubs. For TVT/TC, fixtures are enough.
                      const canRestoreFromSnapshot = isAuctionFormat
                        ? (snap.includes.auctionSquads || snap.includes.auctionClubs)
                        : true;
                      return (
                        <li key={snap.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                          <div className="min-w-0 text-xs">
                            <div className="text-white">
                              <span className="font-semibold">{triggerLabel}</span>{" "}
                              <span className="text-gray-400">— {created.toLocaleString()}</span>
                            </div>
                            <div className="text-gray-500 truncate">includes: {includedParts || "(empty)"}</div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => handleDownloadSnapshot(snap.id)}
                              disabled={isDownloading}
                              className="rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-200 text-xs font-semibold px-3 py-1.5 transition disabled:opacity-50"
                            >
                              {isDownloading ? "Downloading..." : "Download"}
                            </button>
                            {canRestoreFromSnapshot && (
                              <button
                                onClick={() => { setRestoreBackupId(snap.id); setShowRestoreModal(true); }}
                                className="rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 text-xs font-semibold px-3 py-1.5 transition"
                              >
                                Restore
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>

            {/* Legacy per-file Teams + Fixtures uploads removed — use Backup/Restore above instead.
                Captains + Chips blocks remain below until backup-driven restore covers them. */}

            {/* Captain Import Section — H2H/TVT only; auction doesn't use captains. */}
            {leagueConfig?.format !== "auction" && (
              <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <h3 className="text-xl font-bold text-white mb-4">Import Captain Data</h3>
                <p className="text-gray-400 text-sm mb-4">
                  Excel columns: Team, Players, then gameweek numbers (1, 2, 3...) with &quot;C&quot; marking captain gameweeks
                </p>

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">Upload Excel File</label>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={(e) => handleFileUpload(e, "captains")}
                      className="w-full text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-orange-500/20 file:text-orange-400 hover:file:bg-orange-500/30"
                    />
                  </div>

                  <div className="flex items-end">
                    <button
                      onClick={handleImportCaptains}
                      disabled={bulkUploading || captainsData.length === 0}
                      className="w-full rounded-lg bg-gradient-to-r from-orange-400 to-orange-600 px-6 py-3 font-semibold text-white hover:from-orange-300 hover:to-orange-500 transition disabled:opacity-50"
                    >
                      {bulkUploading ? "Importing..." : "Import Captains"}
                    </button>
                  </div>
                </div>

                {captainsFileName && (
                  <div className="mt-4 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <p className="text-green-400 text-sm">
                      ✓ Loaded: {captainsFileName} ({captainsData.length} rows)
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Chip Import Section — TVT only */}
            {leagueConfig?.format === "tvt" && (
              <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <h3 className="text-xl font-bold text-white mb-4">Import Chip Data</h3>
                <p className="text-gray-400 text-sm mb-2">
                  Excel columns: Team, then gameweek numbers (1, 2, 3...) with the chip code marking the GW each team played that chip.
                </p>
                <p className="text-gray-300 text-sm mb-2">
                  Enabled chips for this league:{" "}
                  <span className="text-white font-mono">
                    {leagueConfig.enabledChips.map(formatChipLabel).join(", ")}
                  </span>
                </p>
                <p className="text-gray-500 text-xs mb-4">
                  Append <code className="text-gray-300">W</code> for a wasted chip (e.g. <code className="text-gray-300">WW</code> = wasted Win-Win).
                  For Challenge Chip, append <code className="text-gray-300">:OPP</code> with opponent&apos;s team code (e.g. <code className="text-gray-300">C:TAD</code>).
                </p>

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">Upload Excel File</label>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={(e) => handleFileUpload(e, "chips")}
                      className="w-full text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-purple-500/20 file:text-purple-300 hover:file:bg-purple-500/30"
                    />
                  </div>

                  <div className="flex items-end">
                    <button
                      onClick={handleImportChips}
                      disabled={bulkUploading || chipsData.length === 0}
                      className="w-full rounded-lg bg-gradient-to-r from-purple-500 to-fuchsia-600 px-6 py-3 font-semibold text-white hover:from-purple-400 hover:to-fuchsia-500 transition disabled:opacity-50"
                    >
                      {bulkUploading ? "Importing..." : "Import Chips"}
                    </button>
                  </div>
                </div>

                {chipsFileName && (
                  <div className="mt-4 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <p className="text-green-400 text-sm">
                      ✓ Loaded: {chipsFileName} ({chipsData.length} rows)
                    </p>
                  </div>
                )}
              </div>
            )}


            {/* Upload Results */}
            {bulkUploadResult && (
              <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <h3 className="text-xl font-bold text-white mb-4">Upload Results</h3>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30">
                    <div className="text-2xl font-bold text-green-400">{bulkUploadResult.created}</div>
                    <div className="text-sm text-gray-400">Successfully Created</div>
                  </div>
                  <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
                    <div className="text-2xl font-bold text-red-400">{bulkUploadResult.failed}</div>
                    <div className="text-sm text-gray-400">Failed</div>
                  </div>
                </div>
                
                {bulkUploadResult.details.success.length > 0 && (
                  <div className="mb-4">
                    <h4 className="font-semibold text-green-400 mb-2">Success:</h4>
                    <ul className="text-sm text-gray-300 space-y-1 max-h-40 overflow-y-auto">
                      {bulkUploadResult.details.success.map((item, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span className="text-green-400">✓</span> {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {bulkUploadResult.details.errors.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-red-400 mb-2">Errors:</h4>
                    <ul className="text-sm text-gray-300 space-y-1 max-h-40 overflow-y-auto">
                      {bulkUploadResult.details.errors.map((item, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span className="text-red-400">✗</span> {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Scoring Tab */}
        {activeTab === "scoring" && (
          <>
            {/* Header + Action Bar */}
            <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-white">Scoring</h1>
                <p className="text-sm text-gray-400 mt-0.5">Process and manage gameweek scores</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={processAllPendingGameweeks}
                  disabled={scoringLoading || processingGW !== null}
                  className="px-4 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 text-sm font-medium disabled:opacity-50 transition"
                >
                  {processingGW !== null
                    ? `Processing GW${processingGW}…`
                    : `Process Pending (${gameweekStatuses.filter((g) => g.isPending).length})`}
                </button>
                <button
                  onClick={reprocessAllGameweeks}
                  disabled={scoringLoading || processingGW !== null}
                  className="px-4 py-2 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-sm font-medium disabled:opacity-50 transition"
                >
                  Reprocess All
                </button>
                <button
                  onClick={() => { fetchGameweekStatuses(); fetchCacheStats(); }}
                  disabled={scoringLoading}
                  className="px-4 py-2 rounded-lg bg-white/5 text-gray-400 hover:bg-white/10 text-sm disabled:opacity-50 transition"
                >
                  {scoringLoading ? "Refreshing…" : "Refresh"}
                </button>
                {cacheStats && (
                  <div className="flex items-center gap-2 pl-3 border-l border-white/10">
                    <span className="text-xs text-gray-500">
                      Cache: {cacheStats.totalEntries} entries
                    </span>
                    <button
                      onClick={() => clearCache()}
                      className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 text-xs transition"
                    >
                      Clear All
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Gameweek Grid */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur mb-6">
              {scoringLoading ? (
                <div className="text-center text-gray-400 py-8 text-sm">Loading gameweeks…</div>
              ) : gameweekStatuses.length === 0 ? (
                isAuctionFormat ? (
                  <div className="text-center py-8">
                    <p className="text-gray-400 text-sm mb-3">No gameweeks found</p>
                    <button
                      onClick={createGameweeks}
                      disabled={scoringLoading}
                      className="px-4 py-2 rounded-lg bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 text-sm font-medium disabled:opacity-50 transition"
                    >
                      Create Gameweeks (GW 1–38)
                    </button>
                  </div>
                ) : (
                  <div className="text-center text-gray-400 py-8 text-sm">No gameweeks with fixtures found</div>
                )
              ) : (
                <>
                {isAuctionFormat && (
                  <div className="text-xs text-gray-500 mb-3">Reprocessing uses historical ownership (acquiredGw / releasedGw) — safe to re-run any GW.</div>
                )}
                <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-10 gap-2">
                  {gameweekStatuses.map((gw) => {
                    const cached = cacheStats?.gameweeks.find((c) => c.gameweek === gw.number);
                    return (
                      <div
                        key={gw.number}
                        className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/5 transition"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              gw.isPending ? "bg-yellow-400" : "bg-green-400"
                            }`}
                          />
                          <span className="text-sm font-semibold text-white">GW{gw.number}</span>
                        </div>
                        <div className={`text-xs ${gw.isPending ? "text-yellow-500" : "text-green-500"}`}>
                          {gw.resultsProcessed}/{gw.fixturesCount}
                        </div>
                        {gw.survivalCount ? (
                          <div className={`text-[10px] ${gw.survivalRanked === gw.survivalCount ? "text-green-500" : "text-orange-400"}`}>
                            Survival {gw.survivalRanked ?? 0}/{gw.survivalCount}
                          </div>
                        ) : null}
                        {gw.isPending ? (
                          <button
                            onClick={() => processGameweek(gw.number)}
                            disabled={processingGW !== null}
                            className="w-full text-xs px-2 py-1 rounded-lg bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 disabled:opacity-50 transition"
                          >
                            {processingGW === gw.number ? "…" : "Process"}
                          </button>
                        ) : (
                          <button
                            onClick={() => processGameweek(gw.number, true)}
                            disabled={processingGW !== null}
                            className="w-full text-xs px-2 py-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-50 transition"
                          >
                            {processingGW === gw.number ? "…" : "Reprocess"}
                          </button>
                        )}
                        {cached && (
                          <button
                            onClick={() => clearCache(gw.number)}
                            title={`Clear cache (${cached.entries} entries)`}
                            className="w-full text-xs px-2 py-0.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition"
                          >
                            × cache
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                </>
              )}
            </div>

            {/* Processing Results */}
            {scoringResults.length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <h3 className="text-lg font-bold text-white mb-4">Processing Results</h3>
                <div className="space-y-6">
                  {scoringResults.map((result, idx) => (
                    <div key={idx} className="border border-white/10 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-bold text-white">Gameweek {result.gameweek}</h4>
                        <div className="flex gap-2">
                          <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-400">
                            {result.processed} processed
                          </span>
                          {result.failed > 0 && (
                            <span className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-400">
                              {result.failed} failed
                            </span>
                          )}
                        </div>
                      </div>
                      {result.results.length > 0 && isAuctionFormat && (
                        <div className="space-y-2">
                          {(result.results as AuctionTeamResult[])
                            .slice()
                            .sort((a, b) => a.rank - b.rank)
                            .map((row, mIdx) => (
                              <div key={mIdx} className="flex items-center justify-between p-2 rounded bg-white/5 text-sm">
                                <div className="flex items-center gap-3">
                                  <span className="text-xs font-bold text-gray-400 w-6 text-right">#{row.rank}</span>
                                  <span className={row.rank === 1 ? "text-yellow-300 font-semibold" : "text-white font-semibold"}>
                                    {row.teamName}
                                  </span>
                                </div>
                                <div className="flex items-center gap-4">
                                  <span className="text-[#00ff85] font-mono font-bold">
                                    {row.totalPoints} pts
                                  </span>
                                  <span className="text-green-300 text-xs font-mono">
                                    £{(row.payout / 1_000_000).toFixed(2)}M
                                  </span>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                      {result.results.length > 0 && !isAuctionFormat && (
                        <div className="space-y-2">
                          {(result.results as H2HMatchResult[]).map((match, mIdx) => (
                            <div key={mIdx} className="flex items-center justify-between p-2 rounded bg-white/5 text-sm">
                              <div className="flex items-center gap-2">
                                <span className={match.homeMatchPoints > match.awayMatchPoints ? "text-green-400 font-semibold" : "text-gray-300"}>
                                  {match.homeTeam}
                                </span>
                                <span className="text-gray-500">vs</span>
                                <span className={match.awayMatchPoints > match.homeMatchPoints ? "text-green-400 font-semibold" : "text-gray-300"}>
                                  {match.awayTeam}
                                </span>
                              </div>
                              <div className="flex items-center gap-4">
                                <span className="text-white font-mono">
                                  {match.homeScore} - {match.awayScore}
                                </span>
                                <span className="text-gray-400 text-xs">
                                  ({match.homeMatchPoints} - {match.awayMatchPoints} pts)
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {result.errors && result.errors.length > 0 && (
                        <div className="mt-3 space-y-1">
                          <h5 className="text-sm font-semibold text-red-400">Errors:</h5>
                          {result.errors.map((err, eIdx) => (
                            <div key={eIdx} className="text-xs text-red-300 bg-red-500/10 p-2 rounded">
                              {typeof err === "string"
                                ? err
                                : `${err.homeTeam} vs ${err.awayTeam}: ${err.error}`}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Playoffs Management Tab */}
        {activeTab === "playoffs" && (
          <div className="space-y-6">
            {leagueConfig.format === "triple-crown" ? (
              <>
                {/* Triple Crown: Cup Groups */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h3 className="text-lg font-bold text-white mb-4">Cup Groups (GW6–24)</h3>
                  {cupGroupsLoading ? (
                    <p className="text-gray-400 text-sm">Loading…</p>
                  ) : !cupGroupsGenerated ? (
                    <div>
                      <p className="text-gray-400 text-sm mb-4">
                        Seed 20 teams into 4 cup groups from GW5 standings. Creates 4 Ghost opponents.
                      </p>
                      <button
                        onClick={seedCupGroups}
                        className="px-6 py-3 rounded-lg bg-gradient-to-r from-blue-400 to-cyan-500 text-white font-bold hover:from-blue-300 hover:to-cyan-400 transition"
                      >
                        Seed Cup Groups
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p className="text-green-400 text-sm mb-4">✓ Cup groups seeded. Teams will play cup group fixtures on even GWs (6, 8, 10, 12, 14, 16, 18, 20, 22, 24).</p>
                      <button
                        onClick={deleteCupGroups}
                        disabled={cupGroupsLoading}
                        className="px-6 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-400 font-semibold hover:bg-red-500/30 disabled:opacity-50 transition text-sm"
                      >
                        {cupGroupsLoading ? "Deleting..." : "Delete & Re-seed Cup Groups"}
                      </button>
                    </div>
                  )}
                </div>

                {/* Triple Crown: Brackets */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h3 className="text-lg font-bold text-white mb-4">UCL/UEL Brackets (GW27–38)</h3>
                  {bracketsLoading ? (
                    <p className="text-gray-400 text-sm">Loading…</p>
                  ) : !bracketsGenerated ? (
                    <div>
                      <p className="text-gray-400 text-sm mb-4">
                        Generate UCL/UEL knockout brackets from GW24 cup group standings. Creates QF ties.
                      </p>
                      <button
                        onClick={generateBrackets}
                        disabled={!cupGroupsGenerated}
                        className="px-6 py-3 rounded-lg bg-gradient-to-r from-purple-400 to-pink-500 text-white font-bold hover:from-purple-300 hover:to-pink-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        {!cupGroupsGenerated ? "Seed Cup Groups First" : "Generate UCL/UEL Brackets"}
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p className="text-green-400 text-sm mb-4">✓ Brackets generated. UCL/UEL quarterfinals ready for GW27 & GW29.</p>
                      <button
                        onClick={regenerateBrackets}
                        disabled={bracketsLoading}
                        className="px-6 py-3 rounded-lg bg-gradient-to-r from-red-500 to-orange-500 text-white font-bold hover:from-red-400 hover:to-orange-400 disabled:opacity-50 transition"
                      >
                        {bracketsLoading ? "Regenerating…" : "Delete & Regenerate UCL/UEL Brackets"}
                      </button>
                      <p className="text-gray-500 text-xs mt-2">
                        Deletes all existing UCL/UEL ties, fixtures, and results, then reseeds from GW24 cup group standings.
                      </p>
                    </div>
                  )}
                </div>

                {/* Triple Crown: Advance Knockouts */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h3 className="text-lg font-bold text-white mb-4">Advance Knockouts</h3>
                  {bracketsGenerated && (
                    <div>
                      <p className="text-gray-400 text-sm mb-4">Advance UCL/UEL knockout rounds after each gameweek is scored.</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                        {[27, 29, 33, 35, 37, 38].map((gw) => (
                          <button
                            key={gw}
                            onClick={() => advancePlayoffs(gw)}
                            disabled={advancingGW !== null}
                            className="px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 disabled:opacity-50 transition text-sm"
                          >
                            {advancingGW === gw ? "Advancing…" : `Advance GW${gw}`}
                          </button>
                        ))}
                      </div>
                      <p className="text-gray-500 text-xs mt-4">
                        GW27: QF Leg 1 | GW29: QF Leg 2 + Create SFs | GW33: SF Leg 1 | GW35: SF Leg 2 + Create 2-leg Finals (GW37+38) | GW37: Final Leg 1 | GW38: Final Leg 2 + Crown Champions
                      </p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <h3 className="text-lg font-bold text-white mb-4">Playoff Management</h3>

                {(() => {
                  const { teamSize, playoffStartGw } = leagueConfig;
                  const bracketLabel = teamSize === 8 ? "SF" : teamSize === 16 ? "Group Stage" : "RO16 + C-31";
                  const standingsGw = playoffStartGw - 1;
                  const playoffGws = Array.from({ length: 38 - playoffStartGw + 1 }, (_, i) => playoffStartGw + i);
                  const firstGw = playoffGws[0];
                  const lastGw = playoffGws[playoffGws.length - 1];
                  return playoffsLoading ? (
                    <p className="text-gray-400 text-sm">Loading…</p>
                  ) : !playoffsGenerated ? (
                    <div>
                      <p className="text-gray-400 text-sm mb-4">
                        Generate the initial playoff bracket ({bracketLabel}) from GW{standingsGw} standings. This can only be done once.
                      </p>
                      <button
                        onClick={generatePlayoffs}
                        className="px-6 py-3 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-bold hover:from-yellow-300 hover:to-orange-400 transition"
                      >
                        Generate Playoffs ({bracketLabel})
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p className="text-green-400 text-sm mb-6">✓ Playoffs generated. Use the buttons below to advance each gameweek after scoring is complete.</p>

                      <div className="mb-6">
                        <button
                          onClick={regeneratePlayoffs}
                          disabled={playoffsLoading}
                          className="px-6 py-3 rounded-lg bg-gradient-to-r from-red-500 to-orange-500 text-white font-bold hover:from-red-400 hover:to-orange-400 disabled:opacity-50 transition"
                        >
                          {playoffsLoading ? "Regenerating…" : `Regenerate Playoff Fixtures (${bracketLabel})`}
                        </button>
                        <p className="text-gray-500 text-xs mt-2">
                          Deletes existing {bracketLabel} fixtures/results and regenerates from GW{standingsGw} standings.
                          Use this if the initial standings were incorrect.
                        </p>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {playoffGws.map((gw) => (
                          <button
                            key={gw}
                            onClick={() => advancePlayoffs(gw)}
                            disabled={advancingGW !== null}
                            className="px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white font-semibold hover:bg-white/10 disabled:opacity-50 transition text-sm"
                          >
                            {advancingGW === gw ? "Advancing…" : `Advance GW${gw}`}
                          </button>
                        ))}
                      </div>

                      <p className="text-gray-500 text-xs mt-4">
                        Each button resolves the current round&apos;s results and generates fixtures for the next round.
                        Run them in order (GW{firstGw} → … → GW{lastGw}) after processing each gameweek&apos;s scores.
                      </p>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* Auction Management Tab */}
        {activeTab === "auction" && isAuctionFormat && (
          <div className="space-y-6">

            {/* Live Auction Monitor — only when session is active */}
            {auctionActiveSession && auctionActiveSession.status === "active" && (
              <div className="rounded-2xl border border-green-500/30 bg-green-500/5 p-6 backdrop-blur">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <h2 className="text-xl font-bold text-white">Live Auction Monitor</h2>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateAuctionSession(auctionActiveSession.id, "pause")}
                      disabled={auctionSessionAction !== null}
                      className="px-3 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 text-xs font-medium disabled:opacity-50 transition"
                    >
                      Pause
                    </button>
                    <button
                      onClick={() => updateAuctionSession(auctionActiveSession.id, "complete")}
                      disabled={auctionSessionAction !== null}
                      className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 text-xs font-medium disabled:opacity-50 transition"
                    >
                      Complete
                    </button>
                  </div>
                </div>

                <div className="grid md:grid-cols-3 gap-4">
                  {/* Current Bid Card */}
                  <div className="md:col-span-2 rounded-xl border border-white/10 bg-white/5 p-4">
                    {liveCurrentBid ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-lg font-bold text-white">{liveCurrentBid.playerName}</div>
                            <div className="text-xs text-gray-400">
                              Nominated by {teamNameById(liveCurrentBid.nominatorTeamId)} — Base {formatAuctionCurrency(liveCurrentBid.minBid)}
                            </div>
                          </div>
                          <AuctionTimerRing seconds={liveTimerSec} max={auctionActiveSession.bidTimerSeconds ?? 20} size={96} stroke={9} />
                        </div>
                        <div className="flex items-center justify-between rounded-lg bg-white/5 px-4 py-2">
                          <div>
                            <div className="text-xs text-gray-400">High Bid</div>
                            <div className="text-xl font-bold text-yellow-400">{formatAuctionCurrency(liveCurrentBid.currentHighBid)}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs text-gray-400">By</div>
                            <div className="text-sm font-semibold text-white">{teamNameById(liveCurrentBid.currentHighBidderId)}</div>
                          </div>
                        </div>
                      </div>
                    ) : liveIntermissionUntil && new Date(liveIntermissionUntil).getTime() > Date.now() ? (
                      <div className="flex flex-col items-center justify-center py-4 gap-2">
                        <div className="text-[10px] uppercase tracking-widest text-yellow-300/80">Lot sold — next up</div>
                        <AuctionTimerRing
                          seconds={Math.max(0, Math.ceil((new Date(liveIntermissionUntil).getTime() - Date.now()) / 1000))}
                          max={5}
                          size={88}
                          stroke={8}
                          label="next nom"
                        />
                        <div className="text-xs text-gray-400">Next nomination coming up</div>
                      </div>
                    ) : (
                      <div className="text-center py-6">
                        <div className="text-sm text-gray-400">Waiting for nomination</div>
                        <div className="text-xs text-gray-500 mt-1">
                          Current turn: {auctionActiveSession.snakeOrder[auctionActiveSession.currentNominatorIndex]
                            ? teamNameById(auctionActiveSession.snakeOrder[auctionActiveSession.currentNominatorIndex])
                            : "—"}
                        </div>
                        {liveNominationDeadline && (
                          <div className="text-xs text-yellow-400 font-mono mt-2">
                            Auto-nom in {Math.max(0, Math.ceil((new Date(liveNominationDeadline).getTime() - Date.now()) / 1000))}s
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Nomination Order */}
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                    <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Nomination Order</h3>
                    <div className="space-y-1 max-h-48 overflow-y-auto text-xs">
                      {auctionActiveSession.snakeOrder.map((tid, idx) => {
                        const isCurrent = idx === auctionActiveSession.currentNominatorIndex;
                        return (
                          <div key={tid} className={`flex items-center gap-2 px-2 py-1 rounded ${isCurrent ? "bg-yellow-500/20 text-yellow-300 font-semibold" : "text-gray-400"}`}>
                            <span className="w-4 text-right text-[10px] text-gray-500">{idx + 1}</span>
                            <span>{teamNameById(tid)}</span>
                            {isCurrent && <span className="text-yellow-400 text-[10px]">◄</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Live Feed */}
                <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Live Feed</h3>
                  <div className="space-y-1 max-h-48 overflow-y-auto text-xs">
                    {liveFeed.length === 0 ? (
                      <div className="text-gray-500 py-2 text-center">No activity yet</div>
                    ) : (
                      liveFeed.map((item) => (
                        <div key={item.id} className={`flex items-start gap-2 px-2 py-1 rounded ${
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
              </div>
            )}

            {/* Session Controls */}
            <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-6 backdrop-blur shadow-lg">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-slate-900 text-lg">🏷️</div>
                  <div>
                    <h2 className="text-2xl font-bold text-white">Auction Sessions</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Schedule, start, and manage auction windows</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {leagueConfig.clubAuctionEnabled && (() => {
                    // Mirror the backend ordering guards so the admin gets a tooltip rather than a 409.
                    const hasClubAuction = auctionSessions.some((s) => s.type === "club-auction");
                    const hasInitial = auctionSessions.some((s) => s.type === "initial");
                    const blockedReason = hasClubAuction
                      ? "Club auction already created"
                      : hasInitial
                      ? "An initial auction already exists — clubs must be created first"
                      : null;
                    return (
                      <button
                        onClick={() => { setShowCreateSessionModal("club-auction"); setNewSessionScheduledAt(""); }}
                        disabled={auctionSessionCreating || blockedReason !== null}
                        title={blockedReason ?? undefined}
                        className="px-4 py-2 rounded-lg bg-gradient-to-r from-yellow-500/25 to-amber-500/20 text-yellow-200 hover:from-yellow-500/40 hover:to-amber-500/30 border border-yellow-500/30 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
                      >
                        + Club Auction
                      </button>
                    );
                  })()}
                  {(() => {
                    // Backend allows exactly one initial auction per league — gate the button client-side
                    // so admins get a tooltip instead of a 409. Also gate on club-auction completion
                    // when the league requires it (mirrors the ordering guard in session/route.ts).
                    const hasInitial = auctionSessions.some((s) => s.type === "initial");
                    const needsClubFirst =
                      leagueConfig.clubAuctionEnabled &&
                      !auctionSessions.some((s) => s.type === "club-auction" && s.status === "completed");
                    const blockedReason = hasInitial
                      ? "Initial auction already exists"
                      : needsClubFirst
                      ? "Club auction must complete first"
                      : null;
                    return (
                      <button
                        onClick={() => { setShowCreateSessionModal("initial"); setNewSessionScheduledAt(""); }}
                        disabled={auctionSessionCreating || blockedReason !== null}
                        title={blockedReason ?? undefined}
                        className="px-4 py-2 rounded-lg bg-gradient-to-r from-green-500/25 to-emerald-500/20 text-green-300 hover:from-green-500/40 hover:to-emerald-500/30 border border-green-500/30 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
                      >
                        + Initial Auction
                      </button>
                    );
                  })()}
                  <button
                    onClick={() => { setShowCreateSessionModal("mini-auction"); setNewSessionScheduledAt(""); }}
                    disabled={auctionSessionCreating}
                    className="px-4 py-2 rounded-lg bg-gradient-to-r from-blue-500/25 to-indigo-500/20 text-blue-300 hover:from-blue-500/40 hover:to-indigo-500/30 border border-blue-500/30 text-sm font-medium disabled:opacity-50 transition shadow-sm"
                  >
                    + Mini-Auction
                  </button>
                  <button
                    onClick={fetchAuctionData}
                    disabled={auctionLoading}
                    className="px-4 py-2 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 border border-white/10 text-sm disabled:opacity-50 transition"
                  >
                    {auctionLoading ? "⟳ Loading..." : "↻ Refresh"}
                  </button>
                  <button
                    onClick={() => setShowAuctionResetConfirm(true)}
                    className="px-4 py-2 rounded-lg bg-red-500/15 text-red-300 hover:bg-red-500/25 border border-red-500/30 text-sm font-medium transition"
                  >
                    Reset Auction
                  </button>
                </div>
              </div>

              {auctionLoading ? (
                <div className="text-center text-gray-400 py-8 text-sm">Loading sessions...</div>
              ) : auctionSessions.length === 0 ? (
                <div className="text-center py-12 rounded-xl bg-white/[0.02] border border-dashed border-white/10">
                  <div className="text-3xl mb-2">📅</div>
                  <div className="text-sm text-gray-300 font-medium">No auction sessions yet</div>
                  <div className="text-xs text-gray-500 mt-1">Click &quot;+ Initial Auction&quot; above to schedule one</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {auctionSessions.map((session) => {
                    const sched = session.scheduledAt ? new Date(session.scheduledAt) : null;
                    const schedStr = sched ? sched.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : null;
                    const schedInputVal = sched ? new Date(sched.getTime() - sched.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
                    const isPending = session.status === "pending";
                    return (
                      <div key={session.id} className="group p-4 rounded-xl bg-white/[0.04] border border-white/10 hover:border-white/20 transition">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-semibold text-white">
                                {session.type === "initial"
                                  ? "Initial Auction"
                                  : session.type === "club-auction"
                                  ? "Club Auction"
                                  : `Mini-Auction #${session.cycleNumber}`}
                              </span>
                              <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold tracking-wider border ${
                                session.status === "active" ? "bg-green-500/20 text-green-300 border-green-500/40" :
                                session.status === "paused" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
                                session.status === "completed" ? "bg-gray-500/20 text-gray-400 border-gray-500/40" :
                                "bg-blue-500/20 text-blue-300 border-blue-500/40"
                              }`}>
                                {session.status}
                              </span>
                              {schedStr && (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                                  📅 {schedStr}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 mt-2 flex items-center gap-3">
                              {session.type === "club-auction" ? (
                                <span>🏟️ {session.snakeOrder.length} clubs queued</span>
                              ) : (
                                <span>👥 {session.snakeOrder.length} teams</span>
                              )}
                              <span className="text-gray-600">•</span>
                              <span>Position: {session.currentNominatorIndex + 1}/{session.snakeOrder.length}</span>
                            </div>
                            {isPending && (
                              <div className="mt-3 flex items-center gap-2">
                                <label className="text-[10px] text-gray-500 uppercase tracking-wider">Scheduled for:</label>
                                <input
                                  type="datetime-local"
                                  defaultValue={schedInputVal}
                                  onBlur={(e) => {
                                    const newVal = e.target.value;
                                    if (newVal !== schedInputVal) rescheduleAuctionSession(session.id, newVal);
                                  }}
                                  className="px-2 py-1 rounded-lg bg-slate-800/60 text-white text-xs border border-white/15 focus:border-yellow-400 outline-none"
                                />
                                {schedStr && (
                                  <button
                                    onClick={() => rescheduleAuctionSession(session.id, "")}
                                    className="text-[10px] text-gray-500 hover:text-red-400 transition"
                                    title="Clear schedule"
                                  >
                                    ✕ clear
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {(session.status === "pending" || session.status === "paused") && (
                              <button
                                onClick={() => updateAuctionSession(session.id, "start")}
                                disabled={auctionSessionAction !== null}
                                className="px-3 py-1.5 rounded-lg bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30 text-xs font-medium disabled:opacity-50 transition"
                              >
                                {auctionSessionAction === "start" ? "..." : session.status === "paused" ? "▶ Resume" : "▶ Start"}
                              </button>
                            )}
                            {session.status === "active" && (
                              <>
                                <button
                                  onClick={() => updateAuctionSession(session.id, "pause")}
                                  disabled={auctionSessionAction !== null}
                                  className="px-3 py-1.5 rounded-lg bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 border border-yellow-500/30 text-xs font-medium disabled:opacity-50 transition"
                                >
                                  {auctionSessionAction === "pause" ? "..." : "⏸ Pause"}
                                </button>
                                <button
                                  onClick={() => updateAuctionSession(session.id, "complete")}
                                  disabled={auctionSessionAction !== null}
                                  className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/30 text-xs font-medium disabled:opacity-50 transition"
                                >
                                  {auctionSessionAction === "complete" ? "..." : "■ Complete"}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Create Session Modal (with optional scheduled start time) */}
            {showCreateSessionModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => !auctionSessionCreating && setShowCreateSessionModal(null)}>
                <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-slate-900 text-lg">📅</div>
                    <div>
                      <h3 className="text-xl font-bold text-white">
                        Create {showCreateSessionModal === "initial"
                          ? "Initial Auction"
                          : showCreateSessionModal === "club-auction"
                          ? "Club Auction"
                          : "Mini-Auction"}
                      </h3>
                      <p className="text-xs text-gray-400">Optionally schedule when it should start</p>
                    </div>
                  </div>
                  {showCreateSessionModal === "club-auction" && (
                    <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-[11px] text-yellow-200/90">
                      <p className="font-semibold mb-1">How the PL Club auction works</p>
                      <ul className="list-disc list-inside space-y-0.5 text-yellow-200/80">
                        <li>System auto-nominates one PL club at a time in random order — teams don&apos;t nominate.</li>
                        <li>Each team bids from the same shared purse; only teams without a club can bid.</li>
                        <li>If no one bids, the club rejoins the round-2 queue.</li>
                        <li>Must complete before you can create the initial player auction.</li>
                      </ul>
                    </div>
                  )}
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">Scheduled Start (optional)</label>
                    <input
                      type="datetime-local"
                      value={newSessionScheduledAt}
                      onChange={(e) => setNewSessionScheduledAt(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-slate-800 text-white border border-white/20 focus:border-yellow-400 outline-none text-sm"
                    />
                    <p className="text-[11px] text-gray-500 mt-1.5">Teams will see a countdown to this time. You still need to click &quot;Start&quot; to begin the session.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">Bid Timer (seconds)</label>
                      <input
                        type="number"
                        min="5"
                        max="120"
                        value={newSessionBidTimer}
                        onChange={(e) => setNewSessionBidTimer(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-slate-800 text-white border border-white/20 focus:border-yellow-400 outline-none text-sm"
                      />
                      <p className="text-[11px] text-gray-500 mt-1">Time for each bid round. Default: 20s</p>
                    </div>
                    <div>
                      <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">Nomination Timeout (seconds)</label>
                      <input
                        type="number"
                        min="10"
                        max="300"
                        value={newSessionNominationTimer}
                        onChange={(e) => setNewSessionNominationTimer(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-slate-800 text-white border border-white/20 focus:border-yellow-400 outline-none text-sm"
                      />
                      <p className="text-[11px] text-gray-500 mt-1">Time to nominate a player. Default: 60s</p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => createAuctionSession(showCreateSessionModal, newSessionScheduledAt || undefined)}
                      disabled={auctionSessionCreating}
                      className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-bold hover:from-yellow-300 hover:to-orange-400 disabled:opacity-50 transition shadow"
                    >
                      {auctionSessionCreating ? "Creating..." : "Create Session"}
                    </button>
                    <button
                      onClick={() => { setShowCreateSessionModal(null); setNewSessionScheduledAt(""); }}
                      disabled={auctionSessionCreating}
                      className="px-4 py-2 rounded-lg bg-white/10 text-gray-300 hover:bg-white/20 transition disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Squad Overview */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h2 className="text-2xl font-bold text-white">Squad Overview</h2>
                {auctionTeamSquads.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setExpandedSquads(new Set(auctionTeamSquads.map((s) => s.teamId)))}
                      className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 hover:bg-white/20 transition"
                    >
                      Expand all
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpandedSquads(new Set())}
                      className="px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 hover:bg-white/20 transition"
                    >
                      Collapse all
                    </button>
                  </div>
                )}
              </div>
              {auctionTeamSquads.length === 0 ? (
                <div className="text-center text-gray-400 py-8 text-sm">No squad data available</div>
              ) : (() => {
                // Pre-compute per-team metrics once so sort + render share the same numbers.
                const rows = auctionTeamSquads.map((teamSquad) => {
                  const activePlayers = teamSquad.squad.filter((p) => p.status === "active");
                  const totalSpent = teamSquad.squad.reduce((sum, p) => sum + p.purchasePrice, 0);
                  const totalPoints = teamSquad.squad.reduce((sum, p) => sum + p.totalPoints, 0);
                  const topScorer = activePlayers.length > 0
                    ? [...activePlayers].sort((a, b) => b.totalPoints - a.totalPoints)[0]
                    : null;
                  return { teamSquad, totalSpent, totalPoints, topScorer };
                });
                const sorted = [...rows].sort((a, b) => {
                  const dir = squadSort.dir === "asc" ? 1 : -1;
                  if (squadSort.key === "team") return a.teamSquad.teamName.localeCompare(b.teamSquad.teamName) * dir;
                  if (squadSort.key === "spent") return (a.totalSpent - b.totalSpent) * dir;
                  return (a.totalPoints - b.totalPoints) * dir;
                });
                const toggleSort = (key: "team" | "spent" | "points") =>
                  setSquadSort((prev) => prev.key === key
                    ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
                    : { key, dir: key === "team" ? "asc" : "desc" });
                const sortIndicator = (key: "team" | "spent" | "points") =>
                  squadSort.key === key ? (squadSort.dir === "asc" ? "▲" : "▼") : <span className="text-gray-600">↕</span>;
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs uppercase text-gray-400 border-b border-white/10">
                        <tr>
                          <th className="text-left py-2 px-3 font-medium cursor-pointer select-none hover:text-white transition" onClick={() => toggleSort("team")}>
                            <span className="inline-flex items-center gap-1">Team {sortIndicator("team")}</span>
                          </th>
                          <th className="text-left py-2 px-3 font-medium">Squad</th>
                          <th className="text-right py-2 px-3 font-medium cursor-pointer select-none hover:text-white transition" onClick={() => toggleSort("spent")}>
                            <span className="inline-flex items-center gap-1">Spent {sortIndicator("spent")}</span>
                          </th>
                          <th className="text-right py-2 px-3 font-medium cursor-pointer select-none hover:text-white transition" onClick={() => toggleSort("points")}>
                            <span className="inline-flex items-center gap-1">Pts {sortIndicator("points")}</span>
                          </th>
                          <th className="text-left py-2 px-3 font-medium hidden sm:table-cell">Top scorer</th>
                          <th className="w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map(({ teamSquad, totalSpent, totalPoints, topScorer }) => {
                          const isExpanded = expandedSquads.has(teamSquad.teamId);
                          const toggle = () => setExpandedSquads((prev) => {
                            const next = new Set(prev);
                            if (next.has(teamSquad.teamId)) next.delete(teamSquad.teamId);
                            else next.add(teamSquad.teamId);
                            return next;
                          });
                          return (
                            <Fragment key={teamSquad.teamId}>
                              <tr
                                onClick={toggle}
                                className="border-b border-white/5 hover:bg-white/[0.04] cursor-pointer transition"
                              >
                                <td className="py-2 px-3 font-semibold text-white whitespace-nowrap">
                                  <span className="inline-flex items-center gap-2">
                                    <span>{teamSquad.teamName}</span>
                                    {teamSquad.ownedClub && (
                                      <TierChip
                                        tier={teamSquad.ownedClub.tier}
                                        clubName={teamSquad.ownedClub.plTeamName}
                                        short={teamSquad.ownedClub.plTeamShort}
                                      />
                                    )}
                                  </span>
                                </td>
                                <td className="py-2 px-3">
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                                      {teamSquad.activeCount} active
                                    </span>
                                    {teamSquad.deadwoodCount > 0 && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
                                        {teamSquad.deadwoodCount} dw
                                      </span>
                                    )}
                                  </span>
                                </td>
                                <td className="py-2 px-3 text-right font-mono text-gray-200 whitespace-nowrap">
                                  {formatCurrency(totalSpent)}
                                </td>
                                <td className="py-2 px-3 text-right font-mono text-[#00ff85] whitespace-nowrap">
                                  {totalPoints}
                                </td>
                                <td className="py-2 px-3 text-gray-300 hidden sm:table-cell whitespace-nowrap">
                                  {topScorer ? (
                                    <span>
                                      {topScorer.playerName}
                                      {topScorer.plTeamShort && (
                                        <span className="ml-1 text-[10px] text-gray-500">({topScorer.plTeamShort})</span>
                                      )}
                                      <span className="text-gray-500"> · </span>
                                      <span className="font-mono">{topScorer.totalPoints}</span>
                                    </span>
                                  ) : (
                                    <span className="text-gray-600">—</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-gray-500 text-center">{isExpanded ? "▼" : "▶"}</td>
                              </tr>
                              {isExpanded && (
                                <tr className="bg-black/30 border-b border-white/5">
                                  <td colSpan={6} className="px-3 py-3">
                                    {teamSquad.squad.length === 0 ? (
                                      <p className="text-xs text-gray-500">No players yet</p>
                                    ) : (
                                      <div className="space-y-3">
                                        {([1, 2, 3, 4] as const).map((posType) => {
                                          const players = teamSquad.squad
                                            .filter((p) => p.elementType === posType)
                                            .sort((a, b) => b.totalPoints - a.totalPoints);
                                          return (
                                            <div key={posType}>
                                              <div className="flex items-center gap-2 mb-1.5">
                                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${SQUAD_POSITION_COLORS[posType]}`}>
                                                  {SQUAD_POSITION_LABELS[posType]}
                                                </span>
                                                <span className="text-[10px] text-gray-500">· {players.length}</span>
                                              </div>
                                              <div className="overflow-x-auto">
                                                <table className="w-full text-xs">
                                                  <thead className="text-[10px] uppercase text-gray-500">
                                                    <tr>
                                                      <th className="w-4"></th>
                                                      <th className="text-left py-1 px-2 font-medium">Player</th>
                                                      <th className="text-right py-1 px-2 font-medium w-16">Pts</th>
                                                      <th className="text-right py-1 px-2 font-medium w-20">Spent</th>
                                                      <th className="text-right py-1 px-2 font-medium w-20">FMV</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {players.length === 0 ? (
                                                      <tr><td colSpan={5} className="py-1.5 text-center text-gray-600 text-[11px]">—</td></tr>
                                                    ) : (
                                                      players.map((player) => (
                                                        <tr key={player.ownershipId} className="border-t border-white/[0.04]">
                                                          <td className="py-1 pl-2">
                                                            <span className={`block w-1.5 h-1.5 rounded-full ${player.status === "active" ? "bg-green-400" : "bg-orange-400"}`} />
                                                          </td>
                                                          <td className="py-1 px-2 text-gray-200">
                                                            {player.playerName}
                                                            {player.plTeamShort && (
                                                              <span className="ml-1.5 text-[10px] text-gray-500">({player.plTeamShort})</span>
                                                            )}
                                                          </td>
                                                          <td className={`py-1 px-2 text-right font-mono ${player.totalPoints > 0 ? "text-[#00ff85]" : "text-gray-500"}`}>
                                                            {player.totalPoints}
                                                          </td>
                                                          <td className="py-1 px-2 text-right font-mono text-gray-300">
                                                            {formatCurrency(player.purchasePrice)}
                                                          </td>
                                                          <td className="py-1 px-2 text-right font-mono text-cyan-300 font-semibold">
                                                            {formatCurrency(player.fmv)}
                                                          </td>
                                                        </tr>
                                                      ))
                                                    )}
                                                  </tbody>
                                                </table>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>

            {/* Trade Proposals */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="text-2xl font-bold text-white mb-4">Trade Proposals</h2>
              {auctionTrades.length === 0 ? (
                <div className="text-center text-gray-400 py-8 text-sm">No trade proposals</div>
              ) : (
                <div className="space-y-3">
                  {auctionTrades.map((trade) => {
                    const proposerName = teams.find(t => t.id === trade.proposerTeamId)?.name ?? trade.proposerTeamId;
                    const targetName = teams.find(t => t.id === trade.targetTeamId)?.name ?? trade.targetTeamId;
                    return (
                      <div key={trade.id} className="flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10">
                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            <span className="font-semibold text-white">{proposerName}</span>
                            <span className="text-gray-500">&rarr;</span>
                            <span className="font-semibold text-white">{targetName}</span>
                            <span className={`text-xs px-2 py-0.5 rounded ${
                              trade.status === "pending" ? "bg-yellow-500/20 text-yellow-400" :
                              trade.status === "accepted" ? "bg-green-500/20 text-green-400" :
                              trade.status === "rejected" ? "bg-red-500/20 text-red-400" :
                              trade.status === "vetoed" ? "bg-red-500/20 text-red-400" :
                              "bg-gray-500/20 text-gray-400"
                            }`}>
                              {trade.status}
                            </span>
                          </div>
                          <div className="text-xs text-gray-400 mt-1">
                            {trade.offeredPlayerIds.length} player(s) offered | {trade.requestedPlayerIds.length} requested
                            {trade.cashOffered !== 0 && ` | Cash: ${formatCurrency(Math.abs(trade.cashOffered))} ${trade.cashOffered > 0 ? "(proposer pays)" : "(target pays)"}`}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Auction Corrections */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="text-2xl font-bold text-white mb-4">Corrections</h2>

              {/* Undo Sales */}
              <div className="mb-6">
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Undo Sale</h3>
                {soldBids.length === 0 ? (
                  <p className="text-xs text-gray-500">No sold bids to undo</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {soldBids.map((bid) => (
                      <div key={bid.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10">
                        <div>
                          <span className="text-sm text-white font-medium">{bid.playerName}</span>
                          <span className="text-xs text-gray-400 ml-2">
                            → {teamNameById(bid.currentHighBidderId)} for {formatAuctionCurrency(bid.currentHighBid)}
                          </span>
                        </div>
                        <button
                          onClick={() => handleUndoSale(bid.id)}
                          disabled={undoingBid === bid.id}
                          className="px-3 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 text-xs font-medium disabled:opacity-50 transition"
                        >
                          {undoingBid === bid.id ? "Undoing..." : "Undo"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Manual Transfer */}
              <div>
                <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">Manual Transfer</h3>
                <p className="text-xs text-gray-500 mb-3">Select a player from Squad Overview above, then transfer them.</p>
                {auctionTeamSquads.flatMap((ts) => ts.squad.filter((p) => p.status === "active").map((p) => ({ ...p, teamName: ts.teamName, teamId: ts.teamId }))).length === 0 ? (
                  <p className="text-xs text-gray-500">No active players to transfer</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {auctionTeamSquads.flatMap((ts) =>
                      ts.squad.filter((p) => p.status === "active").map((p) => ({
                        ...p, teamName: ts.teamName, teamId: ts.teamId,
                      }))
                    ).map((player) => (
                      <div key={player.ownershipId} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10">
                        <div>
                          <span className="text-sm text-white font-medium">{player.playerName}</span>
                          <span className="text-xs text-gray-400 ml-2">({player.teamName} — {formatAuctionCurrency(player.purchasePrice)})</span>
                        </div>
                        {transferOwnershipId === player.ownershipId ? (
                          <div className="flex items-center gap-2">
                            <select
                              value={transferToTeamId}
                              onChange={(e) => setTransferToTeamId(e.target.value)}
                              className="px-2 py-1 rounded bg-slate-800 text-white text-xs border border-white/20"
                            >
                              <option value="">Select team...</option>
                              <option value="unowned">Remove (Refund)</option>
                              {teams.filter((t) => t.id !== player.teamId).map((t) => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => handleManualTransfer(player.ownershipId, transferToTeamId)}
                              disabled={!transferToTeamId || transferring}
                              className="px-2 py-1 rounded bg-blue-500/20 text-blue-400 text-xs disabled:opacity-50"
                            >
                              {transferring ? "..." : "Go"}
                            </button>
                            <button
                              onClick={() => { setTransferOwnershipId(null); setTransferToTeamId(""); }}
                              className="px-2 py-1 rounded bg-white/10 text-gray-400 text-xs"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setTransferOwnershipId(player.ownershipId)}
                            className="px-3 py-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 text-xs font-medium transition"
                          >
                            Transfer
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Reset Auction Modal */}
            {showAuctionResetConfirm && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setShowAuctionResetConfirm(false)}>
                <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-slate-900 p-6" onClick={(e) => e.stopPropagation()}>
                  <h3 className="text-xl font-bold text-red-400 mb-4">Reset Auction</h3>
                  <p className="text-sm text-gray-400 mb-4">This will permanently delete auction data. This action cannot be undone.</p>
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 mb-1 block">Reset to</label>
                    <select
                      value={auctionResetTarget}
                      onChange={(e) => setAuctionResetTarget(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-slate-800 text-white border border-white/20 text-sm"
                    >
                      <option value="initial">Before Club Auction (full wipe)</option>
                      {leagueConfig.clubAuctionEnabled && (
                        <option value="player-initial">Before Initial Player Auction (keep clubs)</option>
                      )}
                      <option value="mini-1">Before Mini-Auction 1</option>
                      <option value="mini-2">Before Mini-Auction 2</option>
                      <option value="mini-3">Before Mini-Auction 3</option>
                    </select>
                  </div>
                  {auctionResetTarget === "initial" && (
                    <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-[11px] text-red-200/90 space-y-1">
                      <p className="font-semibold">Full wipe (before club auction) clears:</p>
                      <ul className="list-disc list-inside text-red-200/80">
                        <li>Auction sessions, bids, and bid logs</li>
                        <li>Player ownerships, scores, and trade proposals</li>
                        <li><strong>PL club ownerships</strong> (so a fresh club auction can run)</li>
                        <li>Penalty slots and accumulated penalty ledger</li>
                        <li>Team purse, totalSpent, totalIncome, totalRefunds (reset to initial budget)</li>
                        <li><strong>All league notifications</strong></li>
                      </ul>
                      <p className="pt-1 text-red-200/70">Preserved: team accounts, wishlists, gameweeks, fixtures.</p>
                    </div>
                  )}
                  {auctionResetTarget === "player-initial" && (
                    <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-200/90 space-y-1">
                      <p className="font-semibold">Player reset (keeps the club auction) clears:</p>
                      <ul className="list-disc list-inside text-amber-200/80">
                        <li>Player auction + mini-auction sessions, bids, and logs</li>
                        <li>Player ownerships, scores, and trade proposals</li>
                        <li>Penalty slots, penalty ledger, and slot unlocks</li>
                        <li>Player-phase notifications (trades, GW results, slots) — <strong>club purchase notices kept</strong></li>
                        <li>Team purse restored to initial budget <strong>minus each team&apos;s club spend</strong></li>
                      </ul>
                      <p className="pt-1 text-amber-200/70">Preserved: <strong>PL club ownerships</strong>, the club auction session, team accounts, wishlists, gameweeks, fixtures.</p>
                    </div>
                  )}
                  <div className="flex gap-3">
                    <button
                      onClick={handleAuctionReset}
                      disabled={auctionResetting}
                      className="flex-1 px-4 py-2 rounded-lg bg-red-500 text-white font-bold hover:bg-red-600 disabled:opacity-50 transition"
                    >
                      {auctionResetting ? "Resetting..." : "Confirm Reset"}
                    </button>
                    <button
                      onClick={() => setShowAuctionResetConfirm(false)}
                      className="px-4 py-2 rounded-lg bg-white/10 text-gray-400 hover:bg-white/20 transition"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

        {/* Marketplace Tab (auction-only) */}
        {activeTab === "marketplace" && isAuctionFormat && leagueConfig.leagueDbId && (
          <AdminMarketplaceTab leagueId={leagueConfig.leagueDbId} />
        )}

        {/* Finance Tab (auction-only) */}
        {activeTab === "finance" && isAuctionFormat && leagueConfig.leagueDbId && (
          <AdminFinanceTab leagueId={leagueConfig.leagueDbId} />
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <div className="space-y-6">
            {!isAuctionFormat && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h3 className="text-lg font-bold text-white mb-4">Announcement Controls</h3>
              <p className="text-gray-400 text-sm mb-6">Toggle captain and chip announcements on or off. When disabled, teams cannot submit new announcements.</p>

              {settingsLoading ? (
                <p className="text-gray-400 text-sm">Loading…</p>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-xl bg-white/5">
                    <div>
                      <div className="font-semibold text-white">Captain Announcements</div>
                      <div className="text-sm text-gray-400">Allow teams to announce their captain for upcoming gameweeks</div>
                    </div>
                    <button
                      onClick={() => toggleSetting("captainAnnouncementEnabled", !captainAnnouncementEnabled)}
                      className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                        captainAnnouncementEnabled ? "bg-green-500" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        captainAnnouncementEnabled ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>

                  {leagueConfig.format !== "triple-crown" && (
                  <div className="flex items-center justify-between p-4 rounded-xl bg-white/5">
                    <div>
                      <div className="font-semibold text-white">Chip Announcements</div>
                      <div className="text-sm text-gray-400">Allow teams to submit TVT chips (Double Pointer, Challenge, Win-Win) for upcoming gameweeks</div>
                    </div>
                    <button
                      onClick={() => toggleSetting("chipAnnouncementEnabled", !chipAnnouncementEnabled)}
                      className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                        chipAnnouncementEnabled ? "bg-green-500" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        chipAnnouncementEnabled ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>
                  )}

                </div>
              )}
            </div>
            )}

            <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-6 backdrop-blur">
              <h3 className="text-lg font-bold text-red-400 mb-2">Reset Season Data</h3>
              <p className="text-gray-400 text-sm mb-4">
                Permanently delete all season data including teams, players, fixtures, results, gameweeks, captaincy, chips, playoff ties, and audit logs. User accounts, groups, and settings will be preserved.
              </p>
              {!showResetConfirm ? (
                <button
                  onClick={() => setShowResetConfirm(true)}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 transition-colors"
                >
                  Reset Season Data
                </button>
              ) : (
                <div className="space-y-4 rounded-xl bg-red-500/10 p-4">
                  <p className="text-red-300 text-sm font-semibold">⚠️ This action is irreversible. Enter your admin password to confirm.</p>
                  <input
                    type="password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    placeholder="Admin password"
                    className="w-full rounded-lg border border-red-500/30 bg-black/40 px-4 py-2 text-white placeholder-gray-500 focus:border-red-400 focus:outline-none"
                  />
                  <div className="flex gap-3">
                    <button
                      onClick={resetSeason}
                      disabled={resetLoading}
                      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {resetLoading ? "Resetting…" : "Confirm Reset"}
                    </button>
                    <button
                      onClick={() => { setShowResetConfirm(false); setResetPassword(""); }}
                      className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-white/5 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

          </div>
        )}

        {/* Restore Modal — rendered at the page-root level so it shows regardless of activeTab.
            Server-side guards (meta.json + leagueId + format) reject cross-league restore before
            any destructive operation; the UI just dispatches to the right /restore-{format} route. */}
        {showRestoreModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => !restoringAuction && setShowRestoreModal(false)}>
            <div className="w-full max-w-lg rounded-2xl border border-purple-500/30 bg-slate-900 p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-xl font-bold text-purple-300 mb-3">Restore from Backup</h3>
              <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 text-[11px] text-purple-200/90 mb-4 space-y-1">
                {isAuctionFormat ? (
                  <>
                    <p>This <strong>wipes the league&apos;s current auction state</strong> (sessions, bids, ownership, clubs, trades, scores, penalty slots) and restores from the chosen backup.</p>
                    <p>After restore, reprocess each GW from the Scoring tab to regenerate scores from the restored squads + clubs.</p>
                  </>
                ) : (
                  <>
                    <p>This <strong>wipes the league&apos;s current fixtures</strong> (and cascade-deletes results) and re-imports from the chosen backup.</p>
                    <p>Captains + Chips restore via this path is a tracked follow-up — use the Import Captain Data / Import Chip Data blocks if those need to be re-applied.</p>
                  </>
                )}
                <p className="text-purple-300/70">Team accounts and login IDs are <strong>not</strong> touched.</p>
                <p className="text-amber-300/90 pt-1">This backup must have been taken from this same league. Cross-league restore is rejected automatically.</p>
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">Source</label>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Saved snapshot</label>
                    <select
                      value={restoreBackupId ?? ""}
                      onChange={(e) => { setRestoreBackupId(e.target.value || null); if (e.target.value) setRestoreFile(null); }}
                      className="w-full px-3 py-2 rounded-lg bg-slate-800 text-white border border-white/20 text-sm"
                    >
                      <option value="">— choose a snapshot —</option>
                      {savedBackups
                        .filter(s => isAuctionFormat ? (s.includes.auctionSquads || s.includes.auctionClubs) : true)
                        .map(s => (
                          <option key={s.id} value={s.id}>
                            {formatBackupTrigger(s.trigger)} · {new Date(s.createdAt).toLocaleString()}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="text-center text-[10px] uppercase tracking-wider text-gray-500">— or —</div>
                  <div>
                    <label className="text-xs text-gray-400 block mb-1">Upload .zip backup</label>
                    <input
                      type="file"
                      accept=".zip"
                      onChange={(e) => { const f = e.target.files?.[0] ?? null; setRestoreFile(f); if (f) setRestoreBackupId(null); }}
                      className="w-full text-xs text-gray-300 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-purple-500/20 file:text-purple-200 file:cursor-pointer cursor-pointer"
                    />
                    {restoreFile && (
                      <p className="text-[11px] text-purple-300/80 mt-1">Selected: {restoreFile.name}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleRestoreAuction}
                  disabled={restoringAuction || (!restoreBackupId && !restoreFile)}
                  className="flex-1 px-4 py-2 rounded-lg bg-purple-500 text-white font-bold hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {restoringAuction ? "Restoring..." : "Restore Now"}
                </button>
                <button
                  onClick={() => setShowRestoreModal(false)}
                  disabled={restoringAuction}
                  className="px-4 py-2 rounded-lg bg-white/10 text-gray-400 hover:bg-white/20 transition disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Feedback Tab */}
        {activeTab === "feedback" && (
          <FeedbackTab
            endpoint={`/api/admin/${leagueId}/feedback`}
            scopeLabel="this league"
          />
        )}
      </div>
    </div>
  );
}

// ============================================
// Admin Marketplace Tab
// ============================================

interface AdminMarketplaceProposal {
  id: string;
  proposerTeamId: string;
  targetTeamId: string;
  offeredPlayerIds: string[];
  requestedPlayerIds: string[];
  cashOffered: number;
  status: string;
  createdAt: number;
}

interface AdminMarketplacePendingRelease {
  ownershipId: string;
  teamId: string;
  teamName: string;
  playerName: string;
  purchasePrice: number;
}

interface AdminSquadCache {
  [teamId: string]: { teamName: string; squad: { ownershipId: string; playerName: string; status: string; purchasePrice: number }[] };
}

const fmtMoney = formatCurrency;

const CHIP_NAMES: Record<string, string> = {
  W: "Win-Win",
  D: "Double Pointer",
  C: "Challenge Chip",
  SL: "Score Lock",
  CB: "Comeback",
  UD: "Underdog",
};

function formatChipLabel(code: string): string {
  return CHIP_NAMES[code] ? `${code} (${CHIP_NAMES[code]})` : code;
}

function AdminMarketplaceTab({ leagueId }: { leagueId: string }) {
  const [proposals, setProposals] = useState<AdminMarketplaceProposal[]>([]);
  const [pendingReleases, setPendingReleases] = useState<AdminMarketplacePendingRelease[]>([]);
  const [squadCache, setSquadCache] = useState<AdminSquadCache>({});
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      // Fetch summary to get team list
      const summaryRes = await fetch(`/api/auction/finance?leagueId=${leagueId}&allTeams=true`);
      const summaryJson = summaryRes.ok ? await summaryRes.json() : { teams: [] };
      const teamList: { teamId: string; teamName: string }[] = summaryJson.teams ?? [];

      // Fetch all squads in parallel
      const squadsArr = await Promise.all(
        teamList.map((t) =>
          fetch(`/api/auction/squad?teamId=${t.teamId}`).then((r) => (r.ok ? r.json() : null))
        )
      );
      const cache: AdminSquadCache = {};
      const pr: AdminMarketplacePendingRelease[] = [];
      squadsArr.forEach((sq, idx) => {
        if (!sq) return;
        const t = teamList[idx];
        cache[t.teamId] = { teamName: t.teamName, squad: sq.squad ?? [] };
        for (const p of sq.squad ?? []) {
          if (p.status === "pending_release") {
            pr.push({
              ownershipId: p.ownershipId,
              teamId: t.teamId,
              teamName: t.teamName,
              playerName: p.playerName,
              purchasePrice: p.purchasePrice,
            });
          }
        }
      });
      setSquadCache(cache);
      setPendingReleases(pr);

      const res = await fetch(`/api/auction/trade?leagueId=${leagueId}`);
      if (res.ok) {
        const json = await res.json();
        setProposals(json.proposals ?? []);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [leagueId]);

  useEffect(() => { load(); }, [load]);

  const handleTradeAction = async (proposalId: string, action: "approve" | "reject" | "cancel") => {
    const verb = action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Cancel";
    if (!confirm(`${verb} this trade proposal?`)) return;
    setActionError(null);
    try {
      const res = await fetch("/api/auction/trade/admin", {
        method: "POST",
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

  const teamName = (id: string) => squadCache[id]?.teamName ?? id.slice(0, 6);
  const playerNames = (teamId: string, ownershipIds: string[]) => {
    const squad = squadCache[teamId]?.squad ?? [];
    return ownershipIds
      .map((oid) => squad.find((p) => p.ownershipId === oid)?.playerName ?? "?")
      .join(", ") || "—";
  };

  if (loading) return <div className="text-gray-400 py-8 text-center">Loading marketplace…</div>;

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{actionError}</div>
      )}

      {/* Pending Releases */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <h3 className="text-lg font-bold text-white mb-3">Pending Releases ({pendingReleases.length})</h3>
        <p className="text-xs text-gray-400 mb-3">Finalize automatically at GW 10/20/30.</p>
        {pendingReleases.length === 0 ? (
          <div className="text-center text-gray-500 py-6">None</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase text-gray-400">
                  <th className="text-left py-2 px-2">Player</th>
                  <th className="text-left py-2 px-2">Team</th>
                  <th className="text-right py-2 px-2">Purchase</th>
                  <th className="text-right py-2 px-2">Refund</th>
                  <th className="text-right py-2 px-2">Forfeit</th>
                </tr>
              </thead>
              <tbody>
                {pendingReleases.map((p) => {
                  const refund = Math.floor(p.purchasePrice * 0.5);
                  return (
                    <tr key={p.ownershipId} className="border-b border-white/5">
                      <td className="py-2 px-2 text-white font-semibold">{p.playerName}</td>
                      <td className="py-2 px-2 text-gray-300">{p.teamName}</td>
                      <td className="py-2 px-2 text-right font-mono text-white">{fmtMoney(p.purchasePrice)}</td>
                      <td className="py-2 px-2 text-right font-mono text-green-300">+{fmtMoney(refund)}</td>
                      <td className="py-2 px-2 text-right font-mono text-red-300">-{fmtMoney(p.purchasePrice - refund)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Trade Proposals */}
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <h3 className="text-lg font-bold text-white mb-3">Trade Proposals ({proposals.length})</h3>
        {proposals.length === 0 ? (
          <div className="text-center text-gray-500 py-6">None</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase text-gray-400">
                  <th className="text-left py-2 px-2">Date</th>
                  <th className="text-left py-2 px-2">Proposer → Target</th>
                  <th className="text-left py-2 px-2">Offered</th>
                  <th className="text-left py-2 px-2">Requested</th>
                  <th className="text-right py-2 px-2">Cash</th>
                  <th className="text-center py-2 px-2">Status</th>
                  <th className="text-center py-2 px-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...proposals]
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((p) => (
                    <tr key={p.id} className="border-b border-white/5 align-top">
                      <td className="py-2 px-2 text-gray-400 text-xs whitespace-nowrap">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2 px-2 text-white text-xs">
                        {teamName(p.proposerTeamId)} → {teamName(p.targetTeamId)}
                      </td>
                      <td className="py-2 px-2 text-gray-300 text-xs">{playerNames(p.proposerTeamId, p.offeredPlayerIds)}</td>
                      <td className="py-2 px-2 text-gray-300 text-xs">{playerNames(p.targetTeamId, p.requestedPlayerIds)}</td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {p.cashOffered === 0 ? "—" : (
                          <span className={p.cashOffered > 0 ? "text-green-300" : "text-red-300"}>
                            {p.cashOffered > 0 ? "+" : ""}{fmtMoney(p.cashOffered)}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                          p.status === "pending" ? "bg-blue-500/20 text-blue-300 border-blue-500/40" :
                          p.status === "accepted" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
                          p.status === "completed" ? "bg-green-500/20 text-green-300 border-green-500/40" :
                          "bg-red-500/20 text-red-300 border-red-500/40"
                        }`}>{p.status}</span>
                      </td>
                      <td className="py-2 px-2 text-center">
                        <div className="flex gap-1 justify-center flex-wrap">
                          {p.status === "accepted" && (
                            <button
                              onClick={() => handleTradeAction(p.id, "approve")}
                              className="rounded bg-green-500/20 border border-green-500/40 text-green-300 text-xs px-2 py-1 hover:bg-green-500/30"
                            >
                              Approve
                            </button>
                          )}
                          {(p.status === "pending" || p.status === "accepted") && (
                            <button
                              onClick={() => handleTradeAction(p.id, "reject")}
                              className="rounded bg-red-500/20 border border-red-500/40 text-red-300 text-xs px-2 py-1 hover:bg-red-500/30"
                            >
                              Reject
                            </button>
                          )}
                          {p.status !== "completed" && p.status !== "cancelled" && p.status !== "rejected" && (
                            <button
                              onClick={() => handleTradeAction(p.id, "cancel")}
                              className="rounded bg-white/10 border border-white/20 text-gray-300 text-xs px-2 py-1 hover:bg-white/20"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Admin Finance Tab
// ============================================

interface AdminTeamSummary {
  teamId: string;
  teamName: string;
  purse: number;
  totalSpent: number;
  totalIncome: number;
  totalRefunds: number;
  totalForfeited: number;
  releasedCount: number;
  pendingReleaseCount: number;
  activeCount: number;
  netPnL: number;
}

interface AdminLedgerEntry {
  id: string;
  type: string;
  date: string;
  gw: number | null;
  description: string;
  amount: number;
  runningBalance: number;
  isPending: boolean;
}

interface AdminLedgerResponse {
  teamId: string;
  teamName: string;
  initialBudget: number;
  currentPurse: number;
  summary: { totalSpent: number; totalIncome: number; totalRefunds: number; totalForfeited: number; netPnL: number };
  ledger: AdminLedgerEntry[];
}

function AdminFinanceTab({ leagueId }: { leagueId: string }) {
  const [summaries, setSummaries] = useState<AdminTeamSummary[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [ledger, setLedger] = useState<AdminLedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/auction/finance?leagueId=${leagueId}&allTeams=true`);
      if (res.ok) {
        const json = await res.json();
        setSummaries(json.teams ?? []);
      }
      setLoading(false);
    })();
  }, [leagueId]);

  useEffect(() => {
    if (!selectedTeamId) return; // No team selected — let the previous ledger linger or display the empty state below.
    let cancelled = false;
    (async () => {
      setLedgerLoading(true);
      const res = await fetch(`/api/auction/finance?teamId=${selectedTeamId}`);
      if (cancelled) return;
      if (res.ok) setLedger(await res.json()); else setLedger(null);
      setLedgerLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId]);

  // Reset the ledger to null whenever the selection is cleared. Derived from selectedTeamId so we
  // don't need a sync setState inside the fetch effect.
  const ledgerForSelection = selectedTeamId ? ledger : null;

  if (loading) return <div className="text-gray-400 py-8 text-center">Loading finance audit…</div>;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
        <h3 className="text-lg font-bold text-white mb-3">All Teams — Finance Summary</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase text-gray-400">
                <th className="text-left py-2 px-2">Team</th>
                <th className="text-right py-2 px-2">Purse</th>
                <th className="text-right py-2 px-2">Spent</th>
                <th className="text-right py-2 px-2">Income</th>
                <th className="text-right py-2 px-2">Refunds</th>
                <th className="text-right py-2 px-2">Forfeited</th>
                <th className="text-right py-2 px-2">Net P&amp;L</th>
                <th className="text-center py-2 px-2">Squad</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr
                  key={s.teamId}
                  onClick={() => setSelectedTeamId(s.teamId)}
                  className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${selectedTeamId === s.teamId ? "bg-yellow-500/10" : ""}`}
                >
                  <td className="py-2 px-2 text-white font-semibold">{s.teamName}</td>
                  <td className="py-2 px-2 text-right font-mono text-green-300">{fmtMoney(s.purse)}</td>
                  <td className="py-2 px-2 text-right font-mono text-red-300">{fmtMoney(s.totalSpent)}</td>
                  <td className="py-2 px-2 text-right font-mono text-blue-300">{fmtMoney(s.totalIncome)}</td>
                  <td className="py-2 px-2 text-right font-mono text-green-300">{fmtMoney(s.totalRefunds)}</td>
                  <td className="py-2 px-2 text-right font-mono text-red-300">{fmtMoney(s.totalForfeited)}</td>
                  <td className={`py-2 px-2 text-right font-mono ${s.netPnL >= 0 ? "text-green-300" : "text-red-300"}`}>
                    {s.netPnL >= 0 ? "+" : ""}{fmtMoney(s.netPnL)}
                  </td>
                  <td className="py-2 px-2 text-center text-xs text-gray-400">
                    {s.activeCount}a / {s.pendingReleaseCount}p / {s.releasedCount}r
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedTeamId && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <h3 className="text-lg font-bold text-white mb-3">
            {ledgerForSelection?.teamName ?? "Team"} — Ledger
          </h3>
          {ledgerLoading ? (
            <div className="text-gray-400 py-4 text-center">Loading…</div>
          ) : !ledgerForSelection ? (
            <div className="text-red-400 py-4 text-center">Ledger unavailable</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs uppercase text-gray-400">
                    <th className="text-left py-2 px-2">GW</th>
                    <th className="text-left py-2 px-2">Date</th>
                    <th className="text-left py-2 px-2">Type</th>
                    <th className="text-left py-2 px-2">Description</th>
                    <th className="text-right py-2 px-2">Amount</th>
                    <th className="text-right py-2 px-2">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerForSelection.ledger.map((e) => (
                    <tr key={e.id} className={`border-b border-white/5 ${e.isPending ? "opacity-60" : ""}`}>
                      <td className="py-2 px-2 text-gray-400 font-mono">{e.gw ?? "—"}</td>
                      <td className="py-2 px-2 text-gray-400 text-xs whitespace-nowrap">
                        {new Date(e.date).toLocaleDateString()}
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-300">{e.type.replace(/_/g, " ")}</td>
                      <td className="py-2 px-2 text-white">{e.description}</td>
                      <td className={`py-2 px-2 text-right font-mono ${e.amount > 0 ? "text-green-300" : e.amount < 0 ? "text-red-300" : "text-gray-500"}`}>
                        {e.amount === 0 ? "—" : `${e.amount > 0 ? "+" : ""}${fmtMoney(e.amount)}`}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-white">{fmtMoney(e.runningBalance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
