// FPL element_type ↔ position label/colour. Single source of truth.
//
// This mapping was previously copy-pasted into 11 files (both auction rooms, squad, teams, players,
// marketplace, dashboard, WishlistManager, resolve-bid, …), sometimes under different names
// (`SQUAD_POSITION_LABELS`, `MARKET_POSITION_LABELS`, `GW_POSITION_LABELS`, `POS_LABEL`).

export type PositionLabel = "GKP" | "DEF" | "MID" | "FWD";

/** FPL `element_type`: 1=GKP, 2=DEF, 3=MID, 4=FWD. */
export const POSITION_LABELS: Record<number, PositionLabel> = {
  1: "GKP",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

/** Tailwind text/border colours per position, matching the squad page's existing palette. */
export const POSITION_COLORS: Record<number, string> = {
  1: "text-yellow-300 border-yellow-300/40",
  2: "text-sky-300 border-sky-300/40",
  3: "text-emerald-300 border-emerald-300/40",
  4: "text-rose-300 border-rose-300/40",
};

/** All four positions in squad order — for filter pills and coverage readouts. */
export const POSITION_ORDER: readonly number[] = [1, 2, 3, 4];

export function positionLabel(elementType: number | null | undefined): PositionLabel | null {
  return elementType == null ? null : (POSITION_LABELS[elementType] ?? null);
}
