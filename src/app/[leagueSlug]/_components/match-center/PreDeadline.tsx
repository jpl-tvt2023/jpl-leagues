"use client";

import { FplChipRow } from "@/components/ChipPill";
import { FplEntryLink } from "@/components/FplEntryLink";
import type { MatchCenterSide } from "@/lib/match-center/load";
import { fplEntryLabel } from "@/lib/fpl-links";

/**
 * Before the deadline there is nothing to compare: FPL will not publish picks, and the JPL
 * captain and TVT chip are secret. Show who is playing and what chips they still hold.
 */
export function PreDeadline({
  sides,
  gwNumber,
}: {
  sides: [MatchCenterSide, MatchCenterSide];
  gwNumber: number;
}) {
  // FPL only resolves an entry's gameweek page once that gameweek has started.
  const linkGw = gwNumber > 1 ? gwNumber - 1 : null;
  return (
    <div data-testid="mc-pre-deadline" className="space-y-3">
      <p className="text-center text-xs text-gray-400">
        Line-ups, captains and chips are revealed when the GW{gwNumber} deadline passes.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {sides.map((side) => (
          <section key={side.teamId} className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur">
            <h2 className="text-base font-bold text-white">{side.teamName}</h2>
            {side.group && <div className="text-[10px] text-gray-400">Group {side.group}</div>}
            {side.isGhost ? (
              <div className="mt-3 text-xs text-purple-300">Ghost team — scores the group average.</div>
            ) : (
              <ul className="mt-3 space-y-2">
                {side.roster.map((p) => (
                  <li key={p.fplId} className="text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <FplEntryLink fplId={p.fplId} gw={linkGw} className="truncate text-blue-400 hover:text-blue-300 underline">
                        {p.name}
                      </FplEntryLink>
                      <span className="shrink-0 text-[9px] text-gray-500">{fplEntryLabel(linkGw)} ↗</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-0.5">
                      <FplChipRow status={side.fplChips[p.fplId]} gwNumber={gwNumber} interactive silentWhenUnknown />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
