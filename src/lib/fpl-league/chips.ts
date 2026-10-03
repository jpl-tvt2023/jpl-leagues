import type { FplEntryChip } from "@/lib/fpl";

/**
 * FPL chip status for one manager, derived from /entry/{id}/history/.
 *
 * The history endpoint already lists every chip played, including one played
 * in the gameweek currently in flight — so there is no need to fetch
 * `active_chip` from each entry's picks, which would be another call per
 * manager for information we already hold.
 *
 * ## Which chips exist is the SEASON's decision, not ours
 *
 * FPL changes the chip set between seasons: Assistant Manager arrived in 2024/25 and was gone
 * again by 2025/26, when every chip became one-per-half. This module used to hardcode the
 * 2024/25 set, so every manager showed an "available" Assistant Manager that no longer exists,
 * only one Bench Boost / Triple Captain / Free Hit, and first-half chips as still available after
 * they had expired. The set now comes from bootstrap-static's `chips` (see season-chips.ts),
 * with DEFAULT_SEASON_CHIPS as the fallback when that has not been cached.
 *
 * No runtime imports, so the scorer, the public routes and the unit lane can all use it.
 */

/** One chip slot as bootstrap-static's `chips` array lists it. */
export interface FplSeasonChip {
  /** FPL's raw name: wildcard | freehit | bboost | 3xc | manager. */
  name: string;
  start_event: number;
  stop_event: number;
}

/**
 * The 2026/27 chips, as https://fantasy.premierleague.com/api/bootstrap-static/ listed them on
 * 2026-10-03: one of each chip per half. Used only when the live list has not been cached; when
 * FPL changes the rules pre-season, the cached list takes over without a code change.
 */
export const DEFAULT_SEASON_CHIPS: readonly FplSeasonChip[] = [
  { name: "wildcard", start_event: 2, stop_event: 19 },
  { name: "freehit", start_event: 2, stop_event: 19 },
  { name: "bboost", start_event: 1, stop_event: 19 },
  { name: "3xc", start_event: 1, stop_event: 19 },
  { name: "wildcard", start_event: 20, stop_event: 38 },
  { name: "freehit", start_event: 20, stop_event: 38 },
  { name: "bboost", start_event: 20, stop_event: 38 },
  { name: "3xc", start_event: 20, stop_event: 38 },
];

/** FPL's raw chip names → our short codes. Unknown names pass through as-is. */
const BASE_CODES: Record<string, string> = {
  wildcard: "WC",
  freehit: "FH",
  bboost: "BB",
  "3xc": "TC",
  manager: "AM",
};

const BASE_LABELS: Record<string, string> = {
  WC: "Wildcard",
  FH: "Free Hit",
  BB: "Bench Boost",
  TC: "Triple Captain",
  AM: "Assistant Manager",
};

/** Display order within a half. */
const NAME_ORDER = ["wildcard", "freehit", "bboost", "3xc", "manager"];

/** One chip a manager holds this season, e.g. BB2 = the second-half Bench Boost. */
export interface FplChipSlot {
  /** "BB2" when FPL grants that chip more than once a season, else the bare "BB". */
  code: string;
  /** FPL's raw name. */
  name: string;
  /** "Bench Boost 2 (GW20–38)". */
  label: string;
  /** First and last gameweek it can be played in. */
  from: number;
  to: number;
}

/**
 * Human name for a chip code — "BB2" → "Bench Boost 2", "TC" → "Triple Captain". Also reads the
 * codes used before chips were split by half ("BB", "WC1"), which still appear in stored reasons.
 * Unknown codes are returned as-is.
 */
export function fplChipLabel(code: string): string {
  const m = /^([A-Z]{2})(\d*)$/.exec(code);
  const base = m ? BASE_LABELS[m[1]] : undefined;
  if (!m || !base) return code;
  return m[2] ? `${base} ${m[2]}` : base;
}

/** "BB2" → "BB". For places that only need to say which chip, not which half. */
export function fplChipBaseCode(code: string): string {
  return code.replace(/\d+$/, "");
}

