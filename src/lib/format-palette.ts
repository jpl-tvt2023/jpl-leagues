/**
 * Per-format visual palette tokens.
 *
 * The 5 league variants (TVT-8, TVT-16, TVT-32, Continental Championship, Auction) each get
 * their own palette so users immediately see which kind of league they're in
 * without reading the slug. TVT variants share a purple→indigo→violet hue
 * family with subtle size-shift; TC and Auction get distinct hues.
 *
 * Apply via the `useFormatPalette()` hook (re-exported from league-context).
 * This file is the single source of truth for format-aware chrome — adding new
 * surfaces just means consuming the hook, no per-component branching.
 */

/**
 * Canonical stored value of the JPL Continental Championship format.
 * Imported wherever the format is compared so the token lives in one place.
 */
export const CONTINENTAL_FORMAT = "continental-championship";

/**
 * Canonical stored value of the public FPL Classic format.
 *
 * Named "fpl-classic", not "classic" — `_components/standings/ClassicStandings.tsx` and
 * `_components/playoffs/ClassicPlayoffs.tsx` are the TVT/Continental components. A format
 * literally named `classic` that must NOT render `ClassicStandings` is a trap the next reader
 * would fall straight into.
 */
export const FPL_CLASSIC_FORMAT = "fpl-classic";

export type FormatPalette = {
  /** Hue family — useful for ad-hoc class composition (e.g. `text-${family}-300`). */
  family: "purple" | "indigo" | "violet" | "amber" | "emerald" | "sky";
  /** `from-… to-…` Tailwind classes for accent gradients (e.g. league name). */
  accentGradient: string;
  /** Soft surface tint suitable for cards/sections tied to this format. */
  surfaceTint: string;
  /** Border tint matching surfaceTint. */
  borderTint: string;
  /** Background for the small format chip rendered in the header. */
  badgeBg: string;
  /** Text colour for the format chip. */
  badgeText: string;
  /** Short label (≤6 chars) shown in the format chip. */
  label: string;
  /** Full-page background gradient classes — applied at `[leagueSlug]/layout.tsx`. */
  pageBg: string;
};

const TVT_8_PALETTE: FormatPalette = {
  family: "indigo",
  accentGradient: "from-indigo-300 to-blue-400",
  surfaceTint: "bg-indigo-500/5",
  borderTint: "border-indigo-500/20",
  badgeBg: "bg-indigo-500/20",
  badgeText: "text-indigo-200",
  label: "TVT-8",
  pageBg: "bg-gradient-to-b from-slate-900 via-indigo-900 to-slate-900",
};

const TVT_16_PALETTE: FormatPalette = {
  family: "violet",
  accentGradient: "from-violet-400 to-purple-500",
  surfaceTint: "bg-violet-500/5",
  borderTint: "border-violet-500/20",
  badgeBg: "bg-violet-500/20",
  badgeText: "text-violet-200",
  label: "TVT-16",
  pageBg: "bg-gradient-to-b from-slate-900 via-violet-900 to-slate-900",
};

const TVT_32_PALETTE: FormatPalette = {
  family: "purple",
  accentGradient: "from-purple-400 to-fuchsia-500",
  surfaceTint: "bg-purple-500/5",
  borderTint: "border-purple-500/20",
  badgeBg: "bg-purple-500/20",
  badgeText: "text-purple-200",
  label: "TVT-32",
  pageBg: "bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900",
};

const TC_PALETTE: FormatPalette = {
  family: "amber",
  accentGradient: "from-amber-300 to-orange-500",
  surfaceTint: "bg-amber-500/5",
  borderTint: "border-amber-500/30",
  badgeBg: "bg-amber-500/20",
  badgeText: "text-amber-200",
  label: "JCC",
  pageBg: "bg-gradient-to-b from-slate-900 via-amber-900/40 to-slate-900",
};

const AUCTION_PALETTE: FormatPalette = {
  family: "emerald",
  accentGradient: "from-emerald-300 to-teal-400",
  surfaceTint: "bg-emerald-500/5",
  borderTint: "border-emerald-500/30",
  badgeBg: "bg-emerald-500/20",
  badgeText: "text-emerald-200",
  label: "Auction",
  pageBg: "bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]",
};

// Sky/cyan — reads clearly against indigo/violet/purple/amber/emerald, and distinct from all
// of them at a glance, which matters here specifically: this is the one format with no login,
// so the palette is the reader's only visual cue they are on a different kind of page.
const FPL_CLASSIC_PALETTE: FormatPalette = {
  family: "sky",
  accentGradient: "from-sky-300 to-cyan-400",
  surfaceTint: "bg-sky-500/5",
  borderTint: "border-sky-500/30",
  badgeBg: "bg-sky-500/20",
  badgeText: "text-sky-200",
  label: "Classic",
  pageBg: "bg-gradient-to-b from-slate-900 via-sky-900/40 to-slate-900",
};

const DEFAULT_PALETTE: FormatPalette = TVT_32_PALETTE;

/**
 * Resolve a palette for the given format + teamSize.
 * Inputs come straight from the `leagues` row — no normalization needed.
 */
export function getFormatPalette(format: string | null | undefined, teamSize: number | null): FormatPalette {
  if (format === "auction") return AUCTION_PALETTE;
  if (format === CONTINENTAL_FORMAT) return TC_PALETTE;
  if (format === FPL_CLASSIC_FORMAT) return FPL_CLASSIC_PALETTE;
  if (format === "tvt") {
    if (teamSize === 8) return TVT_8_PALETTE;
    if (teamSize === 16) return TVT_16_PALETTE;
    return TVT_32_PALETTE;
  }
  return DEFAULT_PALETTE;
}
