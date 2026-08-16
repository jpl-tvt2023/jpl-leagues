"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LeagueNav } from "@/components/LeagueNav";
import { useEnforceFormat, useLeague } from "@/lib/league-context";
import { formatCurrency } from "@/lib/format/currency";

interface SessionRow {
  id: string;
  type: "initial" | "mini-auction" | "club-auction";
  cycleNumber: number;
  status: "pending" | "active" | "paused" | "completed";
  snakeOrder: string[];
  scheduledAt: string | null;
  bidTimerSeconds: number;
  nominationTimeoutSeconds: number;
  intermissionSeconds: number;
}

const SESSION_LABEL: Record<SessionRow["type"], (cycle: number) => string> = {
  initial: () => "Initial Auction",
  "club-auction": () => "Club Auction",
  "mini-auction": (cycle) => `Mini-Auction #${cycle}`,
};

const STATUS_STYLE: Record<SessionRow["status"], string> = {
  pending: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  active: "bg-green-500/20 text-green-300 border-green-500/40",
  paused: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
  completed: "bg-white/10 text-gray-300 border-white/20",
};

const STATUS_ORDER: Record<SessionRow["status"], number> = { active: 0, paused: 1, pending: 2, completed: 3 };

export default function AuctionSessionsListPage() {
  useEnforceFormat(["auction"]);
  const { league } = useLeague();
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [myPurse, setMyPurse] = useState<number | null>(null);

  const loadInitial = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [meRes, leaguesRes] = await Promise.all([
        fetch("/api/auth/me"),
        fetch("/api/leagues"),
      ]);
      const me = await meRes.json();
      if (!me.authenticated) {
        router.push("/signin");
        return;
      }
      if (me.type !== "team") {
        setError("Auction is only available to team accounts.");
        setIsLoading(false);
        return;
      }

      const leaguesJson = await leaguesRes.json();
      const leagueRow = (leaguesJson.leagues || []).find((l: { slug: string; id: string }) => l.slug === leagueSlug);
      if (!leagueRow) throw new Error("League not found");

      const [sessRes, econRes] = await Promise.all([
        fetch(`/api/auction/session?leagueId=${leagueRow.id}`),
        fetch(`/api/auction/economy?teamId=${me.team.id}`),
      ]);
      if (sessRes.ok) {
        const d = await sessRes.json();
        setSessions(d.sessions ?? []);
      }
      if (econRes.ok) {
        const d = await econRes.json();
        setMyPurse(d.computedPurse ?? 0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load auction sessions");
    } finally {
      setIsLoading(false);
    }
  }, [leagueSlug, router]);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const sorted = [...sessions].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueSlug}
        currentPage="auction"
        format="auction"
        auctionTier={league.auctionTier ?? "complete"}
        isLoggedIn={true}
        dashboardHref="/dashboard"
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Auction Sessions</h1>
            <p className="text-sm text-gray-400 mt-1">Enter any session — live, upcoming, or completed.</p>
          </div>
          {myPurse !== null && (
            <div className="text-right">
              <div className="text-xs text-gray-400 uppercase">Your Purse</div>
              <div className="font-mono font-bold text-green-300 text-lg">{formatCurrency(myPurse)}</div>
            </div>
          )}
        </div>

        {isLoading ? (
          <LoadingScreen variant="default" fullScreen={false} label="Loading Sessions" />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-16 rounded-2xl border border-white/10 bg-white/5">
            <h2 className="text-xl font-semibold text-white mb-2">No Auction Sessions Yet</h2>
            <p className="text-gray-400">The admin hasn&apos;t created any auction sessions for this league.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sorted.map((session) => {
              const sched = session.scheduledAt ? new Date(session.scheduledAt) : null;
              return (
                <Link
                  key={session.id}
                  href={`/${leagueSlug}/auction/${session.id}`}
                  className="group block p-4 rounded-2xl bg-white/5 border border-white/10 hover:border-yellow-400/40 hover:bg-white/[0.07] transition backdrop-blur"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="font-semibold text-white text-lg">{SESSION_LABEL[session.type](session.cycleNumber)}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold tracking-wider border ${STATUS_STYLE[session.status]}`}>
                          {session.status}
                        </span>
                        {sched && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                            📅 {sched.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                        <span>{session.snakeOrder.length} teams</span>
                        <span>Bid timer: {session.bidTimerSeconds}s</span>
                        <span>Nomination timeout: {session.nominationTimeoutSeconds}s</span>
                        <span>Intermission: {session.intermissionSeconds}s</span>
                      </div>
                    </div>
                    <span className="text-yellow-400 text-sm font-semibold shrink-0 group-hover:translate-x-0.5 transition-transform">
                      Enter Room →
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
