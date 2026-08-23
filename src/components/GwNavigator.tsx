"use client";

/**
 * Prev / dropdown / next gameweek picker.
 *
 * Extracted from the fixtures page, where this markup was inlined and then
 * copy-pasted into the JPL Cup fixtures page. The dashboard needs a third
 * copy, so it lives here now.
 */
export function GwNavigator({
  gws,
  value,
  onChange,
  label,
  badge,
  accent = "default",
  disabled,
}: {
  /** Selectable gameweeks, ascending. */
  gws: number[];
  value: number | null;
  onChange: (gw: number) => void;
  /** Defaults to `Gameweek {n}`. */
  label?: (gw: number) => string;
  /** Rendered beside the picker — e.g. a LIVE pill. */
  badge?: React.ReactNode;
  accent?: "default" | "continental";
  disabled?: boolean;
}) {
  const index = value == null ? -1 : gws.indexOf(value);
  const atStart = index <= 0;
  const atEnd = index < 0 || index >= gws.length - 1;
  const renderLabel = label ?? ((gw: number) => `Gameweek ${gw}`);

  const selectClass =
    accent === "continental"
      ? "bg-[#00ff85]/10 border-[#00ff85]/30 text-[#00ff85] hover:bg-[#00ff85]/20"
      : "bg-white/10 border-white/20 text-white hover:bg-white/20";

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-4">
      <button
        type="button"
        onClick={() => !atStart && onChange(gws[index - 1])}
        disabled={disabled || atStart}
        aria-label="Previous gameweek"
        className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <select
        value={value ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled || gws.length === 0}
        aria-label="Gameweek"
        className={`border rounded-lg px-3 sm:px-4 py-2 text-sm sm:text-base font-semibold min-w-[140px] sm:min-w-[180px] text-center appearance-none cursor-pointer transition disabled:opacity-40 disabled:cursor-not-allowed ${selectClass}`}
      >
        {gws.map((gw) => (
          <option key={gw} value={gw} className="bg-slate-800 text-white">
            {renderLabel(gw)}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => !atEnd && onChange(gws[index + 1])}
        disabled={disabled || atEnd}
        aria-label="Next gameweek"
        className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {badge}
    </div>
  );
}
