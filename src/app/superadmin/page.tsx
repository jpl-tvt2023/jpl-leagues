"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface League {
  id: string;
  slug: string;
  name: string;
  sport: string;
  format: string;
  season: string;
  isActive: boolean;
  createdAt: string;
}

interface Admin {
  id: string;
  name: string;
  email: string;
  role: string;
  mustChangePassword: boolean;
  createdAt: string;
}

type TabType = "leagues" | "admins" | "settings";

export default function SuperAdminDashboard() {
  const [activeTab, setActiveTab] = useState<TabType>("leagues");
  const [leagues, setLeagues] = useState<League[]>([]);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Create league form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [leagueForm, setLeagueForm] = useState({
    slug: "", name: "", sport: "fpl", format: "tvt", season: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Settings
  type SettingsKey = "captainAnnouncementEnabled" | "chipAnnouncementEnabled";
  const [platformSettings, setPlatformSettings] = useState<Record<SettingsKey, boolean>>({
    captainAnnouncementEnabled: true,
    chipAnnouncementEnabled: true,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);

  useEffect(() => {
    if (activeTab === "leagues") fetchLeagues();
    else if (activeTab === "admins") fetchAdmins();
    else if (activeTab === "settings" && !settingsLoaded) fetchSettings();
  }, [activeTab]);

  const fetchLeagues = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/superadmin/leagues");
      if (res.status === 401 || res.status === 403) { window.location.href = "/signin"; return; }
      const data = await res.json();
      setLeagues(data.leagues || []);
    } catch { /* silent */ } finally { setIsLoading(false); }
  };

  const fetchAdmins = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/superadmin/admins");
      if (res.status === 401 || res.status === 403) { window.location.href = "/signin"; return; }
      const data = await res.json();
      setAdmins(data.admins || []);
    } catch { /* silent */ } finally { setIsLoading(false); }
  };

  const fetchSettings = async () => {
    setSettingsLoading(true);
    try {
      const res = await fetch("/api/admin/settings");
      const data = await res.json();
      setPlatformSettings({
        captainAnnouncementEnabled: data.captainAnnouncementEnabled ?? true,
        chipAnnouncementEnabled: data.chipAnnouncementEnabled ?? true,
      });
      setSettingsLoaded(true);
    } catch { /* silent */ } finally { setSettingsLoading(false); }
  };

  const handleCreateLeague = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/superadmin/leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(leagueForm),
      });
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "Failed to create league" }); return; }
      setMessage({ type: "success", text: "League created successfully!" });
      setShowCreateForm(false);
      setLeagueForm({ slug: "", name: "", sport: "fpl", format: "tvt", season: "" });
      setLeagues(prev => [...prev, { ...data, createdAt: new Date().toISOString() }]);
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

  const toggleSetting = async (key: SettingsKey, value: boolean) => {
    setSettingsLoading(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (res.ok) setPlatformSettings(prev => ({ ...prev, [key]: value }));
      else setMessage({ type: "error", text: "Failed to update setting" });
    } catch { setMessage({ type: "error", text: "Network error" }); }
    finally { setSettingsLoading(false); }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const tabs: { id: TabType; label: string }[] = [
    { id: "leagues", label: "Leagues" },
    { id: "admins", label: "Admins" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
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
          <Link href="/admin" className="text-gray-300 hover:text-white transition">League Admin</Link>
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
                onClick={() => { setShowCreateForm(!showCreateForm); setMessage(null); }}
                className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-5 py-2.5 rounded-lg hover:from-yellow-300 hover:to-orange-400 transition"
              >
                + Create League
              </button>
            </div>

            {/* Create league form */}
            {showCreateForm && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 mb-6">
                <h3 className="text-white font-semibold mb-4">New League</h3>
                <form onSubmit={handleCreateLeague} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Slug <span className="text-gray-500">(unique ID, e.g. tvt-fpl)</span></label>
                    <input
                      required value={leagueForm.slug}
                      onChange={e => setLeagueForm({ ...leagueForm, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
                      placeholder="tvt-fpl"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Name</label>
                    <input
                      required value={leagueForm.name}
                      onChange={e => setLeagueForm({ ...leagueForm, name: e.target.value })}
                      placeholder="JPL TVT FPL"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Sport</label>
                    <select
                      value={leagueForm.sport}
                      onChange={e => setLeagueForm({ ...leagueForm, sport: e.target.value })}
                      className="w-full rounded-lg border border-white/10 bg-slate-800 px-4 py-2.5 text-white focus:border-yellow-500 focus:outline-none"
                    >
                      <option value="fpl">FPL</option>
                      <option value="cricket">Cricket</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Format</label>
                    <select
                      value={leagueForm.format}
                      onChange={e => setLeagueForm({ ...leagueForm, format: e.target.value })}
                      className="w-full rounded-lg border border-white/10 bg-slate-800 px-4 py-2.5 text-white focus:border-yellow-500 focus:outline-none"
                    >
                      <option value="tvt">TVT</option>
                      <option value="classic">Classic</option>
                      <option value="grand-prix">Grand Prix</option>
                      <option value="auction">Auction</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm text-gray-300 mb-1">Season</label>
                    <input
                      required value={leagueForm.season}
                      onChange={e => setLeagueForm({ ...leagueForm, season: e.target.value })}
                      placeholder="2025-26"
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none"
                    />
                  </div>
                  <div className="sm:col-span-2 flex gap-3">
                    <button
                      type="submit" disabled={isSubmitting}
                      className="bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold px-6 py-2.5 rounded-lg hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50"
                    >
                      {isSubmitting ? "Creating..." : "Create League"}
                    </button>
                    <button
                      type="button" onClick={() => setShowCreateForm(false)}
                      className="text-gray-400 hover:text-white px-4 py-2.5 transition"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Leagues list */}
            {isLoading ? (
              <p className="text-gray-400 text-center py-12">Loading leagues...</p>
            ) : leagues.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-12 text-center">
                <p className="text-gray-400">No leagues yet. Create your first league above.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {leagues.map(league => (
                  <div key={league.id} className="rounded-xl border border-white/10 bg-white/5 p-5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${league.isActive ? "bg-green-400" : "bg-gray-500"}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-white font-semibold">{league.name}</span>
                          <span className="text-xs text-gray-500 font-mono">{league.slug}</span>
                        </div>
                        <div className="flex gap-3 mt-1 text-xs text-gray-400">
                          <span className="capitalize">{league.sport}</span>
                          <span>·</span>
                          <span className="capitalize">{league.format}</span>
                          <span>·</span>
                          <span>{league.season}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Link
                        href="/admin"
                        className="text-xs text-yellow-400 hover:text-yellow-300 transition border border-yellow-400/30 px-3 py-1.5 rounded-lg"
                      >
                        Manage
                      </Link>
                      <button
                        onClick={() => toggleLeagueActive(league)}
                        className={`text-xs px-3 py-1.5 rounded-lg transition border ${
                          league.isActive
                            ? "border-red-400/30 text-red-400 hover:bg-red-400/10"
                            : "border-green-400/30 text-green-400 hover:bg-green-400/10"
                        }`}
                      >
                        {league.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Admins Tab ── */}
        {activeTab === "admins" && (
          <div>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Admin Users</h2>
              <p className="text-gray-400 text-sm mt-1">All admin accounts on the platform</p>
            </div>

            {isLoading ? (
              <p className="text-gray-400 text-center py-12">Loading admins...</p>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-gray-400 text-left">
                      <th className="px-5 py-3 font-medium">Name</th>
                      <th className="px-5 py-3 font-medium">Email</th>
                      <th className="px-5 py-3 font-medium">Role</th>
                      <th className="px-5 py-3 font-medium">Password</th>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Settings Tab ── */}
        {activeTab === "settings" && (
          <div>
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">Platform Settings</h2>
              <p className="text-gray-400 text-sm mt-1">Toggle announcement features and other platform-wide settings</p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 divide-y divide-white/10">
              {([
                {
                  key: "captainAnnouncementEnabled" as SettingsKey,
                  label: "Captain Announcements",
                  description: "Allow teams to announce captains via WhatsApp bot",
                },
                {
                  key: "chipAnnouncementEnabled" as SettingsKey,
                  label: "Chip Announcements",
                  description: "Allow teams to announce chip usage via WhatsApp bot",
                },
              ] as const).map(setting => (
                <div key={setting.key} className="flex items-center justify-between px-6 py-5">
                  <div>
                    <p className="text-white font-medium">{setting.label}</p>
                    <p className="text-gray-400 text-sm">{setting.description}</p>
                  </div>
                  <button
                    disabled={settingsLoading}
                    onClick={() => toggleSetting(setting.key, !platformSettings[setting.key])}
                    className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${
                      platformSettings[setting.key] ? "bg-yellow-400" : "bg-gray-600"
                    } disabled:opacity-50`}
                  >
                    <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${
                      platformSettings[setting.key] ? "translate-x-7" : "translate-x-1"
                    }`} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
