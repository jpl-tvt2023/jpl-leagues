"use client";

import type { MatchCenterSide } from "@/lib/match-center/load";
import type { SheetComparison, SheetRow } from "@/lib/match-center/team-sheet";
import { PlayerRow, PlayerRowHeader, type RowComparison } from "./PlayerRow";

/**
 * One JPL team's merged squad as a dense table: Playing XI then Bench, each sorted by points
 * (the order comes from buildTeamSheet). Managers and totals live in the Scoreboard above, so
 * this is just the players.
 *
 * `perspective` says which side of `comparison` this table is, so each row can highlight how the
 * player stands against the OTHER team.
 */
export function TeamTable({
  side,
  perspective,
  comparison,
  settled,
  accentClass,
  className = "",
}: {
  side: MatchCenterSide;
  perspective: "a" | "b";
  comparison: SheetComparison | null;
  settled: boolean;
  accentClass: string;
  className?: string;
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
      aria-label={`${side.teamName} squad`}
      className={`@container min-w-0 overflow-hidden rounded-2xl border bg-white/5 backdrop-blur ${accentClass} ${className}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-white/10 bg-black/20 px-3 py-2">
        <h2 className="truncate text-sm font-bold text-white">{side.teamName}</h2>
        <span className="shrink-0 text-lg font-bold text-white">{side.displayTotal ?? "–"}</span>
      </header>

      {side.isGhost ? (
        <p className="p-4 text-center text-xs text-purple-300">
          Ghost team — scores the group average, so there is no squad to show.
        </p>
      ) : !sheet ? (
        <p className="p-4 text-center text-xs text-gray-400">Line-up unavailable.</p>
      ) : (
        <>
          <PlayerRowHeader />
          <GroupLabel>Playing XI · {sheet.rows.length}</GroupLabel>
          {sheet.rows.map((r) => (
            <PlayerRow key={r.element} row={r} managerNames={managerNames} comparison={cmpFor(r)} settled={settled} />
          ))}
          {sheet.bench.length > 0 && (
            <>
              <GroupLabel>Bench · ×0</GroupLabel>
              <div className="opacity-80">
                {sheet.bench.map((r) => (
                  <PlayerRow key={r.element} row={r} managerNames={managerNames} comparison={cmpFor(r)} settled={settled} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-y border-white/10 bg-black/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
      {children}
    </div>
  );
}
