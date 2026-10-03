"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { HelpTip } from "@/components/HelpTip";
import type { TvtChipGain } from "@/lib/formats/tvt/chip-gain";
import {
  aggregateGwStats,
  type GwStatsPayload,
  type StatEntry,
  type StatManagerRef,
} from "@/lib/fixtures-stats/aggregate";
import { positionLabel } from "@/lib/fpl/positions";
import type { Fixture, LiveFixtureScore } from "../shared";
import { bonusPointsFor } from "../shared";
import type { ChipDisplay } from "../ChallengeTip";
import { ManagerList, StatList, type DrillDown, type StatLine } from "./StatList";

/** Refetch cadence while a gameweek is live. The server caches for ten minutes anyway. */
const LIVE_POLL_MS = 5 * 60 * 1000;
/** A 202 means another reader is building; try again shortly. */
const PENDING_RETRY_MS = 8_000;
const BONUS_MARGIN = 75;

interface TeamScore {
  teamId: string;
  name: string;
  group: string | null;
  score: number;
  opponentScore: number;
  fixtureId: string;
}

/**
 * The fixtures page's Stats section: who the league captained, bought and sold, owns and scored
 * with this gameweek, plus the gameweek's leaders and its chips and hits — as a grid of cards.
 *
 * Player stats come from /api/fixtures/stats. Team-level stats (scores, margins, the bonus race,
 * TVT chips) are derived from the fixtures and live scores the page already holds, so they
 * always agree with the cards beside them.
 */
