"use client";

import { HelpTip } from "@/components/HelpTip";

/**
 * "★ BONUS +1" beside the team that took a gameweek's group Bonus Point.
 *
 * The value comes from the stored result rather than being assumed: Double Pointer doubles the
 * bonus to 2 (gameweek-awards.ts), which is exactly what the dashboard's hard-coded "+1" got wrong.
 */
export function BonusPill({
  points,
  margin,
  groupName,
  align = "left",
  className = "",
}: {
  /** 1, or 2 with Double Pointer. */
  points: number;
  /** Winning margin, for the tooltip. */
  margin: number;
  groupName?: string | null;
  align?: "left" | "right";
  className?: string;
}) {
  const where = groupName ? `Group ${groupName}` : "the group";
  return (
    <span className={`inline-flex ${align === "right" ? "justify-end" : ""} ${className}`}>
      <HelpTip
        tip={
          <span>
            Won by <strong>{margin}</strong>: 75+ and the biggest winning margin in {where} this
            gameweek, so this team took the Bonus Point.
            {points === 2 ? " Double Pointer doubled it to +2." : " Worth +1 league point."}
          </span>
        }
      >
        <span
          data-testid="bonus-pill"
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/40"
        >
          ★ BONUS +{points}
        </span>
      </HelpTip>
    </span>
  );
}
