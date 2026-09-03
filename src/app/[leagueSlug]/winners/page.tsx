"use client";

import { fplEntryUrl } from "@/lib/fpl-links";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useEnforceFormat } from "@/lib/league-context";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LeagueNav } from "@/components/LeagueNav";

interface Winner {
  position: number;
  label: string;
  category: "championship" | "challenger" | "jpl" | "jcl" | "jel" | "auction";
  pending: boolean;
  placeholder?: string;
  teamId: string | null;
  teamName: string | null;
  players: { name: string; fplId: string }[];
}

interface WinnersData {
  concluded: boolean;
  winners: Winner[];
}

export default function LeagueWinnersPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  // Every format EXCEPT fpl-classic, which has none of this page's underlying data (no teams,
  // no fixtures, no playoff bracket). Listing the three explicitly rather than excluding one
  // keeps the existing formats' behaviour byte-identical.
  useEnforceFormat(["tvt", "continental-championship", "auction"]);

  const [data, setData] = useState<WinnersData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [dashboardHref, setDashboardHref] = useState("/dashboard");
  const [leagueName, setLeagueName] = useState<string>("");
  const [leagueFormat, setLeagueFormat] = useState<string | null>(null);
  const [teamSize, setTeamSize] = useState<number | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const me = await res.json();
        if (res.ok && me.authenticated && (me.type === "team" || me.type === "admin" || me.type === "superadmin")) {
          setIsLoggedIn(true);
          if (me.type === "admin" && me.adminLeagueId) setDashboardHref(`/admin/${me.adminLeagueId}`);
          else if (me.type === "superadmin") setDashboardHref("/admin");
        }
      } catch {}
    };

    fetch("/api/leagues")
      .then((r) => r.json())
      .then((d) => {
        const league = (d.leagues || []).find((l: { slug: string; name: string; format?: string; teamSize?: number }) => l.slug === leagueSlug);
        if (league) {
          setLeagueName(league.name);
          setLeagueFormat(league.format ?? null);
          setTeamSize(league.teamSize ?? null);
        }
      })
      .catch(() => {});

    checkAuth();
  }, [leagueSlug]);

  useEffect(() => {
    const fetchWinners = async () => {
      try {
        const res = await fetch(`/api/playoffs/winners?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (res.ok) setData(await res.json());
      } catch (err) {
        console.error("Failed to fetch winners:", err);
      } finally {
        setIsLoading(false);
      }
    };
    if (leagueSlug) fetchWinners();
  }, [leagueSlug]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  if (isLoading) return <LoadingScreen variant="standings" fullScreen />;

  const winners = data?.winners ?? [];
  const concluded = data?.concluded ?? false;

  return (
    <div className="min-h-screen">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueName}
        currentPage="winners"
        format={leagueFormat === "auction" ? "auction" : leagueFormat === "continental-championship" ? "continental-championship" : "tvt"}
        teamSize={teamSize}
        isLoggedIn={isLoggedIn}
        dashboardHref={dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">Hall of Champions</h1>
          <p className="text-sm sm:text-base text-gray-400">Season winners and finalists</p>
        </div>

        {/* Slim progress banner — shown until every position is filled */}
        {!concluded && (
          <div className="mb-6 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 flex items-center gap-3">
            <span className="text-2xl shrink-0">⏳</span>
            <div>
              <div className="text-yellow-300 font-semibold text-sm sm:text-base">Tournament in Progress</div>
              <div className="text-yellow-200/70 text-xs mt-0.5">
                Positions fill in as each playoff round resolves. Winners are crowned once the championship finals conclude.
              </div>
            </div>
          </div>
        )}

        {/* Format dispatcher */}
        {leagueFormat === "continental-championship" ? (
          <ContinentalChampionshipTrophies winners={winners} />
        ) : leagueFormat === "auction" ? (
          <AuctionTrophy winners={winners} />
        ) : (
          <TvtWinnersTable winners={winners} teamSize={teamSize ?? 32} />
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Continental Championship — 3 independent trophy cards (NOT a ranked table)              */
/* ──────────────────────────────────────────────────────────────────────────── */

function ContinentalChampionshipTrophies({ winners }: { winners: Winner[] }) {
  // Sort to canonical JPL / JCL / JEL order regardless of API order.
  const order: Winner["category"][] = ["jpl", "jcl", "jel"];
  const sorted = [...winners].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
      {sorted.map(w => <ContinentalChampionshipCard key={w.position} winner={w} />)}
    </div>
  );
}

function ContinentalChampionshipCard({ winner }: { winner: Winner }) {
  const colourMap: Record<string, { card: string; badge: string }> = {
    jpl: { card: "from-blue-700/40 to-blue-900/20 border-blue-500/40",  badge: "bg-blue-500/20 text-blue-200" },
    jcl: { card: "from-sky-600/40 to-sky-900/20 border-sky-500/40",     badge: "bg-sky-500/20 text-sky-200" },
    jel: { card: "from-amber-600/40 to-amber-900/20 border-amber-500/40", badge: "bg-amber-500/20 text-amber-200" },
  };
  const badgeLabel: Record<string, string> = { jpl: "JPL", jcl: "JCL", jel: "JEL" };
  const c = colourMap[winner.category] ?? colourMap.jpl;
  const pendingCls = winner.pending ? "opacity-60 grayscale" : "";

  return (
    <div className={`rounded-2xl border bg-gradient-to-br ${c.card} ${pendingCls} p-6 transition`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-3xl sm:text-4xl">🏆</span>
        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${c.badge}`}>
          {badgeLabel[winner.category] ?? winner.category.toUpperCase()}
        </span>
      </div>
      <div className="text-white font-bold text-lg sm:text-xl mb-1">{winner.label}</div>
      {winner.pending ? (
        <div className="text-gray-400 italic text-sm">TBD — {winner.placeholder}</div>
      ) : (
        <>
          <div className="text-white font-semibold text-base sm:text-lg">{winner.teamName}</div>
          <div className="mt-3 space-y-1">
            {winner.players.map((p, i) => (
              <a
                key={i}
                href={fplEntryUrl(p.fplId, 38)}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-xs sm:text-sm text-blue-300 hover:text-blue-200 underline"
              >
                {p.name}
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  TVT — sectioned ranked table per teamSize                                   */
/* ──────────────────────────────────────────────────────────────────────────── */

function TvtWinnersTable({ winners, teamSize }: { winners: Winner[]; teamSize: number }) {
  const championship = winners.filter(w => w.category === "championship").sort((a, b) => a.position - b.position);
  const challenger   = winners.filter(w => w.category === "challenger").sort((a, b) => a.position - b.position);

  // TVT-8 has only championship — render a single section.
  if (teamSize === 8 || challenger.length === 0) {
    return <WinnersSection title="Championship" rows={championship} />;
  }

  return (
    <div className="space-y-8">
      <WinnersSection title="Championship Bracket" rows={championship} />
      <WinnersSection title="Challenger Bracket" rows={challenger} />
    </div>
  );
}

function WinnersSection({ title, rows }: { title: string; rows: Winner[] }) {
  return (
    <div>
      <h2 className="text-lg sm:text-xl font-bold text-white mb-3 sm:mb-4">{title}</h2>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[500px]">
          <thead>
            <tr className="border-b border-white/10 bg-white/5">
              <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-gray-400 text-xs font-semibold">Rank</th>
              <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-gray-400 text-xs font-semibold">Position</th>
              <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-gray-400 text-xs font-semibold">Team</th>
              <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-gray-400 text-xs font-semibold">Players</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(w => <WinnerRow key={w.position} winner={w} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WinnerRow({ winner }: { winner: Winner }) {
  const emoji = winner.position === 1 ? "🥇" : winner.position === 2 ? "🥈" : winner.position === 3 ? "🥉" : "⭐";
  const pendingCls = winner.pending ? "opacity-50" : "";
  const filledBg = !winner.pending && winner.position <= 3
    ? (winner.position === 1
        ? "bg-gradient-to-r from-yellow-900/40 to-yellow-800/10"
        : winner.position === 2
          ? "bg-gradient-to-r from-gray-600/40 to-gray-500/10"
          : "bg-gradient-to-r from-amber-900/40 to-amber-800/10")
    : winner.pending ? "" : (winner.category === "challenger" ? "bg-yellow-900/10" : "bg-blue-900/10");

  return (
    <tr className={`border-b border-white/5 transition ${pendingCls} ${filledBg}`}>
      <td className="px-2 sm:px-4 py-3 sm:py-4 text-center text-xl sm:text-2xl">
        <span className={winner.pending ? "grayscale" : ""}>{emoji}</span>
      </td>
      <td className="px-2 sm:px-4 py-3 sm:py-4 text-xs sm:text-sm">
        <div className="text-white font-semibold">{winner.label}</div>
        <div className="text-xs text-gray-500 mt-1"># {winner.position}</div>
      </td>
      <td className="px-2 sm:px-4 py-3 sm:py-4 text-xs sm:text-sm">
        {winner.pending ? (
          <span className="text-gray-500 italic">TBD — {winner.placeholder}</span>
        ) : (
          <span className="text-white font-semibold">{winner.teamName}</span>
        )}
      </td>
      <td className="px-2 sm:px-4 py-3 sm:py-4 text-xs sm:text-sm">
        {winner.pending ? (
          <span className="text-gray-600">—</span>
        ) : (
          <div className="space-y-1">
            {winner.players.map((p, i) => (
              <a
                key={i}
                href={fplEntryUrl(p.fplId, 38)}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-blue-400 hover:text-blue-300 underline"
              >
                {p.name}
              </a>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*  Auction — single hero trophy                                                */
/* ──────────────────────────────────────────────────────────────────────────── */

function AuctionTrophy({ winners }: { winners: Winner[] }) {
  const w = winners[0];
  if (!w) return null;
  const pendingCls = w.pending ? "opacity-60 grayscale" : "";

  return (
    <div className="max-w-xl mx-auto">
      <div className={`rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-700/30 to-teal-900/20 ${pendingCls} p-8 text-center`}>
        <div className="text-5xl sm:text-6xl mb-3">🏆</div>
        <div className="text-emerald-200 text-xs font-bold uppercase tracking-widest mb-2">Auction · Season Champion</div>
        {w.pending ? (
          <div className="text-gray-400 italic text-sm">TBD — {w.placeholder}</div>
        ) : (
          <>
            <div className="text-white font-bold text-xl sm:text-2xl">{w.teamName}</div>
            <div className="mt-4 flex flex-col items-center gap-1">
              {w.players.map((p, i) => (
                <a
                  key={i}
                  href={fplEntryUrl(p.fplId, 38)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-300 hover:text-emerald-200 underline text-sm"
                >
                  {p.name}
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
