"use client";

/**
 * AuctionTimerRing — a circular countdown used on the live auction screens (user + admin).
 *
 * Renders an SVG progress ring that depletes as `seconds` runs down toward 0 relative to `max`,
 * with the remaining seconds large in the centre. Colour ramps green → amber → red and the whole
 * ring pulses in the final stretch so the countdown is impossible to miss.
 */
export function AuctionTimerRing({
  seconds,
  max,
  size = 96,
  stroke = 8,
  label,
  className = "",
}: {
  seconds: number;
  /** Full duration the ring represents (e.g. the session bid timer). Used to scale the arc. */
  max: number;
  /** Outer diameter in px. */
  size?: number;
  /** Ring thickness in px. */
  stroke?: number;
  /** Optional small caption rendered under the seconds (e.g. "NEXT NOM"). */
  label?: string;
  className?: string;
}) {
  const safeMax = Math.max(1, max);
  const clamped = Math.max(0, Math.min(seconds, safeMax));
  const fraction = clamped / safeMax; // 1 → full ring, 0 → empty

  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);

  // Colour bands: red+pulse in the final 5s, amber under ~⅓ remaining, green otherwise.
  const critical = clamped <= 5;
  const warning = !critical && fraction <= 0.34;
  const color = critical ? "#f87171" : warning ? "#fbbf24" : "#22c55e"; // red-400 / amber-400 / green-500

  return (
    <div
      className={`relative inline-flex items-center justify-center ${critical ? "animate-pulse" : ""} ${className}`}
      style={{ width: size, height: size }}
      role="timer"
      aria-label={`${clamped} seconds remaining`}
    >
      <svg width={size} height={size} className="-rotate-90">
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth={stroke}
        />
        {/* Progress */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 0.5s linear, stroke 0.3s linear", filter: `drop-shadow(0 0 6px ${color})` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-mono font-bold tabular-nums leading-none"
          style={{ color, fontSize: size * 0.34 }}
        >
          {clamped}
        </span>
        {label && (
          <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-widest text-gray-400">{label}</span>
        )}
      </div>
    </div>
  );
}