export function GwStatsPanel({
  leagueSlug,
  gw,
  fixtures,
  liveScores,
  chipsForGw,
  tvtChipGains,
  isLive,
  deadlinePassed,
  showBonusRace,
  active,
}: {
  leagueSlug: string;
  gw: number | null;
  fixtures: Fixture[];
  liveScores: LiveFixtureScore[];
  chipsForGw: Record<string, ChipDisplay>;
  /** League points each team's TVT chip gained, worked out by the page from what its cards show. */
  tvtChipGains: Record<string, TvtChipGain | null>;
  isLive: boolean;
  deadlinePassed: boolean;
  /** TVT only — Continental Championship has no group bonus. */
  showBonusRace: boolean;
  /**
   * The section is on screen. On a phone it sits behind the Stats tab, and most readers never
   * open it, so nothing is fetched until it is shown. Once shown it stays loaded — switching
   * back to Fixtures does not throw the data away.
   */
  active: boolean;
}) {
  const [payload, setPayload] = useState<GwStatsPayload | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [scope, setScope] = useState<string>("all");
  const [drill, setDrill] = useState<DrillDown | null>(null);
  const [activated, setActivated] = useState(active);
  const gwRef = useRef(gw);
  gwRef.current = gw;

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  useEffect(() => {
    if (!gw || !deadlinePassed) {
      setPayload(null);
      return;
    }
    if (!activated) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = async (attempt = 0) => {
      try {
        const res = await fetch(`/api/fixtures/stats?leagueSlug=${encodeURIComponent(leagueSlug)}&gameweek=${gw}`);
        if (cancelled || gwRef.current !== gw) return;
        if (res.status === 202 && attempt < 6) {
          retry = setTimeout(() => void load(attempt + 1), PENDING_RETRY_MS);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        setPayload((await res.json()) as GwStatsPayload);
        setState("idle");
      } catch {
        if (!cancelled) setState("error");
      }
    };
    setPayload(null);
    setState("loading");
    void load();
    const poll = isLive ? setInterval(() => void load(), LIVE_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (poll) clearInterval(poll);
    };
  }, [leagueSlug, gw, isLive, deadlinePassed, activated]);

  const groups = useMemo(
    () => [...new Set(fixtures.map((f) => f.group?.name).filter((g): g is string => !!g))].sort(),
    [fixtures],
  );
  const hasGroups = groups.length > 1;
  const effectiveScope = hasGroups ? scope : "all";

  const agg = useMemo(
    () => (payload && payload.status === "ok" ? aggregateGwStats(payload, effectiveScope) : null),
    [payload, effectiveScope],
  );

  // ── Team-level, from what the fixture cards already show ──
  const teamScores = useMemo(() => {
    const live = new Map(liveScores.filter((l) => l.gameweek === gw).map((l) => [l.fixtureId, l]));
    const out: TeamScore[] = [];
    for (const f of fixtures) {
      const r = f.result;
      const l = live.get(f.id);
      const hs = r ? r.homeScore : l?.homeScore;
      const as = r ? r.awayScore : l?.awayScore;
      if (hs == null || as == null) continue;
      const group = f.group?.name ?? null;
      if (f.homeTeam.id && !f.homeTeam.isGhost) out.push({ teamId: f.homeTeam.id, name: f.homeTeam.name, group, score: hs, opponentScore: as, fixtureId: f.id });
      if (f.awayTeam.id && !f.awayTeam.isGhost) out.push({ teamId: f.awayTeam.id, name: f.awayTeam.name, group, score: as, opponentScore: hs, fixtureId: f.id });
    }
    return out;
  }, [fixtures, liveScores, gw]);
  const scopedTeams = teamScores.filter((t) => effectiveScope === "all" || t.group === effectiveScope);
  const teamGroup = new Map(teamScores.map((t) => [t.teamId, t.group]));

  const playerLine = (e: StatEntry, value: string, title: string): StatLine => ({
    key: String(e.element),
    label: e.name,
    sub: [e.club, positionLabel(e.pos)].filter(Boolean).join(" · "),
    value,
    extra: e.extra,
    managers: e.managers,
    title,
  });

  const notice = !deadlinePassed
    ? "Player stats appear once the deadline passes."
    : state === "error"
    ? "Stats could not be loaded."
    : !agg
    ? "Loading stats…"
    : !payload!.picksComplete || !payload!.transfersComplete
    ? "Some managers couldn't be read from FPL yet — numbers will fill in shortly."
    : null;

  const pct = (e: StatEntry) => `${e.value} · ${e.pct ?? 0}%`;
  const loadingEmpty = agg ? "Nothing yet" : notice ?? "…";

  // Bonus race: per group, the biggest 75+ winning margin.
  const bonusLines: StatLine[] = showBonusRace
    ? groups
        .filter((g) => effectiveScope === "all" || g === effectiveScope)
        .flatMap((g) => {
          const awarded = fixtures.filter((f) => f.group?.name === g && f.result && (bonusPointsFor(f.result, "home") || bonusPointsFor(f.result, "away")));
          if (awarded.length > 0) {
            return awarded.map((f) => {
              const home = bonusPointsFor(f.result, "home") > 0;
              const team = home ? f.homeTeam.name : f.awayTeam.name;
              const pts = bonusPointsFor(f.result, home ? "home" : "away");
              return { key: `${g}-${f.id}`, label: team, sub: `Group ${g} · bonus awarded`, value: `+${pts}`, managers: [], title: `${team} took the Group ${g} bonus` };
            });
          }
          const leader = teamScores
            .filter((t) => t.group === g && t.score - t.opponentScore >= BONUS_MARGIN)
            .sort((a, b) => (b.score - b.opponentScore) - (a.score - a.opponentScore))[0];
          return [
            leader
              ? { key: `${g}-lead`, label: leader.name, sub: `Group ${g} · ${isLive ? "on course" : "leading"}`, value: `+${leader.score - leader.opponentScore}`, managers: [], title: `${leader.name} leads the Group ${g} bonus race` }
              : { key: `${g}-none`, label: "No 75+ margin yet", sub: `Group ${g}`, value: "–", managers: [], title: `Group ${g}` },
          ];
        })
    : [];

  const tvtChips = Object.entries(chipsForGw)
    .filter(([teamId]) => effectiveScope === "all" || teamGroup.get(teamId) === effectiveScope)
    .map(([teamId, chip]) => ({
      teamId,
      chip,
      name:
        teamScores.find((t) => t.teamId === teamId)?.name ??
        fixtures.flatMap((f) => [f.homeTeam, f.awayTeam]).find((t) => t.id === teamId)?.name ??
        "Team",
      gain: tvtChipGains[teamId] ?? null,
    }))
    // Biggest gain first; chips with nothing to go on yet last.
    .sort((a, b) => (b.gain?.points ?? -1) - (a.gain?.points ?? -1) || a.name.localeCompare(b.name));

  const openDrill = (d: DrillDown) => {
    if (d.managers.length > 0) setDrill(d);
  };

  const teamsEmpty = deadlinePassed ? "No scores yet" : "Scores appear once the gameweek starts";

  return (
    <section data-testid="gw-stats-panel" aria-label={`Gameweek ${gw ?? ""} stats`} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
        <h2 className="text-base sm:text-lg font-bold text-white">
          GW{gw ?? ""} stats
          {agg && <span className="ml-2 text-xs font-normal text-gray-400">{agg.managerCount} managers</span>}
        </h2>
        {hasGroups && (
          <div role="tablist" aria-label="Stats scope" className="flex gap-1 rounded-lg bg-black/20 p-1">
            {["all", ...groups].map((g) => (
              <button
                key={g}
                role="tab"
                aria-selected={effectiveScope === g}
                onClick={() => setScope(g)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  effectiveScope === g ? "bg-white/15 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                {g === "all" ? "All" : `Group ${g}`}
              </button>
            ))}
          </div>
        )}
      </div>

      {notice && (
        <p className={`text-xs ${state === "error" ? "text-rose-300" : notice.startsWith("Some") ? "text-amber-300/80" : "text-gray-400"}`}>
          {notice}
        </p>
      )}

      {/* Order as agreed: owned · captained / in · out / scorers · margins / managers · teams /
          bonus · chips. Two columns beside the fixtures, three below them, one on a phone. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-2 gap-3 items-stretch">
        <StatList
          testId="stat-owned"
          title="Most owned"
          hint="EO = effective ownership: captains count twice, bench zero."
          lines={agg?.owned.map((e) => playerLine(e, pct(e), `${e.name} — owned by ${e.value}`)) ?? []}
          empty={loadingEmpty}
          onOpen={openDrill}
        />
        <StatList
          testId="stat-captained"
          title="Most captained"
          lines={agg?.captained.map((e) => playerLine(e, pct(e), `${e.name} — captained by ${e.value}`)) ?? []}
          empty={loadingEmpty}
          onOpen={openDrill}
        />
        <StatList
          testId="stat-transfers-in"
          title="Most transferred in"
          hint={agg ? transferHint(agg.transferChipManagers) : undefined}
          lines={agg?.transfersIn.map((e) => playerLine(e, String(e.value), `${e.name} — brought in by ${e.value}`)) ?? []}
          empty={agg ? "No transfers in" : loadingEmpty}
          onOpen={openDrill}
        />
        <StatList
          testId="stat-transfers-out"
          title="Most transferred out"
          hint={agg ? "Wildcard and Free Hit moves excluded." : undefined}
          lines={agg?.transfersOut.map((e) => playerLine(e, String(e.value), `${e.name} — sold by ${e.value}`)) ?? []}
          empty={agg ? "No transfers out" : loadingEmpty}
          onOpen={openDrill}
        />
        <StatList
          testId="stat-top-scorers"
          title="Top scorers owned"
          lines={agg?.topScorers.map((e) => playerLine(e, `${e.value} pts`, `${e.name} — ${e.value} pts, owned by ${e.managers.length}`)) ?? []}
          empty={loadingEmpty}
          onOpen={openDrill}
        />
        <StatList
          testId="stat-margins"
          title="Biggest winning margins"
          lines={[...scopedTeams]
            .filter((t) => t.score > t.opponentScore)
            .sort((a, b) => (b.score - b.opponentScore) - (a.score - a.opponentScore))
            .slice(0, 5)
            .map((t) => ({
              key: t.fixtureId,
              label: t.name,
              sub: `${t.score} – ${t.opponentScore}`,
              value: `+${t.score - t.opponentScore}`,
              managers: [],
              title: t.name,
            }))}
          empty={teamsEmpty}
          onOpen={openDrill}
        />
        <StatList
          testId="stat-top-managers"
          title="GW leaders — managers"
          hint="FPL points net of hits, before the JPL captain doubling."
          lines={agg?.topManagers.map((m) => ({
            key: m.fplId,
            label: m.name,
            sub: m.teamName,
            value: String(m.net),
            managers: [m],
            title: `${m.name} — ${m.net}`,
          })) ?? []}
          empty={loadingEmpty}
          onOpen={openDrill}
        />
        <StatList
          testId="stat-top-teams"
          title="GW leaders — teams"
          lines={[...scopedTeams]
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map((t) => ({
              key: t.teamId,
              label: t.name,
              sub: t.group ? `Group ${t.group}` : undefined,
              value: String(t.score),
              managers: [],
              title: t.name,
            }))}
          empty={teamsEmpty}
          onOpen={openDrill}
        />
        {showBonusRace && bonusLines.length > 0 && (
          <StatList
            testId="stat-bonus-race"
            title="Bonus race"
            hint="75+ margin and the biggest in the group."
            lines={bonusLines}
            onOpen={openDrill}
          />
        )}

        {/* @container: beside the fixtures this card is ~15% of the screen, so a narrow card names
            the chip by its code (CC) rather than squeezing the team name out. */}
        <section data-testid="stat-chips-hits" className="@container h-full rounded-xl border border-white/10 bg-white/5 p-3 space-y-2">
          <h3 className="text-xs font-semibold text-white">Chips &amp; hits</h3>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">TVT chips · pts gained</div>
            {tvtChips.length === 0 ? (
              <p className="text-[11px] text-gray-500">{deadlinePassed ? "None played" : "Revealed at the deadline"}</p>
            ) : (
              <ul className="mt-0.5 space-y-0.5">
                {tvtChips.map(({ teamId, chip, name, gain }) => (
                  <li key={teamId} data-testid={`tvt-chip-${teamId}`} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-white">{name}</span>
                    <span className="shrink-0 text-[10px] text-gray-400">
                      <span className="hidden @[18rem]:inline">{chip.chipName}</span>
                      <span className="@[18rem]:hidden" title={chip.chipName}>{chip.chipCode}</span>
                      {chip.isWasted ? " · wasted" : gain?.note ? ` · ${gain.note}` : ""}
                    </span>
                    <ChipGainValue gain={gain} chipName={chip.chipName} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">FPL chips</div>
            {!agg ? (
              <p className="text-[11px] text-gray-500">{loadingEmpty}</p>
            ) : agg.fplChips.length === 0 ? (
              <p className="text-[11px] text-gray-500">None played</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {agg.fplChips.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => openDrill({ title: `${c.label} — ${c.managers.length}`, managers: c.managers })}
                    className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-300 hover:bg-yellow-500/25"
                  >
                    {c.code} × {c.managers.length}
                  </button>
                ))}
              </div>
            )}
          </div>
          {agg && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Transfer hits</div>
              {agg.hits.takers.length === 0 ? (
                <p className="text-[11px] text-gray-500">No hits taken</p>
              ) : (
                <button
                  type="button"
                  onClick={() => openDrill({ title: `Transfer hits — ${agg.hits.total} points`, managers: agg.hits.takers })}
                  className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded px-1 py-0.5 text-left text-xs hover:bg-white/10"
                >
                  {/* Stacked, not side by side: beside the fixtures this card is ~15% of the screen. */}
                  <span className="text-gray-300">
                    <span className="font-semibold text-rose-300">−{agg.hits.total}</span> from {agg.hits.takers.length} manager{agg.hits.takers.length === 1 ? "" : "s"}
                  </span>
                  <span className="max-w-full truncate text-[10px] text-gray-400">
                    Biggest: {agg.hits.takers[0].name} −{agg.hits.takers[0].hits}
                  </span>
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      <Sheet open={drill !== null} onClose={() => setDrill(null)} title={drill?.title ?? ""} size="md">
        {drill && <ManagerList managers={drill.managers} />}
      </Sheet>
    </section>
  );
}

/**
 * What a TVT chip gained, in league points: green when it added something, red when it added
 * nothing. Tap or hover for how the figure was reached.
 */
function ChipGainValue({ gain, chipName }: { gain: TvtChipGain | null; chipName: string }) {
  if (!gain) {
    return (
      <span data-testid="tvt-chip-gain" data-tone="unknown" className="w-7 shrink-0 text-right text-xs text-gray-500">
        –
      </span>
    );
  }
  const tone = gain.points > 0 ? "gain" : "none";
  return (
    <HelpTip
      tip={
        <>
          <span className="block font-semibold text-white">{chipName}</span>
          {gain.detail}
        </>
      }
      className="shrink-0"
    >
      <span
        data-testid="tvt-chip-gain"
        data-gain={gain.points}
        data-tone={tone}
        className={`inline-block w-7 text-right text-xs font-semibold tabular-nums ${
          tone === "gain" ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {gain.points > 0 ? `+${gain.points}` : gain.points}
      </span>
    </HelpTip>
  );
}

function transferHint(excluded: StatManagerRef[]): string {
  if (excluded.length === 0) return "Wildcard and Free Hit moves excluded.";
  return `Wildcard and Free Hit moves excluded (${excluded.length} manager${excluded.length === 1 ? "" : "s"}).`;
}
