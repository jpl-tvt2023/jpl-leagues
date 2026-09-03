"use client";

import {
  chipState,
  FPL_CHIP_ORDER,
  FPL_CHIP_LABELS,
  type ChipState,
  type FplChipStatus,
} from "@/lib/fpl-league/chips";
import { HelpTip } from "./HelpTip";

/**
 * One chip badge, coloured by whether it is spent, in play, or still in hand.
 *
 * Shared rather than duplicated: the dashboard's PL Fixture card and the FPL
 * League table both render chip rows, and they previously carried their own
 * near-identical markup with two different colour schemes. A chip meaning one
 * thing on one page and another elsewhere is worse than no colour at all.
 */

const STATE_CLASSES: Record<ChipState, string> = {
  // Spent and no longer affecting anything on screen — recede.
  past: "border-white/10 text-gray-500",
  // In play right now. Yellow because it is the only state that changes how the
  // score next to it should be read.
  current: "border-yellow-400/50 bg-yellow-500/20 text-yellow-300",
  // Still to come.
  available: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
};

const STATE_WORDS: Record<ChipState, string> = {
  past: "played",
  current: "playing now",
  available: "available",
};

export function ChipPill({
  code,
  label,
  state,
  gw,
  className = "",
  interactive = false,
}: {
  /** Short display code shown in the pill, e.g. "BB" or "DP". */
  code: string;
  /** Full name, used in the tooltip. Falls back to the code. */
  label?: string;
  state: ChipState;
  /** Gameweek it was played in; appended to the pill for spent/in-play chips. */
  gw?: number | null;
  className?: string;
  /**
   * Open the tooltip on tap as well as hover, via HelpTip.
   *
   * Off by default, and that default is load-bearing. The plain pill's tooltip is a native
   * `title=`, which is invisible on touch — fine in the dashboard and the FPL League table, where
   * the chip row sits beside plenty of other context. The public fixtures page is read on phones
   * and the chip is often the whole explanation for a score, so there it opts in. Keeping it
   * opt-in also means those two existing call sites render byte-identically.
   */
  interactive?: boolean;
}) {
  const title =
    state === "available"
      ? `${label ?? code} — available`
      : `${label ?? code} — ${STATE_WORDS[state]}${gw != null ? ` (GW${gw})` : ""}`;

  const pill = (
    <span
      title={interactive ? undefined : title}
      className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border whitespace-nowrap ${STATE_CLASSES[state]} ${className}`}
    >
      {code}
      {gw != null && state !== "available" && <span className="opacity-70"> {gw}</span>}
    </span>
  );

  if (!interactive) return pill;

  return (
    <HelpTip tip={title} className="no-underline">
      {pill}
    </HelpTip>
  );
}

/**
 * One manager's six FPL chips, coloured by state relative to `gwNumber`.
 *
 * Exported because the FPL League table renders the same row and previously
 * kept its own copy of this markup.
 */
export function FplChipRow({
  status,
  gwNumber,
  interactive = false,
  /**
   * Render nothing at all when the status is unknown, instead of "FPL chips unavailable".
   *
   * The public fixtures page reads chip history from cache only and never fetches, so an unknown
   * manager is the ordinary cold-cache state rather than a fault worth a label on a public page.
   */
  silentWhenUnknown = false,
}: {
  status: FplChipStatus | null | undefined;
  gwNumber: number | null;
  interactive?: boolean;
  silentWhenUnknown?: boolean;
}) {
  if (!status) {
    return silentWhenUnknown ? null : <span className="text-[8px] text-gray-600">FPL chips unavailable</span>;
  }

  const playedIn = new Map(status.used.map((u) => [u.code, u.gw]));
  // A chip FPL added mid-season that we do not have a slot for still gets a
  // pill rather than vanishing.
  const extras = status.used.filter((u) => !FPL_CHIP_ORDER.includes(u.code as never));

  return (
    <>
      {FPL_CHIP_ORDER.map((code) => {
        const gw = playedIn.get(code) ?? null;
        return (
          <ChipPill
            key={code}
            code={code}
            label={FPL_CHIP_LABELS[code]}
            state={chipState(gw, gwNumber)}
            gw={gw}
            interactive={interactive}
          />
        );
      })}
      {extras.map((u) => (
        <ChipPill key={u.code} code={u.code} state={chipState(u.gw, gwNumber)} gw={u.gw} interactive={interactive} />
      ))}
    </>
  );
}