/** The season's chips as slots, ordered by half, then Wildcard · Free Hit · Bench Boost · Triple Captain. */
export function seasonChipSlots(season: readonly FplSeasonChip[] = DEFAULT_SEASON_CHIPS): FplChipSlot[] {
  const byName = new Map<string, FplSeasonChip[]>();
  for (const c of season) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }
  // Grouped by which grant of the chip it is (first half, second half) rather than by start
  // gameweek: Bench Boost opens in GW1 but Wildcard in GW2, and sorting on that would split a half.
  const slots: (FplChipSlot & { nth: number })[] = [];
  for (const [name, list] of byName) {
    list.sort((a, b) => a.start_event - b.start_event);
    const base = BASE_CODES[name] ?? name;
    list.forEach((c, i) => {
      const code = list.length > 1 ? `${base}${i + 1}` : base;
      slots.push({
        code,
        name,
        label: `${fplChipLabel(code)} (GW${c.start_event}–${c.stop_event})`,
        from: c.start_event,
        to: c.stop_event,
        nth: i,
      });
    });
  }
  const rank = (n: string) => {
    const i = NAME_ORDER.indexOf(n);
    return i < 0 ? NAME_ORDER.length : i;
  };
  return slots
    .sort((a, b) => a.nth - b.nth || rank(a.name) - rank(b.name) || a.code.localeCompare(b.code))
    .map((s) => ({ code: s.code, name: s.name, label: s.label, from: s.from, to: s.to }));
}

export interface FplChipStatus {
  /** Chips played, in gameweek order. `code` is a slot code ("BB1"), or FPL's raw name for an unknown chip. */
  used: { code: string; gw: number }[];
  /**
   * Slot codes not yet played. May include a chip whose window has closed — compare against
   * `slots[].to` (chipState does) to tell "available" from "expired".
   */
  available: string[];
  /**
   * The season's chip slots this status was built against. Optional so a status built before
   * this field existed (or a test fixture) still reads; renderers fall back to the default season.
   */
  slots?: FplChipSlot[];
}

/**
 * How a chip should read to someone looking at gameweek N.
 *
 * "past" vs "current" because "played" answers the wrong question during a live gameweek: a chip
 * burned in GW3 and a chip being played right now are both "used", but only one of them is still
 * affecting the score on screen. "expired" is an unplayed chip whose half has ended — FPL takes
 * it away, so showing it as available would be wrong.
 */
export type ChipState = "past" | "current" | "available" | "expired";

/**
 * @param usedGw   the gameweek the chip was played in, or null/undefined if unplayed
 * @param currentGw the gameweek being displayed — null when none resolves, in
 *                  which case a played chip is simply "past"
 * @param window   the chip's playable window, when it has one; an unplayed chip past its last
 *                 gameweek is "expired"
 */
export function chipState(
  usedGw: number | null | undefined,
  currentGw: number | null | undefined,
  window?: { to: number } | null,
): ChipState {
  if (usedGw == null) {
    return window && currentGw != null && currentGw > window.to ? "expired" : "available";
  }
  if (currentGw != null && usedGw === currentGw) return "current";
  return "past";
}

/**
 * Match each chip a manager played to the season slot it used: same chip, and the gameweek inside
 * that slot's window. So a Bench Boost in GW24 is BB2 even if BB1 was never played — the old
 * "earlier play is WC1" rule mislabelled exactly that once chips became per-half.
 */
export function buildFplChipStatus(
  chips: FplEntryChip[],
  season: readonly FplSeasonChip[] = DEFAULT_SEASON_CHIPS,
): FplChipStatus {
  const slots = seasonChipSlots(season);
  const taken = new Set<string>();
  const used: { code: string; gw: number }[] = [];

  for (const chip of [...chips].sort((a, b) => a.event - b.event)) {
    const ofName = slots.filter((s) => s.name === chip.name && !taken.has(s.code));
    const slot =
      ofName.find((s) => chip.event >= s.from && chip.event <= s.to) ??
      // Outside every window: FPL's data and ours disagree. Still count it against a slot.
      ofName[0];
    if (slot) {
      taken.add(slot.code);
      used.push({ code: slot.code, gw: chip.event });
    } else {
      // A chip this season's list does not know (or one played more times than it allows):
      // shown under its own code rather than dropped.
      used.push({ code: BASE_CODES[chip.name] ?? chip.name, gw: chip.event });
    }
  }

  return {
    used,
    available: slots.filter((s) => !taken.has(s.code)).map((s) => s.code),
    slots,
  };
}
