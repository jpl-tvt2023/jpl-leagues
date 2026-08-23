"use client";

import { useCallback, useEffect, useState } from "react";
import { GwNavigator } from "@/components/GwNavigator";
import {
  PlayerBreakdown,
  type BreakdownChips,
  type Fixture,
  type LiveFixtureScore,
} from "@/app/[leagueSlug]/_components/fixtures/shared";
import { chipState, type ChipState, type FplChipStatus } from "@/lib/fpl-league/chips";

/**
 * The dashboard's PL Fixture card.
 *
 * Kept out of dashboard/page.tsx, which is already 2,500 lines. Owns its own
 * gameweek selection and fetching so paging between gameweeks does not
 * re-fetch the entire dashboard payload.
 */

interface SideInfo {
  teamId: string;
  name: string;
  players: { name: string; fplId: string; fplUrl: string; fplChips: FplChipStatus | null }[];
  tvtChips: {
    set: 1 | 2 | "playoffs";
    doublePointer: boolean;
    challengeChip: boolean;
    winWin: boolean;
    /** Gameweek each spent chip was played in. Past deadlines only. */
    usedGws: { code: string; gw: number }[];
  };
  playersLeft: { leftToPlay: number; total: number } | null;
}

/** TVT chips in display order, with the flag on SideInfo that marks each spent. */
const TVT_CHIPS: { code: string; label: string; flag: keyof SideInfo["tvtChips"] }[] = [
  { code: "DP", label: "Double Pointer", flag: "doublePointer" },
  { code: "CC", label: "Challenge Chip", flag: "challengeChip" },
  { code: "WW", label: "Win-Win", flag: "winWin" },
];

/**
 * Fold one side's chip state into the shape the points breakdown renders.
 *
 * The two families resolve differently. FPL chips carry the gameweek they were
 * played, so their state falls straight out of `chipState`. A TVT chip may be
 * flagged spent while its gameweek is deliberately withheld — declarations for
 * a gameweek whose deadline has not passed are not published, so an opponent
 * cannot read them early. That case is "past" with no gameweek: spent, but we
 * are not saying when.
 */
function buildChips(side: SideInfo, gwNumber: number | null): BreakdownChips {
  const playedIn = new Map(side.tvtChips.usedGws.map((u) => [u.code, u.gw]));

  return {
    byFplId: Object.fromEntries(side.players.map((p) => [p.fplId, p.fplChips])),
    tvtLabel: side.tvtChips.set === "playoffs" ? "playoffs" : `Set ${side.tvtChips.set}`,
    tvt: TVT_CHIPS.map(({ code, label, flag }) => {
      const gw = playedIn.get(code) ?? null;
      const spent = side.tvtChips[flag] === true;
      const state: ChipState = gw != null ? chipState(gw, gwNumber) : spent ? "past" : "available";
      return { code, label, state, gw };
    }),
  };
}

interface Payload {
  gw: number | null;
  availableGws: number[];
  defaultGw: number | null;
  linkGw: number | null;
  isLive: boolean;
  isHome?: boolean;
  fixture: { id: string; home: SideInfo; away: SideInfo } | null;
  live: LiveFixtureScore | null;
  result: {
    homeScore: number;
    awayScore: number;
    homePlayerScores: string | null;
    awayPlayerScores: string | null;
  } | null;
}

