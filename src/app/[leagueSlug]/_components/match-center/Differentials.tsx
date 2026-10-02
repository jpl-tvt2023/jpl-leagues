"use client";

import type { ElementEdge, SheetComparison } from "@/lib/match-center/team-sheet";

const SHOWN = 5;

/**
 * Where the head-to-head is actually being decided: the players one side counts more times
 * than the other. Shared players with equal multipliers cancel and never appear here.
 */
export function Differentials({
  comparison,
  aName,
  bName,
}: {
  comparison: SheetComparison;
  aName: string;
  bName: string;
}) {
  const totalA = comparison.aEdges.reduce((s, e) => s + e.swing, 0);
  const totalB = comparison.bEdges.reduce((s, e) => s + e.swing, 0);

  return (
    <section data-testid="mc-differentials" className="rounded-2xl border border-white/10 bg-white/5 p-3 sm:p-4 backdrop-blur">
      <h2 className="text-sm font-bold text-white">Key differentials</h2>
      <p className="text-[10px] text-gray-500 mb-2">
        Players one team counts more times than the other. Shared players at the same multiplier cancel out.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <EdgeList title={aName} edges={comparison.aEdges} total={totalA} />
        <EdgeList title={bName} edges={comparison.bEdges} total={totalB} align="right" />
      </div>
    </section>
  );
}

function EdgeList({
  title,
  edges,
  total,
  align = "left",
}: {
  title: string;
  edges: ElementEdge[];
  total: number;
  align?: "left" | "right";
}) {
  return (
    <div className={`min-w-0 ${align === "right" ? "text-right" : ""}`}>
      <div className="truncate text-[11px] font-semibold text-gray-300">
        {title} <span className="text-emerald-300">+{total}</span>
      </div>
      {edges.length === 0 ? (
        <div className="text-[10px] text-gray-500">No edge</div>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {edges.slice(0, SHOWN).map((e) => (
            <li key={e.element} className={`flex items-center gap-1 text-[11px] ${align === "right" ? "justify-end" : ""}`}>
              <span className="truncate text-white">{e.name}</span>
              <span className="shrink-0 rounded bg-white/10 px-1 text-[9px] text-gray-300" title={e.common ? "Owned by both — this is the multiplier difference" : "Only this team owns him"}>
                {e.common ? `+${e.net}×` : `×${e.net}`}
              </span>
              <span className="shrink-0 text-gray-400">{e.swing > 0 ? `+${e.swing}` : e.swing}</span>
            </li>
          ))}
          {edges.length > SHOWN && (
            <li className="text-[10px] text-gray-500">+{edges.length - SHOWN} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
