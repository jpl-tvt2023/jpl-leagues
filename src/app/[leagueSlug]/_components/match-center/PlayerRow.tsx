"use client";

import { HelpTip } from "@/components/HelpTip";
import { POSITION_COLORS, positionLabel } from "@/lib/fpl/positions";
import type { SheetOwner, SheetRow } from "@/lib/match-center/team-sheet";
import { breakdownLabel, formatKickoff, shortManagerName } from "./labels";

/** This row's player as seen from the other team's sheet. */
export interface RowComparison {
  mine: number;
  theirs: number;
  common: boolean;
}

/** How a row stands in the head-to-head; drives the inline highlight. */
type Standing = "diff" | "edge" | "behind" | "cancels" | "none";

function standingOf(row: SheetRow, cmp: RowComparison | undefined): Standing {
  if (!cmp) return "none";
  // A ×0 bench player only matters if the OTHER team counts him.
  if (row.multiplier === 0 && (!cmp.common || cmp.theirs === 0)) return "none";
  if (!cmp.common) return cmp.mine > 0 ? "diff" : "none";
  if (cmp.mine === cmp.theirs) return "cancels";
  return cmp.mine > cmp.theirs ? "edge" : "behind";
}

const ROW_CLASSES: Record<Standing, string> = {
  diff: "border-l-violet-400 bg-violet-500/10",
  edge: "border-l-emerald-400 bg-emerald-500/[0.07]",
  behind: "border-l-rose-400/60",
  cancels: "border-l-transparent opacity-50",
  none: "border-l-transparent",
};

/**
 * Grid columns, in one place so the header row and every player row line up.
 *
 * Container queries, not viewport breakpoints: the table is half the screen on a desktop and the
 * whole screen on a phone, so what decides "one line or two" is the table's own width. Below
 * `@xl` (36rem) the owners and the match drop to a second line under the name.
 */
export const ROW_GRID =
  "grid grid-cols-[2.1rem_minmax(0,1fr)_auto] gap-x-2 " +
  "@xl:grid-cols-[2.1rem_minmax(0,1.5fr)_minmax(0,1.15fr)_minmax(0,1fr)_2rem_2.4rem_2.6rem] @xl:items-center";

const ROLE_WORDS: Record<SheetOwner["role"], string> = {
  C: "Captain",
  TC: "Triple Captain",
  VC: "Vice-captain",
  XI: "Starting",
  BENCH: "Bench",
};

function multiplierClass(m: number): string {
  if (m === 0) return "bg-white/5 text-gray-500";
  if (m === 1) return "bg-white/10 text-gray-200";
  if (m === 2) return "bg-sky-500/20 text-sky-300";
  if (m <= 4) return "bg-amber-500/20 text-amber-300";
  return "bg-fuchsia-500/25 text-fuchsia-200";
}

function ownerTagText(o: SheetOwner, short: string): string {
  const role =
    o.armbandInherited ? "VC→C"
    : o.role === "BENCH" ? `B${o.benchOrder ?? ""}`
    : o.role === "XI" ? "✓"
    : o.role;
  return `${o.jplCaptain ? "★" : ""}${short} ${role}`;
}

function ownerExplanation(o: SheetOwner): string {
  const role = o.armbandInherited ? "Vice-captain (took the armband)" : ROLE_WORDS[o.role];
  const fpl = `${role} ×${o.fplMultiplier}`;
  return o.jplCaptain ? `${fpl} × 2 JPL captain = ×${o.effective}` : `${fpl} = ×${o.effective}`;
}

function MatchLine({ row }: { row: SheetRow }) {
  if (row.matches.length === 0) return <span className="text-gray-500">Blank GW</span>;
  return (
    <>
      {row.matches.map((m, i) => (
        <span key={i} className="whitespace-nowrap">
          {i > 0 && <span className="text-gray-600"> · </span>}
          {m.home ? "v" : "@"} {m.opponent}{" "}
          {m.state === "upcoming" ? (
            <span className="text-emerald-400/90">{formatKickoff(m.kickoff)}</span>
          ) : m.state === "live" ? (
            <span className="text-green-400">LIVE{m.score ? ` ${m.score}` : ""}</span>
          ) : (
            <span className="text-gray-500">FT{m.score ? ` ${m.score}` : ""}</span>
          )}
        </span>
      ))}
    </>
  );
}

