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
  teamCount: number;
  currentGameweek: number | null;
}

export default function AdminLeaguePicker() {
  const [leagues, setLeagues] = useState<League[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSuperadmin, setIsSuperadmin] = useState(false);

  useEffect(() => {
    fetchLeagues();
    fetch("/api/auth/me")
      .then(r => r.json())
      .then(data => { if (data.role === "superadmin") setIsSuperadmin(true); })
      .catch(() => {});
  }, []);

  const fetchLeagues = async () => {
    try {
      const res = await fetch("/api/admin/my-leagues");
      if (res.status === 401 || res.status === 403) {
        window.location.href = "/signin";
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setLeagues(data.leagues || []);
    } catch (err) {
      setError(`Failed to load leagues${err instanceof Error ? `: ${err.message}` : ""}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const sportLabel = (sport: string) => {
    if (sport === "fpl") return "FPL";
    if (sport === "cricket") return "Cricket";
    return sport;
  };

  const formatLabel = (format: string) => {
    if (format === "tvt") return "TVT";
    if (format === "classic") return "Classic";
    return format;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
              TVT
            </div>
            <span className="text-xl font-bold text-white hidden sm:inline">Admin</span>
          </div>
          {isSuperadmin && (
            <Link href="/superadmin" className="text-gray-400 hover:text-white transition text-sm">
              ← Superadmin
            </Link>
          )}
        </div>
        <button
          onClick={handleSignOut}
          className="text-gray-300 hover:text-white transition text-sm"
        >
          Sign Out
        </button>
      </nav>

      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-10">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-white">Your Leagues</h1>
          <p className="text-gray-400 mt-1">Select a league to manage</p>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent" />
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-6 text-red-400">
            {error}
          </div>
        )}

        {!isLoading && !error && leagues.length === 0 && (
          <div className="rounded-xl bg-white/5 border border-white/10 p-12 text-center">
            <p className="text-gray-400 text-lg">No leagues assigned to your account.</p>
            <p className="text-gray-500 text-sm mt-2">Contact a superadmin to get access.</p>
          </div>
        )}

        {!isLoading && leagues.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {leagues.map((league) => (
              <Link
                key={league.id}
                href={`/admin/${league.slug}`}
                className="group block rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur hover:border-yellow-500/50 hover:bg-white/10 transition-all duration-200"
              >
                {/* League name + status badge */}
                <div className="flex items-start justify-between mb-4">
                  <h2 className="text-xl font-bold text-white group-hover:text-yellow-400 transition-colors leading-tight">
                    {league.name}
                  </h2>
                  <span
                    className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                      league.isActive
                        ? "bg-green-500/20 text-green-400 border border-green-500/30"
                        : "bg-gray-500/20 text-gray-400 border border-gray-500/30"
                    }`}
                  >
                    {league.isActive ? "Active" : "Inactive"}
                  </span>
                </div>

                {/* Sport + Format tags */}
                <div className="flex gap-2 mb-5">
                  <span className="rounded-md bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300 border border-purple-500/30">
                    {sportLabel(league.sport)}
                  </span>
                  <span className="rounded-md bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300 border border-blue-500/30">
                    {formatLabel(league.format)}
                  </span>
                  <span className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-gray-400 border border-white/10">
                    {league.season}
                  </span>
                </div>

                {/* Stats row */}
                <div className="flex gap-6 text-sm">
                  <div>
                    <p className="text-gray-500 text-xs mb-0.5">Teams</p>
                    <p className="text-white font-semibold">{league.teamCount}</p>
                  </div>
                  <div>
                    <p className="text-gray-500 text-xs mb-0.5">Current GW</p>
                    <p className="text-white font-semibold">
                      {league.currentGameweek ? `GW${league.currentGameweek}` : "—"}
                    </p>
                  </div>
                </div>

                <div className="mt-5 flex items-center text-yellow-400 text-sm font-semibold opacity-0 group-hover:opacity-100 transition-opacity">
                  Manage →
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
