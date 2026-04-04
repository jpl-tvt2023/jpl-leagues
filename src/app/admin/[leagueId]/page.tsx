"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import * as XLSX from "xlsx";
import { LoadingScreen } from "@/components/LoadingScreen";

interface Team {
  id: string;
  name: string;
  abbreviation: string;
  group: string;
  players: { id: string; name: string; fplId: string }[];
  needsPasswordChange: boolean;
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
}

interface ScoringResult {
  gameweek: number;
  processed: number;
  failed: number;
  results: {
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
    homeMatchPoints: number;
    awayMatchPoints: number;
  }[];
  errors?: { homeTeam: string; awayTeam: string; error: string }[];
}

interface CacheStats {
  totalEntries: number;
  gameweeks: { gameweek: number; entries: number }[];
}

type TabType = "teams" | "captain" | "chips" | "bulkUpload" | "scoring" | "playoffs" | "settings";

export default function AdminDashboard() {
  const params = useParams<{ leagueId: string }>();
  const leagueId = params.leagueId;

  const [activeTab, setActiveTab] = useState<TabType>("teams");
  const [teams, setTeams] = useState<Team[]>([]);
  const [leagueConfig, setLeagueConfig] = useState<{ teamSize: number; groupCount: number; playoffStartGw: number; enabledChips: string[]; format?: string }>({
    teamSize: 32, groupCount: 2, playoffStartGw: 31, enabledChips: ["D", "W", "C"],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    teamName: "",
    abbreviation: "",
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
  const [teamsData, setTeamsData] = useState<Record<string, string>[]>([]);
  const [fixturesData, setFixturesData] = useState<Record<string, string>[]>([]);
  const [captainsData, setCaptainsData] = useState<Record<string, string>[]>([]);
  const [chipsData, setChipsData] = useState<Record<string, string>[]>([]);
  const [teamsFileName, setTeamsFileName] = useState("");
  const [fixturesFileName, setFixturesFileName] = useState("");
  const [captainsFileName, setCaptainsFileName] = useState("");
  const [chipsFileName, setChipsFileName] = useState("");
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

  // Settings State
  const [captainAnnouncementEnabled, setCaptainAnnouncementEnabled] = useState(true);
  const [chipAnnouncementEnabled, setChipAnnouncementEnabled] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Reset Season State
  const [resetPassword, setResetPassword] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Edit Team State
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [editFormData, setEditFormData] = useState({
    teamId: "",
    teamName: "",
    abbreviation: "",
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
    } else if (activeTab === "chips") {
      fetchChipsData();
    } else if (activeTab === "scoring") {
      fetchGameweekStatuses();
      fetchCacheStats();
    } else if (activeTab === "playoffs") {
      fetchPlayoffStatus();
    } else if (activeTab === "settings") {
      fetchSettings();
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
            teamSize: league.teamSize ?? 32,
            groupCount: league.groupCount ?? 2,
            playoffStartGw: league.playoffStartGw ?? 31,
            enabledChips,
            format: league.format,
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
      const statuses: GameweekStatus[] = [];
      // Fetch status for GW1-38 (or until we find gameweeks with no fixtures)
      for (let gw = 1; gw <= 38; gw++) {
        const response = await fetch(`/api/gameweeks/${gw}?leagueId=${leagueId}`);
        if (response.ok) {
          const data = await response.json();
          if (data.gameweek && data.gameweek.fixturesCount > 0) {
            statuses.push({
              number: data.gameweek.number,
              fixturesCount: data.gameweek.fixturesCount,
              resultsProcessed: data.gameweek.resultsProcessed,
              isPending: data.gameweek.resultsProcessed < data.gameweek.fixturesCount,
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

  // Playoff functions
  const fetchPlayoffStatus = async () => {
    setPlayoffsLoading(true);
    try {
      const res = await fetch(`/api/admin/${leagueId}/generate-playoffs`);
      if (res.ok) {
        const data = await res.json();
        setPlayoffsGenerated(data.generated === true);
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

  const fetchSettings = async () => {
    setSettingsLoading(true);
    try {
      const res = await fetch(`/api/admin/${leagueId}/settings`);
      const data = await res.json();
      if (res.ok) {
        setCaptainAnnouncementEnabled(data.captainAnnouncementEnabled);
        setChipAnnouncementEnabled(data.chipAnnouncementEnabled);
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
        setMessage({ type: "success", text: `${key === "captainAnnouncementEnabled" ? "Captain" : "Chip"} announcements ${value ? "enabled" : "disabled"}` });
      } else {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to update setting" });
      }
    } catch {
      setMessage({ type: "error", text: "Network error" });
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
        teamName: "",
        abbreviation: "",
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

  const handleBulkUploadTeams = async () => {
    if (teamsData.length === 0) {
      setMessage({ type: "error", text: "Please upload an Excel file with teams data" });
      return;
    }
    setBulkUploading(true);
    setBulkUploadResult(null);
    setMessage(null);
    
    try {
      // Map Excel columns to expected format
      const teams = teamsData.map(row => ({
        teamName: row["Team Name"] || row["teamName"] || row["Name"] || "",
        abbreviation: row["Abbreviation"] || row["abbreviation"] || row["Abbr"] || "",
        password: row["Password"] || row["password"] || "",
        group: row["Group"] || row["group"] || "",
        player1Name: row["Player1 Name"] || row["player1Name"] || row["Player 1 Name"] || "",
        player1FplId: row["Player1 FPL ID"] || row["player1FplId"] || row["Player 1 FPL ID"] || "",
        player2Name: row["Player2 Name"] || row["player2Name"] || row["Player 2 Name"] || "",
        player2FplId: row["Player2 FPL ID"] || row["player2FplId"] || row["Player 2 FPL ID"] || "",
      }));

      const response = await fetch(`/api/admin/${leagueId}/bulk-upload-teams`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teams }),
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to upload teams" });
      } else {
        setBulkUploadResult(data);
        setMessage({ type: "success", text: `Teams uploaded: ${data.created} created, ${data.failed} failed` });
        setTeamsData([]);
        setTeamsFileName("");
        fetchTeams();
      }
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setBulkUploading(false);
    }
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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: "teams" | "fixtures" | "captains" | "chips") => {
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
        
        if (type === "teams") {
          setTeamsData(jsonData);
          setTeamsFileName(file.name);
        } else if (type === "fixtures") {
          setFixturesData(jsonData);
          setFixturesFileName(file.name);
        } else if (type === "captains") {
          setCaptainsData(jsonData);
          setCaptainsFileName(file.name);
        } else if (type === "chips") {
          setChipsData(jsonData);
          setChipsFileName(file.name);
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
      teamName: team.name,
      abbreviation: team.abbreviation,
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
      const response = await fetch(`/api/admin/${leagueId}/update-team`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editFormData),
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

  const groupATeams = teams.filter(t => t.group === "A");
  const groupBTeams = teams.filter(t => t.group === "B");
  const teamsPerGroup = Math.round(leagueConfig.teamSize / leagueConfig.groupCount);

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
              <h2 className="text-xl font-bold text-white mb-2">Delete Team</h2>
              <p className="text-gray-400 mb-6">
                Are you sure you want to delete <span className="text-white font-semibold">{deletingTeam.name}</span>? 
                This will also delete all players, fixtures, results, and captain data associated with this team.
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
                  {isDeleting ? "Deleting..." : "Delete Team"}
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
              <h2 className="text-xl font-bold text-white">Edit Team</h2>
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
                  <label className="block text-sm font-medium text-gray-300 mb-2">Team Name (Login ID)</label>
                  <input
                    type="text"
                    required
                    value={editFormData.teamName}
                    onChange={(e) => setEditFormData({ ...editFormData, teamName: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Team Abbreviation</label>
                  <input
                    type="text"
                    required
                    maxLength={3}
                    value={editFormData.abbreviation}
                    onChange={(e) => setEditFormData({ ...editFormData, abbreviation: e.target.value.toUpperCase() })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none uppercase"
                  />
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

              {/* Player 1 */}
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

              {/* Player 2 */}
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
          <Link href={`/standings?adminLeague=${leagueId}`} className="text-gray-300 hover:text-white transition">
            Standings
          </Link>
          <Link href={`/fixtures?adminLeague=${leagueId}`} className="text-gray-300 hover:text-white transition">
            Fixtures
          </Link>
          <Link href={`/playoffs?adminLeague=${leagueId}`} className="text-gray-300 hover:text-white transition">
            Playoffs
          </Link>
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
            Team Management
          </button>
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
          <button
            onClick={() => { setActiveTab("chips"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "chips"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Chips Override
          </button>
          <button
            onClick={() => { setActiveTab("bulkUpload"); setMessage(null); }}
            className={`px-3 sm:px-4 py-2 rounded-lg font-semibold text-sm sm:text-base whitespace-nowrap transition ${
              activeTab === "bulkUpload"
                ? "bg-yellow-500 text-slate-900"
                : "bg-white/5 text-gray-300 hover:bg-white/10"
            }`}
          >
            Bulk Upload
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
                <h1 className="text-3xl font-bold text-white">Team Management</h1>
                <p className="text-gray-400 mt-1">Create and manage teams in the league</p>
              </div>
              <button
                onClick={() => setShowCreateForm(!showCreateForm)}
                className="rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
              >
                {showCreateForm ? "Cancel" : "+ Create Team"}
              </button>
            </div>

            {/* Create Team Form */}
            {showCreateForm && (
              <div className="mb-8 rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                <h2 className="text-xl font-bold text-white mb-6">Create New Team</h2>

                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Team Details */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">Team Name (Login ID)</label>
                      <input
                        type="text"
                        required
                        value={formData.teamName}
                        onChange={(e) => setFormData({ ...formData, teamName: e.target.value })}
                        placeholder="DM — Rahul"
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                      />
                      <p className="text-xs text-gray-500 mt-1">Both team members will use this to login</p>
                    </div>
                    <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Team Abbreviation</label>
                  <input
                    type="text"
                    required
                    maxLength={3}
                    value={formData.abbreviation}
                    onChange={(e) => setFormData({ ...formData, abbreviation: e.target.value.toUpperCase() })}
                    placeholder="DM"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none uppercase"
                  />
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

              {/* Player 1 */}
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

              {/* Player 2 */}
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

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
              >
                {isSubmitting ? "Creating..." : "Create Team"}
              </button>
            </form>
          </div>
        )}

        {/* Stats */}
        <div className={`grid grid-cols-2 ${leagueConfig.groupCount === 2 ? "md:grid-cols-4" : "md:grid-cols-3"} gap-4 mb-8`}>
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
            <div className="text-3xl font-bold text-yellow-400">{teams.length}</div>
            <div className="text-sm text-gray-400">Total Teams</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
            <div className="text-3xl font-bold text-blue-400">{groupATeams.length}/{teamsPerGroup}</div>
            <div className="text-sm text-gray-400">{leagueConfig.groupCount === 2 ? "Group A" : "Group"}</div>
          </div>
          {leagueConfig.groupCount === 2 && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
              <div className="text-3xl font-bold text-purple-400">{groupBTeams.length}/{teamsPerGroup}</div>
              <div className="text-sm text-gray-400">Group B</div>
            </div>
          )}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur">
            <div className="text-3xl font-bold text-green-400">{leagueConfig.teamSize - teams.length}</div>
            <div className="text-sm text-gray-400">Spots Left</div>
          </div>
        </div>

        {/* Teams List */}
        {isLoading ? (
          <LoadingScreen variant="admin" fullScreen={false} />
        ) : (
          <div className={`grid ${leagueConfig.groupCount === 2 ? "md:grid-cols-2" : "md:grid-cols-1"} gap-8`}>
            {/* Group A */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h3 className="text-xl font-bold text-blue-400 mb-4">{leagueConfig.groupCount === 2 ? "Group A" : "League"} ({groupATeams.length}/{teamsPerGroup})</h3>
              {groupATeams.length === 0 ? (
                <p className="text-gray-500">No teams yet</p>
              ) : (
                <div className="space-y-3">
                  {groupATeams.map((team, index) => (
                    <div key={team.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                      <div className="flex items-center gap-3">
                        <span className="text-gray-500 w-6">{index + 1}.</span>
                        <div>
                          <div className="font-semibold text-white">{team.name}</div>
                          <div className="text-xs text-gray-400">
                            {team.players.map(p => p.name).join(" & ")}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
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
                        <span className={`text-xs ${team.needsPasswordChange ? "text-yellow-400" : "text-green-400"}`}>
                          {team.needsPasswordChange ? "Pending" : "Active"}
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
              <h3 className="text-xl font-bold text-purple-400 mb-4">Group B ({groupBTeams.length}/{teamsPerGroup})</h3>
              {groupBTeams.length === 0 ? (
                <p className="text-gray-500">No teams yet</p>
              ) : (
                <div className="space-y-3">
                  {groupBTeams.map((team, index) => (
                    <div key={team.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                      <div className="flex items-center gap-3">
                        <span className="text-gray-500 w-6">{index + 1}.</span>
                        <div>
                          <div className="font-semibold text-white">{team.name}</div>
                          <div className="text-xs text-gray-400">
                            {team.players.map(p => p.name).join(" & ")}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
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
                        <span className={`text-xs ${team.needsPasswordChange ? "text-yellow-400" : "text-green-400"}`}>
                          {team.needsPasswordChange ? "Pending" : "Active"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}
          </div>
        )}

        {/* Quick Actions */}
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
          </div>
        </div>
          </>
        )}

        {/* Captain Override Tab */}
        {activeTab === "captain" && (
          <>
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-white">Captain Override</h1>
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

        {/* Chips Override Tab */}
        {activeTab === "chips" && (
          <>
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-white">Chips Override</h1>
              <p className="text-gray-400 mt-1">Reset or mark chips as used for teams in case of technical issues</p>
            </div>

            {chipsLoading ? (
              <div className="text-center text-gray-400 py-12">Loading chips data...</div>
            ) : (
              <>
                {/* Override Form */}
                <div className="mb-8 rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
                  <h2 className="text-xl font-bold text-white mb-6">Update Chip Status</h2>

                  <form onSubmit={handleChipsOverride} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Select Team</label>
                        <select
                          required
                          value={chipOverride.teamId}
                          onChange={(e) => setChipOverride({ ...chipOverride, teamId: e.target.value })}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:border-yellow-500 focus:outline-none"
                        >
                          <option value="" className="bg-slate-800">Select a team...</option>
                          {chipTeams.map((team) => (
                            <option key={team.id} value={team.id} className="bg-slate-800">
                              {team.name} (Group {team.group})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Select Chip</label>
                        {(() => {
                          const CHIP_KEY: Record<string, string> = { W: "winWin", D: "doublePointer", C: "challengeChip", SL: "scoreLock", CB: "comeback", UD: "underdog" };
                          const CHIP_NAME: Record<string, string> = { W: "Win-Win", D: "Double Pointer", C: "Challenge Chip", SL: "Score Lock", CB: "Comeback", UD: "Underdog" };
                          const mid = Math.ceil((leagueConfig.playoffStartGw - 1) / 2);
                          const stageEnd = leagueConfig.playoffStartGw - 1;
                          return (
                            <select
                              required
                              value={chipOverride.chipType}
                              onChange={(e) => setChipOverride({ ...chipOverride, chipType: e.target.value })}
                              className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white focus:border-yellow-500 focus:outline-none"
                            >
                              <option value="" className="bg-slate-800">Select a chip...</option>
                              {leagueConfig.enabledChips.map(code => (
                                <option key={`${code}Set1`} value={`${CHIP_KEY[code]}Set1`} className="bg-slate-800">
                                  {CHIP_NAME[code]} (Set 1, GW1-{mid})
                                </option>
                              ))}
                              {leagueConfig.enabledChips.map(code => (
                                <option key={`${code}Set2`} value={`${CHIP_KEY[code]}Set2`} className="bg-slate-800">
                                  {CHIP_NAME[code]} (Set 2, GW{mid + 1}-{stageEnd})
                                </option>
                              ))}
                            </select>
                          );
                        })()}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Set Status To</label>
                        <div className="flex gap-4">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="chipStatus"
                              checked={chipOverride.status === "available"}
                              onChange={() => setChipOverride({ ...chipOverride, status: "available" })}
                              className="w-4 h-4 text-yellow-500"
                            />
                            <span className="text-green-400">Available (reset)</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="chipStatus"
                              checked={chipOverride.status === "used"}
                              onChange={() => setChipOverride({ ...chipOverride, status: "used" })}
                              className="w-4 h-4 text-yellow-500"
                            />
                            <span className="text-red-400">Used</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="chipStatus"
                              checked={chipOverride.status === "wasted"}
                              onChange={() => setChipOverride({ ...chipOverride, status: "wasted" })}
                              className="w-4 h-4 text-yellow-500"
                            />
                            <span className="text-orange-400">Used but wasted</span>
                          </label>
                        </div>
                      </div>

                      {chipOverride.status !== "available" && (
                        <div>
                          <label className="block text-sm font-medium text-gray-300 mb-2">Gameweek Used</label>
                          <input
                            type="number"
                            required
                            min={1}
                            max={leagueConfig.playoffStartGw - 1}
                            value={chipOverride.gameweek}
                            onChange={(e) => setChipOverride({ ...chipOverride, gameweek: e.target.value })}
                            placeholder={chipOverride.chipType.includes("Set1") ? `1-${Math.ceil((leagueConfig.playoffStartGw - 1) / 2)}` : `${Math.ceil((leagueConfig.playoffStartGw - 1) / 2) + 1}-${leagueConfig.playoffStartGw - 1}`}
                            className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                          />
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">Reason (optional)</label>
                        <input
                          type="text"
                          value={chipOverride.reason}
                          onChange={(e) => setChipOverride({ ...chipOverride, reason: e.target.value })}
                          placeholder="e.g., Chip used by accident, system error"
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
                    >
                      {isSubmitting ? "Updating..." : "Update Chip Status"}
                    </button>
                  </form>
                </div>

                {/* Team Chips Status */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h3 className="text-xl font-bold text-white mb-4">Team Chips Status</h3>

                  {/* Team Filter */}
                  <div className="flex flex-wrap gap-4 mb-4">
                    <div className="min-w-[180px]">
                      <label className="block text-xs text-gray-400 mb-1">Team</label>
                      <select
                        value={chipFilterTeam}
                        onChange={(e) => setChipFilterTeam(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-yellow-500 focus:outline-none"
                      >
                        <option value="" className="bg-slate-800">All Teams</option>
                        {chipTeams.map((team) => (
                          <option key={team.id} value={team.id} className="bg-slate-800">
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {chipTeams.length === 0 ? (
                    <p className="text-gray-500">No teams found</p>
                  ) : (
                    <div className="space-y-4">
                      {chipTeams.filter((team) => !chipFilterTeam || team.id === chipFilterTeam).map((team) => (
                        <div key={team.id} className="p-4 rounded-lg bg-white/5">
                          <div className="font-semibold text-white mb-3">{team.name} (Group {team.group})</div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                            {/* Set 1 */}
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className={team.chips.set1.doublePointer.used ? (team.chips.set1.doublePointer.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>●</span>
                                <span className="text-gray-300">DP Set1:</span>
                                <span className={team.chips.set1.doublePointer.used ? (team.chips.set1.doublePointer.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>
                                  {team.chips.set1.doublePointer.used 
                                    ? (team.chips.set1.doublePointer.wasted 
                                        ? `Wasted in GW${team.chips.set1.doublePointer.gameweek ?? "?"}` 
                                        : `Used in GW${team.chips.set1.doublePointer.gameweek ?? "?"}`)
                                    : "Available"}
                                </span>
                              </div>
                              {team.chips.set1.doublePointer.used && (
                                <span className={`ml-5 text-xs ${team.chips.set1.doublePointer.points > 0 ? "text-green-400" : "text-gray-500"}`}>
                                  +{team.chips.set1.doublePointer.points} points
                                </span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className={team.chips.set1.challengeChip.used ? (team.chips.set1.challengeChip.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>●</span>
                                <span className="text-gray-300">CC Set1:</span>
                                <span className={team.chips.set1.challengeChip.used ? (team.chips.set1.challengeChip.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>
                                  {team.chips.set1.challengeChip.used 
                                    ? (team.chips.set1.challengeChip.wasted 
                                        ? `Wasted in GW${team.chips.set1.challengeChip.gameweek ?? "?"}` 
                                        : `Used in GW${team.chips.set1.challengeChip.gameweek ?? "?"}`)
                                    : "Available"}
                                </span>
                              </div>
                              {team.chips.set1.challengeChip.used && (
                                <span className={`ml-5 text-xs ${team.chips.set1.challengeChip.points > 0 ? "text-green-400" : "text-gray-500"}`}>
                                  +{team.chips.set1.challengeChip.points} points
                                </span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className={team.chips.set1.winWin.used ? (team.chips.set1.winWin.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>●</span>
                                <span className="text-gray-300">WW Set1:</span>
                                <span className={team.chips.set1.winWin.used ? (team.chips.set1.winWin.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>
                                  {team.chips.set1.winWin.used 
                                    ? (team.chips.set1.winWin.wasted 
                                        ? `Wasted in GW${team.chips.set1.winWin.gameweek ?? "?"}` 
                                        : `Used in GW${team.chips.set1.winWin.gameweek ?? "?"}`)
                                    : "Available"}
                                </span>
                              </div>
                              {team.chips.set1.winWin.used && (
                                <span className={`ml-5 text-xs ${team.chips.set1.winWin.points > 0 ? "text-green-400" : "text-gray-500"}`}>
                                  +{team.chips.set1.winWin.points} points
                                </span>
                              )}
                            </div>
                            {/* Set 2 */}
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className={team.chips.set2.doublePointer.used ? (team.chips.set2.doublePointer.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>●</span>
                                <span className="text-gray-300">DP Set2:</span>
                                <span className={team.chips.set2.doublePointer.used ? (team.chips.set2.doublePointer.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>
                                  {team.chips.set2.doublePointer.used 
                                    ? (team.chips.set2.doublePointer.wasted 
                                        ? `Wasted in GW${team.chips.set2.doublePointer.gameweek ?? "?"}` 
                                        : `Used in GW${team.chips.set2.doublePointer.gameweek ?? "?"}`)
                                    : "Available"}
                                </span>
                              </div>
                              {team.chips.set2.doublePointer.used && (
                                <span className={`ml-5 text-xs ${team.chips.set2.doublePointer.points > 0 ? "text-green-400" : "text-gray-500"}`}>
                                  +{team.chips.set2.doublePointer.points} points
                                </span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className={team.chips.set2.challengeChip.used ? (team.chips.set2.challengeChip.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>●</span>
                                <span className="text-gray-300">CC Set2:</span>
                                <span className={team.chips.set2.challengeChip.used ? (team.chips.set2.challengeChip.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>
                                  {team.chips.set2.challengeChip.used 
                                    ? (team.chips.set2.challengeChip.wasted 
                                        ? `Wasted in GW${team.chips.set2.challengeChip.gameweek ?? "?"}` 
                                        : `Used in GW${team.chips.set2.challengeChip.gameweek ?? "?"}`)
                                    : "Available"}
                                </span>
                              </div>
                              {team.chips.set2.challengeChip.used && (
                                <span className={`ml-5 text-xs ${team.chips.set2.challengeChip.points > 0 ? "text-green-400" : "text-gray-500"}`}>
                                  +{team.chips.set2.challengeChip.points} points
                                </span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2">
                                <span className={team.chips.set2.winWin.used ? (team.chips.set2.winWin.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>●</span>
                                <span className="text-gray-300">WW Set2:</span>
                                <span className={team.chips.set2.winWin.used ? (team.chips.set2.winWin.wasted ? "text-orange-400" : "text-red-400") : "text-green-400"}>
                                  {team.chips.set2.winWin.used 
                                    ? (team.chips.set2.winWin.wasted 
                                        ? `Wasted in GW${team.chips.set2.winWin.gameweek ?? "?"}` 
                                        : `Used in GW${team.chips.set2.winWin.gameweek ?? "?"}`)
                                    : "Available"}
                                </span>
                              </div>
                              {team.chips.set2.winWin.used && (
                                <span className={`ml-5 text-xs ${team.chips.set2.winWin.points > 0 ? "text-green-400" : "text-gray-500"}`}>
                                  +{team.chips.set2.winWin.points} points
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
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
              <h1 className="text-3xl font-bold text-white">Bulk Upload</h1>
              <p className="text-gray-400 mt-1">Upload teams and fixtures via Excel (.xlsx)</p>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
              {/* Teams Upload */}
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <h3 className="text-xl font-bold text-white mb-4">Upload Teams</h3>
                <p className="text-gray-400 text-sm mb-4">
                  Excel columns: Team Name, Abbreviation, Password, Group, Player1 Name, Player1 FPL ID, Player2 Name, Player2 FPL ID
                </p>
                
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-300 mb-2">Upload Excel File</label>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => handleFileUpload(e, "teams")}
                    className="w-full text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-yellow-500/20 file:text-yellow-400 hover:file:bg-yellow-500/30"
                  />
                </div>

                {teamsFileName && (
                  <div className="mb-4 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <p className="text-green-400 text-sm">
                      ✓ Loaded: {teamsFileName} ({teamsData.length} rows)
                    </p>
                  </div>
                )}
                
                <button
                  onClick={handleBulkUploadTeams}
                  disabled={bulkUploading || teamsData.length === 0}
                  className="w-full rounded-lg bg-gradient-to-r from-blue-400 to-blue-600 px-6 py-3 font-semibold text-white hover:from-blue-300 hover:to-blue-500 transition disabled:opacity-50"
                >
                  {bulkUploading ? "Uploading..." : "Upload Teams"}
                </button>
              </div>

              {/* Fixtures Upload */}
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                <h3 className="text-xl font-bold text-white mb-4">Upload Fixtures</h3>
                <p className="text-gray-400 text-sm mb-4">
                  Excel columns: Gameweek, Home Team, Away Team
                </p>
                
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-300 mb-2">Upload Excel File</label>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => handleFileUpload(e, "fixtures")}
                    className="w-full text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-purple-500/20 file:text-purple-400 hover:file:bg-purple-500/30"
                  />
                </div>

                {fixturesFileName && (
                  <div className="mb-4 p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                    <p className="text-green-400 text-sm">
                      ✓ Loaded: {fixturesFileName} ({fixturesData.length} rows)
                    </p>
                  </div>
                )}
                
                <button
                  onClick={handleBulkUploadFixtures}
                  disabled={bulkUploading || fixturesData.length === 0}
                  className="w-full rounded-lg bg-gradient-to-r from-purple-400 to-purple-600 px-6 py-3 font-semibold text-white hover:from-purple-300 hover:to-purple-500 transition disabled:opacity-50"
                >
                  {bulkUploading ? "Uploading..." : "Upload Fixtures"}
                </button>
              </div>
            </div>

            {/* Captain Import Section */}
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

            {/* TVT Chips Import Section */}
            <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h3 className="text-xl font-bold text-white mb-4">Import TVT Chips Data</h3>
              <p className="text-gray-400 text-sm mb-2">
                First column must be <span className="text-white font-medium">Team</span> (full name or abbreviation), followed by gameweek numbers (1, 2, 3…) with chip markers.
              </p>
              <div className="mb-4 overflow-x-auto">
                <table className="text-xs text-gray-300 border-collapse">
                  <thead>
                    <tr className="text-gray-400">
                      <th className="border border-white/10 px-3 py-1 bg-white/5 text-left">Team</th>
                      {[1,2,3,"...",15,16,17,"...",30].map((h, i) => (
                        <th key={i} className="border border-white/10 px-3 py-1 bg-white/5">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-white/10 px-3 py-1 text-white">Team Alpha</td>
                      <td className="border border-white/10 px-3 py-1 text-green-400 text-center">W</td>
                      <td className="border border-white/10 px-3 py-1"></td>
                      <td className="border border-white/10 px-3 py-1 text-blue-400 text-center">D</td>
                      <td className="border border-white/10 px-3 py-1 text-gray-500 text-center">…</td>
                      <td className="border border-white/10 px-3 py-1 text-purple-400 text-center">C</td>
                      <td className="border border-white/10 px-3 py-1"></td>
                      <td className="border border-white/10 px-3 py-1 text-green-400 text-center">W</td>
                      <td className="border border-white/10 px-3 py-1 text-gray-500 text-center">…</td>
                      <td className="border border-white/10 px-3 py-1"></td>
                    </tr>
                    <tr>
                      <td className="border border-white/10 px-3 py-1 text-white">TBeta</td>
                      <td className="border border-white/10 px-3 py-1"></td>
                      <td className="border border-white/10 px-3 py-1 text-blue-400 text-center">D</td>
                      <td className="border border-white/10 px-3 py-1"></td>
                      <td className="border border-white/10 px-3 py-1 text-gray-500 text-center">…</td>
                      <td className="border border-white/10 px-3 py-1"></td>
                      <td className="border border-white/10 px-3 py-1 text-green-400 text-center">WW</td>
                      <td className="border border-white/10 px-3 py-1"></td>
                      <td className="border border-white/10 px-3 py-1 text-gray-500 text-center">…</td>
                      <td className="border border-white/10 px-3 py-1 text-purple-400 text-center">C</td>
                    </tr>
                  </tbody>
                </table>
                <p className="text-gray-500 text-xs mt-1">Team column accepts full name (e.g. <span className="text-gray-300">Team Alpha</span>) or abbreviation (e.g. <span className="text-gray-300">TBeta</span>)</p>
              </div>
              <p className="text-gray-400 text-sm mb-3">Chip markers:</p>
              <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
                <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                  <span className="font-bold text-green-400">W</span>
                  <span className="text-gray-300"> = Win-Win (2pts regardless of result)</span>
                </div>
                <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
                  <span className="font-bold text-blue-400">D</span>
                  <span className="text-gray-300"> = Double Pointer (2x match points)</span>
                </div>
                <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
                  <span className="font-bold text-purple-400">C</span>
                  <span className="text-gray-300"> = Challenge (vs top-2 opponent)</span>
                </div>
              </div>
              
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Upload Excel File</label>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => handleFileUpload(e, "chips")}
                    className="w-full text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-pink-500/20 file:text-pink-400 hover:file:bg-pink-500/30"
                  />
                </div>

                <div className="flex items-end">
                  <button
                    onClick={handleImportChips}
                    disabled={bulkUploading || chipsData.length === 0}
                    className="w-full rounded-lg bg-gradient-to-r from-pink-400 to-pink-600 px-6 py-3 font-semibold text-white hover:from-pink-300 hover:to-pink-500 transition disabled:opacity-50"
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

              <div className="mt-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                <p className="text-yellow-400 text-sm">
                  <strong>Note:</strong> Chips will be validated during import. Win-Win cannot have transfer hits,
                  Double Pointer blocked in GW1, Challenge must target top-2 from opposite group.
                  Chip sets: Set 1 (GW1–{Math.ceil((leagueConfig.playoffStartGw - 1) / 2)}), Set 2 (GW{Math.ceil((leagueConfig.playoffStartGw - 1) / 2) + 1}–{leagueConfig.playoffStartGw - 1}).
                </p>
              </div>
            </div>

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
                <div className="text-center text-gray-400 py-8 text-sm">No gameweeks with fixtures found</div>
              ) : (
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
                      {result.results.length > 0 && (
                        <div className="space-y-2">
                          {result.results.map((match, mIdx) => (
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
                              {err.homeTeam} vs {err.awayTeam}: {err.error}
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
                  <h3 className="text-lg font-bold text-white mb-4">Cup Groups (GW1–24)</h3>
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
                    </div>
                  )}
                </div>

                {/* Triple Crown: Advance Knockouts */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h3 className="text-lg font-bold text-white mb-4">Advance Knockouts</h3>
                  {playoffsGenerated && (
                    <div>
                      <p className="text-gray-400 text-sm mb-4">Advance UCL/UEL knockout rounds after each gameweek is scored.</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {[27, 29, 33, 35, 38].map((gw) => (
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
                        GW27: QF Leg 1 | GW29: QF Leg 2 / SF Leg 1 | GW33: SF Leg 2 | GW35: SF Leg 2 / Final Leg 1 | GW38: Final
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

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <div className="space-y-6">
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
                </div>
              )}
            </div>

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
      </div>
    </div>
  );
}
