"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { LoadingScreen } from "@/components/LoadingScreen";
import { FeedbackTab } from "../admin/[leagueId]/FeedbackTab";
import { Logo } from "@/components/Logo";

interface League {
  id: string;
  slug: string;
  name: string;
  sport: string;
  format: string;
  season: string;
  isActive: boolean;
  createdAt: string;
  teamCount: number;
  currentGameweek: number | null;
}

interface Admin {
  id: string;
  name: string;
  email: string;
  role: string;
  mustChangePassword: boolean;
  createdAt: string;
  assignedLeagueIds: string[];
}

type TabType = "leagues" | "admins" | "operations" | "pl-standings" | "score-adjustments" | "feedback";

// ── PL Standings (Club Auction tier mapping) ──
type PLBootstrapTeam = { id: number; name: string; short_name: string };
type PLStandingsState = {
  season: string;
  top8: number[];
  mid: number[];
  promoted: number[];
  updatedAt: string | null;
  plTeams: PLBootstrapTeam[];
};
const STANDINGS_TIER_META: Record<"top8" | "mid" | "promoted", { label: string; pillCls: string; expected: number }> = {
  top8:     { label: "Top 8 (last season finish 1-8)",  pillCls: "bg-yellow-500/20 text-yellow-200 border-yellow-500/30", expected: 8 },
  mid:      { label: "Mid (last season finish 9-17)",  pillCls: "bg-blue-500/20 text-blue-200 border-blue-500/30", expected: 9 },
  promoted: { label: "Promoted (3 new from Championship)", pillCls: "bg-emerald-500/20 text-emerald-200 border-emerald-500/30", expected: 3 },
};

// ── Operations: process-all run summary ──
type ProcessAllLeagueResult = {
  leagueId: string;
  slug: string;
  format: string;
  status: "ok" | "partial" | "error" | "skipped";
  scoredGws: number[];
  advancedGws: number[];
  generatedFor: number[];
  generatedAlready: number[];
  advanceWindowFuture: number[];
  errors: Array<{ gw?: number; step: "score" | "generate" | "advance" | "auction" | "league"; message: string }>;
};

// ── Per-GW chip state, populated as each /league-gw call returns ──
type GwChipState = "queued" | "processing" | "ok" | "skipped" | "error";

type LeagueGwResult = {
  leagueId: string;
  slug: string;
  gw: number;
  status: "ok" | "skipped" | "error";
  scored: boolean;
  scoreSkipped: boolean;
  generated: boolean;
  generatedAlready: boolean;
  advanced: boolean;
  advanceSkipped: boolean;
  advanceWindowFuture: boolean;
  errors: Array<{ step: "score" | "generate" | "advance" | "auction"; message: string }>;
};

// ──────────────────────────────────────────────
// Create-league wizard steps
type WizardStep = "sport" | "format" | "team_size" | "chips" | "details" | "assign";
const SPORT_OPTIONS = [
  { value: "fpl", label: "Football (FPL)", icon: "⚽" },
  { value: "cricket", label: "Cricket", icon: "🏏", comingSoon: true },
];
const FORMAT_OPTIONS: Record<string, { value: string; label: string; description: string; comingSoon?: boolean }[]> = {
  fpl: [
    { value: "tvt", label: "TVT", description: "Head-to-head, chips, captaincy, playoffs" },
    { value: "continental-championship", label: "JPL Continental Championship", description: "JPL + JCL + JEL — 20 teams, Double Header scoring" },
    { value: "auction", label: "JPL Auction", description: "14-player squads, live auctions, economy system — total points league" },
    { value: "classic", label: "Classic", description: "Round-robin / points-based", comingSoon: true },
  ],
};
const CHIP_OPTIONS: { code: string; name: string; description: string }[] = [
  { code: "W", name: "Win-Win", description: "If both players in your team finish with positive scores this GW, earn an extra league point." },
  { code: "D", name: "Double Pointer", description: "Your match points (W/D/L) are doubled this GW. Eligibility restrictions apply." },
  { code: "C", name: "Challenge Chip", description: "Replace your scheduled fixture with a match against a top-2 team from the opposite group." },
  { code: "SL", name: "Score Lock", description: "Your GW score is guaranteed at least your season average. Low scores are floored at your average." },
  { code: "CB", name: "Comeback", description: "If you lost the previous GW and win this one, earn +1 extra league point." },
  { code: "UD", name: "Underdog", description: "If you are ranked 3+ places below your opponent and you win, earn +1 extra league point." },
];
const TEAM_SIZE_OPTIONS = [
  {
    teamSize: 32, groupCount: 2, label: "32 Teams", sublabel: "2 groups of 16",
    description: "Full league — 30 GW group stage, RO16 → QF → SF → Final playoffs (GW31-38)",
  },
  {
    teamSize: 16, groupCount: 1, label: "16 Teams", sublabel: "1 group of 16",
    description: "Mid-size — 30 GW group stage, QF → SF → Final playoffs (GW31-36)",
  },
  {
    teamSize: 8, groupCount: 1, label: "8 Teams", sublabel: "1 group of 8",
    description: "Compact — 35 GW group stage (5× round-robin), SF + Final playoffs (GW36-38)",
  },
];
// ──────────────────────────────────────────────

