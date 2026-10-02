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
  return `${o.jplCaptain ? "★ " : ""}${short} ${role}`;
}

function ownerExplanation(o: SheetOwner): string {
  const role = o.armbandInherited ? "Vice-captain (took the armband)" : ROLE_WORDS[o.role];
  const fpl = `${role} ×${o.fplMultiplier}`;
  return o.jplCaptain ? `${fpl} × 2 JPL captain = ×${o.effective}` : `${fpl} = ×${o.effective}`;
}

function MatchLine({ row }: { row: SheetRow }) {
  if (row.matches.length === 0) return <span className="text-gray-500">No fixture (blank)</span>;
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
        {row.owners.map((o) => (
          <div key={o.fplId} className="text-gray-300">
            <span className="text-white">{o.managerName}:</span> {ownerExplanation(o)}
          </div>
        ))}
        <div className="text-white font-semibold">
          {row.points} pts × {row.multiplier} = {row.contribution}
        </div>
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
      className="flex items-start gap-2 py-1.5 border-b border-white/5 last:border-b-0"
    >
      <span
        className={`mt-0.5 w-9 shrink-0 rounded border px-1 py-0.5 text-center text-[9px] font-bold ${POSITION_COLORS[row.position] ?? ""}`}
      >
        {pos}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <HelpTip tip={breakdown} width={300} className="min-w-0">
            <span className="truncate text-sm font-medium text-white underline decoration-dotted decoration-white/30 underline-offset-2">
              {row.name}
            </span>
          </HelpTip>
          <span className="shrink-0 text-[10px] text-gray-500">{row.club}</span>
          {comparison && <DiffBadge cmp={comparison} />}
        </div>
        <div className="text-[10px] text-gray-400 truncate">
          <MatchLine row={row} />
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {row.owners.map((o) => (
            <span
              key={o.fplId}
              title={`${o.managerName}: ${ownerExplanation(o)}`}
              className={`rounded px-1 py-px text-[9px] font-semibold ${
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
      </div>

      <div className="shrink-0 text-right leading-tight">
        <div className={`text-sm font-bold ${played || row.points !== 0 ? "text-white" : "text-gray-500"}`}>
          {played || !yetToPlay ? row.points : "–"}
        </div>
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px]">
          <span className={`rounded px-1 font-bold ${multiplierClass(row.multiplier)}`}>×{row.multiplier}</span>
          <span className="text-gray-300">{row.contribution}</span>
        </div>
      </div>
    </div>
  );
}

/** How this player sits against the other team: shared and cancelling, an edge, or a differential. */
function DiffBadge({ cmp }: { cmp: RowComparison }) {
  if (cmp.common) {
    if (cmp.mine === cmp.theirs) {
      return (
        <span className="shrink-0 rounded px-1 text-[9px] font-semibold bg-white/5 text-gray-400" title={`Both teams have him at ×${cmp.mine}: his points cancel out.`}>
          = both
        </span>
      );
    }
    const net = cmp.mine - cmp.theirs;
    return (
      <span
        className={`shrink-0 rounded px-1 text-[9px] font-semibold ${net > 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}
        title={`Both teams own him: ×${cmp.mine} here vs ×${cmp.theirs} for them, a net ${net > 0 ? "+" : ""}${net}× in this head-to-head.`}
      >
        {net > 0 ? `+${net}×` : `${net}×`}
      </span>
    );
  }
  if (cmp.mine === 0) return null;
  return (
    <span className="shrink-0 rounded px-1 text-[9px] font-semibold bg-violet-500/20 text-violet-300" title="Only this team owns him — every point he scores is a swing.">
      DIFF
    </span>
  );
}
