"use client";

/**
 * FPL Classic — the Winners page.
 *
 * Sections in order of how much a reader cares: season first, then the two special awards, then
 * months, then every gameweek. Everything on one scrolling page rather than behind tabs — with ~38
 * gameweek winners and ~10 monthly ones, hiding most of them behind a click would defeat the point
 * of a page whose entire job is to list winners.
 *
 * The load-bearing distinction is `status`, not the layout. An award whose period is still running
 * shows who is ahead, badged `Leading`, with copy saying plainly that it is not settled. Calling
 * that person a winner would be a false claim about a live competition.
 *
 * ⚠️ NO PRIZES. This page announces names and figures only — see the warning in
 * lib/fpl-classic/awards.ts.
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague } from "@/lib/league-context";
import {
  AwardCard,
  AwardStatusBadge,
  scopeLabel,
  type AwardGroup,
  type MonthOption,
} from "../fpl-classic/awards-shared";

interface Payload {
  league: {
    slug: string; name: string; season: string; fplLeagueId: number; fplLeagueName: string | null;
    scoringMetric: "net" | "gross"; winnerCutPercent: number;
  };
  settledThroughGw: number;
  entrantCount: number;
  months: MonthOption[];
  awards: AwardGroup[];
}

export function FplClassicWinners() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;
  const { league } = useLeague();

  const [data, setData] = useState<Payload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/fpl-classic/winners?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body?.error ?? `Could not load winners (${res.status})`);
        else setData(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load winners");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [leagueSlug]);

  const monthLabelByKey = new Map((data?.months ?? []).map((m) => [m.key, m.label]));
  const bySlot = (scope: AwardGroup["scope"]) => (data?.awards ?? []).filter((a) => a.scope === scope);

  const season = bySlot("season");
  const special = bySlot("special");
  const monthly = [...bySlot("month")].sort((a, b) => b.scopeKey.localeCompare(a.scopeKey));
  const gameweeks = [...bySlot("gameweek")].sort(
    (a, b) => Number(b.scopeKey.split(":")[1] ?? 0) - Number(a.scopeKey.split(":")[1] ?? 0),
  );

  if (isLoading) return <LoadingScreen variant="playoffs" fullScreen={false} />;

  return (
    <div data-testid="fpl-classic-winners" className="min-h-screen">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="winners"
        format="fpl-classic"
        isLoggedIn={false}
        dashboardHref="/"
        onSignOut={() => {}}
      />

      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-10 py-8 sm:py-12">
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">Winners</h1>
          <p className="text-sm text-gray-400">
            {data?.league.fplLeagueName ?? league.name}
            {data ? ` · ${data.entrantCount} entrants` : ""}
          </p>
        </div>

        {error && <div className="text-center text-red-400 py-8">{error}</div>}

        {data && (
          <>
            <div className="mb-8 rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-400">
                <span className="flex items-center gap-2"><AwardStatusBadge status="final" /> Confirmed — will not change.</span>
                <span className="flex items-center gap-2"><AwardStatusBadge status="provisional" /> Settled, not yet confirmed.</span>
                <span className="flex items-center gap-2"><AwardStatusBadge status="leading" /> Still being played for.</span>
              </div>
              <p className="mt-3 text-xs text-gray-500">
                {data.settledThroughGw > 0
                  ? `Calculated from gameweeks up to and including GW${data.settledThroughGw}.`
                  : "No gameweeks have been processed yet."}
                {" "}Prizes are announced separately and are never listed on this site.
              </p>
            </div>

            {data.awards.length === 0 ? (
              <p className="text-center text-gray-500 py-12">
                Nothing to show yet — winners appear here once the first gameweek has been processed.
              </p>
            ) : (
              <div className="space-y-10">
                <Section
                  title="Season"
                  subtitle={`The top ${data.league.winnerCutPercent}% of entrants by season total.`}
                  groups={season}
                  monthLabelByKey={monthLabelByKey}
                />
                <Section title="Special awards" groups={special} monthLabelByKey={monthLabelByKey} />
                <Section title="Manager of the Month" groups={monthly} monthLabelByKey={monthLabelByKey} compact />
                <Section title="Manager of the Gameweek" groups={gameweeks} monthLabelByKey={monthLabelByKey} compact />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  groups,
  monthLabelByKey,
  compact = false,
}: {
  title: string;
  subtitle?: string;
  groups: AwardGroup[];
  monthLabelByKey: Map<string, string>;
  compact?: boolean;
}) {
  if (groups.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg sm:text-xl font-bold text-white mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-gray-500 mb-3">{subtitle}</p>}
      {/* Monthly and gameweek lists get a denser grid — there are up to 38 of them and each holds
          a single name, so the roomier card grid used for season/special would scroll forever. */}
      <div
        className={
          compact
            ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-2"
            : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        }
      >
        {groups.map((group) =>
          compact ? (
            <CompactRow key={`${group.key}::${group.scopeKey}`} group={group} monthLabelByKey={monthLabelByKey} />
          ) : (
            <AwardCard key={`${group.key}::${group.scopeKey}`} group={group} monthLabelByKey={monthLabelByKey} />
          ),
        )}
      </div>
    </section>
  );
}

function CompactRow({ group, monthLabelByKey }: { group: AwardGroup; monthLabelByKey: Map<string, string> }) {
  const winner = group.winners[0];
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <span className="text-[11px] font-semibold text-sky-300 shrink-0 w-16">
        {scopeLabel(group, monthLabelByKey)}
      </span>
      <span className="text-sm text-white font-medium truncate flex-1 min-w-0">
        {winner ? winner.entryName : "—"}
        {winner?.isTied && <span className="text-gray-500 text-[10px] ml-1">(tied)</span>}
      </span>
      {winner && <span className="text-xs text-gray-400 shrink-0">{winner.value}</span>}
      <AwardStatusBadge status={group.status} />
    </div>
  );
}
