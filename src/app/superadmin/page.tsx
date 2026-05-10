"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { LoadingScreen } from "@/components/LoadingScreen";

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

type TabType = "leagues" | "admins" | "operations";

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
    { value: "triple-crown", label: "JPL Triple Crown", description: "PL + UCL + UEL — 20 teams, Double Header scoring" },
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
  }, [activeTab, fetchLeagues, fetchAdmins]);

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
      setLeagueForm({ slug: "", name: "", sport: "", format: "", season: "", teamSize: 32, groupCount: 2, playoffStartGw: 31, enabledChips: ["D", "W", "C"], initialBudget: 100_000_000, isSimulated: false });
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

  // ── Operations: Run Auto-Processing (client-orchestrated, league-by-league) ──
  type LeaguePlanItem = { id: string; slug: string; format: string; teamSize: number | null; playoffStartGw: number | null };
  type LeagueRow = ProcessAllLeagueResult & { uiStatus: "queued" | "processing" | "ok" | "partial" | "error" | "skipped" };

  const [processRunning, setProcessRunning] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processRunId, setProcessRunId] = useState<string | null>(null);
  const [processDueGws, setProcessDueGws] = useState<number[] | null>(null);
  const [processGlobalErrors, setProcessGlobalErrors] = useState<string[]>([]);
  const [processLeagues, setProcessLeagues] = useState<LeagueRow[]>([]);
  const [processCurrentSlug, setProcessCurrentSlug] = useState<string | null>(null);
  const [processStartedAt, setProcessStartedAt] = useState<number | null>(null);
  const [processForce, setProcessForce] = useState(false);
  const [processReprocess, setProcessReprocess] = useState(false);

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
      const planUrl = `/api/admin/process-all/plan${processForce ? "?force=true" : ""}`;
      const planRes = await fetch(planUrl, { credentials: "include" });
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
    })));

    // Step 2: process each league sequentially
    const completedResults: ProcessAllLeagueResult[] = [];
    for (let i = 0; i < plan.leagues.length; i++) {
      const lg = plan.leagues[i];
      setProcessCurrentSlug(lg.slug);

      // mark this league as processing in the UI
      setProcessLeagues(prev => prev.map((row, idx) => idx === i ? { ...row, uiStatus: "processing" } : row));

      try {
        const leagueUrl = `/api/admin/process-all/league${processReprocess ? "?reprocess=true" : ""}`;
        const res = await fetch(leagueUrl, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: plan.runId, league: lg, dueGws: plan.dueGws }),
        });

        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          const txt = (await res.text()).slice(0, 200);
          const errMsg = res.status === 504
            ? `Per-league call timed out (60s). The league has too many unscored fixtures, or "Force re-score" is enabled. Try un-checking Force re-score, or reprocess one GW at a time via the league's own admin page.`
            : `Non-JSON response (HTTP ${res.status}): ${txt}`;
          const failedResult: ProcessAllLeagueResult = {
            leagueId: lg.id, slug: lg.slug, format: lg.format,
            status: "error", scoredGws: [], advancedGws: [], generatedFor: [],
            generatedAlready: [], advanceWindowFuture: [],
            errors: [{ step: "league", message: errMsg }],
          };
          completedResults.push(failedResult);
          setProcessLeagues(prev => prev.map((row, idx) => idx === i ? { ...failedResult, uiStatus: "error" } : row));
          continue;
        }

        const data = await res.json();
        if (!res.ok) {
          const errMsg = `HTTP ${res.status}: ${data.error ?? data.message ?? "unknown"}`;
          const failedResult: ProcessAllLeagueResult = {
            leagueId: lg.id, slug: lg.slug, format: lg.format,
            status: "error", scoredGws: [], advancedGws: [], generatedFor: [],
            generatedAlready: [], advanceWindowFuture: [],
            errors: [{ step: "league", message: errMsg }],
          };
          completedResults.push(failedResult);
          setProcessLeagues(prev => prev.map((row, idx) => idx === i ? { ...failedResult, uiStatus: "error" } : row));
          continue;
        }

        const result: ProcessAllLeagueResult = data.result;
        completedResults.push(result);
        setProcessLeagues(prev => prev.map((row, idx) => idx === i ? { ...result, uiStatus: result.status } : row));
      } catch (e) {
        const errMsg = `Network error: ${e instanceof Error ? e.message : "unknown"}`;
        const failedResult: ProcessAllLeagueResult = {
          leagueId: lg.id, slug: lg.slug, format: lg.format,
          status: "error", scoredGws: [], advancedGws: [], generatedFor: [],
          generatedAlready: [], advanceWindowFuture: [],
          errors: [{ step: "league", message: errMsg }],
        };
        completedResults.push(failedResult);
        setProcessLeagues(prev => prev.map((row, idx) => idx === i ? { ...failedResult, uiStatus: "error" } : row));
      }
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
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900">
            JPL
          </div>
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
                onClick={() => { setShowWizard(true); setWizardStep("sport"); setLeagueForm({ slug: "", name: "", sport: "", format: "", season: "", teamSize: 32, groupCount: 2, playoffStartGw: 31, enabledChips: ["D", "W", "C"], initialBudget: 100_000_000, isSimulated: false }); setMessage(null); }}
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
                              if (opt.value === "triple-crown") {
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
                <label className="flex items-center gap-2 text-sm text-gray-300 select-none cursor-pointer">
                  <input
                    type="checkbox"
                    checked={processForce}
                    onChange={(e) => setProcessForce(e.target.checked)}
                    disabled={processRunning}
                    className="h-4 w-4 rounded border-white/20 bg-white/5"
                  />
                  Force-process even if FPL hasn&apos;t finalized
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300 select-none cursor-pointer">
                  <input
                    type="checkbox"
                    checked={processReprocess}
                    onChange={(e) => setProcessReprocess(e.target.checked)}
                    disabled={processRunning}
                    className="h-4 w-4 rounded border-white/20 bg-white/5"
                  />
                  Force re-score (recompute every result from scratch)
                </label>
                {processRunning && processCurrentSlug && (
                  <span className="text-sm text-gray-400 w-full">
                    Processing <span className="text-white">{processCurrentSlug}</span>…
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-3">
                <strong className="text-gray-400">Force-process</strong> bypasses the FPL bootstrap gate. Use only when you know the
                gameweek scores are stable but FPL&apos;s bootstrap hasn&apos;t flipped <code>finished=true</code> yet
                (extended FPL outage, test environment, etc.).
              </p>
              <p className="text-xs text-gray-500 mt-2">
                <strong className="text-gray-400">Force re-score</strong> deletes every existing result and recomputes from FPL.
                Slow — typically only finishes within 60s for leagues that have just a few GWs of history. Don&apos;t enable
                routinely; use for emergencies after a scoring-rule change.
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
                    const isInflight = lg.uiStatus === "queued" || lg.uiStatus === "processing";
                    return (
                      <div key={lg.leagueId} className={`rounded-xl border ${colour} p-4`}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-semibold">{lg.slug}</span>
                            <span className="text-xs text-gray-500">({lg.format})</span>
                          </div>
                          {badge}
                        </div>
                        {!isInflight && (
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
                        )}
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
      </div>
    </div>
  );
}
