/**
 * JPL Auction — mini-auction gameweeks.
 *
 * The gameweeks a league plans its mini-auctions around, configured per league (stored as
 * `release_cycle_gws`, default GW 10/20/30). Purely informational now: the rules page names them,
 * but releases no longer confirm at these gameweeks — they confirm 24 hours before the mini-auction
 * itself (see release-deadline.ts).
 *
 * An explicit list beats a configurable interval here: it composes with any start
 * gameweek without offset arithmetic, and it lets the UI name the real gameweeks
 * instead of describing a rule.
 *
 * Zero imports on purpose (same reasoning as gameweeks/default-gw.ts) so this
 * unit-tests without a DB and can be called from client components.
 */

/** Reproduces the legacy `gw % 10 === 0` cadence. Also the schema column default. */
export const DEFAULT_RELEASE_CYCLE_GWS = [10, 20, 30];

/** Most boundaries a league may configure — each is expected to pair with one mini-auction. */
export const MAX_RELEASE_CYCLE_GWS = 10;

/**
 * Parse the stored JSON column into an ascending list of gameweek numbers.
 *
 * Falls back to DEFAULT_RELEASE_CYCLE_GWS on anything malformed rather than
 * returning an empty list, so the rules page always has gameweeks to name.
 */
export function parseReleaseCycleGws(raw: string | null | undefined): number[] {
  if (!raw) return [...DEFAULT_RELEASE_CYCLE_GWS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_RELEASE_CYCLE_GWS];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_RELEASE_CYCLE_GWS];
  const gws = parsed.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 38);
  if (gws.length === 0) return [...DEFAULT_RELEASE_CYCLE_GWS];
  return [...new Set(gws)].sort((a, b) => a - b);
}

/**
 * Validate admin input for the mini-auction gameweek list: 1..MAX_RELEASE_CYCLE_GWS unique
 * integers, each within `startGw`..38. Mirrors validateEnabledChipsArray in
 * formats/tvt/chip-validation.ts so create and edit share one rule.
 *
 * Accepts either an array of numbers or a comma-separated string ("10, 20, 30"),
 * because the admin UI collects it as free text.
 *
 * Returns `{ ok: true, gws }` (ascending, de-duplicated) or `{ ok: false, error }`.
 */
export function validateReleaseCycleGws(
  value: unknown,
  startGw: number
): { ok: true; gws: number[] } | { ok: false; error: string } {
  const errorMsg =
    `Mini-auction gameweeks must be 1-${MAX_RELEASE_CYCLE_GWS} unique gameweek numbers between ${startGw} and 38`;

  let items: unknown[];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return { ok: false, error: errorMsg };
    items = trimmed.split(",").map((part) => {
      const t = part.trim();
      // Guard against Number("") === 0 and Number("  ") === 0 slipping through as
      // a valid-looking 0 from a trailing comma.
      return t === "" ? NaN : Number(t);
    });
  } else if (Array.isArray(value)) {
    items = value;
  } else {
    return { ok: false, error: errorMsg };
  }

  if (items.length === 0 || items.length > MAX_RELEASE_CYCLE_GWS) {
    return { ok: false, error: errorMsg };
  }
  if (!items.every((n): n is number => Number.isInteger(n) && (n as number) >= startGw && (n as number) <= 38)) {
    return { ok: false, error: errorMsg };
  }
  const unique = [...new Set(items as number[])];
  if (unique.length !== items.length) {
    return { ok: false, error: errorMsg };
  }
  return { ok: true, gws: unique.sort((a, b) => a - b) };
}

/**
 * "GW 10/20/30" — the single source for every user-facing mention of the cadence,
 * so admin and rules copy can never drift apart again.
 */
export function formatReleaseCycleGws(cycleGws: number[]): string {
  if (cycleGws.length === 0) return "the league's mini-auction gameweeks";
  return `GW ${cycleGws.join("/")}`;
}