export function PlFixtureCard() {
  const [data, setData] = useState<Payload | null>(null);
  const [gw, setGw] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Collapsed by default — the card is a summary first. Chips live inside the
  // breakdown and are hidden with it, which is fine; players-left is not, so it
  // is rendered in the header where it survives the collapse.
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (targetGw: number | null, refresh = false) => {
    const params = new URLSearchParams();
    if (targetGw != null) params.set("gw", String(targetGw));
    if (refresh) params.set("refresh", "1");
    const res = await fetch(`/api/team/dashboard/pl-fixture?${params}`);
    if (!res.ok) throw new Error("failed");
    return (await res.json()) as Payload;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await load(null);
        if (cancelled) return;
        setData(body);
        setGw(body.gw);
        setError(null);
      } catch {
        if (!cancelled) setError("Could not load your fixture.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const changeGw = async (next: number) => {
    setGw(next);
    setIsLoading(true);
    try {
      setData(await load(next));
      setError(null);
    } catch {
      setError("Could not load that gameweek.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (!data?.isLive || isRefreshing) return;
    setIsRefreshing(true);
    try {
      setData(await load(gw, true));
    } catch {
      // Leave the current numbers on screen — a failed refresh should not
      // blank a card that is already showing valid data.
    } finally {
      setIsRefreshing(false);
    }
  };

  const card = "rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur";

  if (isLoading && !data) {
    return (
      <div className={card}>
        <div className="h-5 w-40 bg-white/10 rounded animate-pulse mb-4" />
        <div className="h-16 bg-white/5 rounded animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={card}>
        <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
          <span className="text-yellow-400">⚔</span> PL Fixture
        </h2>
        <p className="text-center text-gray-400 text-sm">{error ?? "No fixture found."}</p>
      </div>
    );
  }

  const { fixture, live, result } = data;

  // PlayerBreakdown is the same component the Fixtures page uses, so the two
  // can never render a fixture differently.
  const asFixture: Fixture | null = fixture
    ? {
        id: fixture.id,
        homeTeam: { id: fixture.home.teamId, name: fixture.home.name },
        awayTeam: { id: fixture.away.teamId, name: fixture.away.name },
        gameweek: { number: data.gw ?? 0 },
        result: result ?? null,
      }
    : null;

  const homeScore = result ? result.homeScore : live?.homeScore;
  const awayScore = result ? result.awayScore : live?.awayScore;
  const hasScore = homeScore !== undefined && awayScore !== undefined;

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <span className="text-yellow-400">⚔</span> GW{data.gw} PL Fixture
        </h2>
        <div className="flex items-center gap-2">
          {data.isLive && (
            <span className="px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 text-[10px] font-semibold flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
              LIVE
            </span>
          )}
          {/* Only enabled while the gameweek is actually being played — a
              refresh on a finished gameweek costs a full FPL fetch to return
              numbers that cannot change. */}
          <button
            onClick={handleRefresh}
            disabled={!data.isLive || isRefreshing}
            title={data.isLive ? "Refresh live scores" : "Scores only change while the gameweek is live"}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition ${
              !data.isLive || isRefreshing
                ? "bg-white/5 text-gray-500 cursor-not-allowed"
                : "bg-white/10 text-gray-300 hover:bg-white/20"
            }`}
          >
            <svg className={`w-3 h-3 ${isRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {data.availableGws.length > 1 && (
        <div className="mb-4">
          <GwNavigator gws={data.availableGws} value={gw} onChange={changeGw} disabled={isLoading} />
        </div>
      )}

      {!fixture || !asFixture ? (
        <div className="text-center text-gray-400 text-sm py-4">
          No fixture for GW{data.gw}.
        </div>
      ) : (
        <>
          <div className="flex items-center justify-center gap-4 mb-3">
            <SideHeader side={fixture.home} label={data.isHome ? "HOME" : "HOME"} score={hasScore ? homeScore : undefined} />
            <span className="text-gray-500 font-medium">VS</span>
            <SideHeader side={fixture.away} label="AWAY" score={hasScore ? awayScore : undefined} align="right" />
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full text-center text-[11px] text-gray-500 hover:text-gray-300 transition py-1"
          >
            {expanded ? "▲ Hide points breakdown" : "▼ Points breakdown"}
          </button>
          {expanded && (
            <PlayerBreakdown
              fixture={asFixture}
              liveData={live ?? undefined}
              homeChips={buildChips(fixture.home, data.gw)}
              awayChips={buildChips(fixture.away, data.gw)}
              // Already in the header above, which is visible either way.
              hidePlayersLeft
              // Not data.gw: FPL cannot render a gameweek that has not kicked
              // off, so paging forward must keep the links on the last one that
              // started.
              linkGw={data.linkGw}
            />
          )}
        </>
      )}
    </div>
  );
}

function SideHeader({
  side,
  label,
  score,
  align = "left",
}: {
  side: SideInfo;
  label: string;
  score?: number;
  align?: "left" | "right";
}) {
  return (
    <div className={`text-center ${align === "right" ? "order-3" : ""}`}>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-lg font-bold text-white truncate max-w-[10rem]">{side.name}</div>
      {score !== undefined && <div className="text-xl font-bold text-white">{score}</div>}
      {/* Kept in the header, not only in the breakdown: this is a live figure and
          the breakdown is collapsed by default. */}
      {side.playersLeft && (
        <div className="text-[10px] text-emerald-400 mt-0.5">
          ⏳ {side.playersLeft.leftToPlay}/{side.playersLeft.total} left
        </div>
      )}
    </div>
  );
}
