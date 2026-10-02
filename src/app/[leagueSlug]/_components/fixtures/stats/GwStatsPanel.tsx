"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
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
 * The fixtures page's right-hand column: who the league captained, bought and sold, owns and
 * scored with this gameweek, plus the gameweek's leaders and its chips and hits.
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
  isLive,
  deadlinePassed,
  showBonusRace,
}: {
  leagueSlug: string;
  gw: number | null;
  fixtures: Fixture[];
  liveScores: LiveFixtureScore[];
  chipsForGw: Record<string, ChipDisplay>;
  isLive: boolean;
  deadlinePassed: boolean;
  /** TVT only — Continental Championship has no group bonus. */
  showBonusRace: boolean;
}) {
  const [payload, setPayload] = useState<GwStatsPayload | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [scope, setScope] = useState<string>("all");
  const [drill, setDrill] = useState<DrillDown | null>(null);
  const [open, setOpen] = useState(false);
  const gwRef = useRef(gw);
  gwRef.current = gw;

  // Below xl the panel starts collapsed, and most phone readers never open it — so it fetches
  // nothing until it is actually on screen. Once shown it stays loaded, so collapsing it again
  // does not throw the data away.
  const [isWide, setIsWide] = useState(false);
  const [activated, setActivated] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (open || isWide) setActivated(true);
  }, [open, isWide]);

  useEffect(() => {
    if (!gw || !deadlinePassed) {
      setPayload(null);
      return;
    }
    if (!activated) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = async (attempt = 0) => {
      setState((s) => (s === "idle" && attempt === 0 ? "loading" : s));
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

  const noData = !deadlinePassed
    ? "Stats appear once the deadline passes."
    : state === "error"
    ? "Stats could not be loaded."
    : state === "loading" || !payload
    ? "Loading…"
    : null;

  const n = agg?.managerCount ?? 0;
  const pct = (e: StatEntry) => `${e.value} · ${e.pct ?? 0}%`;

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

  const tvtChipLines: StatLine[] = Object.entries(chipsForGw)
    .filter(([teamId]) => effectiveScope === "all" || teamGroup.get(teamId) === effectiveScope)
    .map(([teamId, chip]) => {
      const name = teamScores.find((t) => t.teamId === teamId)?.name
        ?? fixtures.flatMap((f) => [f.homeTeam, f.awayTeam]).find((t) => t.id === teamId)?.name
        ?? "Team";
      return {
        key: teamId,
        label: name,
        sub: chip.chipName + (chip.isWasted ? " · wasted" : ""),
        value: chip.chipCode,
        managers: [],
        title: `${name} played ${chip.chipName}`,
      };
    });

  const openDrill = (d: DrillDown) => {
    if (d.managers.length > 0) setDrill(d);
  };

  return (
    <aside data-testid="gw-stats-panel" className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="xl:hidden mb-3 flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white"
      >
        <span>📊 GW{gw ?? ""} stats</span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      <div className={`${open ? "block" : "hidden"} xl:block space-y-3 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:pr-1`}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="hidden xl:block text-base font-bold text-white">GW{gw ?? ""} stats</h2>
          {agg && <span className="text-[10px] text-gray-500">{n} managers</span>}
        </div>

        {hasGroups && (
          <div role="tablist" aria-label="Stats scope" className="flex gap-1 rounded-lg bg-white/5 p-1">
            {["all", ...groups].map((g) => (
              <button
                key={g}
                role="tab"
                aria-selected={effectiveScope === g}
                onClick={() => setScope(g)}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                  effectiveScope === g ? "bg-white/15 text-white" : "text-gray-400 hover:text-white"
                }`}
              >
                {g === "all" ? "All" : `Group ${g}`}
              </button>
            ))}
          </div>
        )}

        {noData && !agg ? (
          <p className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-gray-400">{noData}</p>
        ) : agg ? (
          <>
            {(!payload!.picksComplete || !payload!.transfersComplete) && (
              <p className="text-[10px] text-amber-300/80">
                Some managers couldn&apos;t be read from FPL yet — numbers will fill in shortly.
              </p>
            )}
            <StatList
              testId="stat-captained"
              title="Most captained"
              lines={agg.captained.map((e) => playerLine(e, pct(e), `${e.name} — captained by ${e.value}`))}
              onOpen={openDrill}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-3">
              <StatList
                testId="stat-transfers-in"
                title="Most transferred in"
                hint={transferHint(agg.transferChipManagers)}
                lines={agg.transfersIn.map((e) => playerLine(e, String(e.value), `${e.name} — brought in by ${e.value}`))}
                empty="No transfers in"
                onOpen={openDrill}
              />
              <StatList
                testId="stat-transfers-out"
                title="Most transferred out"
                lines={agg.transfersOut.map((e) => playerLine(e, String(e.value), `${e.name} — sold by ${e.value}`))}
                empty="No transfers out"
                onOpen={openDrill}
              />
            </div>
            <StatList
              testId="stat-owned"
              title="Most owned"
              hint="EO = effective ownership: captains count twice, bench zero."
              lines={agg.owned.map((e) => playerLine(e, pct(e), `${e.name} — owned by ${e.value}`))}
              onOpen={openDrill}
            />
            <StatList
              testId="stat-top-scorers"
              title="Top scorers owned"
              lines={agg.topScorers.map((e) => playerLine(e, `${e.value} pts`, `${e.name} — ${e.value} pts, owned by ${e.managers.length}`))}
              onOpen={openDrill}
            />
          </>
        ) : null}

        {/* Leaders: teams from the cards beside this, managers from the stats payload. */}
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
          empty={deadlinePassed ? "No scores yet" : "Scores appear once the gameweek starts"}
          onOpen={openDrill}
        />
        {agg && (
          <StatList
            testId="stat-top-managers"
            title="GW leaders — managers"
            hint="FPL points net of hits, before the JPL captain doubling."
            lines={agg.topManagers.map((m) => ({
              key: m.fplId,
              label: m.name,
              sub: m.teamName,
              value: String(m.net),
              managers: [m],
              title: `${m.name} — ${m.net}`,
            }))}
            onOpen={openDrill}
          />
        )}
        {scopedTeams.length > 0 && (
          <StatList
            title="Biggest winning margins"
            lines={[...scopedTeams]
              .filter((t) => t.score > t.opponentScore)
              .sort((a, b) => (b.score - b.opponentScore) - (a.score - a.opponentScore))
              .slice(0, 3)
              .map((t) => ({
                key: t.fixtureId,
                label: t.name,
                sub: `${t.score} – ${t.opponentScore}`,
                value: `+${t.score - t.opponentScore}`,
                managers: [],
                title: t.name,
              }))}
            empty="No wins yet"
            onOpen={openDrill}
          />
        )}
        {bonusLines.length > 0 && (
          <StatList testId="stat-bonus-race" title="Bonus race" hint="75+ margin and the biggest in the group." lines={bonusLines} onOpen={openDrill} />
        )}

        {/* Chips & hits */}
        {(tvtChipLines.length > 0 || (agg && (agg.fplChips.length > 0 || agg.hits.takers.length > 0))) && (
          <section data-testid="stat-chips-hits" className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2">
            <h3 className="text-xs font-semibold text-white">Chips &amp; hits</h3>
            {tvtChipLines.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">TVT chips</div>
                <ul className="mt-0.5 space-y-0.5">
                  {tvtChipLines.map((l) => (
                    <li key={l.key} className="flex items-center justify-between text-xs">
                      <span className="truncate text-white">{l.label}</span>
                      <span className="shrink-0 text-[10px] text-gray-400">{l.sub}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {agg && agg.fplChips.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">FPL chips</div>
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
              </div>
            )}
            {agg && agg.hits.takers.length > 0 && (
              <button
                type="button"
                onClick={() => openDrill({ title: `Transfer hits — ${agg.hits.total} points`, managers: agg.hits.takers })}
                className="flex w-full items-center justify-between rounded px-1 py-0.5 text-left text-xs hover:bg-white/10"
              >
                <span className="text-gray-300">
                  Hits: <span className="font-semibold text-rose-300">−{agg.hits.total}</span> from {agg.hits.takers.length} managers
                </span>
                <span className="truncate pl-2 text-[10px] text-gray-400">
                  Biggest: {agg.hits.takers[0].name} −{agg.hits.takers[0].hits}
                </span>
              </button>
            )}
          </section>
        )}
      </div>

      <Sheet open={drill !== null} onClose={() => setDrill(null)} title={drill?.title ?? ""} size="md">
        {drill && <ManagerList managers={drill.managers} />}
      </Sheet>
    </aside>
  );
}

function transferHint(excluded: StatManagerRef[]): string {
  if (excluded.length === 0) return "Wildcard and Free Hit moves excluded.";
  return `Wildcard and Free Hit moves excluded (${excluded.length} manager${excluded.length === 1 ? "" : "s"}).`;
}
