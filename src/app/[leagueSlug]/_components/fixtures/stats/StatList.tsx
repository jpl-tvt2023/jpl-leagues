"use client";

import type { StatManagerRef } from "@/lib/fixtures-stats/aggregate";

/** One ranked line in a stats card. `managers` is what tapping it reveals. */
export interface StatLine {
  key: string;
  label: string;
  sub?: string;
  value: string;
  extra?: string;
  managers: StatManagerRef[];
  /** Drill-down title, e.g. "Haaland — captained by 41". */
  title: string;
}

export interface DrillDown {
  title: string;
  managers: StatManagerRef[];
}

/**
 * A titled, ranked list whose every line opens the managers behind it.
 * Lines are buttons, so they work by tap and keyboard alike.
 */
export function StatList({
  title,
  hint,
  lines,
  empty = "Nothing yet",
  onOpen,
  testId,
}: {
  title: string;
  hint?: string;
  lines: StatLine[];
  empty?: string;
  onOpen: (d: DrillDown) => void;
  testId?: string;
}) {
  return (
    // @container: beside the fixtures each card is only ~15% of the screen, so a narrow card moves
    // the secondary figure (e.g. "EO 186%") under the name rather than squeezing the name out.
    <section data-testid={testId} className="@container h-full rounded-xl border border-white/10 bg-white/5 p-3">
      <h3 className="text-xs font-semibold text-white">{title}</h3>
      {hint && <p className="text-[10px] text-gray-500">{hint}</p>}
      {lines.length === 0 ? (
        <p className="mt-1 text-[11px] text-gray-500">{empty}</p>
      ) : (
        <ol className="mt-1.5 space-y-0.5">
          {lines.map((l, i) => (
            <li key={l.key}>
              <button
                type="button"
                onClick={() => onOpen({ title: l.title, managers: l.managers })}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10 transition"
              >
                <span className="w-3 shrink-0 text-[10px] text-gray-500">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-white">{l.label}</span>
                  {(l.sub || l.extra) && (
                    <span className="block truncate text-[10px] text-gray-500">
                      {l.sub}
                      {l.extra && (
                        <span className="@[18rem]:hidden text-gray-400">{l.sub ? " · " : ""}{l.extra}</span>
                      )}
                    </span>
                  )}
                </span>
                {l.extra && <span className="hidden @[18rem]:inline shrink-0 text-[10px] text-gray-400">{l.extra}</span>}
                <span className="shrink-0 text-xs font-semibold text-sky-300">{l.value}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The list a drill-down shows: managers grouped by their JPL team. */
export function ManagerList({ managers }: { managers: StatManagerRef[] }) {
  if (managers.length === 0) return <p className="text-sm text-gray-400">No managers.</p>;
  const byTeam = new Map<string, StatManagerRef[]>();
  for (const m of managers) {
    const list = byTeam.get(m.teamName) ?? [];
    list.push(m);
    byTeam.set(m.teamName, list);
  }
  return (
    <ul className="divide-y divide-white/10">
      {[...byTeam.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([team, list]) => (
          <li key={team} className="py-2">
            <div className="text-xs font-semibold text-white">{team}</div>
            {list.map((m) => (
              <div key={m.fplId} className="flex items-center justify-between text-xs text-gray-300">
                <span className="truncate">{m.name}</span>
                {m.note && <span className="shrink-0 text-[10px] text-gray-400">{m.note}</span>}
              </div>
            ))}
          </li>
        ))}
    </ul>
  );
}
