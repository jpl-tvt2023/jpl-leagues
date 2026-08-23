import type { FplEntryChip } from "@/lib/fpl";

/**
 * FPL chip status for one manager, derived from /entry/{id}/history/.
 *
 * The history endpoint already lists every chip played, including one played
 * in the gameweek currently in flight — so there is no need to fetch
 * `active_chip` from each entry's picks, which would be another call per
 * manager for information we already hold.
 */

export type FplChipCode = "WC1" | "WC2" | "BB" | "TC" | "FH" | "AM";

/** Display order, and the full set a manager starts the season with. */
export const FPL_CHIP_ORDER: FplChipCode[] = ["WC1", "WC2", "BB", "TC", "FH", "AM"];

export const FPL_CHIP_LABELS: Record<string, string> = {
  WC1: "Wildcard 1",
  WC2: "Wildcard 2",
  BB: "Bench Boost",
  TC: "Triple Captain",
  FH: "Free Hit",
  AM: "Assistant Manager",
};

export interface FplChipStatus {
  /** Chips played, in gameweek order. `code` is a display code, not FPL's raw name. */
  used: { code: string; gw: number }[];
  /** Standard chips not yet played. */
  available: FplChipCode[];
}

/** FPL's raw chip names → our display codes. Wildcards are handled separately. */
const NAME_TO_CODE: Record<string, FplChipCode> = {
  bboost: "BB",
  "3xc": "TC",
  freehit: "FH",
  manager: "AM",
};

export function buildFplChipStatus(chips: FplEntryChip[]): FplChipStatus {
  const used: { code: string; gw: number }[] = [];

  // Wildcards are the only chip granted twice. FPL does not distinguish them
  // in the payload, so order by gameweek: the earlier play is WC1.
  //
  // Deliberately NOT split on a hardcoded GW19 boundary — the first wildcard's
  // window shifts season to season, and a fixed midpoint silently mislabels a
  // manager who played WC1 late or WC2 early.
  const wildcards = chips
    .filter((c) => c.name === "wildcard")
    .sort((a, b) => a.event - b.event);
  wildcards.forEach((c, i) => {
    used.push({ code: i === 0 ? "WC1" : i === 1 ? "WC2" : `WC${i + 1}`, gw: c.event });
  });

  for (const chip of chips) {
    if (chip.name === "wildcard") continue;
    // Unknown names pass through as-is rather than being dropped: FPL adds
    // chips between seasons (Assistant Manager arrived in 2024/25), and a new
    // one should show up as a labelled pill, not vanish.
    used.push({ code: NAME_TO_CODE[chip.name] ?? chip.name, gw: chip.event });
  }

  used.sort((a, b) => a.gw - b.gw);

  const usedCodes = new Set(used.map((u) => u.code));
  const available = FPL_CHIP_ORDER.filter((code) => !usedCodes.has(code));

  return { used, available };
}
