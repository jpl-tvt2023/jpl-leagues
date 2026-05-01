"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { NotificationBell } from "@/components/NotificationBell";

// Types
interface DashboardData {
  team: {
    id: string;
    name: string;
    group: string;
    leaguePoints: number;
    bonusPoints: number;
  };
  deadline: {
    gameweek: number;
    timestamp: string | null;
  };
  serverTime: string;
  upcomingFixture: {
    isHome: boolean;
    opponent: {
      id: string;
      name: string;
      players: { name: string; fplId: string; fplUrl: string }[];
    };
    gameweek: number;
    lastCompletedGw?: number;
  } | null;
  upcomingCaptain: { playerId: string; playerName: string } | null;
  upcomingChip: { type: string; chipName: string } | null;
  lastGwResult: {
    gameweek: number;
    result: "W" | "D" | "L";
    myScore: number;
    oppScore: number;
    gotBonus: boolean;
    isHome: boolean;
    myTeamId: string;
    myTeamName: string;
    opponentTeamId: string | null;
    opponent: string;
    hasMyCaptainData: boolean;
    hasOppCaptainData: boolean;
    myPlayerScores: { name: string; isCaptain: boolean; fplScore: number; transferHits: number; finalScore: number; isInferred?: boolean; fplId?: string; fplUrl?: string }[];
    oppPlayerScores: { name: string; isCaptain: boolean; fplScore: number; transferHits: number; finalScore: number; isInferred?: boolean; fplId?: string; fplUrl?: string }[];
    isPlayoff?: boolean;
    roundName?: string | null;
    tieId?: string | null;
    leg?: number | null;
  } | null;
  // Add min/max completed GW for navigation
  minCompletedGw?: number;
  maxCompletedGw?: number;
  recentForm: { gameweek: number; result: "W" | "D" | "L"; score: string; gotBonus: boolean }[];
  seasonStats: {
    played: number;
    wins: number;
    draws: number;
    losses: number;
    pointsFor: number;
    pointsAgainst: number;
    pointsDiff: number;
    bonusPointsEarned: number;
    chipPointsEarned: number;
    highestScoringGW: { gameweek: number; score: number; opponent?: string } | null;
    lowestScoringGW: { gameweek: number; score: number; opponent?: string } | null;
    currentStreak: { type: "W" | "D" | "L"; count: number } | null;
  };
  leaguePosition: {
    groupRank: number;
    zone: "playoffs" | "challenger" | "eliminated";
    pointsToTop: number;
    miniTable: { rank: number; name: string; points: number; isCurrentTeam: boolean }[];
  };
  chipStatus: {
    currentSet: 1 | 2 | "playoffs";
    set1: {
      doublePointer: { used: boolean; name: string };
      challengeChip: { used: boolean; name: string };
      winWin: { used: boolean; name: string };
    };
    set2: {
      doublePointer: { used: boolean; name: string };
      challengeChip: { used: boolean; name: string };
      winWin: { used: boolean; name: string };
    };
  };
  captaincyStatus: {
    player1: { id: string; name: string; chipsUsed: number; chipsRemaining: number };
    player2: { id: string; name: string; chipsUsed: number; chipsRemaining: number };
    recentCaptains: { gameweek: number; playerName: string; score: number }[];
  };
  upcomingFixtures: { gameweek: number; opponent: string; isHome: boolean; competitionType?: string; competitionLabel?: string }[];
  oppositeGroupTeams: { id: string; name: string }[];
  announcementSettings: {
    captainAnnouncementEnabled: boolean;
    chipAnnouncementEnabled: boolean;
  };
  teamMembers: {
    name: string;
    fplId: string;
    fplUrl: string;
    fplHistoryUrl: string;
    captaincyChipsUsed: number;
  }[];
  leagueGroupCount?: number;
  plPosition?: {
    rank: number;
    totalTeams: number;
  };
  cupProgress?: {
    groupName: string | null;
    rank: number;
    totalTeams: number;
    cupZone: "ucl" | "uel";
    minCompletedCupGw?: number | null;
    maxCompletedCupGw?: number | null;
    completedCupGws?: number[];
    miniTable: { rank: number; name: string; wins: number; losses: number; cupGroupPoints: number; isCurrentTeam: boolean }[];
    lastCupResult: {
      gameweek: number;
      competitionType: string;
      competitionLabel: string;
      opponent: string | undefined;
      isHome: boolean;
      myScore: number;
      oppScore: number;
      result: "W" | "L";
      myPlayerScores?: any[];
      oppPlayerScores?: any[];
      hasMyCaptainData?: boolean;
      hasOppCaptainData?: boolean;
    } | null;
    upcomingCupFixture: {
      gameweek: number;
      competitionType: string;
      competitionLabel: string;
      opponent: string | undefined;
      isHome: boolean;
    } | null;
  };
  cupGwResult?: {
    gameweek: number;
    competitionType: string;
    competitionLabel: string;
    result: "W" | "L";
    myScore: number;
    oppScore: number;
    isHome: boolean;
    myTeamName: string;
    opponent: string;
    hasMyCaptainData: boolean;
    hasOppCaptainData: boolean;
    myPlayerScores: any[];
    oppPlayerScores: any[];
  } | null;
}

// Countdown Timer Component
function DeadlineTimer({ deadline, gameweek, serverTime, label, expiredLabel }: { deadline: string | null; gameweek: number; serverTime?: string; label?: string; expiredLabel?: string }) {
  const [timeLeft, setTimeLeft] = useState<{ days: number; hours: number; minutes: number; seconds: number } | null>(null);
  const [isExpired, setIsExpired] = useState(false);
  // Compute server-client time offset once on mount so the countdown
  // reflects the server clock, not the (possibly drifted) client clock.
  const [serverOffset] = useState(() =>
    serverTime ? new Date(serverTime).getTime() - Date.now() : 0
  );

  useEffect(() => {
    if (!deadline) return;

    const calculateTimeLeft = () => {
      const deadlineDate = new Date(deadline);
      const now = new Date(Date.now() + serverOffset);
      const diff = deadlineDate.getTime() - now.getTime();

      if (diff <= 0) {
        setIsExpired(true);
        setTimeLeft(null);
        return;
      }

      setIsExpired(false);
      setTimeLeft({
        days: Math.floor(diff / (1000 * 60 * 60 * 24)),
        hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((diff % (1000 * 60)) / 1000),
      });
    };

    calculateTimeLeft();
    const interval = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  if (!deadline) {
    return (
      <div className="text-center text-gray-400">
        No upcoming deadline
      </div>
    );
  }

  if (isExpired) {
    return (
      <div className="text-center">
        <div className="text-red-400 text-xl font-bold">{expiredLabel ?? `GW${gameweek} Deadline Passed`}</div>
        <div className="text-gray-400 text-sm mt-1">Waiting for results...</div>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="text-sm text-gray-400 mb-2">{label ?? `GW${gameweek} Deadline`}</div>
      <div className="flex justify-center gap-2 sm:gap-3 flex-wrap">
        {timeLeft?.days !== undefined && timeLeft.days > 0 && (
          <div className="bg-white/10 rounded-lg px-3 sm:px-4 py-2">
            <div className="text-lg sm:text-2xl font-bold text-white">{timeLeft.days}</div>
            <div className="text-[10px] sm:text-xs text-gray-400">days</div>
          </div>
        )}
        <div className="bg-white/10 rounded-lg px-3 sm:px-4 py-2">
          <div className="text-lg sm:text-2xl font-bold text-white">{timeLeft?.hours.toString().padStart(2, "0")}</div>
          <div className="text-[10px] sm:text-xs text-gray-400">hrs</div>
        </div>
        <div className="bg-white/10 rounded-lg px-3 sm:px-4 py-2">
          <div className="text-lg sm:text-2xl font-bold text-white">{timeLeft?.minutes.toString().padStart(2, "0")}</div>
          <div className="text-[10px] sm:text-xs text-gray-400">mins</div>
        </div>
        <div className="bg-white/10 rounded-lg px-3 sm:px-4 py-2">
          <div className="text-lg sm:text-2xl font-bold text-yellow-400">{timeLeft?.seconds.toString().padStart(2, "0")}</div>
          <div className="text-[10px] sm:text-xs text-gray-400">secs</div>
        </div>
      </div>
    </div>
  );
}

// Next Deadline card content — auction-only.
// Returns null when there's no live, paused, or scheduled auction so the card collapses.
function NextDeadlineContent({ data, leagueSlug }: { data: AuctionDashboardData; leagueSlug: string }) {
  // 1. Auction live
  if (data.auctionSession?.status === "active") {
    return (
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
          </span>
          <span className="text-red-300 font-bold text-lg">🔨 Auction Live</span>
        </div>
        <Link href={`/${leagueSlug}/auction`} className="inline-block px-4 py-2 rounded-lg bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 font-semibold transition text-sm">
          Join Room
        </Link>
      </div>
    );
  }

  // 2. Auction paused
  if (data.auctionSession?.status === "paused") {
    return (
      <div className="text-center">
        <div className="text-gray-300 font-bold text-lg mb-2">⏸ Auction Paused</div>
        <Link href={`/${leagueSlug}/auction`} className="text-yellow-300 hover:text-yellow-200 text-sm underline">
          View room
        </Link>
      </div>
    );
  }

  // 3. Scheduled upcoming auction
  if (data.nextAuction) {
    const typeLabel =
      data.nextAuction.type === "initial"
        ? "Initial Auction"
        : `Mini-Auction #${data.nextAuction.cycleNumber}`;
    return (
      <DeadlineTimer
        deadline={data.nextAuction.scheduledAt}
        gameweek={0}
        serverTime={data.serverTime}
        label={typeLabel}
        expiredLabel={`${typeLabel} starting...`}
      />
    );
  }

  // 4. No auction scheduled — collapse the card
  return null;
}

// Form Result Badge
function FormBadge({ result, gotBonus }: { result: "W" | "D" | "L"; gotBonus: boolean }) {
  const colors = {
    W: "bg-green-500",
    D: "bg-gray-500",
    L: "bg-red-500",
  };

  return (
    <div className="relative">
      <div className={`w-8 h-8 ${colors[result]} rounded-full flex items-center justify-center text-white font-bold text-sm`}>
        {result}
      </div>
      {gotBonus && (
        <div className="absolute -top-1 -right-1 w-4 h-4 bg-yellow-500 rounded-full flex items-center justify-center text-xs text-slate-900 font-bold">
          B
        </div>
      )}
    </div>
  );
}

// Zone Badge
function ZoneBadge({ zone }: { zone: "playoffs" | "challenger" | "eliminated" }) {
  const config = {
    playoffs: { bg: "bg-green-500/20", text: "text-green-400", label: "Playoffs" },
    challenger: { bg: "bg-yellow-500/20", text: "text-yellow-400", label: "Challenger" },
    eliminated: { bg: "bg-red-500/20", text: "text-red-400", label: "Eliminated" },
  };

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${config[zone].bg} ${config[zone].text}`}>
      {config[zone].label}
    </span>
  );
}

// Chip Status Badge
function ChipBadge({ used, name }: { used: boolean; name: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${used ? "bg-red-500/10" : "bg-green-500/10"}`}>
      <span className={`w-2 h-2 rounded-full ${used ? "bg-red-400" : "bg-green-400"}`}></span>
      <span className={`text-sm ${used ? "text-red-400" : "text-green-400"}`}>
        {name}: {used ? "Used" : "Available"}
      </span>
    </div>
  );
}

const DOUBLE_HEADER_GWS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 27, 29, 33, 35, 38];