/** The column titles, shown only when the table is wide enough for one-line rows. */
export function PlayerRowHeader() {
  return (
    <div className={`${ROW_GRID} hidden @xl:grid px-2 py-1 text-[10px] uppercase tracking-wide text-gray-500`}>
      <span />
      <span>Player</span>
      <span>Owned by</span>
      <span>Match</span>
      <span className="text-right">Pts</span>
      <span className="text-center">×</span>
      <span className="text-right">=</span>
    </div>
  );
}

export function PlayerRow({
  row,
  managerNames,
  comparison,
  settled,
}: {
  row: SheetRow;
  managerNames: string[];
  comparison?: RowComparison;
  settled: boolean;
}) {
  const pos = positionLabel(row.position) ?? "";
  const played = row.minutes > 0;
  const yetToPlay = row.leftToPlay > 0;
  const standing = standingOf(row, comparison);

  const breakdown = (
    <div className="text-xs">
      <div className="font-semibold text-white mb-1">
        {row.name} <span className="text-gray-400 font-normal">· {row.clubName || row.club}</span>
      </div>
      {row.breakdown.length > 0 ? (
        <table className="w-full">
          <tbody>
            {row.breakdown.map(([id, value, pts]) => (
              <tr key={id}>
                <td className="pr-2 text-gray-300">{breakdownLabel(id)}</td>
                <td className="pr-2 text-right text-gray-400">{value}</td>
                <td className="text-right font-semibold text-white">{pts > 0 ? `+${pts}` : pts}</td>
              </tr>
            ))}
            <tr className="border-t border-white/10">
              <td className="pr-2 pt-1 text-gray-300" colSpan={2}>Total</td>
              <td className="pt-1 text-right font-bold text-white">{row.points}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <div className="text-gray-400">{yetToPlay ? "Yet to play." : "Did not play."}</div>
      )}
      <div className="mt-2 pt-2 border-t border-white/10 space-y-0.5">
        {row.owners.map((o, i) => (
          <div key={`${o.fplId}-${i}`} className="text-gray-300">
            <span className="text-white">{o.managerName}:</span> {ownerExplanation(o)}
          </div>
        ))}
        <div className="text-white font-semibold">
          {row.points} pts × {row.multiplier} = {row.contribution}
        </div>
        {comparison?.common && (
          <div className="text-gray-400">
            The other team has him at ×{comparison.theirs}
            {comparison.mine === comparison.theirs ? " — his points cancel out." : "."}
          </div>
        )}
        {!settled && played && !row.breakdown.some(([id]) => id === "bonus") && (
          <div className="text-[10px] text-gray-500">Bonus is added once FPL confirms it.</div>
        )}
      </div>
    </div>
  );

  return (
    <div
      data-testid={`mc-row-${row.element}`}
      data-multiplier={row.multiplier}
      data-points={row.points}
      data-section={row.section}
      data-standing={standing}
      className={`${ROW_GRID} border-l-2 px-2 py-1.5 border-b border-b-white/5 last:border-b-0 ${ROW_CLASSES[standing]}`}
    >
      <span
        className={`row-span-2 @xl:row-span-1 self-start @xl:self-center mt-0.5 @xl:mt-0 rounded border px-0.5 py-0.5 text-center text-[9px] font-bold ${POSITION_COLORS[row.position] ?? ""}`}
      >
        {pos}
      </span>

      {/* Name, club, and how this player stands against the other team. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <HelpTip tip={breakdown} width={300} className="min-w-0">
          <span className="truncate text-sm font-medium text-white underline decoration-dotted decoration-white/30 underline-offset-2">
            {row.name}
          </span>
        </HelpTip>
        <span className="shrink-0 text-[10px] text-gray-500">{row.club}</span>
        <StandingBadge standing={standing} cmp={comparison} />
      </div>

      {/* Second line on a narrow table; their own two columns on a wide one. */}
      <div className="col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 @xl:contents">
        <div className="flex min-w-0 flex-wrap gap-1">
          {/* Index in the key: an owner is per pick, and nothing guarantees one per manager. */}
          {row.owners.map((o, i) => (
            <span
              key={`${o.fplId}-${i}`}
              title={`${o.managerName}: ${ownerExplanation(o)}`}
              className={`rounded px-1 py-px text-[9px] font-semibold whitespace-nowrap ${
                o.role === "BENCH" && o.fplMultiplier === 0
                  ? "bg-white/5 text-gray-500"
                  : o.jplCaptain
                  ? "bg-yellow-500/15 text-yellow-300"
                  : "bg-white/10 text-gray-300"
              }`}
            >
              {ownerTagText(o, shortManagerName(o.managerName, managerNames))}
            </span>
          ))}
          {row.owners.some((o) => o.projectedSubOut) && (
            <span className="rounded px-1 py-px text-[9px] font-semibold bg-amber-500/15 text-amber-300" title="Projection: 0 minutes and his matches are over, so FPL will likely substitute him at the end of the gameweek. Not in the live score.">
              ↓ likely sub
            </span>
          )}
          {row.owners.some((o) => o.projectedSubIn) && (
            <span className="rounded px-1 py-px text-[9px] font-semibold bg-emerald-500/15 text-emerald-300" title="Projection: first eligible bench player who has played. Not in the live score until FPL makes the substitution.">
              ↑ likely on
            </span>
          )}
          {row.owners.some((o) => o.autoSubOut) && (
            <span className="rounded px-1 py-px text-[9px] font-semibold bg-white/10 text-gray-400">↓ subbed off</span>
          )}
          {row.owners.some((o) => o.autoSubIn) && (
            <span className="rounded px-1 py-px text-[9px] font-semibold bg-emerald-500/15 text-emerald-300">↑ subbed on</span>
          )}
        </div>
        <div className="min-w-0 truncate text-[10px] text-gray-400">
          <MatchLine row={row} />
        </div>
      </div>

      {/* Points, multiplier, contribution: one cluster on a narrow table, three columns on a wide one. */}
      <div className="col-start-3 row-start-1 row-span-2 flex items-center gap-1.5 self-center @xl:contents">
        <span className={`text-right text-sm font-bold ${played || row.points !== 0 ? "text-white" : "text-gray-500"}`}>
          {played || !yetToPlay ? row.points : "–"}
        </span>
        <span className={`justify-self-center rounded px-1 text-center text-[10px] font-bold ${multiplierClass(row.multiplier)}`}>
          ×{row.multiplier}
        </span>
        <span className="text-right text-xs font-semibold text-gray-200">
          {played || !yetToPlay ? row.contribution : "–"}
        </span>
      </div>
    </div>
  );
}

function StandingBadge({ standing, cmp }: { standing: Standing; cmp?: RowComparison }) {
  if (!cmp) return null;
  if (standing === "diff") {
    return (
      <span className="shrink-0 rounded px-1 text-[9px] font-bold bg-violet-500/25 text-violet-200" title="Only this team owns him — every point he scores is a swing.">
        DIFF
      </span>
    );
  }
  if (standing === "edge" || standing === "behind") {
    const net = cmp.mine - cmp.theirs;
    return (
      <span
        className={`shrink-0 rounded px-1 text-[9px] font-bold ${net > 0 ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}
        title={`Both teams own him: ×${cmp.mine} here vs ×${cmp.theirs} for them, a net ${net > 0 ? "+" : ""}${net}× in this head-to-head.`}
      >
        {net > 0 ? `+${net}×` : `${net}×`}
      </span>
    );
  }
  if (standing === "cancels") {
    return (
      <span className="shrink-0 text-[10px] font-bold text-gray-400" title={`Both teams have him at ×${cmp.mine}: his points cancel out.`}>
        ═
      </span>
    );
  }
  return null;
}
