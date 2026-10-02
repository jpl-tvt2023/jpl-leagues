"use client";

import { ChipPill } from "@/components/ChipPill";
import { FplEntryLink } from "@/components/FplEntryLink";
import { GwNavigator } from "@/components/GwNavigator";
import { HelpTip } from "@/components/HelpTip";
import { LiveFreshness } from "@/components/LiveFreshness";
import type { MatchCenterPayload, MatchCenterSide, MatchCenterTeamOption } from "@/lib/match-center/load";
import { BonusPill } from "../fixtures/BonusPill";
import { bonusPointsFor } from "../fixtures/shared";
import { formatCountdown, rawChip } from "./labels";

export type MatchStatus = "upcoming" | "live" | "provisional" | "final";

/**
 * Where this comparison stands. "provisional" = FPL has settled the gameweek but the JPL scores
 * have not been processed yet.
 */
export function matchStatus(data: MatchCenterPayload): MatchStatus {
  if (!data.gameweek.started) return "upcoming";
  const processed = data.a.storedScore != null && data.b.storedScore != null;
  if (processed) return "final";
  return data.gameweek.settled ? "provisional" : "live";
}

export interface CompareChoice {
  a: string;
  b: string;
  gw: number;
}

/**
 * Everything above the two squads, in one card: the two team pickers ARE the team names, the
 * score sits between them, then the gameweek switcher, both teams' managers, and one line of
 * context (players left, the differential swing, notes). It replaces what used to be four
 * stacked cards — picker, header, differentials, and a managers block per team.
 */
export function Scoreboard({
  data,
  status,
  onChange,
  disabled,
  isRefreshing,
  now,
  accent = "default",
}: {
  data: MatchCenterPayload;
  status: MatchStatus;
  onChange: (next: CompareChoice) => void;
  disabled?: boolean;
  isRefreshing: boolean;
  now: number;
  accent?: "default" | "continental";
}) {
  const { a, b, fixture, comparison } = data;
  const gw = data.gameweek.number;

  // Bonus belongs to a real fixture; orient its home/away flags onto this page's a/b.
  const aIsHome = fixture ? fixture.homeTeamId === a.teamId : true;
  const bonusA = fixture?.result ? bonusPointsFor(fixture.result, aIsHome ? "home" : "away") : 0;
  const bonusB = fixture?.result ? bonusPointsFor(fixture.result, aIsHome ? "away" : "home") : 0;
  const hasBonus = bonusA > 0 || bonusB > 0;

  const sa = a.displayTotal;
  const sb = b.displayTotal;
  const margin = sa != null && sb != null ? Math.abs(sa - sb) : 0;
  const swingA = comparison?.aEdges.reduce((s, e) => s + e.swing, 0) ?? 0;
  const swingB = comparison?.bEdges.reduce((s, e) => s + e.swing, 0) ?? 0;

  const scoreClass = (mine: number | null, theirs: number | null) =>
    status !== "final" || mine == null || theirs == null
      ? "text-white"
      : mine > theirs ? "text-green-400" : mine < theirs ? "text-gray-400" : "text-white";

  return (
    <header
      data-testid="mc-header"
      className={`rounded-2xl border p-3 sm:p-4 backdrop-blur ${
        hasBonus
          ? "border-amber-400/50 bg-amber-500/[0.06] shadow-[0_0_28px_-6px_rgba(251,191,36,0.55)]"
          : "border-white/10 bg-white/5"
      }`}
    >
      {/* Teams and score */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-6">
        <SideTitle
          side={a}
          label="First team"
          teams={data.teams}
          exclude={b.teamId}
          disabled={disabled}
          onSelect={(id) => onChange({ a: id, b: b.teamId, gw })}
          bonus={bonusA}
          margin={margin}
          group={fixture?.group ?? null}
          align="left"
        />
        <div className="flex flex-col items-center gap-1">
          <StatusPill status={status} deadline={data.gameweek.deadline} now={now} />
          {status === "upcoming" ? (
            <span className="text-sm font-medium text-gray-500">VS</span>
          ) : (
            <div className="flex items-center gap-2 sm:gap-3">
              <span data-testid="mc-score-a" className={`text-3xl sm:text-4xl font-bold ${scoreClass(sa, sb)}`}>{sa ?? "–"}</span>
              <span className="text-gray-500">-</span>
              <span data-testid="mc-score-b" className={`text-3xl sm:text-4xl font-bold ${scoreClass(sb, sa)}`}>{sb ?? "–"}</span>
            </div>
          )}
        </div>
        <SideTitle
          side={b}
          label="Second team"
          teams={data.teams}
          exclude={a.teamId}
          disabled={disabled}
          onSelect={(id) => onChange({ a: a.teamId, b: id, gw })}
          bonus={bonusB}
          margin={margin}
          group={fixture?.group ?? null}
          align="right"
        />
      </div>

      {/* Gameweek + swap */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <GwNavigator
          gws={data.gameweeks}
          value={gw}
          onChange={(next) => onChange({ a: a.teamId, b: b.teamId, gw: next })}
          accent={accent}
          disabled={disabled}
          selectLabel="Match Center gameweek"
        />
        <button
          type="button"
          onClick={() => onChange({ a: b.teamId, b: a.teamId, gw })}
          disabled={disabled}
          aria-label="Swap teams"
          title="Swap teams"
          className="h-9 rounded-lg bg-white/10 px-3 text-sm text-gray-300 hover:bg-white/20 disabled:opacity-40 transition"
        >
          ⇄
        </button>
        {status === "live" && <LiveFreshness updatedAt={data.generatedAt} isRefreshing={isRefreshing} />}
      </div>

      {/* Managers: how each one's FPL score becomes their share of the team score. */}
      {status !== "upcoming" && (a.sheet || b.sheet || a.isGhost || b.isGhost) && (
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/10 pt-3">
          <Managers side={a} gw={gw} settled={data.gameweek.settled} align="left" />
          <Managers side={b} gw={gw} settled={data.gameweek.settled} align="right" />
        </div>
      )}

      {/* Context line */}
      {status !== "upcoming" && (
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-[1fr_auto_1fr] items-center gap-x-3 gap-y-1 text-[11px]">
          <LeftToPlay side={a} show={status === "live"} align="left" />
          {comparison && (
            <HelpTip
              className="order-last col-span-2 sm:order-none sm:col-span-1 justify-self-center"
              tip="Points each team is gaining from players it counts more times than the other team — its differentials. Shared players at the same multiplier cancel out and are left out."
            >
              <span data-testid="mc-swing" className="text-gray-300">
                Differential swing: <span className="font-semibold text-sky-300">{a.teamName} +{swingA}</span>
                {" · "}
                <span className="font-semibold text-rose-300">{b.teamName} +{swingB}</span>
              </span>
            </HelpTip>
          )}
          <LeftToPlay side={b} show={status === "live"} align="right" />
        </div>
      )}

      {!fixture && (
        <p className="mt-2 text-center text-[11px] text-gray-400">
          Comparison only — these teams did not play each other in GW{gw}. Each score is from the
          team&apos;s own fixture.
        </p>
      )}
    </header>
  );
}

function StatusPill({ status, deadline, now }: { status: MatchStatus; deadline: string; now: number }) {
  if (status === "upcoming") {
    return (
      <span className="rounded-full bg-yellow-500/20 px-3 py-0.5 text-[11px] font-medium text-yellow-300 whitespace-nowrap">
        Deadline in {formatCountdown(Date.parse(deadline) - now)}
      </span>
    );
  }
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/20 px-3 py-0.5 text-[11px] font-medium text-green-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" /> LIVE
      </span>
    );
  }
  if (status === "provisional") {
    return (
      <span className="rounded-full bg-sky-500/20 px-3 py-0.5 text-[11px] font-medium text-sky-300" title="FPL has settled the gameweek; JPL scores are not processed yet">
        Provisional
      </span>
    );
  }
  return <span className="rounded-full bg-green-500/20 px-3 py-0.5 text-[11px] font-medium text-green-400">Final</span>;
}

