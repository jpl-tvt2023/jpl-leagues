// Render a points value with up to one decimal place, stripping `.0` for whole numbers.
//   formatPts(13)    → "13"
//   formatPts(12.5)  → "12.5"
//   formatPts(0)     → "0"
//   formatPts(null)  → "0"
// Synergy on owned-club players is `0.5 × raw`, which lands on a half-point for odd raw scores.
// We display the fractional value rather than rounding — keeps standings + GW Results honest.

export function formatPts(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}
