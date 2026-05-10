/**
 * Per-format visual palette tokens.
 *
 * The 5 league variants (TVT-8, TVT-16, TVT-32, Triple Crown, Auction) each get
 * their own palette so users immediately see which kind of league they're in
 * without reading the slug. TVT variants share a purple→indigo→violet hue
 * family with subtle size-shift; TC and Auction get distinct hues.
 *
 * Apply via the `useFormatPalette()` hook (re-exported from league-context).
 * This file is the single source of truth for format-aware chrome — adding new
 * surfaces just means consuming the hook, no per-component branching.
 */

export type FormatPalette = {
  /** Hue family — useful for ad-hoc class composition (e.g. `text-${family}-300`). */
  family: "purple" | "indigo" | "violet" | "amber" | "emerald";
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
};

const TVT_8_PALETTE: FormatPalette = {
  family: "indigo",
  accentGradient: "from-indigo-300 to-blue-400",
  surfaceTint: "bg-indigo-500/5",
  borderTint: "border-indigo-500/20",
  badgeBg: "bg-indigo-500/20",
  badgeText: "text-indigo-200",
  label: "TVT-8",
};

const TVT_16_PALETTE: FormatPalette = {
  family: "violet",
  accentGradient: "from-violet-400 to-purple-500",
  surfaceTint: "bg-violet-500/5",
  borderTint: "border-violet-500/20",
  badgeBg: "bg-violet-500/20",
  badgeText: "text-violet-200",
  label: "TVT-16",
};

const TVT_32_PALETTE: FormatPalette = {
  family: "purple",
  accentGradient: "from-purple-400 to-fuchsia-500",
  surfaceTint: "bg-purple-500/5",
  borderTint: "border-purple-500/20",
  badgeBg: "bg-purple-500/20",
  badgeText: "text-purple-200",
  label: "TVT-32",
};

const TC_PALETTE: FormatPalette = {
  family: "amber",
  accentGradient: "from-amber-300 to-orange-500",
  surfaceTint: "bg-amber-500/5",
  borderTint: "border-amber-500/30",
  badgeBg: "bg-amber-500/20",
  badgeText: "text-amber-200",
  label: "TC",
};

const AUCTION_PALETTE: FormatPalette = {
  family: "emerald",
  accentGradient: "from-emerald-300 to-teal-400",
  surfaceTint: "bg-emerald-500/5",
  borderTint: "border-emerald-500/30",
  badgeBg: "bg-emerald-500/20",
  badgeText: "text-emerald-200",
  label: "Auction",
};

const DEFAULT_PALETTE: FormatPalette = TVT_32_PALETTE;

/**
 * Resolve a palette for the given format + teamSize.
 * Inputs come straight from the `leagues` row — no normalization needed.
 */
export function getFormatPalette(format: string | null | undefined, teamSize: number | null): FormatPalette {
  if (format === "auction") return AUCTION_PALETTE;
  if (format === "triple-crown") return TC_PALETTE;
  if (format === "tvt") {
    if (teamSize === 8) return TVT_8_PALETTE;
    if (teamSize === 16) return TVT_16_PALETTE;
    return TVT_32_PALETTE;
  }
  return DEFAULT_PALETTE;
}
