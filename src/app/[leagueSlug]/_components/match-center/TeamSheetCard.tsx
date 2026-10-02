"use client";

import { ChipPill } from "@/components/ChipPill";
import { FplEntryLink } from "@/components/FplEntryLink";
import { POSITION_ORDER, positionLabel } from "@/lib/fpl/positions";
import type { MatchCenterSide } from "@/lib/match-center/load";
import type { SheetComparison, SheetRow } from "@/lib/match-center/team-sheet";
import { PlayerRow, type RowComparison } from "./PlayerRow";
import { rawChip } from "./labels";

const POSITION_HEADINGS: Record<number, string> = {
  1: "Goalkeepers",
  2: "Defenders",
  3: "Midfielders",
  4: "Forwards",
};

/**
 * One JPL team's gameweek: the two managers' scores up top, then a single merged squad.
 *
 * `perspective` says which side of `comparison` this card is, so each row can say how the
 * player sits against the OTHER team (shared and cancelling, an edge, or a pure differential).
 */
export function TeamSheetCard({
  side,
  perspective,
  comparison,
  gwNumber,
  settled,
  accentClass,
}: {
  side: MatchCenterSide;
  perspective: "a" | "b";
  comparison: SheetComparison | null;
  gwNumber: number;
  settled: boolean;
  accentClass: string;
}) {
  const sheet = side.sheet;
  const managerNames = side.roster.map((p) => p.name);

  const cmpFor = (row: SheetRow): RowComparison | undefined => {
    const c = comparison?.byElement[row.element];
    if (!c) return undefined;
    return perspective === "a"
      ? { mine: c.a, theirs: c.b, common: c.common }
      : { mine: c.b, theirs: c.a, common: c.common };
  };

  return (
    <section
      data-testid={`mc-side-${perspective}`}
      className={`rounded-2xl border bg-white/5 p-3 sm:p-4 backdrop-blur ${accentClass}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base sm:text-lg font-bold text-white">{side.teamName}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {side.group && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-gray-300">Group {side.group}</span>
            )}
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
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div data-testid={`mc-total-${perspective}`} className="text-2xl sm:text-3xl font-bold text-white">
            {side.displayTotal ?? "–"}
          </div>
          {sheet && sheet.playersLeft > 0 && !settled && (
            <div className="text-[10px] text-emerald-400" title="Players with a multiplier still to play, and the total multiplier riding on them">
              ⏳ {sheet.playersLeft} left · ×{sheet.remainingMultiplier} to come
            </div>
          )}
        </div>
      </header>

      {side.isGhost ? (
        <div className="mt-4 rounded-lg bg-purple-500/10 p-3 text-center text-xs text-purple-300">
          Ghost team — scores the group average, so there is no squad to show.
        </div>
      ) : !sheet ? null : (
        <>
          {/* The two managers: how each one's FPL score becomes their share of the team score. */}
          <div className="mt-3 space-y-1.5 rounded-xl bg-black/20 p-2.5">
            {sheet.managers.map((m) => {
              const chip = rawChip(m.chip);
              return (
                <div key={m.fplId} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                      <FplEntryLink
                        fplId={m.fplId}
                        gw={gwNumber}
                        className="truncate text-blue-400 hover:text-blue-300 underline"
                      >
                        {m.name}
                      </FplEntryLink>
                      {m.isJplCaptain && (
                        <span
                          className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold ${
                            m.isTempCaptain ? "bg-amber-500/20 text-amber-400" : "bg-yellow-500/20 text-yellow-400"
                          }`}
                          title={m.isTempCaptain ? "Auto-assigned: lowest scorer" : "JPL captain — score doubled"}
                        >
                          {m.isTempCaptain ? "C*" : "C"}
                        </span>
                      )}
                      {chip && <ChipPill code={chip.code} label={chip.label} state={settled ? "past" : "current"} interactive />}
                    </div>
                    <div className="shrink-0 text-right text-gray-300">
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
                    </div>
                  </div>
                  {m.fplAdjustment !== 0 && (
                    <div className="text-[10px] text-gray-500">
                      Includes {m.fplAdjustment > 0 ? "+" : ""}{m.fplAdjustment} FPL applied after the rows below (bonus or substitutions).
                    </div>
                  )}
                  {m.projectedSubs.length > 0 && (
                    <div className="text-[10px] text-amber-300/80">
                      Auto-sub projection: {m.projectedSubs.filter((s) => s.in != null).length} likely
                      {m.projectedGain > 0 ? `, +${m.projectedGain} if they happen` : ""}. Not in the live score yet.
                    </div>
                  )}
                </div>
              );
            })}
            {side.adjustment !== 0 && (
              <div className="pt-1 text-[10px] text-gray-400 border-t border-white/10">
                Processed score {side.adjustment > 0 ? "+" : ""}{side.adjustment} vs the managers above — e.g. a carry-forward hit penalty.
              </div>
            )}
          </div>

          {POSITION_ORDER.map((pos) => {
            const rows = sheet.rows.filter((r) => r.position === pos);
            if (rows.length === 0) return null;
            return (
              <div key={pos} className="mt-3">
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  {POSITION_HEADINGS[pos] ?? positionLabel(pos)}
                </div>
                {rows.map((r) => (
                  <PlayerRow key={r.element} row={r} managerNames={managerNames} comparison={cmpFor(r)} settled={settled} />
                ))}
              </div>
            );
          })}

          {sheet.bench.length > 0 && (
            <div className="mt-3 rounded-xl bg-black/20 px-2.5 py-1.5 opacity-80">
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Bench (×0)</div>
              {sheet.bench.map((r) => (
                <PlayerRow key={r.element} row={r} managerNames={managerNames} comparison={cmpFor(r)} settled={settled} />
              ))}
            </div>
          )}

          <p className="mt-3 text-[10px] text-gray-500">
            ★ = JPL captain (all their players count double). ×N is how many times a player&apos;s points
            count in this team&apos;s score. Tap a name for the breakdown.
          </p>
        </>
      )}
    </section>
  );
}
