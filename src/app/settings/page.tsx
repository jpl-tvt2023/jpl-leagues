"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LoadingScreen } from "@/components/LoadingScreen";
import { Logo } from "@/components/Logo";

interface PlayerInfo {
  name: string;
  fplId: string;
}

export default function SettingsPage() {
  const router = useRouter();

  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [teamLoginId, setTeamLoginId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [players, setPlayers] = useState<PlayerInfo[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const meRes = await fetch("/api/auth/me");
        const me = await meRes.json();

        if (!me.authenticated || me.type !== "team") {
          router.push("/signin");
          return;
        }

        const settingsRes = await fetch("/api/team/settings");
        if (!settingsRes.ok) {
          setMessage({ type: "error", text: "Failed to load settings" });
          return;
        }
        const settingsData = await settingsRes.json();
        setTeamLoginId(settingsData.teamLoginId || "");
        setTeamName(settingsData.teamName || "");
        setPlayers(settingsData.players || []);
      } catch (err) {
        console.error("Settings load error:", err);
        setMessage({ type: "error", text: "Network error. Please try again." });
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/team/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamLoginId, teamName }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to update settings" });
        return;
      }

      setMessage({ type: "success", text: "Settings updated successfully!" });
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return <LoadingScreen variant="default" label="Loading Settings" />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Logo />
          <span className="text-xl font-bold text-white hidden sm:inline">Settings</span>
        </Link>
        <Link href="/dashboard" className="text-gray-300 hover:text-white transition">
          Back to Dashboard
        </Link>
      </nav>

      <div className="mx-auto max-w-md px-4 sm:px-6 py-10 sm:py-16">
        <div className="text-center mb-8 sm:mb-10">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2 sm:mb-4">Profile Settings</h1>
          <p className="text-sm sm:text-base text-gray-400">
            View and manage your team&apos;s login details.
          </p>
        </div>

        {message && (
          <div
            className={`mb-6 rounded-lg p-4 ${
              message.type === "success"
                ? "bg-green-500/10 border border-green-500/30 text-green-400"
                : "bg-red-500/10 border border-red-500/30 text-red-400"
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Team Login ID (your userid)</label>
              <input
                type="text"
                value={teamLoginId}
                onChange={(e) => setTeamLoginId(e.target.value)}
                placeholder="Team login ID"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Used to sign in. 3–20 characters: letters, numbers, underscore, or hyphen. Must be unique.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Team Name</label>
              <input
                type="text"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="Team name"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
              />
              <p className="mt-1 text-xs text-gray-500">Must be unique within your league.</p>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>

        {players.length > 0 && (
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
            <h2 className="text-sm font-semibold text-gray-300 mb-4 uppercase tracking-wider">Players</h2>
            <div className="space-y-3">
              {players.map((p, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-white font-medium">{p.name}</span>
                  <span className="text-gray-400 text-sm">FPL ID: {p.fplId}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-500">
              To change a player&apos;s name or FPL ID, please contact your league admin.
            </p>
          </div>
        )}

        <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Password</h2>
            <p className="text-xs text-gray-500 mt-1">Change your password if you know your current one.</p>
          </div>
          <Link
            href="/change-password"
            className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 transition shrink-0"
          >
            Change Password
          </Link>
        </div>
      </div>
    </div>
  );
}
