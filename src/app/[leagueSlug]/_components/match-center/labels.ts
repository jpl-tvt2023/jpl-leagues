/** Display words for the Match Center. Kept together so the page and its rows agree. */

/** FPL `explain` identifiers → what a reader calls them. Unknown ones fall back to a de-snaked id. */
const BREAKDOWN_LABELS: Record<string, string> = {
  minutes: "Minutes played",
  goals_scored: "Goals scored",
  assists: "Assists",
  clean_sheets: "Clean sheet",
  goals_conceded: "Goals conceded",
  own_goals: "Own goals",
  penalties_saved: "Penalties saved",
  penalties_missed: "Penalties missed",
  yellow_cards: "Yellow card",
  red_cards: "Red card",
  saves: "Saves",
  bonus: "Bonus",
  defensive_contribution: "Defensive contribution",
};

export function breakdownLabel(identifier: string): string {
  return BREAKDOWN_LABELS[identifier] ?? identifier.replace(/_/g, " ");
}

/** FPL's raw `active_chip` → [pill code, full name]. */
const RAW_CHIPS: Record<string, [string, string]> = {
  wildcard: ["WC", "Wildcard"],
  freehit: ["FH", "Free Hit"],
  bboost: ["BB", "Bench Boost"],
  "3xc": ["TC", "Triple Captain"],
  manager: ["AM", "Assistant Manager"],
};

export function rawChip(name: string | null | undefined): { code: string; label: string } | null {
  if (!name) return null;
  const hit = RAW_CHIPS[name];
  return hit ? { code: hit[0], label: hit[1] } : { code: name.toUpperCase(), label: name };
}

/** "Ravi Kumar" → "Ravi". Disambiguates when both managers share a first name. */
export function shortManagerName(name: string, others: string[]): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  const clash = others.some((o) => o !== name && (o.trim().split(/\s+/)[0] ?? o) === first);
  return clash ? name : first;
}

export function formatKickoff(iso: string | null): string {
  if (!iso) return "TBC";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