export default function SuperAdminDashboard() {
  const [activeTab, setActiveTab] = useState<TabType>("leagues");
  const [leagues, setLeagues] = useState<League[]>([]);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // ── Create-league wizard ──
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>("sport");
  const [leagueForm, setLeagueForm] = useState({
    slug: "", name: "", sport: "", format: "", season: "",
    teamSize: 32, groupCount: 2, playoffStartGw: 31,
    enabledChips: ["D", "W", "C"] as string[],
    initialBudget: 100_000_000,
    isSimulated: false,
    clubAuctionEnabled: false,
    auctionTier: "complete" as "primary" | "complete",
  });
  const [wizardSelectedAdminIds, setWizardSelectedAdminIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ── Edit League modal ──
  const [editingLeague, setEditingLeague] = useState<League | null>(null);
  const [editLeagueForm, setEditLeagueForm] = useState({ name: "", season: "", enabledChips: [] as string[] });
  const [editLeagueAdminIds, setEditLeagueAdminIds] = useState<string[]>([]);

  // ── Delete League modal ──
  const [deletingLeague, setDeletingLeague] = useState<League | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Admin CRUD modals ──
  const [showCreateAdmin, setShowCreateAdmin] = useState(false);
  const [adminForm, setAdminForm] = useState({ name: "", email: "", password: "" });
  const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);
  const [editAdminForm, setEditAdminForm] = useState({ name: "", email: "", password: "" });
  const [deletingAdmin, setDeletingAdmin] = useState<Admin | null>(null);
  const [assigningAdmin, setAssigningAdmin] = useState<Admin | null>(null);
  const [assignedLeagueIds, setAssignedLeagueIds] = useState<string[]>([]);
  const [adminActionLoading, setAdminActionLoading] = useState(false);

  // ── PL Standings (Club Auction tier mapping) ──
  const [standings, setStandings] = useState<PLStandingsState | null>(null);
  const [standingsLoading, setStandingsLoading] = useState(false);
  const [standingsSaving, setStandingsSaving] = useState(false);

  const fetchStandings = useCallback(async () => {
    setStandingsLoading(true);
    try {
      const res = await fetch("/api/superadmin/pl-standings");
      if (res.status === 401 || res.status === 403) { window.location.href = "/signin"; return; }
      const data = await res.json();
      setStandings({
        season: data.season,
        top8: data.top8 ?? [],
        mid: data.mid ?? [],
        promoted: data.promoted ?? [],
        updatedAt: data.updatedAt ?? null,
        plTeams: data.plTeams ?? [],
      });
    } catch (err) { console.error("fetchStandings failed:", err); }
    finally { setStandingsLoading(false); }
  }, []);

  const moveStandingsTeam = (teamId: number, target: "top8" | "mid" | "promoted" | null) => {
    setStandings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, top8: [...prev.top8], mid: [...prev.mid], promoted: [...prev.promoted] };
      next.top8 = next.top8.filter((id) => id !== teamId);
      next.mid = next.mid.filter((id) => id !== teamId);
      next.promoted = next.promoted.filter((id) => id !== teamId);
      if (target === "top8") next.top8.push(teamId);
      else if (target === "mid") next.mid.push(teamId);
      else if (target === "promoted") {
        // Promoted tier displays alphabetically (positions 18/19/20)
        next.promoted.push(teamId);
        const byName = new Map(prev.plTeams.map((t) => [t.id, t.name] as const));
        next.promoted.sort((a, b) => (byName.get(a) ?? "").localeCompare(byName.get(b) ?? ""));
      }
      return next;
    });
  };

  const saveStandings = async () => {
    if (!standings) return;
    if (standings.top8.length !== 8 || standings.mid.length !== 9 || standings.promoted.length !== 3) {
      setMessage({ type: "error", text: "Tier counts must be: 8 / 9 / 3 (got " + standings.top8.length + " / " + standings.mid.length + " / " + standings.promoted.length + ")" });
      return;
    }
    setStandingsSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/superadmin/pl-standings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          season: standings.season,
          top8: standings.top8,
          mid: standings.mid,
          promoted: standings.promoted,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Failed to save PL standings" }); return; }
      setStandings((prev) => prev ? { ...prev, updatedAt: data.updatedAt } : prev);
      setMessage({ type: "success", text: "PL standings saved." });
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setStandingsSaving(false); }
  };

  // ── Score Adjustments (PL Club Auction breakdown overrides) ──
  type AdjLeague = { id: string; slug: string; name: string; season: string };
  type AdjScoreRow = {
    id: string; teamId: string; teamName: string;
    totalPoints: number; rawPoints: number; synergyBonus: number; clubResultBonus: number;
    rank: number | null; payout: number;
  };
  const [adjLeagues, setAdjLeagues] = useState<AdjLeague[]>([]);
  const [adjGwsByLeague, setAdjGwsByLeague] = useState<Record<string, number[]>>({});
  const [adjLeagueId, setAdjLeagueId] = useState<string>("");
  const [adjGw, setAdjGw] = useState<number | null>(null);
  const [adjRows, setAdjRows] = useState<AdjScoreRow[]>([]);
  const [adjLoading, setAdjLoading] = useState(false);
  const [adjEdits, setAdjEdits] = useState<Record<string, { synergyBonus?: number; clubResultBonus?: number; reason?: string }>>({});
  const [adjSavingId, setAdjSavingId] = useState<string | null>(null);

  const fetchAdjBootstrap = useCallback(async () => {
    setAdjLoading(true);
    try {
      const res = await fetch("/api/superadmin/score-adjustments");
      if (res.status === 401 || res.status === 403) { window.location.href = "/signin"; return; }
      const data = await res.json();
      setAdjLeagues(data.leagues ?? []);
      setAdjGwsByLeague(data.gwsByLeague ?? {});
    } catch (err) { console.error("fetchAdjBootstrap failed:", err); }
    finally { setAdjLoading(false); }
  }, []);

  const fetchAdjRows = useCallback(async (leagueId: string, gw: number) => {
    setAdjLoading(true);
    setAdjRows([]);
    try {
      const res = await fetch(`/api/superadmin/score-adjustments?leagueId=${encodeURIComponent(leagueId)}&gameweek=${gw}`);
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Failed to load scores" }); return; }
      setAdjRows(data.scores ?? []);
      setAdjEdits({});
    } catch (err) { console.error("fetchAdjRows failed:", err); setMessage({ type: "error", text: "Network error" }); }
    finally { setAdjLoading(false); }
  }, []);

  const saveAdj = async (row: AdjScoreRow) => {
    const edit = adjEdits[row.id];
    if (!edit) return;
    const reason = (edit.reason ?? "").trim();
    if (!reason) { setMessage({ type: "error", text: "Reason is required to save adjustments." }); return; }
    if (edit.synergyBonus == null && edit.clubResultBonus == null) {
      setMessage({ type: "error", text: "Edit synergy or club-result before saving." });
      return;
    }
    setAdjSavingId(row.id);
    setMessage(null);
    try {
      const res = await fetch("/api/superadmin/score-adjustments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          ...(edit.synergyBonus != null ? { synergyBonus: edit.synergyBonus } : {}),
          ...(edit.clubResultBonus != null ? { clubResultBonus: edit.clubResultBonus } : {}),
          reason,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Save failed" }); return; }
      // Patch the row in-place
      setAdjRows((prev) => prev.map((r) =>
        r.id === row.id
          ? { ...r, synergyBonus: data.synergyBonus, clubResultBonus: data.clubResultBonus, totalPoints: data.totalPoints }
          : r
      ));
      setAdjEdits((prev) => { const n = { ...prev }; delete n[row.id]; return n; });
      setMessage({ type: "success", text: `Saved (Δ ${data.deltaTotal >= 0 ? "+" : ""}${data.deltaTotal} pts).` });
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setAdjSavingId(null); }
  };

  const fetchLeagues = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/superadmin/leagues");
      if (res.status === 401 || res.status === 403) { window.location.href = "/signin"; return; }
      const data = await res.json();
      setLeagues(data.leagues || []);
    } catch (err) { console.error("fetchLeagues failed:", err); } finally { setIsLoading(false); }
  }, []);

  const fetchAdmins = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/superadmin/admins");
      if (res.status === 401 || res.status === 403) { window.location.href = "/signin"; return; }
      const data = await res.json();
      setAdmins(data.admins || []);
    } catch (err) { console.error("fetchAdmins failed:", err); } finally { setIsLoading(false); }
  }, []);

  useEffect(() => {
    fetchLeagues();
    fetchAdmins();
    if (activeTab === "pl-standings" && !standings) {
      fetchStandings();
    }
    if (activeTab === "score-adjustments" && adjLeagues.length === 0) {
      fetchAdjBootstrap();
    }
  }, [activeTab, fetchLeagues, fetchAdmins, fetchStandings, standings, fetchAdjBootstrap, adjLeagues.length]);

  // ── League actions ──

  const handleCreateLeague = (e: React.FormEvent) => {
    e.preventDefault();
    // Move to admin assignment step — actual API call happens in handleWizardFinish
    setWizardSelectedAdminIds([]);
    setWizardStep("assign");
  };

  const handleWizardFinish = async (skipAssignment = false) => {
    setIsSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/superadmin/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: leagueForm.slug,
          name: leagueForm.name,
          sport: leagueForm.sport,
          format: leagueForm.format,
          season: leagueForm.season,
          teamSize: leagueForm.teamSize,
          groupCount: leagueForm.groupCount,
          playoffStartGw: leagueForm.playoffStartGw,
          enabledChips: leagueForm.enabledChips,
          initialBudget: leagueForm.initialBudget,
          isSimulated: leagueForm.isSimulated,
          clubAuctionEnabled: leagueForm.clubAuctionEnabled,
          auctionTier: leagueForm.auctionTier,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Failed to create league" }); return; }

      const newLeagueId: string = data.id;

      if (!skipAssignment && wizardSelectedAdminIds.length > 0) {
        await Promise.all(wizardSelectedAdminIds.map(userId =>
          fetch("/api/superadmin/league-assignments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, leagueId: newLeagueId }),
          })
        ));
        // Refresh admins so assigned league counts are up to date
        fetchAdmins();
      }

      setMessage({ type: "success", text: `League "${leagueForm.name}" created!` });
      setShowWizard(false);
      setWizardStep("sport");
      setLeagueForm({ slug: "", name: "", sport: "", format: "", season: "", teamSize: 32, groupCount: 2, playoffStartGw: 31, enabledChips: ["D", "W", "C"], initialBudget: 100_000_000, isSimulated: false, clubAuctionEnabled: false, auctionTier: "complete" });
      setWizardSelectedAdminIds([]);
      setLeagues(prev => [...prev, { ...data, teamCount: 0, currentGameweek: null }]);
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setIsSubmitting(false); }
  };

  const toggleLeagueActive = async (league: League) => {
    try {
      const res = await fetch(`/api/superadmin/leagues/${league.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !league.isActive }),
      });
      if (!res.ok) { setMessage({ type: "error", text: "Failed to update league" }); return; }
      setLeagues(prev => prev.map(l => l.id === league.id ? { ...l, isActive: !l.isActive } : l));
    } catch { setMessage({ type: "error", text: "Network error" }); }
  };

  const handleDeleteLeague = async () => {
    if (!deletingLeague || !deletePassword) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/superadmin/leagues/${deletingLeague.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: deletePassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDeleteError(data.error || "Failed to delete league");
        return;
      }
      setLeagues(prev => prev.filter(l => l.id !== deletingLeague.id));
      setDeletingLeague(null);
      setDeletePassword("");
      setMessage({ type: "success", text: data.message });
    } catch {
      setDeleteError("Network error");
    } finally {
      setDeleteLoading(false);
    }
  };

  const openEditLeague = (league: League) => {
    setEditingLeague(league);
    // Parse enabledChips from the league data (it may not be in the League interface, so we'll set it to empty)
    setEditLeagueForm({
      name: league.name,
      season: league.season,
      enabledChips: [] as string[] // Will be loaded from API if needed
    });
    const currentAdminIds = admins.filter(a => a.assignedLeagueIds.includes(league.id)).map(a => a.id);
    setEditLeagueAdminIds(currentAdminIds);
  };

  const handleEditLeague = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLeague) return;
    setIsSubmitting(true);
    setMessage(null);
    try {
      if (editLeagueForm.name !== editingLeague.name || editLeagueForm.season !== editingLeague.season || editLeagueForm.enabledChips.length > 0) {
        const res = await fetch(`/api/superadmin/leagues/${editingLeague.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: editLeagueForm.name,
            season: editLeagueForm.season,
            ...(editLeagueForm.enabledChips.length > 0 && { enabledChips: editLeagueForm.enabledChips }),
          }),
        });
        if (!res.ok) { setMessage({ type: "error", text: "Failed to update league details" }); return; }
      }

      const originalAdminIds = admins.filter(a => a.assignedLeagueIds.includes(editingLeague.id)).map(a => a.id);
      const toAdd = editLeagueAdminIds.filter(id => !originalAdminIds.includes(id));
      const toRemove = originalAdminIds.filter(id => !editLeagueAdminIds.includes(id));

      await Promise.all([
        ...toAdd.map(userId => fetch("/api/superadmin/league-assignments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, leagueId: editingLeague.id }),
        })),
        ...toRemove.map(userId => fetch("/api/superadmin/league-assignments", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, leagueId: editingLeague.id }),
        })),
      ]);

      setLeagues(prev => prev.map(l =>
        l.id === editingLeague.id ? { ...l, name: editLeagueForm.name, season: editLeagueForm.season } : l
      ));
      setAdmins(prev => prev.map(a => {
        if (toAdd.includes(a.id)) return { ...a, assignedLeagueIds: [...a.assignedLeagueIds, editingLeague.id] };
        if (toRemove.includes(a.id)) return { ...a, assignedLeagueIds: a.assignedLeagueIds.filter(id => id !== editingLeague.id) };
        return a;
      }));

      setEditingLeague(null);
      setMessage({ type: "success", text: "League updated." });
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setIsSubmitting(false); }
  };

  // ── Admin actions ──

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminActionLoading(true);
    setMessage(null);
    try {
      const res = await fetch("/api/superadmin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adminForm),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Failed to create admin" }); return; }
      setAdmins(prev => [...prev, data]);
      setShowCreateAdmin(false);
      setAdminForm({ name: "", email: "", password: "" });
      setMessage({ type: "success", text: `Admin "${adminForm.name}" created. They must change their password on first login.` });
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setAdminActionLoading(false); }
  };

  const handleEditAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAdmin) return;
    setAdminActionLoading(true);
    setMessage(null);
    try {
      const body: Record<string, string> = {};
      if (editAdminForm.name) body.name = editAdminForm.name;
      if (editAdminForm.email) body.email = editAdminForm.email;
      if (editAdminForm.password) body.password = editAdminForm.password;
      const res = await fetch(`/api/superadmin/admins/${editingAdmin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Failed to update admin" }); return; }
      setAdmins(prev => prev.map(a =>
        a.id === editingAdmin.id
          ? {
              ...a,
              name: editAdminForm.name || a.name,
              email: editAdminForm.email || a.email,
              mustChangePassword: editAdminForm.password ? true : a.mustChangePassword,
            }
          : a
      ));
      setEditingAdmin(null);
      setMessage({ type: "success", text: "Admin updated." });
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setAdminActionLoading(false); }
  };

  const handleDeleteAdmin = async () => {
    if (!deletingAdmin) return;
    setAdminActionLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/superadmin/admins/${deletingAdmin.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Failed to delete admin" }); return; }
      setAdmins(prev => prev.filter(a => a.id !== deletingAdmin.id));
      setDeletingAdmin(null);
      setMessage({ type: "success", text: "Admin deleted." });
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setAdminActionLoading(false); }
  };

  const openAssignModal = (admin: Admin) => {
    setAssigningAdmin(admin);
    setAssignedLeagueIds([...admin.assignedLeagueIds]);
  };

  const toggleLeagueAssignment = async (leagueId: string, currently: boolean) => {
    if (!assigningAdmin) return;
    try {
      const res = await fetch("/api/superadmin/league-assignments", {
        method: currently ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: assigningAdmin.id, leagueId }),
      });
      if (!res.ok) {
        const data = await res.json();
        setMessage({ type: "error", text: data.error || "Failed to update assignment" });
        return;
      }
      const newIds = currently
        ? assignedLeagueIds.filter(id => id !== leagueId)
        : [...assignedLeagueIds, leagueId];
      setAssignedLeagueIds(newIds);
      setAdmins(prev => prev.map(a =>
        a.id === assigningAdmin.id ? { ...a, assignedLeagueIds: newIds } : a
      ));
    } catch { setMessage({ type: "error", text: "Network error" }); }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  // ── Operations: Run Auto-Processing (client-orchestrated, league × gw) ──
  type LeaguePlanItem = { id: string; slug: string; format: string; teamSize: number | null; playoffStartGw: number | null };
  type LeagueRow = ProcessAllLeagueResult & {
    uiStatus: "queued" | "processing" | "ok" | "partial" | "error" | "skipped";
    gwStates: Record<number, GwChipState>;
    gwTooltips: Record<number, string>;
  };

  const [processRunning, setProcessRunning] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processRunId, setProcessRunId] = useState<string | null>(null);
  const [processDueGws, setProcessDueGws] = useState<number[] | null>(null);
  const [processGlobalErrors, setProcessGlobalErrors] = useState<string[]>([]);
  const [processLeagues, setProcessLeagues] = useState<LeagueRow[]>([]);
  const [processCurrentSlug, setProcessCurrentSlug] = useState<string | null>(null);
  const [processStartedAt, setProcessStartedAt] = useState<number | null>(null);

  const handleRunProcessAll = async () => {
    if (processRunning) return;
    setProcessRunning(true);
    setProcessError(null);
    setProcessRunId(null);
    setProcessDueGws(null);
    setProcessGlobalErrors([]);
    setProcessLeagues([]);
    setProcessCurrentSlug(null);
    setProcessStartedAt(Date.now());

    // Step 1: fetch the plan
    let plan: { runId: string; dueGws: number[]; leagues: LeaguePlanItem[]; globalErrors: string[] };
    try {
      const planRes = await fetch("/api/admin/process-all/plan", { credentials: "include" });
      if (!planRes.ok) {
        const data = await planRes.json().catch(() => ({}));
        if (planRes.status === 401) setProcessError("Not authenticated — please sign in again.");
        else if (planRes.status === 403) setProcessError("Not authorized — superadmin access required.");
        else setProcessError(`Plan failed (HTTP ${planRes.status}): ${data.error ?? data.message ?? "unknown"}`);
        setProcessRunning(false);
        return;
      }
      const data = await planRes.json();
      plan = data.plan;
    } catch (e) {
      setProcessError(`Plan network error: ${e instanceof Error ? e.message : "unknown"}`);
      setProcessRunning(false);
      return;
    }

    setProcessRunId(plan.runId);
    setProcessDueGws(plan.dueGws);
    setProcessGlobalErrors(plan.globalErrors);

    // Initialize per-league rows with every dueGw queued.
    const initialGwStates = plan.dueGws.reduce<Record<number, GwChipState>>((acc, gw) => { acc[gw] = "queued"; return acc; }, {});
    setProcessLeagues(plan.leagues.map(lg => ({
      leagueId: lg.id,
      slug: lg.slug,
      format: lg.format,
      status: "skipped",
      uiStatus: "queued",
      scoredGws: [],
      advancedGws: [],
      generatedFor: [],
      generatedAlready: [],
      advanceWindowFuture: [],
      errors: [],
      gwStates: { ...initialGwStates },
      gwTooltips: {},
    })));

    // Step 2: nested loop — for each league, for each GW, fire one /league-gw call.
    // Each call is bounded by ~5-15s so we never hit Vercel's 60s ceiling.
    const completedResults: ProcessAllLeagueResult[] = [];
    for (let i = 0; i < plan.leagues.length; i++) {
      const lg = plan.leagues[i];
      setProcessCurrentSlug(lg.slug);
      setProcessLeagues(prev => prev.map((row, idx) => idx === i ? { ...row, uiStatus: "processing" } : row));

      // Build the per-league aggregate as GW results stream in.
      const agg: ProcessAllLeagueResult = {
        leagueId: lg.id, slug: lg.slug, format: lg.format,
        status: "skipped",
        scoredGws: [], advancedGws: [], generatedFor: [],
        generatedAlready: [], advanceWindowFuture: [],
        errors: [],
      };

      for (const gw of plan.dueGws) {
        // mark this GW as in-flight
        setProcessLeagues(prev => prev.map((row, idx) => idx === i
          ? { ...row, gwStates: { ...row.gwStates, [gw]: "processing" } }
          : row));

        let gwResult: LeagueGwResult | null = null;
        let gwError: string | null = null;

        try {
          const res = await fetch("/api/admin/process-all/league-gw", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: plan.runId, league: lg, gw }),
          });
          const ct = res.headers.get("content-type") ?? "";
          if (!ct.includes("application/json")) {
            const txt = (await res.text()).slice(0, 200);
            gwError = res.status === 504
              ? `Call timed out (60s). Visit this league's admin page to process GW${gw} manually.`
              : `Non-JSON response (HTTP ${res.status}): ${txt}`;
          } else {
            const data = await res.json();
            if (!res.ok) {
              gwError = `HTTP ${res.status}: ${data.error ?? data.message ?? "unknown"}`;
            } else {
              gwResult = data.result as LeagueGwResult;
            }
          }
        } catch (e) {
          gwError = `Network error: ${e instanceof Error ? e.message : "unknown"}`;
        }

        // Aggregate into the league row + update the chip state.
        let chipState: GwChipState;
        let tooltip: string;
        if (gwError) {
          chipState = "error";
          tooltip = `GW${gw} — ${gwError}`;
          agg.errors.push({ gw, step: "score", message: gwError });
        } else if (gwResult) {
          if (gwResult.scored || gwResult.scoreSkipped) agg.scoredGws.push(gw);
          if (gwResult.advanced) agg.advancedGws.push(gw);
          if (gwResult.generated) agg.generatedFor.push(gw);
          if (gwResult.generatedAlready) agg.generatedAlready.push(gw);
          for (const e of gwResult.errors) agg.errors.push({ gw, step: e.step, message: e.message });

          chipState = gwResult.status;
          // Build a compact tooltip from the per-stage flags.
          const parts: string[] = [];
          if (gwResult.scored) parts.push("score: ok");
          else if (gwResult.scoreSkipped) parts.push("score: skipped");
          if (gwResult.generated) parts.push("generate: ok");
          else if (gwResult.generatedAlready) parts.push("generate: already in place");
          if (gwResult.advanced) parts.push("advance: ok");
          else if (gwResult.advanceSkipped) parts.push("advance: skipped");
          if (gwResult.errors.length > 0) parts.push(...gwResult.errors.map(e => `${e.step}: ${e.message}`));
          tooltip = `GW${gw} — ${parts.join(" / ") || "no work"}`;
        } else {
          chipState = "error";
          tooltip = `GW${gw} — unknown error`;
        }

        setProcessLeagues(prev => prev.map((row, idx) => idx === i ? {
          ...row,
          gwStates: { ...row.gwStates, [gw]: chipState },
          gwTooltips: { ...row.gwTooltips, [gw]: tooltip },
          // Mirror the aggregate into the row so error lists / Scored / Advanced lines update live.
          scoredGws: agg.scoredGws,
          advancedGws: agg.advancedGws,
          generatedFor: agg.generatedFor,
          generatedAlready: agg.generatedAlready,
          errors: agg.errors,
        } : row));
      }

      // After all GWs for this league: compute advanceWindowFuture (window ∖ dueGws ∖ advanced).
      // We don't know the advance window client-side, so we skip this here — the existing
      // server-aggregated wrapper handles it for the cron path; for the UI we just leave it empty.
      const errorCount = agg.errors.length;
      const didAnyWork = agg.scoredGws.length + agg.advancedGws.length + agg.generatedFor.length + agg.generatedAlready.length > 0;
      const finalStatus: ProcessAllLeagueResult["status"] = errorCount === 0
        ? (didAnyWork ? "ok" : "skipped")
        : (didAnyWork ? "partial" : "error");
      agg.status = finalStatus;

      completedResults.push(agg);
      setProcessLeagues(prev => prev.map((row, idx) => idx === i ? { ...row, uiStatus: finalStatus } : row));
    }

    // Step 3: finish (audit log + pre-warm)
    setProcessCurrentSlug(null);
    try {
      await fetch("/api/admin/process-all/finish", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: plan.runId,
          dueGws: plan.dueGws,
          results: completedResults,
          globalErrors: plan.globalErrors,
        }),
      });
    } catch (e) {
      console.error("finish call failed:", e);
    }
    setProcessRunning(false);
  };

  const tabs: { id: TabType; label: string }[] = [
    { id: "leagues", label: "Leagues" },
    { id: "admins", label: "Admins" },
    { id: "operations", label: "Operations" },
    { id: "pl-standings", label: "PL Standings" },
    { id: "score-adjustments", label: "Score Adjustments" },
    { id: "feedback", label: "Feedback" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">

      {/* ── Edit League Modal ── */}
      {editingLeague && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-lg">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Edit League</h2>
              <button onClick={() => setEditingLeague(null)} className="text-gray-400 hover:text-white text-2xl">×</button>
            </div>
            <form onSubmit={handleEditLeague} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-sm text-gray-300 mb-1">Name</label>
                  <input
                    required value={editLeagueForm.name}
                    onChange={e => setEditLeagueForm({ ...editLeagueForm, name: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:border-yellow-500 focus:outline-none"
                  />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-sm text-gray-300 mb-1">Season</label>
                  <input
                    required value={editLeagueForm.season}
                    onChange={e => setEditLeagueForm({ ...editLeagueForm, season: e.target.value })}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white focus:border-yellow-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-2">Enabled Chips</label>
                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {CHIP_OPTIONS.map(chip => (
                    <label key={chip.code} className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 cursor-pointer hover:bg-white/10 transition">
                      <input
                        type="checkbox"
                        checked={editLeagueForm.enabledChips.includes(chip.code)}
                        onChange={() => setEditLeagueForm(prev => ({
                          ...prev,
                          enabledChips: prev.enabledChips.includes(chip.code)
                            ? prev.enabledChips.filter(c => c !== chip.code)
                            : [...prev.enabledChips, chip.code]
                        }))}
                        className="w-4 h-4 accent-yellow-400 mt-0.5 flex-shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-white text-sm font-medium">{chip.name}</p>
                        <p className="text-gray-500 text-xs">{chip.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-2">Assigned Admins</label>
                {admins.filter(a => a.role !== "superadmin").length === 0 ? (
                  <p className="text-gray-500 text-sm">No admin users yet.</p>
                ) : (
                  <div className="space-y-2 max-h-52 overflow-y-auto">
                    {admins.filter(a => a.role !== "superadmin").map(admin => (
                      <label key={admin.id} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 cursor-pointer hover:bg-white/10 transition">
                        <input
                          type="checkbox"
                          checked={editLeagueAdminIds.includes(admin.id)}
                          onChange={() => setEditLeagueAdminIds(prev =>
                            prev.includes(admin.id) ? prev.filter(id => id !== admin.id) : [...prev, admin.id]
                          )}
                          className="w-4 h-4 accent-yellow-400"
                        />
                        <div className="min-w-0">
                          <p className="text-white text-sm font-medium">{admin.name}</p>
                          <p className="text-gray-500 text-xs">{admin.email}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setEditingLeague(null)} className="flex-1 rounded-lg border border-white/10 px-4 py-2.5 text-gray-300 hover:bg-white/5 transition">Cancel</button>
                <button type="submit" disabled={isSubmitting} className="flex-1 rounded-lg bg-yellow-500 px-4 py-2.5 font-semibold text-slate-900 hover:bg-yellow-400 transition disabled:opacity-50">
                  {isSubmitting ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete League Confirmation Modal ── */}
      {deletingLeague && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-2">Delete League</h2>
            <p className="text-gray-400 mb-1">
              You are about to permanently delete{" "}
              <span className="text-white font-semibold">{deletingLeague.name}</span>.
            </p>
            <p className="text-red-400 text-sm mb-5">
              This will delete ALL teams, players, fixtures, results, chips, and playoff data. This cannot be undone.
            </p>
            <div className="mb-5">
              <label className="block text-sm text-gray-300 mb-1">Confirm your password to proceed</label>
              <input
                type="password"
                value={deletePassword}
                onChange={e => { setDeletePassword(e.target.value); setDeleteError(null); }}
                placeholder="Your superadmin password"
                className="w-full rounded-lg bg-slate-700 border border-white/10 px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
                autoFocus
              />
              {deleteError && <p className="text-red-400 text-sm mt-2">{deleteError}</p>}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => { setDeletingLeague(null); setDeletePassword(""); setDeleteError(null); }}
                disabled={deleteLoading}
                className="flex-1 rounded-lg border border-white/10 px-4 py-2.5 text-gray-300 hover:bg-white/5 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteLeague}
                disabled={deleteLoading || !deletePassword}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 font-semibold text-white hover:bg-red-700 transition disabled:opacity-50"
              >
                {deleteLoading ? "Deleting..." : "Delete League"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Admin Confirmation Modal ── */}
      {deletingAdmin && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-md">
            <h2 className="text-xl font-bold text-white mb-3">Delete Admin</h2>
            <p className="text-gray-400 mb-6">
              Are you sure you want to delete <span className="text-white font-semibold">{deletingAdmin.name}</span>?
              This will remove all their league assignments too.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeletingAdmin(null)} className="flex-1 rounded-lg border border-white/10 px-4 py-2.5 text-gray-300 hover:bg-white/5 transition">Cancel</button>
              <button onClick={handleDeleteAdmin} disabled={adminActionLoading} className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 font-semibold text-white hover:bg-red-700 transition disabled:opacity-50">
                {adminActionLoading ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Admin Modal ── */}
      {editingAdmin && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-md">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Edit Admin</h2>
              <button onClick={() => setEditingAdmin(null)} className="text-gray-400 hover:text-white text-2xl">×</button>
            </div>
            <form onSubmit={handleEditAdmin} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">Name</label>
                <input
                  value={editAdminForm.name}
                  onChange={e => setEditAdminForm({ ...editAdminForm, name: e.target.value })}
                  placeholder={editingAdmin.name}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Email</label>
                <input
                  type="email"
                  value={editAdminForm.email}
                  onChange={e => setEditAdminForm({ ...editAdminForm, email: e.target.value })}
                  placeholder={editingAdmin.email}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">New Password <span className="text-gray-500">(leave blank to keep current)</span></label>
                <input
                  type="password"
                  value={editAdminForm.password}
                  onChange={e => setEditAdminForm({ ...editAdminForm, password: e.target.value })}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                />
                {editAdminForm.password && (
                  <p className="text-xs text-orange-400 mt-1">Admin will be required to change password on next login.</p>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setEditingAdmin(null)} className="flex-1 rounded-lg border border-white/10 px-4 py-2.5 text-gray-300 hover:bg-white/5 transition">Cancel</button>
                <button type="submit" disabled={adminActionLoading} className="flex-1 rounded-lg bg-yellow-500 px-4 py-2.5 font-semibold text-slate-900 hover:bg-yellow-400 transition disabled:opacity-50">
                  {adminActionLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Assign Leagues Modal ── */}
      {assigningAdmin && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-md">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Assign Leagues</h2>
              <button onClick={() => setAssigningAdmin(null)} className="text-gray-400 hover:text-white text-2xl">×</button>
            </div>
            <p className="text-gray-400 text-sm mb-4">Toggle leagues for <span className="text-white font-medium">{assigningAdmin.name}</span>. Changes save immediately.</p>
            {leagues.length === 0 ? (
              <p className="text-gray-500 text-sm">No leagues available.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {leagues.map(league => {
                  const assigned = assignedLeagueIds.includes(league.id);
                  return (
                    <label key={league.id} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 cursor-pointer hover:bg-white/10 transition">
                      <input
                        type="checkbox"
                        checked={assigned}
                        onChange={() => toggleLeagueAssignment(league.id, assigned)}
                        className="w-4 h-4 accent-yellow-400"
                      />
                      <div className="min-w-0">
                        <p className="text-white font-medium text-sm">{league.name}</p>
                        <p className="text-gray-500 text-xs">{league.season} · {league.sport.toUpperCase()} {league.format.toUpperCase()}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <button onClick={() => setAssigningAdmin(null)} className="mt-5 w-full rounded-lg border border-white/10 px-4 py-2.5 text-gray-300 hover:bg-white/5 transition">
              Done
            </button>
          </div>
        </div>
      )}

      {/* ── Create Admin Modal ── */}
      {showCreateAdmin && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl border border-white/10 p-8 w-full max-w-md">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-bold text-white">Create Admin</h2>
              <button onClick={() => setShowCreateAdmin(false)} className="text-gray-400 hover:text-white text-2xl">×</button>
            </div>
            <form onSubmit={handleCreateAdmin} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">Name</label>
                <input
                  required value={adminForm.name}
                  onChange={e => setAdminForm({ ...adminForm, name: e.target.value })}
                  placeholder="Admin Name"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Email</label>
                <input
                  required type="email" value={adminForm.email}
                  onChange={e => setAdminForm({ ...adminForm, email: e.target.value })}
                  placeholder="admin@example.com"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">Initial Password</label>
                <input
                  required type="password" value={adminForm.password}
                  onChange={e => setAdminForm({ ...adminForm, password: e.target.value })}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                />
                <p className="text-xs text-gray-500 mt-1">Admin will be asked to change this on first login.</p>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowCreateAdmin(false)} className="flex-1 rounded-lg border border-white/10 px-4 py-2.5 text-gray-300 hover:bg-white/5 transition">Cancel</button>
                <button type="submit" disabled={adminActionLoading} className="flex-1 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-4 py-2.5 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50">
                  {adminActionLoading ? "Creating..." : "Create Admin"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 lg:px-12 border-b border-white/10">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <span className="text-xl font-bold text-white">Platform Admin</span>
            <span className="ml-2 text-xs bg-yellow-400/20 text-yellow-400 px-2 py-0.5 rounded-full">Superadmin</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/superadmin/help" className="text-gray-400 hover:text-white transition">Help</Link>
          <button onClick={handleSignOut} className="text-gray-400 hover:text-white transition">Sign Out</button>
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* Message */}
        {message && (
          <div className={`mb-6 rounded-lg p-4 ${
            message.type === "success"
              ? "bg-green-500/10 border border-green-500/30 text-green-400"
              : "bg-red-500/10 border border-red-500/30 text-red-400"
          }`}>
            {message.text}
            <button onClick={() => setMessage(null)} className="float-right opacity-60 hover:opacity-100">✕</button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-8 border-b border-white/10 pb-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2.5 rounded-t-lg font-medium text-sm transition ${
                activeTab === tab.id
                  ? "bg-yellow-400 text-slate-900"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Leagues Tab ── */}
        {activeTab === "leagues" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-white">Leagues</h2>
                <p className="text-gray-400 text-sm mt-1">Manage all leagues on the platform</p>
              </div>
              <button
                onClick={() => { setShowWizard(true); setWizardStep("sport"); setLeagueForm({ slug: "", name: "", sport: "", format: "", season: "", teamSize: 32, groupCount: 2, playoffStartGw: 31, enabledChips: ["D", "W", "C"], initialBudget: 100_000_000, isSimulated: false, clubAuctionEnabled: false, auctionTier: "complete" }); setMessage(null); }}
                className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-5 py-2.5 rounded-lg hover:from-yellow-300 hover:to-orange-400 transition"
              >
                + Create League
              </button>
            </div>

            {/* Create League Wizard */}
            {showWizard && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 mb-6">

                {/* Step: Sport */}
                {wizardStep === "sport" && (
                  <div>
                    <h3 className="text-white font-semibold text-lg mb-1">Select Sport</h3>
                    <p className="text-gray-400 text-sm mb-5">Choose the sport for this league.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {SPORT_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          disabled={opt.comingSoon}
                          onClick={() => {
                            if (!opt.comingSoon) {
                              setLeagueForm({ ...leagueForm, sport: opt.value, format: "" });
                              setWizardStep("format");
                            }
                          }}
                          className={`relative rounded-xl border p-5 text-left transition ${
                            opt.comingSoon
                              ? "border-white/5 bg-white/2 opacity-50 cursor-not-allowed"
                              : "border-white/10 bg-white/5 hover:border-yellow-500/50 hover:bg-white/10 cursor-pointer"
                          }`}
                        >
                          <div className="text-3xl mb-2">{opt.icon}</div>
                          <div className="text-white font-semibold">{opt.label}</div>
                          {opt.comingSoon && (
                            <span className="absolute top-3 right-3 text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">Coming soon</span>
                          )}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setShowWizard(false)} className="mt-4 text-gray-500 hover:text-gray-300 text-sm transition">Cancel</button>
                  </div>
                )}

                {/* Step: Format */}
                {wizardStep === "format" && (
                  <div>
                    <button onClick={() => setWizardStep("sport")} className="text-gray-400 hover:text-white text-sm mb-4 flex items-center gap-1 transition">← Back</button>
                    <h3 className="text-white font-semibold text-lg mb-1">Select Format</h3>
                    <p className="text-gray-400 text-sm mb-5">Choose the format for this {leagueForm.sport.toUpperCase()} league.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {(FORMAT_OPTIONS[leagueForm.sport] ?? []).map(opt => (
                        <button
                          key={opt.value}
                          disabled={opt.comingSoon}
                          onClick={() => {
                            if (!opt.comingSoon) {
                              if (opt.value === "continental-championship") {
                                // Triple Crown: hardcoded values
                                setLeagueForm({
                                  ...leagueForm,
                                  format: opt.value,
                                  teamSize: 20,
                                  groupCount: 4,
                                  playoffStartGw: 27,
                                  enabledChips: [],
                                });
                              } else if (opt.value === "auction") {
                                // JPL Auction: no groups, no playoffs, no chips
                                setLeagueForm({
                                  ...leagueForm,
                                  format: opt.value,
                                  teamSize: 10,
                                  groupCount: 0,
                                  playoffStartGw: 39,
                                  enabledChips: [],
                                  initialBudget: 100_000_000,
                                  isSimulated: false,
                                  clubAuctionEnabled: false,
                                  auctionTier: "complete",
                                });
                              } else {
                                setLeagueForm({ ...leagueForm, format: opt.value });
                              }
                              // TVT has team-size variants; Triple Crown and Auction go straight to details
                              setWizardStep(opt.value === "tvt" ? "team_size" : "details");
                            }
                          }}
                          className={`relative rounded-xl border p-5 text-left transition ${
                            opt.comingSoon
                              ? "border-white/5 bg-white/2 opacity-50 cursor-not-allowed"
                              : "border-white/10 bg-white/5 hover:border-yellow-500/50 hover:bg-white/10 cursor-pointer"
                          }`}
                        >
                          <div className="text-white font-semibold mb-1">{opt.label}</div>
                          <div className="text-gray-400 text-sm">{opt.description}</div>
                          {opt.comingSoon && (
                            <span className="absolute top-3 right-3 text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">Coming soon</span>
                          )}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setShowWizard(false)} className="mt-4 text-gray-500 hover:text-gray-300 text-sm transition">Cancel</button>
                  </div>
                )}

                {/* Step: Team Size (TVT only) */}
                {wizardStep === "team_size" && (
                  <div>
                    <button onClick={() => setWizardStep("format")} className="text-gray-400 hover:text-white text-sm mb-4 flex items-center gap-1 transition">← Back</button>
                    <h3 className="text-white font-semibold text-lg mb-1">Team Size</h3>
                    <p className="text-gray-400 text-sm mb-5">Choose how many teams will compete in this league.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {TEAM_SIZE_OPTIONS.map(opt => (
                        <button
                          key={opt.teamSize}
                          onClick={() => {
                            const playoffStartGw = opt.teamSize === 8 ? 36 : 31;
                            const chips = opt.teamSize !== 32
                              ? leagueForm.enabledChips.filter(c => c !== "C")
                              : leagueForm.enabledChips;
                            setLeagueForm({ ...leagueForm, teamSize: opt.teamSize, groupCount: opt.groupCount, playoffStartGw, enabledChips: chips });
                            setWizardStep("chips");
                          }}
                          className={`rounded-xl border p-5 text-left transition ${
                            leagueForm.teamSize === opt.teamSize
                              ? "border-yellow-500 bg-yellow-500/10"
                              : "border-white/10 bg-white/5 hover:border-yellow-500/50 hover:bg-white/10"
                          } cursor-pointer`}
                        >
                          <div className="text-white font-bold text-xl mb-0.5">{opt.label}</div>
                          <div className="text-yellow-400 text-xs font-medium mb-2">{opt.sublabel}</div>
                          <div className="text-gray-400 text-xs leading-relaxed">{opt.description}</div>
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setShowWizard(false)} className="mt-4 text-gray-500 hover:text-gray-300 text-sm transition">Cancel</button>
                  </div>
                )}

                {/* Step: Chip Selection (TVT only) */}
                {wizardStep === "chips" && (
                  <div>
                    <button onClick={() => setWizardStep("team_size")} className="text-gray-400 hover:text-white text-sm mb-4 flex items-center gap-1 transition">← Back</button>
                    <h3 className="text-white font-semibold text-lg mb-1">Select Chips</h3>
                    <p className="text-gray-400 text-sm mb-5">
                      Choose exactly <span className="text-yellow-400 font-semibold">3 chips</span> for this league. These cannot be changed after creation.
                      Each team gets one of each chip per set.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                      {CHIP_OPTIONS.map(chip => {
                        const selected = leagueForm.enabledChips.includes(chip.code);
                        const isCcUnavailable = chip.code === "C" && leagueForm.teamSize !== 32;
                        const atMax = leagueForm.enabledChips.length >= 3 && !selected;
                        const disabled = isCcUnavailable || atMax;
                        return (
                          <button
                            key={chip.code}
                            disabled={disabled}
                            onClick={() => {
                              if (selected) {
                                setLeagueForm({ ...leagueForm, enabledChips: leagueForm.enabledChips.filter(c => c !== chip.code) });
                              } else if (!disabled) {
                                setLeagueForm({ ...leagueForm, enabledChips: [...leagueForm.enabledChips, chip.code] });
                              }
                            }}
                            className={`rounded-xl border p-4 text-left transition ${
                              selected
                                ? "border-yellow-500 bg-yellow-500/10"
                                : disabled
                                  ? "border-white/5 bg-white/2 opacity-40 cursor-not-allowed"
                                  : "border-white/10 bg-white/5 hover:border-yellow-500/50 hover:bg-white/10 cursor-pointer"
                            }`}
                          >
                            <div className="flex items-center gap-2 mb-1">
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${selected ? "bg-yellow-500 text-slate-900" : "bg-white/10 text-gray-400"}`}>{chip.code}</span>
                              <span className="text-white font-semibold text-sm">{chip.name}</span>
                              {selected && <span className="ml-auto text-yellow-400 text-xs">✓ Selected</span>}
                            </div>
                            <p className="text-gray-400 text-xs leading-relaxed">{chip.description}</p>
                            {isCcUnavailable && (
                              <p className="text-red-400 text-xs mt-1">32-team only — requires 2 groups</p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-4">
                      <button
                        disabled={leagueForm.enabledChips.length !== 3}
                        onClick={() => setWizardStep("details")}
                        className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-6 py-2.5 rounded-lg hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Next → {leagueForm.enabledChips.length < 3 && `(${leagueForm.enabledChips.length}/3 selected)`}
                      </button>
                      <button type="button" onClick={() => setShowWizard(false)} className="text-gray-400 hover:text-white px-4 py-2.5 transition">Cancel</button>
                    </div>
                  </div>
                )}

                {/* Step: Details form */}
                {wizardStep === "details" && (
                  <div>
                    <button onClick={() => setWizardStep(leagueForm.format === "tvt" ? "chips" : "format")} className="text-gray-400 hover:text-white text-sm mb-4 flex items-center gap-1 transition">← Back</button>
                    <h3 className="text-white font-semibold text-lg mb-1">League Details</h3>
                    <p className="text-gray-400 text-sm mb-5">
                      {leagueForm.sport.toUpperCase()} · {leagueForm.format === "auction" ? "JPL Auction" : leagueForm.format.toUpperCase()} · {leagueForm.teamSize} {leagueForm.format === "auction" ? "Managers" : "Teams"}
                    </p>
                    <form onSubmit={handleCreateLeague} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm text-gray-300 mb-1">Slug <span className="text-gray-500">(unique ID, e.g. {leagueForm.format === "auction" ? "jpl-auction-2526" : "tvt-fpl-2526"})</span></label>
                        <input
                          required value={leagueForm.slug}
                          onChange={e => setLeagueForm({ ...leagueForm, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
                          placeholder={leagueForm.format === "auction" ? "jpl-auction-2526" : "tvt-fpl-2526"}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-300 mb-1">Name</label>
                        <input
                          required value={leagueForm.name}
                          onChange={e => setLeagueForm({ ...leagueForm, name: e.target.value })}
                          placeholder={leagueForm.format === "auction" ? "JPL Auction League" : "JPL TVT FPL"}
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-300 mb-1">Season</label>
                        <input
                          required value={leagueForm.season}
                          onChange={e => setLeagueForm({ ...leagueForm, season: e.target.value })}
                          placeholder="2025-26"
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                        />
                      </div>
                      {leagueForm.format === "auction" ? (
                        <>
                          <div>
                            <label className="block text-sm text-gray-300 mb-1">Number of Managers</label>
                            <input
                              type="number" min={2} max={20} required value={leagueForm.teamSize}
                              onChange={e => setLeagueForm({ ...leagueForm, teamSize: parseInt(e.target.value) || 10 })}
                              className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-300 mb-1">Initial Budget</label>
                            <div className="flex items-center gap-2">
                              <input
                                type="number" min={10_000_000} step={1_000_000} required value={leagueForm.initialBudget}
                                onChange={e => setLeagueForm({ ...leagueForm, initialBudget: parseInt(e.target.value) || 100_000_000 })}
                                className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                              />
                              <span className="text-gray-500 text-xs whitespace-nowrap">({(leagueForm.initialBudget / 1_000_000).toFixed(0)}M)</span>
                            </div>
                          </div>
                          <div className="sm:col-span-2">
                            <label className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 cursor-pointer hover:bg-white/10 transition">
                              <input
                                type="checkbox"
                                checked={leagueForm.isSimulated}
                                onChange={e => setLeagueForm({ ...leagueForm, isSimulated: e.target.checked })}
                                className="w-4 h-4 accent-yellow-400"
                              />
                              <div>
                                <p className="text-white text-sm font-medium">Simulated Auction (Testing)</p>
                                <p className="text-gray-500 text-xs">Auto-assigns players via snake draft when session starts. Skips live auction.</p>
                              </div>
                            </label>
                          </div>
                          <div className="sm:col-span-2">
                            <p className="text-white text-sm font-medium mb-2">Auction Tier</p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <label className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 cursor-pointer hover:bg-white/10 transition">
                                <input
                                  type="radio"
                                  name="auctionTier"
                                  value="primary"
                                  checked={leagueForm.auctionTier === "primary"}
                                  onChange={() => setLeagueForm({ ...leagueForm, auctionTier: "primary" })}
                                  className="mt-1 accent-yellow-400"
                                />
                                <div>
                                  <p className="text-white text-sm font-medium">Primary</p>
                                  <p className="text-gray-500 text-xs">Auction + GW payouts + penalty-slot redemption. <strong>No trades, no slot expansion.</strong></p>
                                </div>
                              </label>
                              <label className="flex items-start gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 cursor-pointer hover:bg-white/10 transition">
                                <input
                                  type="radio"
                                  name="auctionTier"
                                  value="complete"
                                  checked={leagueForm.auctionTier === "complete"}
                                  onChange={() => setLeagueForm({ ...leagueForm, auctionTier: "complete" })}
                                  className="mt-1 accent-yellow-400"
                                />
                                <div>
                                  <p className="text-white text-sm font-medium">Complete</p>
                                  <p className="text-gray-500 text-xs">All features: trades, slot 16/17/18 unlocks (£10M / £20M / £30M), redemption, club auction.</p>
                                </div>
                              </label>
                            </div>
                          </div>
                          <div className="sm:col-span-2">
                            <label className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 cursor-pointer hover:bg-white/10 transition">
                              <input
                                type="checkbox"
                                checked={leagueForm.clubAuctionEnabled}
                                onChange={e => setLeagueForm({ ...leagueForm, clubAuctionEnabled: e.target.checked })}
                                className="w-4 h-4 accent-yellow-400"
                              />
                              <div>
                                <p className="text-white text-sm font-medium">PL Club Auction</p>
                                <p className="text-gray-500 text-xs">Before the player auction, each team buys 1 PL club (random nomination, single round). Owned-club players earn ×1.5 synergy, plus a per-GW result bonus by tier (Top 8 / Mid / Promoted).</p>
                              </div>
                            </label>
                          </div>
                        </>
                      ) : (
                      <div>
                        <label className="block text-sm text-gray-300 mb-1">Playoff Start GW</label>
                        <div className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white text-sm flex items-center gap-2">
                          GW{leagueForm.playoffStartGw}
                          <span className="text-gray-500 text-xs">(determined by team size)</span>
                        </div>
                      </div>
                      )}
                      <div className="sm:col-span-2 flex gap-3">
                        <button
                          type="submit"
                          className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-6 py-2.5 rounded-lg hover:from-yellow-300 hover:to-orange-400 transition"
                        >
                          Next →
                        </button>
                        <button type="button" onClick={() => setShowWizard(false)} className="text-gray-400 hover:text-white px-4 py-2.5 transition">Cancel</button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Step: Assign Admins */}
                {wizardStep === "assign" && (
                  <div>
                    <button onClick={() => setWizardStep("details")} className="text-gray-400 hover:text-white text-sm mb-4 flex items-center gap-1 transition">← Back</button>
                    <h3 className="text-white font-semibold text-lg mb-1">Assign Admins</h3>
                    <p className="text-gray-400 text-sm mb-5">Choose which admins can manage this league. You can change this later.</p>
                    {admins.filter(a => a.role !== "superadmin").length === 0 ? (
                      <p className="text-gray-500 text-sm mb-5">No admin users yet. You can assign admins after creating them.</p>
                    ) : (
                      <div className="space-y-2 max-h-52 overflow-y-auto mb-5">
                        {admins.filter(a => a.role !== "superadmin").map(admin => (
                          <label key={admin.id} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 cursor-pointer hover:bg-white/10 transition">
                            <input
                              type="checkbox"
                              checked={wizardSelectedAdminIds.includes(admin.id)}
                              onChange={() => setWizardSelectedAdminIds(prev =>
                                prev.includes(admin.id) ? prev.filter(id => id !== admin.id) : [...prev, admin.id]
                              )}
                              className="w-4 h-4 accent-yellow-400"
                            />
                            <div className="min-w-0">
                              <p className="text-white text-sm font-medium">{admin.name}</p>
                              <p className="text-gray-500 text-xs">{admin.email}</p>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => handleWizardFinish(false)}
                        disabled={isSubmitting}
                        className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-6 py-2.5 rounded-lg hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
                      >
                        {isSubmitting ? "Creating..." : "Create League"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleWizardFinish(true)}
                        disabled={isSubmitting}
                        className="text-gray-400 hover:text-white text-sm transition disabled:opacity-50"
                      >
                        Skip
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Leagues list */}
            {isLoading ? (
              <LoadingScreen variant="admin" fullScreen={false} />
            ) : leagues.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-12 text-center">
                <p className="text-gray-400">No leagues yet. Create your first league above.</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead>
                    <tr className="border-b border-white/10 text-gray-400 text-left">
                      <th className="px-5 py-3 font-medium">League</th>
                      <th className="px-5 py-3 font-medium">Teams</th>
                      <th className="px-5 py-3 font-medium">Current GW</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leagues.map((league, i) => (
                      <tr key={league.id} className={`border-b border-white/5 ${i % 2 === 0 ? "" : "bg-white/[0.02]"}`}>
                        <td className="px-5 py-4">
                          <div className="text-white font-medium">{league.name}</div>
                          <div className="text-gray-500 text-xs font-mono mt-0.5">{league.slug} · {league.sport} · {league.format} · {league.season}</div>
                        </td>
                        <td className="px-5 py-4 text-gray-300">{league.teamCount}</td>
                        <td className="px-5 py-4 text-gray-300">{league.currentGameweek ? `GW${league.currentGameweek}` : "—"}</td>
                        <td className="px-5 py-4">
                          <span className={`text-xs px-2 py-1 rounded-full ${
                            league.isActive ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"
                          }`}>
                            {league.isActive ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link
                              href={`/admin/${league.slug}`}
                              className="text-xs text-yellow-400 hover:text-yellow-300 transition border border-yellow-400/30 px-3 py-1.5 rounded-lg whitespace-nowrap"
                            >
                              Manage
                            </Link>
                            <button
                              onClick={() => openEditLeague(league)}
                              className="text-xs text-blue-400 hover:text-blue-300 transition border border-blue-400/30 px-3 py-1.5 rounded-lg whitespace-nowrap"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => toggleLeagueActive(league)}
                              className={`text-xs px-3 py-1.5 rounded-lg transition border whitespace-nowrap ${
                                league.isActive
                                  ? "border-red-400/30 text-red-400 hover:bg-red-400/10"
                                  : "border-green-400/30 text-green-400 hover:bg-green-400/10"
                              }`}
                            >
                              {league.isActive ? "Deactivate" : "Activate"}
                            </button>
                            <button
                              onClick={() => { setDeletingLeague(league); setDeletePassword(""); setDeleteError(null); }}
                              className="text-xs px-3 py-1.5 rounded-lg transition border border-red-600/40 text-red-500 hover:bg-red-600/10 whitespace-nowrap"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Admins Tab ── */}
        {activeTab === "admins" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-2xl font-bold text-white">Admin Users</h2>
                <p className="text-gray-400 text-sm mt-1">Create and manage admin accounts</p>
              </div>
              <button
                onClick={() => { setShowCreateAdmin(true); setAdminForm({ name: "", email: "", password: "" }); setMessage(null); }}
                className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-5 py-2.5 rounded-lg hover:from-yellow-300 hover:to-orange-400 transition"
              >
                + Create Admin
              </button>
            </div>

            {isLoading ? (
              <LoadingScreen variant="admin" fullScreen={false} />
            ) : admins.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-12 text-center">
                <p className="text-gray-400">No admin users yet.</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[650px]">
                  <thead>
                    <tr className="border-b border-white/10 text-gray-400 text-left">
                      <th className="px-5 py-3 font-medium">Name</th>
                      <th className="px-5 py-3 font-medium">Email</th>
                      <th className="px-5 py-3 font-medium">Role</th>
                      <th className="px-5 py-3 font-medium">Password</th>
                      <th className="px-5 py-3 font-medium">Leagues</th>
                      <th className="px-5 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {admins.map((admin, i) => (
                      <tr key={admin.id} className={`border-b border-white/5 ${i % 2 === 0 ? "" : "bg-white/[0.02]"}`}>
                        <td className="px-5 py-3 text-white font-medium">{admin.name}</td>
                        <td className="px-5 py-3 text-gray-300">{admin.email}</td>
                        <td className="px-5 py-3">
                          <span className={`text-xs px-2 py-1 rounded-full ${
                            admin.role === "superadmin"
                              ? "bg-yellow-400/20 text-yellow-400"
                              : "bg-purple-400/20 text-purple-300"
                          }`}>
                            {admin.role}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          {admin.mustChangePassword ? (
                            <span className="text-xs text-orange-400">Must change</span>
                          ) : (
                            <span className="text-xs text-green-400">Set</span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          {admin.role === "superadmin" ? (
                            <span className="text-xs text-gray-500">All leagues</span>
                          ) : (
                            <span className="text-xs text-gray-300">
                              {admin.assignedLeagueIds.length === 0
                                ? <span className="text-gray-500">None</span>
                                : admin.assignedLeagueIds.length === 1
                                  ? `${admin.assignedLeagueIds.length} league`
                                  : `${admin.assignedLeagueIds.length} leagues`
                              }
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => { setEditingAdmin(admin); setEditAdminForm({ name: "", email: "", password: "" }); }}
                              className="text-xs text-yellow-400 hover:text-yellow-300 border border-yellow-400/30 px-2.5 py-1.5 rounded-lg transition"
                            >
                              Edit
                            </button>
                            {admin.role !== "superadmin" && (
                              <>
                                <button
                                  onClick={() => openAssignModal(admin)}
                                  className="text-xs text-blue-400 hover:text-blue-300 border border-blue-400/30 px-2.5 py-1.5 rounded-lg transition"
                                >
                                  Leagues
                                </button>
                                <button
                                  onClick={() => setDeletingAdmin(admin)}
                                  className="text-xs text-red-400 hover:text-red-300 border border-red-400/30 px-2.5 py-1.5 rounded-lg transition"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Operations Tab ── */}
        {activeTab === "operations" && (
          <div>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Operations</h2>
              <p className="text-gray-400 text-sm mt-1">
                Catch-up runner — scores pending fixtures, generates initial playoff brackets,
                advances every league through its playoff window, and pre-warms page caches.
                Idempotent (safe to re-click). Skips any GW where FPL hasn&apos;t marked the
                gameweek as finalized yet.
              </p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center gap-4 flex-wrap">
                <button
                  onClick={handleRunProcessAll}
                  disabled={processRunning}
                  className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-6 py-3 rounded-lg hover:from-yellow-300 hover:to-orange-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {processRunning ? "Processing…" : "Run Auto-Processing for All Leagues"}
                </button>
                {processRunning && processCurrentSlug && (
                  <span className="text-sm text-gray-400 w-full">
                    Processing <span className="text-white">{processCurrentSlug}</span>…
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-3">
                For force-reprocess (recompute every result) or to bypass the FPL finalization gate, use the
                affected league&apos;s own admin page (Scoring tab → Reprocess). The buttons there are scoped
                to one league at a time.
              </p>
            </div>

            {/* Top-level error banner (plan failed, network, etc.) */}
            {processError && (
              <div className="mt-6 rounded-lg border border-red-500/40 bg-red-500/10 p-4">
                <div className="font-semibold text-red-300 mb-1">Run failed</div>
                <pre className="text-xs text-red-200 whitespace-pre-wrap font-mono">{processError}</pre>
              </div>
            )}

            {/* Live progress / final summary panel */}
            {processLeagues.length > 0 && (
              <div className="mt-6 space-y-4">
                {/* Progress bar (during run) or status banner (after) */}
                {(() => {
                  const total = processLeagues.length;
                  const done = processLeagues.filter(l => l.uiStatus !== "queued" && l.uiStatus !== "processing").length;
                  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
                  const okCount = processLeagues.filter(l => l.uiStatus === "ok").length;
                  const partialCount = processLeagues.filter(l => l.uiStatus === "partial").length;
                  const errorCount = processLeagues.filter(l => l.uiStatus === "error").length;
                  const skippedCount = processLeagues.filter(l => l.uiStatus === "skipped").length;
                  const elapsedMs = processStartedAt ? Date.now() - processStartedAt : 0;
                  const elapsed = `${Math.floor(elapsedMs / 1000)}s`;
                  if (processRunning) {
                    return (
                      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
                        <div className="text-sm text-yellow-300 font-semibold mb-2">
                          Processing — {done} of {total} leagues ({pct}%) · elapsed {elapsed}
                        </div>
                        <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-yellow-400 to-orange-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {processDueGws && processDueGws.length > 0 && (
                          <div className="text-xs text-yellow-200/80 mt-2">
                            Due gameweeks: {processDueGws.map(n => `GW${n}`).join(", ")}
                          </div>
                        )}
                      </div>
                    );
                  }
                  if (processDueGws && processDueGws.length === 0 && total === 0) {
                    return (
                      <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-green-300 text-sm">
                        No gameweeks need processing — everything is up to date.
                      </div>
                    );
                  }
                  const tone = errorCount > 0 ? "red" : partialCount > 0 ? "orange" : "green";
                  const cls = tone === "red"
                    ? "border-red-500/30 bg-red-500/10 text-red-300"
                    : tone === "orange"
                    ? "border-orange-500/30 bg-orange-500/10 text-orange-300"
                    : "border-green-500/30 bg-green-500/10 text-green-300";
                  return (
                    <div className={`rounded-lg border ${cls} p-4 text-sm`}>
                      <div className="font-semibold">
                        Run complete: {okCount} ok · {partialCount} partial · {errorCount} error · {skippedCount} skipped · {elapsed} elapsed
                      </div>
                      {processDueGws && (
                        <div className="text-xs mt-1 opacity-80">
                          Due gameweeks this run: {processDueGws.length > 0 ? processDueGws.map(n => `GW${n}`).join(", ") : "(none)"}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Global errors (run-wide skips like "GW35 not yet finalized") */}
                {processGlobalErrors.length > 0 && (
                  <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
                    <div className="font-semibold text-yellow-300 mb-2 text-sm">Global notices</div>
                    <ul className="space-y-1">
                      {processGlobalErrors.map((m, i) => (
                        <li key={i} className="text-xs text-yellow-200 font-mono whitespace-pre-wrap">{m}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Per-league cards (live-updating) */}
                <div className="space-y-3">
                  {processLeagues.map((lg) => {
                    const colour = lg.uiStatus === "ok"
                      ? "border-green-500/30 bg-green-500/5"
                      : lg.uiStatus === "partial"
                      ? "border-orange-500/40 bg-orange-500/5"
                      : lg.uiStatus === "error"
                      ? "border-red-500/40 bg-red-500/5"
                      : lg.uiStatus === "processing"
                      ? "border-yellow-500/40 bg-yellow-500/5 animate-pulse"
                      : lg.uiStatus === "queued"
                      ? "border-white/10 bg-white/[0.02]"
                      : "border-gray-500/30 bg-gray-500/5";
                    const badge = lg.uiStatus === "ok"
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">✓ OK</span>
                      : lg.uiStatus === "partial"
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400">⚠ PARTIAL</span>
                      : lg.uiStatus === "error"
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">✗ ERROR</span>
                      : lg.uiStatus === "processing"
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">⏳ PROCESSING</span>
                      : lg.uiStatus === "queued"
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-gray-500">⏸ QUEUED</span>
                      : <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400">– SKIPPED</span>;
                    const dueGwsForRow = processDueGws ?? [];
                    return (
                      <div key={lg.leagueId} className={`rounded-xl border ${colour} p-4`}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-semibold">{lg.slug}</span>
                            <span className="text-xs text-gray-500">({lg.format})</span>
                          </div>
                          {badge}
                        </div>
                        {/* Per-GW chip row — live progress visible immediately */}
                        {dueGwsForRow.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-3">
                            {dueGwsForRow.map(gw => {
                              const st = lg.gwStates[gw] ?? "queued";
                              const tip = lg.gwTooltips[gw] ?? `GW${gw} — ${st}`;
                              const chipCls = st === "ok"
                                ? "bg-green-500/30 text-green-200 border-green-500/40"
                                : st === "skipped"
                                ? "bg-teal-500/15 text-teal-300/70 border-teal-500/20"
                                : st === "processing"
                                ? "bg-yellow-500/30 text-yellow-200 border-yellow-500/50 animate-pulse"
                                : st === "error"
                                ? "bg-red-500/30 text-red-200 border-red-500/50"
                                : "bg-white/5 text-gray-500 border-white/10";
                              return (
                                <span
                                  key={gw}
                                  title={tip}
                                  className={`text-[10px] px-1.5 py-0.5 rounded border ${chipCls} font-mono`}
                                >
                                  {gw}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        <div className="space-y-1 text-xs text-gray-300 mb-3">
                          <div>
                            <span className="text-gray-500">Scored:</span>{" "}
                            {lg.scoredGws.length > 0 ? lg.scoredGws.map(n => `GW${n}`).join(", ") : "—"}
                          </div>
                          <div>
                            <span className="text-gray-500">Generated:</span>{" "}
                            {lg.generatedFor.length > 0 ? (
                              <span className="text-green-300">{lg.generatedFor.map(n => `GW${n}`).join(", ")}</span>
                            ) : lg.generatedAlready.length > 0 ? (
                              <span className="text-gray-500">
                                {lg.generatedAlready.map(n => `GW${n}`).join(", ")} (already in place)
                              </span>
                            ) : "—"}
                          </div>
                          <div>
                            <span className="text-gray-500">Advanced:</span>{" "}
                            {lg.advancedGws.length > 0 ? lg.advancedGws.map(n => `GW${n}`).join(", ") : "—"}
                          </div>
                          {lg.advanceWindowFuture.length > 0 && (
                            <div className="italic text-yellow-200/70">
                              <span className="text-gray-500 not-italic">Awaiting:</span>{" "}
                              {lg.advanceWindowFuture.map(n => `GW${n}`).join(", ")} not yet finalized
                            </div>
                          )}
                        </div>
                        {lg.errors.length > 0 && (
                          <div className="mt-2 pt-3 border-t border-white/10">
                            <div className="text-xs font-semibold text-red-300 mb-1.5">Errors:</div>
                            <ul className="space-y-1.5">
                              {lg.errors.map((e, i) => (
                                <li key={i} className="text-[11px] text-red-200 font-mono whitespace-pre-wrap leading-relaxed">
                                  {e.gw != null ? `GW${e.gw} ` : ""}{e.step}: {e.message}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {processRunId && (
                  <div className="text-xs text-gray-500 mt-4">Run ID: <code className="text-gray-400">{processRunId}</code></div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── PL Standings Tab ── */}
        {activeTab === "pl-standings" && (
          <div>
            <div className="mb-6 flex flex-wrap items-end gap-4 justify-between">
              <div>
                <h2 className="text-2xl font-bold text-white">PL Standings — Club Auction Tiers</h2>
                <p className="text-gray-400 text-sm mt-1 max-w-2xl">
                  Configures the tier mapping used by the PL Club Auction. Top 8 + Mid (9-17) are last
                  season&apos;s final-ladder slots; Promoted is this season&apos;s 3 newly-promoted clubs (positions
                  18/19/20 shown alphabetically). Tier sets the club&apos;s W/D bonus values.
                </p>
              </div>
              {standings && (
                <div className="text-xs text-gray-500">
                  {standings.updatedAt && <>Last saved: <span className="text-gray-300">{new Date(standings.updatedAt).toLocaleString()}</span></>}
                </div>
              )}
            </div>

            {standingsLoading && !standings && (
              <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-sm text-gray-400">Loading…</div>
            )}

            {standings && (
              <div className="space-y-6">
                {/* Season + save bar */}
                <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                  <label className="text-sm text-gray-300">
                    Season:
                    <input
                      value={standings.season}
                      onChange={(e) => setStandings((prev) => prev ? { ...prev, season: e.target.value } : prev)}
                      className="ml-2 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-white focus:border-yellow-500 focus:outline-none"
                      placeholder="2025-26"
                    />
                  </label>
                  <div className="ml-auto flex items-center gap-3">
                    <span className="text-xs text-gray-400">
                      Counts: <span className="text-yellow-200">{standings.top8.length}</span>/8 ·{" "}
                      <span className="text-blue-200">{standings.mid.length}</span>/9 ·{" "}
                      <span className="text-emerald-200">{standings.promoted.length}</span>/3
                    </span>
                    <button
                      onClick={saveStandings}
                      disabled={standingsSaving}
                      className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-5 py-2 rounded-lg hover:from-yellow-300 hover:to-orange-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      {standingsSaving ? "Saving…" : "Save Standings"}
                    </button>
                  </div>
                </div>

                {/* Tier sections */}
                {(["top8", "mid", "promoted"] as const).map((tier) => {
                  const meta = STANDINGS_TIER_META[tier];
                  const ids = standings[tier];
                  const byId = new Map(standings.plTeams.map((t) => [t.id, t] as const));
                  const inTier = ids.map((id) => byId.get(id)).filter((t): t is PLBootstrapTeam => Boolean(t));
                  const display = tier === "promoted"
                    ? [...inTier].sort((a, b) => a.name.localeCompare(b.name))
                    : inTier;
                  return (
                    <div key={tier} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                      <div className="flex items-center gap-3 mb-4">
                        <span className={`text-xs font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full border ${meta.pillCls}`}>
                          {meta.label}
                        </span>
                        <span className={`text-xs ${ids.length === meta.expected ? "text-gray-400" : "text-red-300"}`}>
                          {ids.length} / {meta.expected}
                        </span>
                      </div>
                      {display.length === 0 ? (
                        <div className="text-sm text-gray-500 italic">No clubs assigned.</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {display.map((t) => (
                            <span key={t.id} className="inline-flex items-center gap-2 rounded-full bg-white/5 border border-white/10 pl-3 pr-1.5 py-1 text-sm text-white">
                              <span>{t.name}</span>
                              <button
                                onClick={() => moveStandingsTeam(t.id, null)}
                                title="Remove from tier"
                                className="rounded-full bg-white/5 text-gray-400 hover:text-white hover:bg-white/10 w-5 h-5 flex items-center justify-center text-xs"
                              >×</button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Unassigned / re-pick pool */}
                {(() => {
                  const assigned = new Set([...standings.top8, ...standings.mid, ...standings.promoted]);
                  const unassigned = standings.plTeams.filter((t) => !assigned.has(t.id));
                  if (unassigned.length === 0) return null;
                  return (
                    <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-5">
                      <div className="text-sm font-semibold text-gray-300 mb-3">Unassigned clubs ({unassigned.length})</div>
                      <div className="space-y-2">
                        {unassigned.map((t) => (
                          <div key={t.id} className="flex items-center justify-between gap-3 bg-white/5 rounded-lg px-3 py-2">
                            <span className="text-sm text-white">{t.name}</span>
                            <div className="flex gap-1">
                              <button
                                onClick={() => moveStandingsTeam(t.id, "top8")}
                                className="text-xs px-2.5 py-1 rounded bg-yellow-500/20 text-yellow-200 hover:bg-yellow-500/30 border border-yellow-500/30"
                              >→ Top 8</button>
                              <button
                                onClick={() => moveStandingsTeam(t.id, "mid")}
                                className="text-xs px-2.5 py-1 rounded bg-blue-500/20 text-blue-200 hover:bg-blue-500/30 border border-blue-500/30"
                              >→ Mid</button>
                              <button
                                onClick={() => moveStandingsTeam(t.id, "promoted")}
                                className="text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 border border-emerald-500/30"
                              >→ Promoted</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Tier scoring reference */}
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-xs text-gray-400">
                  <div className="font-semibold text-gray-300 mb-1">Per-fixture bonus (paid per real-PL fixture the owned club plays in a GW)</div>
                  <div className="grid grid-cols-3 gap-3 mt-2">
                    <div><span className="text-yellow-200 font-semibold">Top 8</span> — Win 2 · Draw 1</div>
                    <div><span className="text-blue-200 font-semibold">Mid</span> — Win 3 · Draw 1</div>
                    <div><span className="text-emerald-200 font-semibold">Promoted</span> — Win 4 · Draw 2</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Score Adjustments Tab ── */}
        {activeTab === "score-adjustments" && (
          <div>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Score Adjustments — PL Club Auction overrides</h2>
              <p className="text-gray-400 text-sm mt-1 max-w-2xl">
                Manually override the <span className="text-yellow-200">Synergy</span> or
                <span className="text-emerald-200"> Club result</span> bonus on a processed GW score row.
                Raw points stay locked. Total auto-recomputes to Raw + Synergy + Club result.
                Every change is logged with the reason you provide.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 mb-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">League</label>
                <select
                  value={adjLeagueId}
                  onChange={(e) => { setAdjLeagueId(e.target.value); setAdjGw(null); setAdjRows([]); }}
                  className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-white focus:border-yellow-500 focus:outline-none"
                >
                  <option value="">— Pick a league —</option>
                  {adjLeagues.map((l) => (
                    <option key={l.id} value={l.id}>{l.slug} · {l.name} ({l.season})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Gameweek</label>
                <select
                  value={adjGw ?? ""}
                  onChange={(e) => {
                    const gw = e.target.value ? parseInt(e.target.value, 10) : null;
                    setAdjGw(gw);
                    if (gw != null && adjLeagueId) fetchAdjRows(adjLeagueId, gw);
                  }}
                  disabled={!adjLeagueId}
                  className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-white focus:border-yellow-500 focus:outline-none disabled:opacity-50"
                >
                  <option value="">— Pick a GW —</option>
                  {(adjLeagueId ? adjGwsByLeague[adjLeagueId] ?? [] : []).map((gw) => (
                    <option key={gw} value={gw}>GW{gw}</option>
                  ))}
                </select>
              </div>
              {adjLoading && <span className="text-xs text-gray-400">Loading…</span>}
            </div>

            {adjRows.length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-white/5 text-xs uppercase tracking-wide text-gray-400">
                    <tr>
                      <th className="text-left px-3 py-2">Team</th>
                      <th className="text-right px-2 py-2">Rank</th>
                      <th className="text-right px-2 py-2">Raw</th>
                      <th className="text-right px-2 py-2">Synergy</th>
                      <th className="text-right px-2 py-2">Club</th>
                      <th className="text-right px-2 py-2">Total</th>
                      <th className="text-left px-3 py-2">Reason</th>
                      <th className="px-2 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {adjRows.map((row) => {
                      const edit = adjEdits[row.id] ?? {};
                      const dirty = edit.synergyBonus != null || edit.clubResultBonus != null;
                      const effSynergy = edit.synergyBonus ?? row.synergyBonus;
                      const effClubResult = edit.clubResultBonus ?? row.clubResultBonus;
                      const previewTotal = row.rawPoints + effSynergy + effClubResult;
                      return (
                        <tr key={row.id} className="border-t border-white/5">
                          <td className="px-3 py-2 text-white">{row.teamName}</td>
                          <td className="px-2 py-2 text-right text-gray-300">{row.rank ?? "—"}</td>
                          <td className="px-2 py-2 text-right text-gray-300">{row.rawPoints}</td>
                          <td className="px-2 py-2 text-right">
                            <input
                              type="number"
                              value={effSynergy}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                setAdjEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], synergyBonus: Number.isFinite(v) ? v : 0 } }));
                              }}
                              className="w-16 rounded border border-white/10 bg-white/5 px-2 py-1 text-yellow-200 text-right text-sm focus:border-yellow-500 focus:outline-none"
                            />
                          </td>
                          <td className="px-2 py-2 text-right">
                            <input
                              type="number"
                              value={effClubResult}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                setAdjEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], clubResultBonus: Number.isFinite(v) ? v : 0 } }));
                              }}
                              className="w-16 rounded border border-white/10 bg-white/5 px-2 py-1 text-emerald-200 text-right text-sm focus:border-emerald-500 focus:outline-none"
                            />
                          </td>
                          <td className={`px-2 py-2 text-right font-semibold ${dirty && previewTotal !== row.totalPoints ? "text-yellow-300" : "text-white"}`}>
                            {previewTotal}
                            {dirty && previewTotal !== row.totalPoints && (
                              <div className="text-[10px] text-gray-500">was {row.totalPoints}</div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={edit.reason ?? ""}
                              placeholder={dirty ? "Required" : ""}
                              onChange={(e) => setAdjEdits((prev) => ({ ...prev, [row.id]: { ...prev[row.id], reason: e.target.value } }))}
                              disabled={!dirty}
                              className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-white text-sm focus:border-yellow-500 focus:outline-none disabled:opacity-50"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <button
                              onClick={() => saveAdj(row)}
                              disabled={!dirty || adjSavingId === row.id || !(edit.reason ?? "").trim()}
                              className="text-xs px-3 py-1 rounded bg-yellow-400 text-slate-900 font-semibold hover:bg-yellow-300 disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              {adjSavingId === row.id ? "Saving…" : "Save"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!adjLoading && adjLeagueId && adjGw != null && adjRows.length === 0 && (
              <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-gray-400">
                No scored rows found for this league/GW combination.
              </div>
            )}
          </div>
        )}

        {/* Feedback Tab — site-scoped feedback only */}
        {activeTab === "feedback" && (
          <FeedbackTab endpoint="/api/superadmin/feedback" scopeLabel="site-wide" />
        )}
      </div>
    </div>
  );
}
