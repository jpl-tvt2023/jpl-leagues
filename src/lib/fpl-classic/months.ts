/**
 * FPL Classic — bucketing gameweeks into calendar months.
 *
 * A gameweek belongs to the calendar month of its FPL deadline, in UTC, always — never the
 * viewer's local timezone, and never the month its matches are actually played in (a Friday
 * 18:30 UTC deadline on the last day of November puts the whole gameweek in November even
 * though most of its fixtures kick off in December). UTC is deliberate: the month a gameweek
 * falls in must be the same figure for every reader regardless of where they are, and it is
 * frozen onto the settled row at sync time — see `fpl_classic_entry_gws.monthKey` in schema.ts.
 *
 * Pure and import-free so it unit-tests without a database or a clock dependency beyond the
 * deadline strings themselves.
 */

export interface MonthBucket {
  /** "2025-11" — sorts correctly as a plain string, unlike a locale-formatted label. */
  key: string;
  /** "November 2025" */
  label: string;
  /** Gameweek numbers in this month, ascending. */
  gws: number[];
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The UTC calendar-month key for one deadline ISO string, e.g. "2025-11". */
export function monthKeyFromDeadline(deadlineIso: string): string {
  const d = new Date(deadlineIso);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** "2025-11" -> "November 2025". Falls back to the raw key if it is not well-formed. */
export function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const name = MONTH_NAMES[monthIndex];
  return name ? `${name} ${year}` : key;
}

/**
 * Group gameweeks into month buckets by their deadline. Buckets are returned in month order;
 * within a bucket, gameweek numbers are ascending. A month with no gameweeks in the input never
 * appears — there is no "empty" bucket to render.
 */
export function buildMonthBuckets(
  gameweeks: { gw: number; deadlineTime: string }[],
): MonthBucket[] {
  const byKey = new Map<string, number[]>();
  for (const { gw, deadlineTime } of gameweeks) {
    const key = monthKeyFromDeadline(deadlineTime);
    const list = byKey.get(key) ?? [];
    list.push(gw);
    byKey.set(key, list);
  }

  const buckets: MonthBucket[] = [...byKey.entries()]
    .map(([key, gws]) => ({ key, label: monthLabel(key), gws: [...gws].sort((a, b) => a - b) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return buckets;
}

/**
 * Which month should be selected by default: the one containing `currentGw`. Falls back to the
 * LAST bucket (the most recent complete month) when `currentGw` is null — e.g. before a season's
 * gameweek calendar has resolved to an active gameweek. Null only when there are no buckets at all.
 */
export function defaultMonthKey(buckets: MonthBucket[], currentGw: number | null): string | null {
  if (buckets.length === 0) return null;
  if (currentGw != null) {
    const containing = buckets.find((b) => b.gws.includes(currentGw));
    if (containing) return containing.key;
  }
  return buckets[buckets.length - 1].key;
}
