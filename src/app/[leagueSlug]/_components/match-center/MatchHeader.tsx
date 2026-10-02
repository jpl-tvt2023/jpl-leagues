"use client";

import { LiveFreshness } from "@/components/LiveFreshness";
import type { MatchCenterPayload } from "@/lib/match-center/load";
import { BonusPill } from "../fixtures/BonusPill";
import { bonusPointsFor } from "../fixtures/shared";
import { formatCountdown } from "./labels";

export type MatchStatus = "upcoming" | "live" | "provisional" | "final";

/**
 * Where this comparison stands. "provisional" = every PL match is over and FPL has settled the
 * gameweek, but the JPL scores have not been processed yet.
 */
export function matchStatus(data: MatchCenterPayload): MatchStatus {
  if (!data.gameweek.started) return "upcoming";
  const processed = data.a.storedScore != null && data.b.storedScore != null;
  if (processed) return "final";
  return data.gameweek.settled ? "provisional" : "live";
}

export function MatchHeader({
  data,
  status,
  isRefreshing,
  now,
}: {
  data: MatchCenterPayload;
  status: MatchStatus;
  isRefreshing: boolean;
  now: number;
}) {
  const { a, b, fixture } = data;
  // Bonus belongs to a real fixture; orient its home/away flags onto this page's a/b.
  const aIsHome = fixture ? fixture.homeTeamId === a.teamId : true;
  const bonusA = fixture?.result ? bonusPointsFor(fixture.result, aIsHome ? "home" : "away") : 0;
  const bonusB = fixture?.result ? bonusPointsFor(fixture.result, aIsHome ? "away" : "home") : 0;
  const hasBonus = bonusA > 0 || bonusB > 0;

  const sa = a.displayTotal;
  const sb = b.displayTotal;
  const margin = sa != null && sb != null ? Math.abs(sa - sb) : 0;
  const deadlineMs = Date.parse(data.gameweek.deadline);

  const statusPill =
    status === "upcoming" ? (
      <span className="rounded-full bg-yellow-500/20 px-3 py-0.5 text-xs font-medium text-yellow-300">
        Deadline in {formatCountdown(deadlineMs - now)}
      </span>
    ) : status === "live" ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/20 px-3 py-0.5 text-xs font-medium text-green-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" /> LIVE
      </span>
    ) : status === "provisional" ? (
      <span className="rounded-full bg-sky-500/20 px-3 py-0.5 text-xs font-medium text-sky-300" title="FPL has settled the gameweek; JPL scores are not processed yet">
        Provisional
      </span>
    ) : (
      <span className="rounded-full bg-green-500/20 px-3 py-0.5 text-xs font-medium text-green-400">Final</span>
    );

  const scoreClass = (mine: number | null, theirs: number | null) =>
    status === "upcoming" || mine == null || theirs == null
      ? "text-white"
      : mine > theirs
      ? status === "final" ? "text-green-400" : "text-white"
      : status === "final" ? "text-gray-400" : "text-white";

  return (
    <div
      data-testid="mc-header"
      className={`rounded-2xl border p-4 sm:p-5 backdrop-blur ${
        hasBonus
          ? "border-amber-400/50 bg-amber-500/[0.06] shadow-[0_0_28px_-6px_rgba(251,191,36,0.55)]"
          : "border-white/10 bg-white/5"
      }`}
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        {statusPill}
        <span className="text-xs text-gray-400">Gameweek {data.gameweek.number}</span>
        {status === "live" && <LiveFreshness updatedAt={data.generatedAt} isRefreshing={isRefreshing} />}
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-4">
        <div className="min-w-0 text-left">
          <div className="truncate text-sm sm:text-lg font-semibold text-white">{a.teamName}</div>
          {bonusA > 0 && <BonusPill points={bonusA} margin={margin} groupName={fixture?.group} className="mt-1" />}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {status === "upcoming" ? (
            <span className="text-sm font-medium text-gray-500">VS</span>
          ) : (
            <>
              <span className={`text-3xl sm:text-4xl font-bold ${scoreClass(sa, sb)}`}>{sa ?? "–"}</span>
              <span className="text-gray-500">-</span>
              <span className={`text-3xl sm:text-4xl font-bold ${scoreClass(sb, sa)}`}>{sb ?? "–"}</span>
            </>
          )}
        </div>
        <div className="min-w-0 text-right">
          <div className="truncate text-sm sm:text-lg font-semibold text-white">{b.teamName}</div>
          {bonusB > 0 && (
            <BonusPill points={bonusB} margin={margin} groupName={fixture?.group} align="right" className="mt-1" />
          )}
        </div>
      </div>

      {!fixture && (
        <p className="mt-3 text-center text-[11px] text-gray-400">
          Comparison only — these teams did not play each other in GW{data.gameweek.number}. Each score is
          from the team&apos;s own fixture.
        </p>
      )}
    </div>
  );
}