/**
 * The team picker, styled as the team's name. A native select so it works with a keyboard, a
 * screen reader, and a phone's own picker.
 */
function SideTitle({
  side,
  label,
  teams,
  exclude,
  disabled,
  onSelect,
  bonus,
  margin,
  group,
  align,
}: {
  side: MatchCenterSide;
  label: string;
  teams: MatchCenterTeamOption[];
  exclude: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  bonus: number;
  margin: number;
  group: string | null;
  align: "left" | "right";
}) {
  const visible = teams.filter((t) => t.id !== exclude && (!t.isGhost || t.id === side.teamId));
  const groups = [...new Set(visible.map((t) => t.group))];
  const hasGroups = groups.some((g) => g != null);
  const option = (t: MatchCenterTeamOption) => (
    <option key={t.id} value={t.id} className="bg-slate-900 text-base font-normal">
      {t.name}{t.isGhost ? " (ghost)" : ""}
    </option>
  );
  const right = align === "right";

  return (
    <div className={`min-w-0 ${right ? "text-right" : ""}`}>
      <div className={`flex items-center gap-1 ${right ? "justify-end" : ""}`}>
        {right && <span aria-hidden className="text-xs text-gray-500">▾</span>}
        <select
          aria-label={label}
          value={side.teamId}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value)}
          className={`min-w-0 max-w-full cursor-pointer appearance-none truncate rounded-md bg-transparent px-1 py-0.5 text-base sm:text-xl font-bold text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-sky-400/50 ${
            right ? "text-right [text-align-last:right]" : ""
          }`}
        >
          {hasGroups
            ? groups.map((g) => (
                <optgroup key={g ?? "none"} label={g ? `Group ${g}` : "Other"} className="bg-slate-900">
                  {visible.filter((t) => t.group === g).map(option)}
                </optgroup>
              ))
            : visible.map(option)}
        </select>
        {!right && <span aria-hidden className="text-xs text-gray-500">▾</span>}
      </div>
      <div className={`mt-0.5 flex flex-wrap items-center gap-1 px-1 ${right ? "justify-end" : ""}`}>
        {side.group && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-gray-300">Group {side.group}</span>}
        {side.tvtChip && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              side.tvtChip.isWasted ? "bg-white/5 text-gray-500 line-through" : "bg-yellow-500/20 text-yellow-300"
            }`}
            title={side.tvtChip.isWasted ? `${side.tvtChip.name} — wasted${side.tvtChip.wastedReason ? `: ${side.tvtChip.wastedReason}` : ""}` : side.tvtChip.name}
          >
            {side.tvtChip.code}
          </span>
        )}
        {bonus > 0 && <BonusPill points={bonus} margin={margin} groupName={group} align={align} />}
      </div>
    </div>
  );
}

function Managers({
  side,
  gw,
  settled,
  align,
}: {
  side: MatchCenterSide;
  gw: number;
  settled: boolean;
  align: "left" | "right";
}) {
  const right = align === "right";
  if (side.isGhost) {
    return <p className={`text-[11px] text-purple-300 ${right ? "text-right" : ""}`}>Ghost team — group average</p>;
  }
  const sheet = side.sheet;
  if (!sheet) return <div />;

  const notes: string[] = [];
  const projected = sheet.managers.reduce((s, m) => s + m.projectedGain, 0);
  const projectedCount = sheet.managers.reduce((s, m) => s + m.projectedSubs.filter((x) => x.in != null).length, 0);
  if (projectedCount > 0) notes.push(`${projectedCount} auto-sub${projectedCount === 1 ? "" : "s"} likely${projected > 0 ? ` (+${projected})` : ""}`);
  const fplAdj = sheet.managers.reduce((s, m) => s + m.fplAdjustment, 0);
  if (fplAdj !== 0) notes.push(`FPL adj ${fplAdj > 0 ? "+" : ""}${fplAdj}`);
  if (side.adjustment !== 0) notes.push(`Processed ${side.adjustment > 0 ? "+" : ""}${side.adjustment} (e.g. hit carry-over)`);

  return (
    <div className={`min-w-0 space-y-0.5 ${right ? "text-right" : ""}`}>
      {sheet.managers.map((m) => {
        const chip = rawChip(m.chip);
        return (
          <div key={m.fplId} className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs ${right ? "justify-end" : ""}`}>
            <FplEntryLink fplId={m.fplId} gw={gw} className="truncate text-blue-400 hover:text-blue-300 underline">
              {m.name}
            </FplEntryLink>
            {m.isJplCaptain && (
              <span
                className={`rounded px-1 py-0.5 text-[9px] font-bold ${m.isTempCaptain ? "bg-amber-500/20 text-amber-400" : "bg-yellow-500/20 text-yellow-400"}`}
                title={m.isTempCaptain ? "Auto-assigned: lowest scorer" : "JPL captain — score doubled"}
              >
                {m.isTempCaptain ? "★C*" : "★C"}
              </span>
            )}
            {chip && <ChipPill code={chip.code} label={chip.label} state={settled ? "past" : "current"} interactive />}
            <span className="text-gray-300 whitespace-nowrap">
              {m.unavailable ? (
                <span className="text-gray-500">FPL unavailable</span>
              ) : (
                <>
                  {m.gross}
                  {m.hits > 0 && <span className="text-rose-300"> −{m.hits}</span>}
                  {m.isJplCaptain && <span className="text-yellow-400"> ×2</span>}
                  <span className="text-gray-500"> = </span>
                  <span className="font-semibold text-white">{m.final}</span>
                </>
              )}
            </span>
          </div>
        );
      })}
      {notes.length > 0 && <p className="text-[10px] text-amber-300/80">{notes.join(" · ")}</p>}
    </div>
  );
}

function LeftToPlay({ side, show, align }: { side: MatchCenterSide; show: boolean; align: "left" | "right" }) {
  const sheet = side.sheet;
  const cls = align === "right" ? "text-right justify-self-end" : "";
  if (!show || !sheet) return <span className={cls} />;
  return (
    <span
      className={`${cls} ${sheet.playersLeft > 0 ? "text-emerald-400" : "text-gray-500"}`}
      title="Players with a multiplier still to play, and the total multiplier riding on them"
    >
      ⏳ {sheet.playersLeft} left{sheet.playersLeft > 0 ? ` · ×${sheet.remainingMultiplier} to come` : ""}
    </span>
  );
}