// ===== Auction Dashboard Types & Component =====
interface AuctionDashboardData {
  leagueSlug: string;
  leagueFormat: "auction";
  team: { id: string; name: string };
  purse: number;
  initialBudget: number;
  totalSpent: number;
  totalIncome: number;
  totalRefunds: number;
  totalForfeit: number;
  releases: { id: string; playerName: string; purchasePrice: number; refund: number; forfeit: number; releasedGw: number | null }[];
  totalPoints: number;
  squadValue: number;
  squadSize: number;
  squad: { id: string; fplElementId: number; playerName: string; purchasePrice: number; acquiredGw: number; status: string; elementType: number | null; totalPoints: number }[];
  rank: number;
  totalManagers: number;
  standings: { id: string; name: string; totalPoints: number; rank: number; isCurrentTeam: boolean }[];
  gwHistory: { gameweek: number; points: number; rank: number | null; income: number }[];
  lastGwResult: { gameweek: number; points: number; rank: number | null; income: number } | null;
  auctionSession: { id: string; type: string; status: string } | null;
  nextAuction: { id: string; type: string; cycleNumber: number; scheduledAt: string } | null;
  deadline: { gameweek: number; timestamp: string | null };
  serverTime: string;
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
  return `£${value}`;
}

function AuctionDashboard({ data, leagueSlug, onSignOut }: { data: AuctionDashboardData; leagueSlug: string; onSignOut: () => void }) {
  const router = useRouter();
  const netPnL = data.initialBudget + data.totalIncome + data.totalRefunds - data.totalSpent;

  const POS_LABEL: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
  const positionCounts = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>;
  for (const p of data.squad) {
    if (p.elementType && positionCounts[p.elementType] !== undefined) positionCounts[p.elementType]++;
  }
  const sortedByPoints = [...data.squad].sort((a, b) => b.totalPoints - a.totalPoints);
  const topPerformers = sortedByPoints.slice(0, 4);
  const leastPerformers = data.squad.length > 4
    ? [...sortedByPoints].reverse().slice(0, 4)
    : [];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            JPL
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">{data.team.name}</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/dashboard" className="text-yellow-400 font-semibold transition">Dashboard</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">Standings</Link>
          <Link href={`/${leagueSlug}/teams`} className="text-gray-300 hover:text-white transition">Teams</Link>
          <Link href={`/${leagueSlug}/auction`} className="text-gray-300 hover:text-white transition">Auction</Link>
          <Link href={`/${leagueSlug}/squad`} className="text-gray-300 hover:text-white transition">Squad</Link>
          <Link href={`/${leagueSlug}/players`} className="text-gray-300 hover:text-white transition">Players</Link>
          {!data.auctionSession && (
            <Link href={`/${leagueSlug}/marketplace`} className="text-gray-300 hover:text-white transition">Marketplace</Link>
          )}
          <Link href={`/${leagueSlug}/finance`} className="text-gray-300 hover:text-white transition">Finance</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">Rules</Link>
          <NotificationBell />
          <button onClick={onSignOut} className="rounded-full bg-white/10 px-6 py-2 font-semibold text-white hover:bg-white/20 transition">
            Sign Out
          </button>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 mb-2">
            <h1 className="text-2xl sm:text-4xl font-bold text-white truncate">{data.team.name}</h1>
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-300">
              Rank #{data.rank} of {data.totalManagers}
            </span>
          </div>
          <p className="text-sm sm:text-base text-gray-400">
            {data.totalPoints} total points • {data.squadSize}/14 players
          </p>
        </div>

        {/* Active Auction Alert */}
        {data.auctionSession && (
          <div className="mb-6 rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 backdrop-blur flex items-center justify-between">
            <div>
              <div className="text-yellow-300 font-bold">🔨 Auction {data.auctionSession.status === "active" ? "In Progress" : "Paused"}</div>
              <div className="text-sm text-gray-300 mt-1">
                {data.auctionSession.type === "initial" ? "Initial Draft" : "Mini-Auction"} — Join the auction room to bid.
              </div>
            </div>
            <Link href={`/${leagueSlug}/auction`} className="px-4 py-2 rounded-lg bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 font-semibold transition">
              Enter Room
            </Link>
          </div>
        )}

        {/* Economy Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-6">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Purse</div>
            <div className="text-xl sm:text-2xl font-bold text-green-400">{formatCurrency(data.purse)}</div>
            <div className="text-xs text-gray-500 mt-1">Available to bid</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Squad Value</div>
            <div className="text-xl sm:text-2xl font-bold text-white">{formatCurrency(data.squadValue)}</div>
            <div className="text-xs text-gray-500 mt-1">{data.squadSize}/14 players</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Income Earned</div>
            <div className="text-xl sm:text-2xl font-bold text-blue-400">{formatCurrency(data.totalIncome)}</div>
            <div className="text-xs text-gray-500 mt-1">From GW payouts</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Net P&amp;L</div>
            <div className={`text-xl sm:text-2xl font-bold ${netPnL >= 0 ? "text-green-400" : "text-red-400"}`}>
              {netPnL >= 0 ? "+" : ""}{formatCurrency(netPnL)}
            </div>
            <div className="text-xs text-gray-500 mt-1">Budget + Income + Refunds − Spent</div>
          </div>
          <div className="group relative rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur cursor-default">
            <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Lost to Releases</div>
            <div className={`text-xl sm:text-2xl font-bold ${data.totalForfeit > 0 ? "text-red-400" : "text-gray-500"}`}>
              {data.totalForfeit > 0 ? `-${formatCurrency(data.totalForfeit)}` : "£0"}
            </div>
            <div className="text-xs text-gray-500 mt-1">{data.releases.length > 0 ? `${data.releases.length} released` : "No releases"}</div>
            {data.releases.length > 0 && (
              <div className="hidden group-hover:block absolute z-20 left-0 top-full mt-2 w-72 rounded-xl border border-white/10 bg-slate-800/95 backdrop-blur-xl shadow-xl p-3">
                <div className="text-xs text-gray-400 font-semibold mb-2 uppercase tracking-wider">Release Breakdown</div>
                {data.releases.map((r) => (
                  <div key={r.id} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                    <div>
                      <div className="text-sm text-white font-semibold">{r.playerName}</div>
                      <div className="text-[10px] text-gray-500">{r.releasedGw != null ? `GW${r.releasedGw}` : "—"}</div>
                    </div>
                    <div className="text-right text-xs">
                      <div className="text-gray-400">Bought {formatCurrency(r.purchasePrice)}</div>
                      <div className="text-green-400">Refund {formatCurrency(r.refund)}</div>
                      <div className="text-red-400 font-bold">Lost {formatCurrency(r.forfeit)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Main Grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column: Squad + GW History */}
          <div className="lg:col-span-2 space-y-6">
            {/* Squad summary */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              {data.squad.length === 0 ? (
                <div className="text-center text-gray-400 py-8">
                  <p>No players yet.</p>
                  <p className="text-sm mt-2">Join the auction to acquire players.</p>
                </div>
              ) : (
                <>
                  {/* Position summary */}
                  <div className="mb-4 flex flex-wrap gap-2 text-xs sm:text-sm">
                    {[1, 2, 3, 4].map((pos) => (
                      <span
                        key={pos}
                        className="rounded-full bg-white/10 border border-white/10 px-3 py-1 font-mono text-gray-200"
                      >
                        <span className="font-semibold text-yellow-400">{positionCounts[pos]}</span>
                        <span className="text-gray-400"> {POS_LABEL[pos]}</span>
                      </span>
                    ))}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <PerformerPanel title="Top Performers" accent="text-green-400" players={topPerformers} posLabels={POS_LABEL} formatCurrency={formatCurrency} />
                    <PerformerPanel title="Least Performers" accent="text-red-400" players={leastPerformers} posLabels={POS_LABEL} formatCurrency={formatCurrency} emptyHint="Need 5+ players" />
                  </div>

                  <div className="mt-4 text-right">
                    <Link
                      href={`/${leagueSlug}/squad`}
                      className="inline-flex items-center gap-1 text-sm text-yellow-400 hover:text-yellow-300 font-semibold transition"
                    >
                      View Full Squad ({data.squadSize}/14) →
                    </Link>
                  </div>
                </>
              )}
            </div>

            {/* GW History */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-yellow-400">📊</span> Gameweek History
              </h2>
              {data.gwHistory.length === 0 ? (
                <div className="text-center text-gray-400 py-6 text-sm">No gameweeks processed yet</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-gray-400 border-b border-white/10">
                        <th className="py-2">GW</th>
                        <th className="py-2 text-right">Points</th>
                        <th className="py-2 text-right">Rank</th>
                        <th className="py-2 text-right">Income</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.gwHistory].reverse().map(gw => (
                        <tr
                          key={gw.gameweek}
                          onClick={() => router.push(`/${leagueSlug}/standings?gw=${gw.gameweek}`)}
                          className="border-b border-white/5 cursor-pointer hover:bg-white/10 transition"
                        >
                          <td className="py-2 text-white font-semibold">GW{gw.gameweek}</td>
                          <td className="py-2 text-right text-white">{gw.points}</td>
                          <td className="py-2 text-right text-gray-400">{gw.rank ?? "—"}</td>
                          <td className="py-2 text-right text-green-400 font-mono">{formatCurrency(gw.income)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Right column: Deadline + Standings */}
          <div className="space-y-6">
            {/* Deadline — only render when there's an auction (live, paused, or scheduled) */}
            {(data.auctionSession || data.nextAuction) && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-yellow-400">⏱</span> Next Deadline
                </h2>
                <NextDeadlineContent data={data} leagueSlug={leagueSlug} />
              </div>
            )}

            {/* Last GW */}
            {data.lastGwResult && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                <h2 className="text-lg font-bold text-white mb-3">Last Gameweek</h2>
                <div className="text-sm text-gray-400 mb-2">GW{data.lastGwResult.gameweek}</div>
                <div className="text-2xl sm:text-3xl font-bold text-white mb-1">{data.lastGwResult.points} pts</div>
                <div className="text-sm text-gray-400">
                  Rank #{data.lastGwResult.rank ?? "—"} • Income: <span className="text-green-400">{formatCurrency(data.lastGwResult.income)}</span>
                </div>
              </div>
            )}

            {/* Mini Standings */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-yellow-400">🏆</span> Standings
              </h2>
              <div className="space-y-1">
                {data.standings.map(s => (
                  <div
                    key={s.id}
                    className={`flex items-center justify-between px-3 py-2 rounded-lg ${s.isCurrentTeam ? "bg-yellow-500/10 border border-yellow-500/20" : "bg-white/5"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-6">#{s.rank}</span>
                      <span className={`text-sm ${s.isCurrentTeam ? "text-yellow-300 font-semibold" : "text-white"}`}>
                        {s.name}
                      </span>
                    </div>
                    <span className="text-sm text-white font-mono">{s.totalPoints}</span>
                  </div>
                ))}
              </div>
              <Link href={`/${leagueSlug}/standings`} className="block mt-3 text-center text-xs text-yellow-400 hover:text-yellow-300">
                View Full Standings →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PerformerPanel({
  title,
  accent,
  players,
  posLabels,
  formatCurrency,
  emptyHint,
}: {
  title: string;
  accent: string;
  players: AuctionDashboardData["squad"];
  posLabels: Record<number, string>;
  formatCurrency: (n: number) => string;
  emptyHint?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className={`text-xs uppercase tracking-wider mb-2 font-semibold ${accent}`}>{title}</div>
      {players.length === 0 ? (
        <div className="text-sm text-gray-500 py-4 text-center">{emptyHint ?? "No data"}</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className="border-b border-white/5 last:border-0">
                <td className="py-1.5 text-white font-semibold">
                  {p.playerName}
                  {p.elementType && (
                    <span className="ml-2 text-[10px] text-gray-500 uppercase">{posLabels[p.elementType]}</span>
                  )}
                </td>
                <td className="py-1.5 text-right text-yellow-400 font-mono text-xs">{formatCurrency(p.purchasePrice)}</td>
                <td className="py-1.5 text-right text-white font-mono w-12">{p.totalPoints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewedGw, setViewedGw] = useState<number | null>(null);
  const [leagueSlug, setLeagueSlug] = useState<string>("");
  const [leagueFormat, setLeagueFormat] = useState<string>("tvt");
  
  // Submission states
  const [selectedCaptain, setSelectedCaptain] = useState<string>("");
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [selectedChallengedTeam, setSelectedChallengedTeam] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showOpponentPlayers, setShowOpponentPlayers] = useState(false);
  const [showAllCaptains, setShowAllCaptains] = useState(false);
  const [cupExpanded, setCupExpanded] = useState(false);
  const [cupViewedGw, setCupViewedGw] = useState<number | null>(null);
  const [cupRefreshing, setCupRefreshing] = useState(false);
  const [liveRefreshing, setLiveRefreshing] = useState(false);
  const [liveScoreOverride, setLiveScoreOverride] = useState<{
    myScore: number;
    oppScore: number;
    myPlayerScores: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
    oppPlayerScores: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
  } | null>(null);

  const fetchDashboard = useCallback(async (gw?: number) => {
    try {
      if (gw) {
        // Lightweight GW-only fetch for navigation (no FPL sync, no standings, etc.)
        const response = await fetch(`/api/team/dashboard/gw-result?gw=${gw}`, {
          credentials: "include", // Ensure cookies are sent
        });
        if (response.status === 401) { router.push("/signin"); return; }
        if (!response.ok) throw new Error("Failed to fetch GW result");
        const gwData = await response.json();
        setData(prev => prev ? {
          ...prev,
          lastGwResult: gwData.lastGwResult,
          cupGwResult: gwData.cupGwResult ?? null,
          minCompletedGw: gwData.minCompletedGw,
          maxCompletedGw: gwData.maxCompletedGw,
          cupProgress: prev.cupProgress ? {
            ...prev.cupProgress,
            completedCupGws: gwData.completedCupGws ?? prev.cupProgress.completedCupGws,
          } : prev.cupProgress,
        } : prev);
        if (gwData.lastGwResult) setViewedGw(gwData.lastGwResult.gameweek);
      } else {
        // Full initial load
        const response = await fetch("/api/team/dashboard", {
          credentials: "include", // Ensure cookies are sent
        });
        if (response.status === 401) { router.push("/signin"); return; }
        if (!response.ok) throw new Error("Failed to fetch dashboard");
        const dashboardData = await response.json();
        setData(dashboardData);
        if (dashboardData.leagueSlug) setLeagueSlug(dashboardData.leagueSlug);
        if (dashboardData.leagueFormat) setLeagueFormat(dashboardData.leagueFormat);
        if (dashboardData.lastGwResult) setViewedGw(dashboardData.lastGwResult.gameweek);
        if (dashboardData.cupProgress?.lastCupResult) setCupViewedGw(dashboardData.cupProgress.lastCupResult.gameweek);
      }
    } catch (err) {
      console.error("Dashboard error:", err);
      setError("Failed to load dashboard. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    // Check auth status and profile completion before loading dashboard
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const me = await res.json();

        // If not authenticated, redirect to signin
        if (!me.authenticated || me.type !== "team") {
          router.push("/signin");
          return;
        }

        // If profile not complete, redirect to setup
        if (!me.team.isProfileComplete) {
          router.push("/setup");
          return;
        }

        // Auth is valid and profile is complete, load dashboard
        fetchDashboard();
      } catch (err) {
        console.error("Auth check error:", err);
        router.push("/signin");
      }
    };

    checkAuth();
  }, [fetchDashboard, router]);

  // GW navigation handlers
  const handlePrevGw = () => {
    if (data && viewedGw && data.minCompletedGw && viewedGw > data.minCompletedGw) {
      setLiveScoreOverride(null);
      fetchDashboard(viewedGw - 1);
    }
  };
  const handleNextGw = () => {
    if (data && viewedGw && data.maxCompletedGw && viewedGw < data.maxCompletedGw) {
      setLiveScoreOverride(null);
      fetchDashboard(viewedGw + 1);
    }
  };

  const handleLiveRefresh = async () => {
    if (!data || !viewedGw) return;
    setLiveRefreshing(true);
    try {
      const res = await fetch(`/api/fixtures/live/refresh?gameweek=${viewedGw}`, {
        credentials: "include", // Ensure cookies are sent
      });
      if (res.ok) {
        const freshData = await res.json();
        // Find the fixture matching this user's team
        const myId = data.lastGwResult?.myTeamId;
        const oppId = data.lastGwResult?.opponentTeamId;
        if (myId && oppId && freshData.fixtures) {
          const fixture = freshData.fixtures.find((f: { homeTeamId: string; awayTeamId: string }) =>
            (f.homeTeamId === myId && f.awayTeamId === oppId) ||
            (f.homeTeamId === oppId && f.awayTeamId === myId)
          );
          if (fixture) {
            const isMyHome = fixture.homeTeamId === myId;
            setLiveScoreOverride({
              myScore: isMyHome ? fixture.homeScore : fixture.awayScore,
              oppScore: isMyHome ? fixture.awayScore : fixture.homeScore,
              myPlayerScores: isMyHome ? fixture.homePlayers : fixture.awayPlayers,
              oppPlayerScores: isMyHome ? fixture.awayPlayers : fixture.homePlayers,
            });
          }
        }
      }
    } catch (err) {
      console.error("Live refresh failed:", err);
    } finally {
      setLiveRefreshing(false);
    }
  };

  // Independent cup GW navigation
  const fetchCupResult = async (cupGw: number) => {
    if (!data) return;
    setCupRefreshing(true);
    try {
      const res = await fetch(`/api/team/dashboard/gw-result?cupGw=${cupGw}`, { credentials: "include" });
      if (!res.ok) return;
      const d = await res.json();
      setCupViewedGw(d.cupGwResult?.gameweek ?? cupGw);
      setData(prev => prev ? {
        ...prev,
        cupGwResult: d.cupGwResult ?? null,
        cupProgress: prev.cupProgress ? {
          ...prev.cupProgress,
          minCompletedCupGw: d.minCompletedCupGw ?? prev.cupProgress.minCompletedCupGw,
          maxCompletedCupGw: d.maxCompletedCupGw ?? prev.cupProgress.maxCompletedCupGw,
          completedCupGws: d.completedCupGws ?? prev.cupProgress.completedCupGws,
        } : prev.cupProgress,
      } : prev);
    } catch (err) {
      console.error("Cup result fetch failed:", err);
    } finally {
      setCupRefreshing(false);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    router.push("/signin");
  };
  
  const handleCaptainSubmit = async () => {
    if (!selectedCaptain || !data) return;

    setIsSubmitting(true);
    setSubmitMessage(null);

    try {
      const payload = {
        playerId: selectedCaptain,
        gameweek: data.deadline.gameweek,
      };

      console.log("Submitting captain with payload:", payload);

      const response = await fetch("/api/team/captain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include", // Ensure cookies are sent
      });

      const result = await response.json();
      console.log("Captain submission response:", response.status, result);

      if (!response.ok) {
        const errorText = result.error || "Failed to submit captain";
        // Check if error is due to no gameweeks (fixtures not generated)
        const isFixturesNotGenerated = errorText.toLowerCase().includes("gameweek not found");
        const displayError = isFixturesNotGenerated
          ? "Fixtures have not been generated yet. Please ask the admin to generate fixtures first."
          : errorText;
        setSubmitMessage({ type: "error", text: displayError });
      } else {
        const action = result.captain.wasSwitched ? "switched to" : "announced as";
        setSubmitMessage({ type: "success", text: `${result.captain.playerName} ${action} captain for GW${data.deadline.gameweek}` });
        // Refresh dashboard data
        fetchDashboard();
      }
    } catch (error) {
      console.error("Captain submission error:", error);
      setSubmitMessage({ type: "error", text: "Failed to submit captain" });
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleChipSubmit = async () => {
    if (!data || selectedChip === null) return;

    // "No Chip" selected while a chip is active → cancel it
    if (selectedChip === "" && data.upcomingChip) {
      await handleCancelChip();
      setSelectedChip(null);
      return;
    }

    if (!selectedChip) return;
    if (selectedChip === "C" && !selectedChallengedTeam) return;

    setIsSubmitting(true);
    setSubmitMessage(null);

    try {
      const payload = {
        chipType: selectedChip,
        gameweek: data.deadline.gameweek,
        ...(selectedChip === "C" && { challengedTeamId: selectedChallengedTeam }),
      };

      console.log("Submitting chip with payload:", payload);

      const response = await fetch("/api/team/chips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include", // Ensure cookies are sent
      });

      const result = await response.json();
      console.log("Chip submission response:", response.status, result);

      if (!response.ok) {
        const errorText = result.error || "Failed to submit chip";
        // Check if error is due to no gameweeks (fixtures not generated)
        const isFixturesNotGenerated = errorText.toLowerCase().includes("gameweek not found");
        const displayError = isFixturesNotGenerated
          ? "Fixtures have not been generated yet. Please ask the admin to generate fixtures first."
          : errorText;
        setSubmitMessage({ type: "error", text: displayError });
      } else {
        setSubmitMessage({ type: "success", text: result.message });
        setSelectedChip(null);
        // Refresh dashboard data
        fetchDashboard();
      }
    } catch {
      setSubmitMessage({ type: "error", text: "Failed to submit chip" });
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleCancelChip = async () => {
    if (!data) return;

    setIsSubmitting(true);
    setSubmitMessage(null);

    try {
      const payload = {
        gameweek: data.deadline.gameweek,
      };

      const response = await fetch("/api/team/chips", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include", // Ensure cookies are sent
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        setSubmitMessage({ type: "error", text: result.error || "Failed to cancel chip" });
      } else {
        setSubmitMessage({ type: "success", text: result.message });
        // Refresh dashboard data
        fetchDashboard();
      }
    } catch {
      setSubmitMessage({ type: "error", text: "Failed to cancel chip" });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return <LoadingScreen variant="dashboard" />;
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center">
        <div className="text-red-400 text-lg sm:text-xl px-4 text-center">{error || "Failed to load dashboard"}</div>
      </div>
    );
  }

  // ===== Auction format dashboard — separate layout =====
  if (leagueFormat === "auction") {
    return <AuctionDashboard data={data as unknown as AuctionDashboardData} leagueSlug={leagueSlug} onSignOut={handleSignOut} />;
  }

  const currentChipSet = data.chipStatus.currentSet === 1 ? data.chipStatus.set1 : data.chipStatus.set2;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            JPL
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">{data?.team?.name || "Dashboard"}</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/dashboard" className="text-yellow-400 font-semibold transition">
            Dashboard
          </Link>
          {leagueFormat === "triple-crown" ? (
            <>
              <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">PL Standings</Link>
              <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">PL Fixtures</Link>
              <Link href={`/${leagueSlug}/uefa-standings`} className="text-gray-300 hover:text-white transition">UEFA Standings</Link>
              <Link href={`/${leagueSlug}/uefa-fixtures`} className="text-gray-300 hover:text-white transition">UEFA Fixtures</Link>
              <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">Playoffs</Link>
            </>
          ) : (
            <>
              <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">Standings</Link>
              <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">Fixtures</Link>
              <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">Playoffs</Link>
            </>
          )}
          <Link href={`/${leagueSlug}/winners`} className="text-gray-300 hover:text-white transition">Winners</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">Rules</Link>
          <Link href={`/${leagueSlug}/help`} className="text-gray-300 hover:text-white transition">Help</Link>
          <button
            onClick={handleSignOut}
            className="rounded-full bg-white/10 px-6 py-2 font-semibold text-white hover:bg-white/20 transition"
          >
            Sign Out
          </button>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 mb-2">
            <h1 className="text-2xl sm:text-4xl font-bold text-white truncate">{data.team.name}</h1>
            {leagueFormat === "triple-crown" ? (
              <>
                {data.plPosition && (
                  <span className="px-3 py-1 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300">
                    PL: #{data.plPosition.rank} of {data.plPosition.totalTeams}
                  </span>
                )}
                {data.cupProgress && (
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold ${data.cupProgress.cupZone === "ucl" ? "bg-green-500/20 text-green-400" : "bg-orange-500/20 text-orange-400"}`}>
                    UEFA {data.cupProgress.groupName} #{data.cupProgress.rank} → {data.cupProgress.cupZone === "ucl" ? "UCL" : "Europa"}
                  </span>
                )}
              </>
            ) : (
              <ZoneBadge zone={data.leaguePosition.zone} />
            )}
          </div>
          <p className="text-sm sm:text-base text-gray-400">
            {leagueFormat === "triple-crown"
              ? `${data.team.leaguePoints} PL Points`
              : `${data.leagueGroupCount && data.leagueGroupCount > 1 ? `Group ${data.team.group} • ` : ""}Rank #${data.leaguePosition.groupRank} • ${data.team.leaguePoints} Points`}
          </p>
        </div>

        {/* Main Grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* TC layout: merged Deadline+Captain, then Next Fixture */}
            {leagueFormat === "triple-crown" ? (
              <></>
            ) : (
              /* TVT: Deadline + Upcoming Fixture side by side */
              <div className="grid md:grid-cols-2 gap-6">
                {/* Deadline Timer */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                  <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <span className="text-yellow-400">⏱</span> Deadline
                  </h2>
                  <DeadlineTimer deadline={data.deadline.timestamp} gameweek={data.deadline.gameweek} serverTime={data.serverTime} />
                </div>

                {/* Upcoming Fixture */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                  <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <span className="text-yellow-400">⚔</span> GW{data.deadline.gameweek} PL Fixture
                  </h2>
                  {data.upcomingFixture ? (
                    <div>
                      <div className="flex items-center justify-center gap-4 mb-3">
                        <div className="text-center">
                          <div className="text-xs text-gray-400 mb-1">{data.upcomingFixture.isHome ? "HOME" : "AWAY"}</div>
                          <div className="text-lg font-bold text-white">{data.team.name}</div>
                        </div>
                        <span className="text-gray-500 font-medium">VS</span>
                        <div className="text-center">
                          <div className="text-xs text-gray-400 mb-1">{data.upcomingFixture.isHome ? "AWAY" : "HOME"}</div>
                          <button
                            onClick={() => setShowOpponentPlayers(!showOpponentPlayers)}
                            className="text-lg font-bold text-blue-400 hover:text-blue-300 underline decoration-dotted underline-offset-4 transition"
                          >
                            {data.upcomingFixture.opponent.name}
                          </button>
                        </div>
                      </div>
                      <div className="text-center text-xs text-gray-500 mb-2">
                        Click opponent name to {showOpponentPlayers ? "hide" : "view"} players
                      </div>
                      {showOpponentPlayers && (
                        <div className="mt-3 p-3 rounded-lg bg-white/5 border border-white/10">
                          <div className="text-xs text-gray-400 mb-2 font-semibold">{data.upcomingFixture.opponent.name} — Players</div>
                          <div className="space-y-2">
                            {data.upcomingFixture.opponent.players.map((p, i) => (
                              <div key={i} className="flex items-center justify-between">
                                <span className="text-white text-sm">{p.name}</span>
                                <div className="flex gap-2">
                                  <a href={p.fplUrl} target="_blank" rel="noopener noreferrer"
                                    className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition">
                                    GW{data.upcomingFixture?.lastCompletedGw ?? (data.deadline.gameweek - 1)} ↗
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center text-gray-400">No upcoming fixture</div>
                  )}
                </div>
              </div>
            )}

            {/* TC: Merged Deadline + Captain card */}
            {leagueFormat === "triple-crown" && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                {data.deadline.gameweek === 0 ? (
                  <div className="text-center py-6">
                    <p className="text-gray-400 text-sm">Captain and chip submissions will be available once the admin generates fixtures.</p>
                  </div>
                ) : (
                  <div className="grid md:grid-cols-2 gap-6">
                    {/* Left: Deadline */}
                    <div>
                      <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                        <span className="text-yellow-400">⏱</span> GW{data.deadline.gameweek} Deadline
                      </h2>
                      <DeadlineTimer deadline={data.deadline.timestamp} gameweek={data.deadline.gameweek} serverTime={data.serverTime} />
                    </div>
                    {/* Right: Captain */}
                    <div>
                      <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                        <span className="text-yellow-400">📋</span> Captain
                      </h3>
                      {!data.announcementSettings.captainAnnouncementEnabled ? (
                        <div className="flex items-center gap-2 text-red-400 mb-3">
                          <span className="w-3 h-3 rounded-full bg-red-400"></span>
                          Captain announcements disabled
                        </div>
                      ) : (
                        <>
                          {data.upcomingCaptain ? (
                            <div className="flex items-center gap-2 text-green-400 mb-3">
                              <span className="w-3 h-3 rounded-full bg-green-400"></span>
                              {data.upcomingCaptain.playerName} selected
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-orange-400 mb-3">
                              <span className="w-3 h-3 rounded-full bg-orange-400"></span>
                              Not Submitted
                            </div>
                          )}
                          <select
                            value={selectedCaptain || data.upcomingCaptain?.playerId || ""}
                            onChange={(e) => setSelectedCaptain(e.target.value)}
                            className="w-full p-2 rounded-lg bg-slate-800 text-white border border-white/30 mb-3 focus:border-yellow-400 focus:outline-none"
                            disabled={isSubmitting}
                          >
                            <option value="">Select captain...</option>
                            {data.captaincyStatus.player1.chipsRemaining > 0 && (
                              <option value={data.captaincyStatus.player1.id}>
                                {data.captaincyStatus.player1.name} ({data.captaincyStatus.player1.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player1.chipsRemaining} left`})
                              </option>
                            )}
                            {data.captaincyStatus.player2.chipsRemaining > 0 && (
                              <option value={data.captaincyStatus.player2.id}>
                                {data.captaincyStatus.player2.name} ({data.captaincyStatus.player2.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player2.chipsRemaining} left`})
                              </option>
                            )}
                          </select>
                          <button
                            onClick={handleCaptainSubmit}
                            disabled={!selectedCaptain || isSubmitting || selectedCaptain === data.upcomingCaptain?.playerId}
                            className="w-full py-2 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold disabled:opacity-50 disabled:cursor-not-allowed hover:from-yellow-300 hover:to-orange-400 transition"
                          >
                            {isSubmitting ? "Submitting..." : data.upcomingCaptain ? "Switch Captain" : "Announce Captain"}
                          </button>
                        </>
                      )}
                      <div className="mt-3 text-sm text-gray-400">
                        <div className="flex justify-between">
                          <span>{data.captaincyStatus.player1.name}</span>
                          <span>{data.captaincyStatus.player1.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player1.chipsRemaining}/19 left`}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{data.captaincyStatus.player2.name}</span>
                          <span>{data.captaincyStatus.player2.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player2.chipsRemaining}/19 left`}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {submitMessage && (
                  <div className={`mt-4 p-3 rounded-lg ${submitMessage.type === "success" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                    {submitMessage.text}
                  </div>
                )}
              </div>
            )}

            {/* TC: Next Fixture card — full width for single, half-half for double header */}
            {leagueFormat === "triple-crown" && data.upcomingFixture && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <span className="text-yellow-400">⚔</span> GW{data.deadline.gameweek} Fixture{DOUBLE_HEADER_GWS.includes(data.deadline.gameweek) && data.cupProgress?.upcomingCupFixture ? "s" : ""}
                  {DOUBLE_HEADER_GWS.includes(data.deadline.gameweek) && data.cupProgress?.upcomingCupFixture && (
                    <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-semibold">Double Header</span>
                  )}
                </h2>
                <div className={DOUBLE_HEADER_GWS.includes(data.deadline.gameweek) && data.cupProgress?.upcomingCupFixture ? "grid md:grid-cols-2 gap-6 divide-x divide-white/10" : ""}>
                  {/* PL Fixture */}
                  <div className={DOUBLE_HEADER_GWS.includes(data.deadline.gameweek) && data.cupProgress?.upcomingCupFixture ? "pr-6" : ""}>
                    <div className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-2">Premier League</div>
                    <div className="flex items-center justify-center gap-4 mb-3">
                      <div className="text-center">
                        <div className="text-xs text-gray-400 mb-1">{data.upcomingFixture.isHome ? "HOME" : "AWAY"}</div>
                        <div className="text-lg font-bold text-white">{data.team.name}</div>
                      </div>
                      <span className="text-gray-500 font-medium">VS</span>
                      <div className="text-center">
                        <div className="text-xs text-gray-400 mb-1">{data.upcomingFixture.isHome ? "AWAY" : "HOME"}</div>
                        <button
                          onClick={() => setShowOpponentPlayers(!showOpponentPlayers)}
                          className="text-lg font-bold text-blue-400 hover:text-blue-300 underline decoration-dotted underline-offset-4 transition"
                        >
                          {data.upcomingFixture.opponent.name}
                        </button>
                      </div>
                    </div>
                    <div className="text-center text-xs text-gray-500 mb-2">
                      Click opponent to {showOpponentPlayers ? "hide" : "view"} players
                    </div>
                    {showOpponentPlayers && (
                      <div className="mt-3 p-3 rounded-lg bg-white/5 border border-white/10">
                        <div className="text-xs text-gray-400 mb-2 font-semibold">{data.upcomingFixture.opponent.name} — Players</div>
                        <div className="space-y-2">
                          {data.upcomingFixture.opponent.players.map((p, i) => (
                            <div key={i} className="flex items-center justify-between">
                              <span className="text-white text-sm">{p.name}</span>
                              <div className="flex gap-2">
                                <a href={p.fplUrl} target="_blank" rel="noopener noreferrer"
                                  className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition">
                                  GW{data.upcomingFixture?.lastCompletedGw ?? (data.deadline.gameweek - 1)} ↗
                                </a>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Cup Fixture (double header only) */}
                  {DOUBLE_HEADER_GWS.includes(data.deadline.gameweek) && data.cupProgress?.upcomingCupFixture && (
                    <div className="pl-6">
                      <div className="text-xs text-blue-400 font-semibold uppercase tracking-wider mb-2">
                        {data.cupProgress.upcomingCupFixture.competitionLabel}
                      </div>
                      <div className="flex items-center justify-center gap-4 mb-3">
                        <div className="text-center">
                          <div className="text-xs text-gray-400 mb-1">{data.cupProgress.upcomingCupFixture.isHome ? "HOME" : "AWAY"}</div>
                          <div className="text-lg font-bold text-white">{data.team.name}</div>
                        </div>
                        <span className="text-gray-500 font-medium">VS</span>
                        <div className="text-center">
                          <div className="text-xs text-gray-400 mb-1">{data.cupProgress.upcomingCupFixture.isHome ? "AWAY" : "HOME"}</div>
                          <div className="text-lg font-bold text-blue-300">{data.cupProgress.upcomingCupFixture.opponent ?? "TBD"}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TVT: Captain & Chip Submission */}
            {leagueFormat !== "triple-crown" && <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <span className="text-yellow-400">📋</span> GW{data.deadline.gameweek > 0 ? data.deadline.gameweek : "?"} Submissions
              </h2>

              {data.deadline.gameweek === 0 ? (
                <div className="text-center py-6">
                  <p className="text-gray-400 text-sm">Captain and chip submissions will be available once the admin generates fixtures.</p>
                </div>
              ) : (
              <>
              {/* Submit Message */}
              {submitMessage && (
                <div className={`mb-4 p-3 rounded-lg ${submitMessage.type === "success" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  {submitMessage.text}
                </div>
              )}
              
              <div className="grid md:grid-cols-2 gap-6">
                {/* Captain Submission */}
                <div className="p-4 rounded-xl bg-white/5">
                  <h3 className="font-semibold text-white mb-3">Captain</h3>
                  {!data.announcementSettings.captainAnnouncementEnabled ? (
                    <div className="flex items-center gap-2 text-red-400 mb-3">
                      <span className="w-3 h-3 rounded-full bg-red-400"></span>
                      Captain announcements are currently disabled
                    </div>
                  ) : (
                    <>
                      {data.upcomingCaptain ? (
                        <div className="flex items-center gap-2 text-green-400 mb-3">
                          <span className="w-3 h-3 rounded-full bg-green-400"></span>
                          {data.upcomingCaptain.playerName} selected
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-orange-400 mb-3">
                          <span className="w-3 h-3 rounded-full bg-orange-400"></span>
                          Not Submitted
                        </div>
                      )}
                      <select
                        value={selectedCaptain || data.upcomingCaptain?.playerId || ""}
                        onChange={(e) => setSelectedCaptain(e.target.value)}
                        className="w-full p-2 rounded-lg bg-slate-800 text-white border border-white/30 mb-3 focus:border-yellow-400 focus:outline-none"
                        disabled={isSubmitting}
                      >
                        <option value="">Select captain...</option>
                        {data.captaincyStatus.player1.chipsRemaining > 0 && (
                          <option value={data.captaincyStatus.player1.id}>
                            {data.captaincyStatus.player1.name} ({data.captaincyStatus.player1.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player1.chipsRemaining} chips left`})
                          </option>
                        )}
                        {data.captaincyStatus.player2.chipsRemaining > 0 && (
                          <option value={data.captaincyStatus.player2.id}>
                            {data.captaincyStatus.player2.name} ({data.captaincyStatus.player2.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player2.chipsRemaining} chips left`})
                          </option>
                        )}
                      </select>
                      <button
                        onClick={handleCaptainSubmit}
                        disabled={!selectedCaptain || isSubmitting || selectedCaptain === data.upcomingCaptain?.playerId}
                        className="w-full py-2 rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 text-slate-900 font-semibold disabled:opacity-50 disabled:cursor-not-allowed hover:from-yellow-300 hover:to-orange-400 transition"
                      >
                        {isSubmitting ? "Submitting..." : data.upcomingCaptain ? "Switch Captain" : "Announce Captain"}
                      </button>
                    </>
                  )}
                  <div className="mt-3 text-sm text-gray-400">
                    <div className="flex justify-between">
                      <span>{data.captaincyStatus.player1.name}</span>
                      <span>{data.captaincyStatus.player1.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player1.chipsRemaining}/${leagueFormat === "triple-crown" ? 19 : 15} chips left`}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>{data.captaincyStatus.player2.name}</span>
                      <span>{data.captaincyStatus.player2.chipsRemaining >= 999 ? "unlimited" : `${data.captaincyStatus.player2.chipsRemaining}/${leagueFormat === "triple-crown" ? 19 : 15} chips left`}</span>
                    </div>
                  </div>
                </div>

                {/* TVT Chips Submission — hidden for Triple Crown */}
                {leagueFormat !== "triple-crown" && <div className="p-4 rounded-xl bg-white/5">
                  <h3 className="font-semibold text-white mb-3">
                    TVT Chips (Set {data.chipStatus.currentSet === "playoffs" ? "Playoffs" : data.chipStatus.currentSet})
                  </h3>
                  
                  {!data.announcementSettings.chipAnnouncementEnabled ? (
                    <div className="flex items-center gap-2 text-red-400 mb-3">
                      <span className="w-3 h-3 rounded-full bg-red-400"></span>
                      Chip announcements are currently disabled
                    </div>
                  ) : data.chipStatus.currentSet !== "playoffs" ? (
                    <>
                      {data.upcomingChip ? (
                        <div className="flex items-center gap-2 text-green-400 mb-3">
                          <span className="w-3 h-3 rounded-full bg-green-400"></span>
                          {data.upcomingChip.chipName} selected
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-orange-400 mb-3">
                          <span className="w-3 h-3 rounded-full bg-orange-400"></span>
                          No chip selected
                        </div>
                      )}
                      <select
                        value={selectedChip ?? data.upcomingChip?.type ?? ""}
                        onChange={(e) => { setSelectedChip(e.target.value); setSelectedChallengedTeam(""); }}
                        className="w-full p-2 rounded-lg bg-slate-800 text-white border border-white/30 mb-3 focus:border-purple-400 focus:outline-none"
                        disabled={isSubmitting}
                      >
                        <option value="">No Chip</option>
                        {(!currentChipSet.doublePointer.used || data.upcomingChip?.type === "D") && (
                          <option value="D">Double Pointer (DP)</option>
                        )}
                        {(!currentChipSet.challengeChip.used || data.upcomingChip?.type === "C") && (
                          <option value="C">Challenge Chip (CC)</option>
                        )}
                        {(!currentChipSet.winWin.used || data.upcomingChip?.type === "W") && (
                          <option value="W">Win-Win (WW)</option>
                        )}
                      </select>
                      {(selectedChip ?? data.upcomingChip?.type) === "C" && (
                        <div className="mb-3">
                          <label className="block text-xs text-gray-400 mb-1">Challenge against (top 2 from opposite group)</label>
                          <select
                            value={selectedChallengedTeam}
                            onChange={(e) => setSelectedChallengedTeam(e.target.value)}
                            className="w-full p-2 rounded-lg bg-slate-800 text-white border border-purple-400/50 focus:border-purple-400 focus:outline-none"
                            disabled={isSubmitting}
                          >
                            <option value="">Select opponent...</option>
                            {(data.oppositeGroupTeams ?? []).map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <button
                        onClick={handleChipSubmit}
                        disabled={
                          isSubmitting ||
                          selectedChip === null ||
                          selectedChip === (data.upcomingChip?.type ?? "") ||
                          ((selectedChip ?? data.upcomingChip?.type) === "C" && !selectedChallengedTeam)
                        }
                        className="w-full py-2 rounded-lg bg-purple-500/20 text-purple-400 font-semibold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-purple-500/30 transition"
                      >
                        {isSubmitting ? "Submitting..." : selectedChip === "" && data.upcomingChip ? "Remove Chip" : data.upcomingChip && selectedChip !== null ? "Switch Chip" : "Use Chip"}
                      </button>
                    </>
                  ) : (
                    <div className="text-gray-400 text-sm">No chips available in playoffs</div>
                  )}
                  
                  <div className="mt-3 space-y-2">
                    <ChipBadge used={currentChipSet.doublePointer.used} name="DP" />
                    <ChipBadge used={currentChipSet.challengeChip.used} name="CC" />
                    <ChipBadge used={currentChipSet.winWin.used} name="WW" />
                  </div>
                </div>}
              </div>
              </>
              )}
            </div>}

            {/* Last GW Result with navigation */}
            {data.lastGwResult && (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                <div className="flex items-center justify-between mb-4">
                  <button
                    onClick={handlePrevGw}
                    disabled={!data.minCompletedGw || !viewedGw || viewedGw <= data.minCompletedGw}
                    className="text-xl sm:text-3xl px-2 sm:px-3 py-1 rounded-full bg-purple-900/60 border border-purple-400 text-yellow-300 shadow-lg hover:bg-yellow-400 hover:text-purple-900 transition disabled:opacity-30 disabled:bg-gray-700 disabled:text-gray-400"
                    aria-label="Previous GW"
                  >
                    &#8592;
                  </button>
                  <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                    <span className="text-yellow-400">📊</span>
                    {data.lastGwResult.isPlayoff
                      ? `${data.lastGwResult.tieId || data.lastGwResult.roundName || "Playoff"}${data.lastGwResult.leg ? ` Leg ${data.lastGwResult.leg}` : ""} (GW${data.lastGwResult.gameweek})`
                      : leagueFormat === "triple-crown"
                        ? `PL — GW${data.lastGwResult.gameweek}`
                        : `Group Stage — GW${data.lastGwResult.gameweek}`}
                    <button
                      onClick={handleLiveRefresh}
                      disabled={liveRefreshing}
                      className={`text-green-400 hover:text-green-300 disabled:opacity-50 transition-all text-sm ${liveRefreshing ? "animate-spin" : ""}`}
                      title="Refresh live scores"
                    >
                      ⟳
                    </button>
                  </h2>
                  <button
                    onClick={handleNextGw}
                    disabled={!data.maxCompletedGw || !viewedGw || viewedGw >= data.maxCompletedGw}
                    className="text-xl sm:text-3xl px-2 sm:px-3 py-1 rounded-full bg-purple-900/60 border border-purple-400 text-yellow-300 shadow-lg hover:bg-yellow-400 hover:text-purple-900 transition disabled:opacity-30 disabled:bg-gray-700 disabled:text-gray-400"
                    aria-label="Next GW"
                  >
                    &#8594;
                  </button>
                </div>
                
                {/* Score Header */}
                <div className="flex flex-col sm:flex-row items-center justify-between mb-6 gap-2 sm:gap-0">
                  <div className="flex-1 text-center">
                    <div className="text-xs text-gray-400 mb-1">{data.lastGwResult.isHome ? "HOME" : "AWAY"}</div>
                    <div className="text-base sm:text-lg font-bold text-white">{data.lastGwResult.myTeamName}</div>
                  </div>
                  <div className="px-4 sm:px-6 text-center">
                    {(() => {
                      const myScore = liveScoreOverride?.myScore ?? data.lastGwResult.myScore;
                      const oppScore = liveScoreOverride?.oppScore ?? data.lastGwResult.oppScore;
                      const isLive = !!liveScoreOverride;
                      const result = myScore > oppScore ? "W" : myScore < oppScore ? "L" : "D";
                      return (
                        <>
                          <div className={`text-3xl sm:text-4xl font-bold ${
                            isLive ? "text-green-400" :
                            data.lastGwResult.result === "W" ? "text-green-400" :
                            data.lastGwResult.result === "L" ? "text-red-400" : "text-gray-400"
                          }`}>
                            {myScore} - {oppScore}
                            {isLive && <span className="ml-2 text-xs align-top text-green-400 animate-pulse">LIVE</span>}
                          </div>
                          <div className="flex items-center justify-center gap-2 mt-2">
                            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                              (isLive ? result : data.lastGwResult.result) === "W" ? "bg-green-500/20 text-green-400" :
                              (isLive ? result : data.lastGwResult.result) === "L" ? "bg-red-500/20 text-red-400" : "bg-gray-500/20 text-gray-400"
                            }`}>
                              {data.lastGwResult.gameweek <= 30
                                ? ((isLive ? result : data.lastGwResult.result) === "W" ? "WIN +2" : (isLive ? result : data.lastGwResult.result) === "D" ? "DRAW +1" : "LOSS +0")
                                : ((isLive ? result : data.lastGwResult.result) === "W" ? "WIN" : (isLive ? result : data.lastGwResult.result) === "D" ? "DRAW" : "LOSS")}
                            </span>
                            {data.lastGwResult.gotBonus && !isLive && (
                              <span className="px-2 py-0.5 rounded text-xs font-semibold bg-yellow-500/20 text-yellow-400">
                                BONUS +1
                              </span>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  <div className="flex-1 text-center">
                    <div className="text-xs text-gray-400 mb-1">{data.lastGwResult.isHome ? "AWAY" : "HOME"}</div>
                    <div className="text-base sm:text-lg font-bold text-white">{data.lastGwResult.opponent}</div>
                  </div>
                </div>
                
                {/* Player Scores */}
                <div className="grid md:grid-cols-2 gap-4">
                  {/* My Team Players */}
                  <div className={`p-3 rounded-lg ${liveScoreOverride ? "bg-green-900/10 border border-green-500/20" : "bg-white/5"}`}>
                    <div className="text-xs text-gray-400 mb-2 text-center">
                      {data.lastGwResult.myTeamName} Players
                      {!liveScoreOverride && !data.lastGwResult.hasMyCaptainData && (
                        <span className="text-orange-400 ml-1">(estimated)</span>
                      )}
                      {liveScoreOverride && <span className="text-green-400 ml-1">(live)</span>}
                    </div>
                    {(liveScoreOverride?.myPlayerScores ?? data.lastGwResult.myPlayerScores).map((p, i) => (
                      <div key={i} className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2">
                          {(('fplUrl' in p && p.fplUrl) || ('fplId' in p && p.fplId)) ? (
                            <a
                              href={'fplUrl' in p && p.fplUrl ? p.fplUrl : `https://fantasy.premierleague.com/entry/${'fplId' in p ? p.fplId : ''}/event/${data.lastGwResult!.gameweek}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 underline"
                            >
                              {p.name}
                            </a>
                          ) : (
                            <span className="text-white">{p.name}</span>
                          )}
                          {p.isCaptain && (
                            <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${'isInferred' in p && p.isInferred ? "bg-orange-500/20 text-orange-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                              C{'isInferred' in p && p.isInferred ? "?" : ""}
                            </span>
                          )}
                        </div>
                        <div className="text-right">
                          {p.isCaptain ? (
                            <span className={`${'isInferred' in p && p.isInferred ? "text-orange-400" : "text-yellow-400"} font-semibold`}>
                              {p.transferHits > 0
                                ? `(${p.fplScore} − ${p.transferHits}) × 2 = ${p.finalScore}`
                                : `${p.fplScore} × 2 = ${p.finalScore}`}
                            </span>
                          ) : (
                            <span className={liveScoreOverride ? "text-green-300" : "text-white"}>
                              {p.transferHits > 0 ? `${p.fplScore} − ${p.transferHits} = ${p.finalScore}` : p.finalScore}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  {/* Opponent Players */}
                  <div className={`p-3 rounded-lg ${liveScoreOverride ? "bg-green-900/10 border border-green-500/20" : "bg-white/5"}`}>
                    <div className="text-xs text-gray-400 mb-2 text-center">
                      {data.lastGwResult.opponent} Players
                      {!liveScoreOverride && !data.lastGwResult.hasOppCaptainData && (
                        <span className="text-orange-400 ml-1">(estimated)</span>
                      )}
                      {liveScoreOverride && <span className="text-green-400 ml-1">(live)</span>}
                    </div>
                    {(liveScoreOverride?.oppPlayerScores ?? data.lastGwResult.oppPlayerScores).map((p, i) => (
                      <div key={i} className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2">
                          {(('fplUrl' in p && p.fplUrl) || ('fplId' in p && p.fplId)) ? (
                            <a
                              href={'fplUrl' in p && p.fplUrl ? p.fplUrl : `https://fantasy.premierleague.com/entry/${'fplId' in p ? p.fplId : ''}/event/${data.lastGwResult!.gameweek}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 underline"
                            >
                              {p.name}
                            </a>
                          ) : (
                            <span className="text-white">{p.name}</span>
                          )}
                          {p.isCaptain && (
                            <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${'isInferred' in p && p.isInferred ? "bg-orange-500/20 text-orange-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                              C{'isInferred' in p && p.isInferred ? "?" : ""}
                            </span>
                          )}
                        </div>
                        <div className="text-right">
                          {p.isCaptain ? (
                            <span className={`${'isInferred' in p && p.isInferred ? "text-orange-400" : "text-yellow-400"} font-semibold`}>
                              {p.transferHits > 0
                                ? `(${p.fplScore} − ${p.transferHits}) × 2 = ${p.finalScore}`
                                : `${p.fplScore} × 2 = ${p.finalScore}`}
                            </span>
                          ) : (
                            <span className={liveScoreOverride ? "text-green-300" : "text-white"}>
                              {p.transferHits > 0 ? `${p.fplScore} − ${p.transferHits} = ${p.finalScore}` : p.finalScore}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TC Cup Last Result — independent navigation, always-visible breakdown */}
            {leagueFormat === "triple-crown" && (() => {
              const cupResult = data.cupGwResult ?? data.cupProgress?.lastCupResult ?? null;
              if (!cupResult) return null;
              const cupPlayerScores = cupResult.myPlayerScores ?? [];
              const cupOppPlayerScores = cupResult.oppPlayerScores ?? [];
              const myName = (cupResult as any).myTeamName ?? data.team.name;
              const oppName = cupResult.opponent ?? "OPP";
              const currentCupGw = cupViewedGw ?? cupResult.gameweek;
              const cupGws = data.cupProgress?.completedCupGws ?? [];
              const currentCupIdx = cupGws.indexOf(currentCupGw);
              const prevCupGw = currentCupIdx > 0 ? cupGws[currentCupIdx - 1] : null;
              const nextCupGw = currentCupIdx >= 0 && currentCupIdx < cupGws.length - 1 ? cupGws[currentCupIdx + 1] : null;
              return (
                <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 sm:p-6 backdrop-blur">
                  {/* Header with independent nav arrows */}
                  <div className="flex items-center justify-between mb-4">
                    <button
                      onClick={() => { if (prevCupGw !== null) fetchCupResult(prevCupGw); }}
                      disabled={cupRefreshing || prevCupGw === null}
                      className="text-xl sm:text-3xl px-2 sm:px-3 py-1 rounded-full bg-blue-900/60 border border-blue-400 text-blue-300 hover:bg-blue-400 hover:text-blue-900 transition disabled:opacity-30 disabled:bg-gray-700 disabled:text-gray-400"
                    >
                      &#8592;
                    </button>
                    <h2 className="text-base sm:text-lg font-bold text-blue-300 flex items-center gap-2">
                      <span>🏆</span>
                      {cupResult.competitionLabel} — GW{cupResult.gameweek}
                      <button
                        onClick={() => fetchCupResult(currentCupGw)}
                        disabled={cupRefreshing}
                        className={`text-green-400 hover:text-green-300 disabled:opacity-50 transition-all text-sm ${cupRefreshing ? "animate-spin" : ""}`}
                        title="Refresh cup result"
                      >
                        ⟳
                      </button>
                    </h2>
                    <button
                      onClick={() => { if (nextCupGw !== null) fetchCupResult(nextCupGw); }}
                      disabled={cupRefreshing || nextCupGw === null}
                      className="text-xl sm:text-3xl px-2 sm:px-3 py-1 rounded-full bg-blue-900/60 border border-blue-400 text-blue-300 hover:bg-blue-400 hover:text-blue-900 transition disabled:opacity-30 disabled:bg-gray-700 disabled:text-gray-400"
                    >
                      &#8594;
                    </button>
                  </div>

                  {/* Score */}
                  <div className="flex flex-col sm:flex-row items-center justify-between mb-6 gap-2">
                    <div className="flex-1 text-center">
                      <div className="text-xs text-gray-400 mb-1">{cupResult.isHome ? "HOME" : "AWAY"}</div>
                      <div className="text-base sm:text-lg font-bold text-white truncate">{myName}</div>
                    </div>
                    <div className="px-4 sm:px-6 text-center">
                      <div className={`text-3xl sm:text-4xl font-bold ${cupResult.result === "W" ? "text-green-400" : "text-red-400"}`}>
                        {cupResult.myScore} - {cupResult.oppScore}
                      </div>
                      <div className="flex items-center justify-center gap-2 mt-2">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${cupResult.result === "W" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                          {cupResult.result === "W" ? "WIN" : "LOSS"}
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 text-center">
                      <div className="text-xs text-gray-400 mb-1">{cupResult.isHome ? "AWAY" : "HOME"}</div>
                      <div className="text-base sm:text-lg font-bold text-white">{cupResult.opponent ?? "TBD"}</div>
                    </div>
                  </div>

                  {/* Player breakdown — always visible */}
                  {cupPlayerScores.length > 0 && (
                    <div className="grid md:grid-cols-2 gap-4">
                      {[
                        { scores: cupPlayerScores, label: myName, hasCaptainData: !!(cupResult as any).hasMyCaptainData },
                        { scores: cupOppPlayerScores, label: oppName, hasCaptainData: !!(cupResult as any).hasOppCaptainData },
                      ].map(({ scores, label, hasCaptainData }) => (
                        <div key={label} className="p-3 rounded-lg bg-blue-900/10 border border-blue-500/20">
                          <div className="text-xs text-gray-400 mb-2 text-center">
                            {label} Players
                            {!hasCaptainData && <span className="text-orange-400 ml-1">(estimated)</span>}
                          </div>
                          {scores.map((p: any, i: number) => (
                            <div key={i} className="flex items-center justify-between py-1">
                              <div className="flex items-center gap-2">
                                {p.fplUrl ? (
                                  <a href={p.fplUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{p.name}</a>
                                ) : (
                                  <span className="text-white">{p.name}</span>
                                )}
                                {p.isCaptain && (
                                  <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${p.isInferred ? "bg-orange-500/20 text-orange-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                                    C{p.isInferred ? "?" : ""}
                                  </span>
                                )}
                              </div>
                              <div className="text-right">
                                {p.isCaptain ? (
                                  <span className={`${p.isInferred ? "text-orange-400" : "text-yellow-400"} font-semibold`}>
                                    {p.transferHits > 0
                                      ? `(${p.fplScore} − ${p.transferHits}) × 2 = ${p.finalScore}`
                                      : `${p.fplScore} × 2 = ${p.finalScore}`}
                                  </span>
                                ) : (
                                  <span className="text-white">
                                    {p.transferHits > 0 ? `${p.fplScore} − ${p.transferHits} = ${p.finalScore}` : p.finalScore}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Recent Form & Stats */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Recent Form */}
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Recent Form</h2>
                <div className="flex flex-wrap gap-2 mb-4">
                  {data.recentForm.map((f, i) => (
                    <div key={i} className="text-center">
                      <FormBadge result={f.result} gotBonus={f.gotBonus} />
                      <div className="text-xs text-gray-500 mt-1">GW{f.gameweek}</div>
                    </div>
                  ))}
                  {data.recentForm.length === 0 && (
                    <div className="text-gray-400">No matches played yet</div>
                  )}
                </div>
                {data.seasonStats.currentStreak && (
                  <div className="text-sm text-gray-400">
                    Current: <span className={
                      data.seasonStats.currentStreak.type === "W" ? "text-green-400" :
                      data.seasonStats.currentStreak.type === "L" ? "text-red-400" : "text-gray-400"
                    }>
                      {data.seasonStats.currentStreak.count} {data.seasonStats.currentStreak.type === "W" ? "wins" : data.seasonStats.currentStreak.type === "L" ? "losses" : "draws"} in a row
                    </span>
                  </div>
                )}
              </div>

              {/* Season Stats */}
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Season Stats</h2>
                <div className="grid grid-cols-3 gap-2 sm:gap-4 text-center mb-3 sm:mb-4">
                  <div>
                    <div className="text-xl sm:text-2xl font-bold text-green-400">{data.seasonStats.wins}</div>
                    <div className="text-xs text-gray-400">Wins</div>
                  </div>
                  <div>
                    <div className="text-xl sm:text-2xl font-bold text-gray-400">{data.seasonStats.draws}</div>
                    <div className="text-xs text-gray-400">Draws</div>
                  </div>
                  <div>
                    <div className="text-xl sm:text-2xl font-bold text-red-400">{data.seasonStats.losses}</div>
                    <div className="text-xs text-gray-400">Losses</div>
                  </div>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between text-gray-400">
                    <span>Bonus Points</span>
                    <span className="text-yellow-400">+{data.seasonStats.bonusPointsEarned}</span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span>Chip Points</span>
                    <span className="text-purple-400">+{data.seasonStats.chipPointsEarned}</span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span>Points To Top</span>
                    <span className="text-white">-{data.leaguePosition.pointsToTop}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Team Members */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Team Members</h2>
              <div className="grid md:grid-cols-2 gap-4">
                {data.teamMembers.map((member, i) => (
                  <div key={i} className="p-4 rounded-xl bg-white/5">
                    <div className="font-semibold text-white mb-2">{member.name}</div>
                    <div className="text-sm text-gray-400 mb-3">
                      Captaincy chips used: {member.captaincyChipsUsed}
                    </div>
                    <div className="flex gap-2">
                      <a
                        href={member.fplUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center px-3 py-2 rounded-lg bg-blue-500/20 text-blue-400 text-sm hover:bg-blue-500/30 transition"
                      >
                        Current GW ↗
                      </a>
                      <a
                        href={member.fplHistoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center px-3 py-2 rounded-lg bg-purple-500/20 text-purple-400 text-sm hover:bg-purple-500/30 transition"
                      >
                        History ↗
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Mini Table(s) */}
            {leagueFormat === "triple-crown" ? (
              <>
                {/* PL Mini Table */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-bold text-white">PL Table</h2>
                    {data.plPosition && (
                      <span className="text-sm font-bold text-yellow-400">
                        #{data.plPosition.rank} / {data.plPosition.totalTeams}
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {data.leaguePosition.miniTable.map((t) => (
                      <div
                        key={t.rank}
                        className={`flex items-center justify-between p-3 rounded-lg ${
                          t.isCurrentTeam ? "bg-yellow-500/20 border border-yellow-500/30" : "bg-white/5"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${
                            t.rank <= 4 ? "bg-green-500/20 text-green-400" :
                            t.rank <= 8 ? "bg-blue-500/20 text-blue-400" :
                            t.rank <= 14 ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400"
                          }`}>
                            {t.rank}
                          </span>
                          <span className={t.isCurrentTeam ? "text-yellow-400 font-semibold" : "text-white"}>
                            {t.name}
                          </span>
                        </div>
                        <span className="text-white font-bold">{t.points}</span>
                      </div>
                    ))}
                  </div>
                  <Link
                    href={`/${leagueSlug}/standings`}
                    className="block text-center text-sm text-blue-400 hover:text-blue-300 mt-4"
                  >
                    View Full PL Table →
                  </Link>

                  {/* My PL Stats */}
                  <div className="mt-4 pt-4 border-t border-white/10">
                    <div className="text-xs text-gray-400 font-semibold uppercase tracking-wider mb-2">My PL Stats</div>
                    <div className="flex justify-around text-center">
                      <div>
                        <div className="text-xl font-bold text-green-400">{data.seasonStats.wins}</div>
                        <div className="text-xs text-gray-500">W</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold text-gray-400">{data.seasonStats.draws}</div>
                        <div className="text-xs text-gray-500">D</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold text-red-400">{data.seasonStats.losses}</div>
                        <div className="text-xs text-gray-500">L</div>
                      </div>
                      <div>
                        <div className="text-xl font-bold text-white">{data.team.leaguePoints}</div>
                        <div className="text-xs text-gray-500">Pts</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cup Group Mini Table */}
                {data.cupProgress && (
                  <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 sm:p-6 backdrop-blur">
                    <h2 className="text-lg font-bold text-white mb-1">
                      Cup Group {data.cupProgress.groupName}
                    </h2>
                    <p className="text-xs text-gray-400 mb-4">
                      Top 2 → UCL · Bottom 2 → Europa
                    </p>
                    <div className="space-y-2">
                      {data.cupProgress.miniTable.map((t) => (
                        <div
                          key={t.rank}
                          className={`flex items-center justify-between p-3 rounded-lg ${
                            t.isCurrentTeam ? "bg-yellow-500/20 border border-yellow-500/30" : "bg-white/5"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${
                              t.rank <= 2 ? "bg-green-500/20 text-green-400" : "bg-orange-500/20 text-orange-400"
                            }`}>
                              {t.rank}
                            </span>
                            <span className={t.isCurrentTeam ? "text-yellow-400 font-semibold" : "text-white"}>
                              {t.name}
                            </span>
                          </div>
                          <span className="text-white font-bold">{t.cupGroupPoints} pts</span>
                        </div>
                      ))}
                    </div>
                    <Link
                      href={`/${leagueSlug}/uefa-standings`}
                      className="block text-center text-sm text-blue-400 hover:text-blue-300 mt-4"
                    >
                      View Full UEFA Standings →
                    </Link>

                    {/* Cup Stats */}
                    {(() => {
                      const myStat = data.cupProgress!.miniTable.find(t => t.isCurrentTeam);
                      if (!myStat) return null;
                      return (
                        <div className="mt-4 pt-4 border-t border-blue-500/20">
                          <div className="text-xs text-gray-400 font-semibold uppercase tracking-wider mb-2">My Cup Stats</div>
                          <div className="flex justify-around text-center">
                            <div>
                              <div className="text-xl font-bold text-green-400">{myStat.wins}</div>
                              <div className="text-xs text-gray-500">W</div>
                            </div>
                            <div>
                              <div className="text-xl font-bold text-red-400">{myStat.losses}</div>
                              <div className="text-xs text-gray-500">L</div>
                            </div>
                            <div>
                              <div className="text-xl font-bold text-white">{myStat.cupGroupPoints}</div>
                              <div className="text-xs text-gray-500">Pts</div>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* TC: Upcoming Fixtures in right column */}
                {data.upcomingFixtures.length > 0 && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                    <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Upcoming Fixtures</h2>
                    <div className="space-y-3">
                      {(() => {
                        const byGw = new Map<number, typeof data.upcomingFixtures>();
                        for (const f of data.upcomingFixtures) {
                          if (!byGw.has(f.gameweek)) byGw.set(f.gameweek, []);
                          byGw.get(f.gameweek)!.push(f);
                        }
                        return Array.from(byGw.entries()).map(([gw, gwFixtures]) => {
                          const plFix = gwFixtures.find(f => !f.competitionType || f.competitionType === "pl");
                          const cupFix = gwFixtures.find(f => f.competitionType && f.competitionType !== "pl");
                          const isDouble = !!plFix && !!cupFix;
                          return (
                            <div key={gw} className="rounded-xl border border-white/10 overflow-hidden">
                              <div className="px-3 py-1.5 bg-white/5 border-b border-white/10 flex items-center gap-2">
                                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">GW{gw}</span>
                                {isDouble && <span className="text-xs text-yellow-400 font-semibold">⚡ Double Header</span>}
                              </div>
                              <div className={isDouble ? "grid grid-cols-2 divide-x divide-white/10" : ""}>
                                {plFix && (
                                  <div className="flex items-center gap-2 px-3 py-2.5">
                                    <span className={`text-xs px-2 py-0.5 rounded font-semibold ${plFix.isHome ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"}`}>{plFix.isHome ? "H" : "A"}</span>
                                    <span className="text-white text-sm truncate">{plFix.opponent}</span>
                                    <span className="text-xs text-gray-500 ml-auto shrink-0">PL</span>
                                  </div>
                                )}
                                {cupFix && (
                                  <div className="flex items-center gap-2 px-3 py-2.5">
                                    <span className={`text-xs px-2 py-0.5 rounded font-semibold ${cupFix.isHome ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"}`}>{cupFix.isHome ? "H" : "A"}</span>
                                    <span className="text-blue-200 text-sm truncate">{cupFix.opponent}</span>
                                    <span className="text-xs text-blue-400/70 ml-auto shrink-0">{cupFix.competitionLabel ?? "Cup"}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}
              </>
            ) : (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Group {data.team.group} Table</h2>
              <div className="space-y-2">
                {data.leaguePosition.miniTable.map((t) => (
                  <div
                    key={t.rank}
                    className={`flex items-center justify-between p-3 rounded-lg ${
                      t.isCurrentTeam ? "bg-yellow-500/20 border border-yellow-500/30" : "bg-white/5"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${
                        t.rank <= 8 ? "bg-green-500/20 text-green-400" :
                        t.rank <= 14 ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400"
                      }`}>
                        {t.rank}
                      </span>
                      <span className={t.isCurrentTeam ? "text-yellow-400 font-semibold" : "text-white"}>
                        {t.name}
                      </span>
                    </div>
                    <span className="text-white font-bold">{t.points}</span>
                  </div>
                ))}
              </div>
              <Link
                href={`/${leagueSlug}/standings`}
                className="block text-center text-sm text-blue-400 hover:text-blue-300 mt-4"
              >
                View Full Table →
              </Link>
            </div>
            )}

            {/* Next 5 Fixtures — grouped by GW (TVT only; TC shows these above results) */}
            {leagueFormat !== "triple-crown" && <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Upcoming Fixtures</h2>
              {data.upcomingFixtures.length === 0 ? (
                <div className="text-gray-400 text-center py-4">No upcoming fixtures</div>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    // Group by GW number preserving order
                    const byGw = new Map<number, typeof data.upcomingFixtures>();
                    for (const f of data.upcomingFixtures) {
                      if (!byGw.has(f.gameweek)) byGw.set(f.gameweek, []);
                      byGw.get(f.gameweek)!.push(f);
                    }
                    return Array.from(byGw.entries()).map(([gw, gwFixtures]) => {
                      const plFix = gwFixtures.find(f => !f.competitionType || f.competitionType === "pl");
                      const cupFix = gwFixtures.find(f => f.competitionType && f.competitionType !== "pl");
                      const isDouble = !!plFix && !!cupFix;
                      return (
                        <div key={gw} className="rounded-xl border border-white/8 overflow-hidden">
                          {/* GW label */}
                          <div className="px-3 py-1.5 bg-white/5 border-b border-white/8">
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">GW{gw}</span>
                            {isDouble && (
                              <span className="ml-2 text-xs text-yellow-400 font-semibold">Double Header</span>
                            )}
                          </div>
                          {/* Fixture row(s) */}
                          <div className={isDouble ? "grid grid-cols-2 divide-x divide-white/8" : ""}>
                            {plFix && (
                              <div className="flex items-center gap-2 px-3 py-2.5">
                                <span className={`text-xs px-2 py-0.5 rounded font-semibold ${plFix.isHome ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"}`}>
                                  {plFix.isHome ? "H" : "A"}
                                </span>
                                <span className="text-white text-sm truncate">{plFix.opponent}</span>
                                <span className="text-xs text-gray-500 ml-auto shrink-0">{plFix.competitionLabel ?? "PL"}</span>
                              </div>
                            )}
                            {cupFix && (
                              <div className="flex items-center gap-2 px-3 py-2.5">
                                <span className={`text-xs px-2 py-0.5 rounded font-semibold ${cupFix.isHome ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"}`}>
                                  {cupFix.isHome ? "H" : "A"}
                                </span>
                                <span className="text-blue-200 text-sm truncate">{cupFix.opponent}</span>
                                <span className="text-xs text-blue-400/70 ml-auto shrink-0">{cupFix.competitionLabel ?? "Cup"}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>}

            {/* Highs & Lows */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Highs & Lows</h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-green-500/10">
                  <div className="text-sm text-gray-400">Highest Score</div>
                  <div className="text-right">
                    <div className="text-green-400 font-bold">{data.seasonStats.highestScoringGW?.score ?? '—'}</div>
                    <div className="text-xs text-gray-500">
                      {data.seasonStats.highestScoringGW
                        ? `${data.seasonStats.highestScoringGW.opponent ? `vs ${data.seasonStats.highestScoringGW.opponent} · ` : ''}GW${data.seasonStats.highestScoringGW.gameweek}`
                        : 'No data'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg bg-red-500/10">
                  <div className="text-sm text-gray-400">Lowest Score</div>
                  <div className="text-right">
                    <div className="text-red-400 font-bold">{data.seasonStats.lowestScoringGW?.score ?? '—'}</div>
                    <div className="text-xs text-gray-500">
                      {data.seasonStats.lowestScoringGW
                        ? `${data.seasonStats.lowestScoringGW.opponent ? `vs ${data.seasonStats.lowestScoringGW.opponent} · ` : ''}GW${data.seasonStats.lowestScoringGW.gameweek}`
                        : 'No data'}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Recent Captains */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
              <h2 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">Captain History</h2>
              <div className="space-y-2">
                {(showAllCaptains
                  ? data.captaincyStatus.recentCaptains
                  : data.captaincyStatus.recentCaptains.slice(0, 5)
                ).map((c, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-8">GW{c.gameweek}</span>
                      <span className="text-white">{c.playerName}</span>
                    </div>
                    <span className="text-yellow-400 font-bold">{c.score}</span>
                  </div>
                ))}
                {data.captaincyStatus.recentCaptains.length === 0 && (
                  <div className="text-gray-400 text-center py-4">No captain history</div>
                )}
                {data.captaincyStatus.recentCaptains.length > 5 && (
                  <button
                    onClick={() => setShowAllCaptains(!showAllCaptains)}
                    className="w-full text-center text-sm text-yellow-400 hover:text-yellow-300 transition py-2"
                  >
                    {showAllCaptains ? "Show Less ▲" : `Show All (${data.captaincyStatus.recentCaptains.length}) ▼`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
