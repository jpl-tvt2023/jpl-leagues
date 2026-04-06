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
}

const SPORT_ICONS: Record<string, string> = {
  fpl: "⚽",
  cricket: "🏏",
};

const SPORT_GRADIENTS: Record<string, string> = {
  fpl: "from-purple-900/60 via-blue-900/40 to-slate-900/60",
  cricket: "from-emerald-900/40 via-teal-900/30 to-slate-900/60",
};

const SPORT_GLOW: Record<string, string> = {
  fpl: "bg-purple-600/10",
  cricket: "bg-emerald-600/10",
};

const STANDINGS_BTN: Record<string, string> = {
  fpl: "bg-purple-600 hover:bg-purple-500 text-white",
  cricket: "bg-emerald-700/40 text-emerald-300",
};

export default function Home() {
  const [leagues, setLeagues] = useState<League[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => setLeagues(data.leagues || []))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/10 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 font-extrabold text-slate-900 text-sm">
              JPL
            </div>
            <span className="hidden text-lg font-bold text-white sm:inline">JPL Sports</span>
          </div>
          <Link
            href="/signin"
            className="rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-5 py-2 text-sm font-bold text-slate-900 transition hover:from-yellow-300 hover:to-orange-400"
          >
            Sign In
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-6 py-20 text-center">
        <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-yellow-400">
          JPL Sports
        </p>
        <h1 className="text-5xl font-extrabold tracking-tight text-white sm:text-6xl">
          Fantasy League Hub
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-gray-400">
          Choose your league and compete. Multiple formats, one platform.
        </p>
      </section>

      {/* League Cards */}
      <section className="mx-auto max-w-5xl px-4 pb-24 sm:px-6">
        {isLoading ? (
          <div className="grid gap-6 sm:grid-cols-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-64 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
            ))}
          </div>
        ) : leagues.length === 0 ? (
          <p className="text-center text-gray-500">No leagues available yet.</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 items-stretch">
            {leagues.map((league) => {
              const icon = SPORT_ICONS[league.sport] ?? "🏆";
              const gradient = SPORT_GRADIENTS[league.sport] ?? "from-slate-800/60 to-slate-900/60";
              const glow = SPORT_GLOW[league.sport] ?? "bg-white/5";
              const standingsBtn = STANDINGS_BTN[league.sport] ?? "bg-white/10 text-white";

              return (
                <div
                  key={league.id}
                  className={`relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br ${gradient} p-8 shadow-xl h-full flex flex-col`}
                >
                  <div className={`absolute -right-8 -top-8 h-40 w-40 rounded-full ${glow} blur-2xl`} />
                  <div className="relative flex flex-col flex-1">
                    <div className="mb-5 flex items-center gap-3">
                      <span className="text-4xl">{icon}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="text-2xl font-extrabold text-white">{league.name}</h2>
                          {league.isActive ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2.5 py-0.5 text-xs font-semibold text-green-400">
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                              </span>
                              Live
                            </span>
                          ) : (
                            <span className="rounded-full bg-yellow-500/20 px-2.5 py-0.5 text-xs font-semibold text-yellow-400">
                              Coming Soon
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-400">
                          {league.sport.toUpperCase()} · {league.format.toUpperCase()} · {league.season}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3 mt-auto">
                      <Link
                        href={`/${league.slug}/standings`}
                        className={`rounded-full px-4 py-2 text-sm font-semibold transition ${standingsBtn}`}
                      >
                        Standings
                      </Link>
                      {league.format === "triple-crown" ? (
                        <>
                          <Link
                            href={`/${league.slug}/fixtures`}
                            className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                          >
                            PL Fixtures
                          </Link>
                          <Link
                            href={`/${league.slug}/uefa-standings`}
                            className="rounded-full border border-blue-400/30 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-300 transition hover:bg-blue-500/20"
                          >
                            UEFA Standings
                          </Link>
                          <Link
                            href={`/${league.slug}/uefa-fixtures`}
                            className="rounded-full border border-blue-400/30 bg-blue-500/10 px-4 py-2 text-sm font-semibold text-blue-300 transition hover:bg-blue-500/20"
                          >
                            UEFA Fixtures
                          </Link>
                        </>
                      ) : (
                        <>
                          <Link
                            href={`/${league.slug}/fixtures`}
                            className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                          >
                            Fixtures
                          </Link>
                          <Link
                            href={`/${league.slug}/playoffs`}
                            className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
                          >
                            Playoffs
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 bg-slate-900/50 py-8 text-center text-sm text-gray-500">
        JPL Sports © 2026 &mdash; Multiple fantasy sports, one league platform.
      </footer>
    </div>
  );
}
