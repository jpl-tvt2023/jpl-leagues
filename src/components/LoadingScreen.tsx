import React from "react";

type LoadingVariant =
  | "standings"
  | "fixtures"
  | "playoffs"
  | "dashboard"
  | "rules"
  | "help"
  | "admin"
  | "default";

interface LoadingScreenProps {
  variant?: LoadingVariant;
  /** true = full-screen with gradient bg (early-return pages); false = content-area block (nav always visible) */
  fullScreen?: boolean;
}

// ── SVG icons ─────────────────────────────────────────────────────────────────

function IconStandings() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      <rect x="2" y="14" width="4" height="8" rx="1" fill="currentColor" opacity="0.9" />
      <rect x="9" y="9" width="4" height="13" rx="1" fill="currentColor" />
      <rect x="16" y="5" width="4" height="17" rx="1" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

function IconFixtures() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      {/* left shield */}
      <path d="M4 4 L7 4 L9 4 L9 10 C9 12.5 7 14 7 14 C7 14 5 12.5 5 10 Z" fill="currentColor" opacity="0.8" />
      {/* right shield */}
      <path d="M15 4 L19 4 L19 4 L19 10 C19 12.5 17 14 17 14 C17 14 15 12.5 15 10 Z" fill="currentColor" opacity="0.8" />
      {/* football in centre */}
      <circle cx="12" cy="13" r="3" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M12 10.5 L12 15.5 M9.5 13 L14.5 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconPlayoffs() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      {/* cup body */}
      <path d="M7 3 H17 L15 12 C15 14.2 13.7 16 12 16 C10.3 16 9 14.2 9 12 Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      {/* handles */}
      <path d="M7 5 C5 5 4 7 5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M17 5 C19 5 20 7 19 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      {/* stem */}
      <line x1="12" y1="16" x2="12" y2="19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* base */}
      <line x1="9" y1="19" x2="15" y2="19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* star */}
      <path d="M12 6.5 L12.4 7.7 L13.7 7.7 L12.7 8.4 L13.1 9.7 L12 8.9 L10.9 9.7 L11.3 8.4 L10.3 7.7 L11.6 7.7 Z" fill="currentColor" />
    </svg>
  );
}

function IconDashboard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      {/* person */}
      <circle cx="12" cy="7" r="3" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M6 20 C6 16.7 8.7 14 12 14 C15.3 14 18 16.7 18 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      {/* small stat bars on right */}
      <rect x="18" y="5" width="2" height="6" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="21" y="3" width="2" height="8" rx="0.5" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

function IconRules() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      {/* document */}
      <rect x="5" y="2" width="14" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      {/* lines */}
      <line x1="8" y1="7" x2="16" y2="7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="8" y1="11" x2="16" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="8" y1="15" x2="13" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* top fold */}
      <path d="M15 2 L19 6 L15 6 Z" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function IconHelp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path
        d="M9.5 9.5 C9.5 7.8 10.6 6.5 12 6.5 C13.4 6.5 14.5 7.6 14.5 9 C14.5 10.6 13 11.5 12 12.5"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"
      />
      <circle cx="12" cy="16" r="1" fill="currentColor" />
    </svg>
  );
}

function IconAdmin() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path
        d="M12 2 L13.5 5.5 L17 4 L17 7 L20.5 8.5 L19 12 L20.5 15.5 L17 17 L17 20 L13.5 18.5 L12 22 L10.5 18.5 L7 20 L7 17 L3.5 15.5 L5 12 L3.5 8.5 L7 7 L7 4 L10.5 5.5 Z"
        stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"
      />
    </svg>
  );
}

function IconDefault() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />
      {/* pentagon patches */}
      <circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="0.6" />
      <path d="M12 3.5 L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 18 L12 20.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3.5 12 L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M18 12 L20.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Variant config ─────────────────────────────────────────────────────────────

const VARIANTS: Record<
  LoadingVariant,
  { label: string; ringColor: string; dotColor: string; textColor: string; Icon: () => React.ReactElement }
> = {
  standings: {
    label: "Loading League Table",
    ringColor: "#facc15",        // yellow-400
    dotColor: "bg-yellow-400",
    textColor: "text-yellow-400",
    Icon: IconStandings,
  },
  fixtures: {
    label: "Loading Fixtures",
    ringColor: "#60a5fa",        // blue-400
    dotColor: "bg-blue-400",
    textColor: "text-blue-400",
    Icon: IconFixtures,
  },
  playoffs: {
    label: "Loading Playoffs",
    ringColor: "#c084fc",        // purple-400
    dotColor: "bg-purple-400",
    textColor: "text-purple-400",
    Icon: IconPlayoffs,
  },
  dashboard: {
    label: "Loading Your Dashboard",
    ringColor: "#4ade80",        // green-400
    dotColor: "bg-green-400",
    textColor: "text-green-400",
    Icon: IconDashboard,
  },
  rules: {
    label: "Loading Rules",
    ringColor: "#fb923c",        // orange-400
    dotColor: "bg-orange-400",
    textColor: "text-orange-400",
    Icon: IconRules,
  },
  help: {
    label: "Loading Help",
    ringColor: "#22d3ee",        // cyan-400
    dotColor: "bg-cyan-400",
    textColor: "text-cyan-400",
    Icon: IconHelp,
  },
  admin: {
    label: "Loading",
    ringColor: "#9ca3af",        // gray-400
    dotColor: "bg-gray-400",
    textColor: "text-gray-400",
    Icon: IconAdmin,
  },
  default: {
    label: "Loading",
    ringColor: "#facc15",        // yellow-400
    dotColor: "bg-yellow-400",
    textColor: "text-yellow-400",
    Icon: IconDefault,
  },
};

// ── Component ──────────────────────────────────────────────────────────────────

export function LoadingScreen({ variant = "default", fullScreen = true }: LoadingScreenProps) {
  const cfg = VARIANTS[variant];
  const { Icon } = cfg;

  const spinner = (
    <div className="flex flex-col items-center gap-5">
      {/* Double counter-rotating rings + centered icon */}
      <div className="relative w-20 h-20">
        {/* outer ring — clockwise, 1 s */}
        <div
          className="absolute inset-0 rounded-full border-4 animate-spin"
          style={{
            borderColor: `${cfg.ringColor}22`,
            borderTopColor: cfg.ringColor,
            animationDuration: "1s",
          }}
        />
        {/* inner ring — counter-clockwise, 1.6 s */}
        <div
          className="absolute inset-3 rounded-full border-2 animate-spin"
          style={{
            borderColor: `${cfg.ringColor}15`,
            borderTopColor: `${cfg.ringColor}80`,
            animationDirection: "reverse",
            animationDuration: "1.6s",
          }}
        />
        {/* icon */}
        <div className={`absolute inset-0 flex items-center justify-center ${cfg.textColor} animate-pulse`}>
          <Icon />
        </div>
      </div>

      {/* label */}
      <p className={`text-sm font-semibold tracking-wide ${cfg.textColor}`}>{cfg.label}</p>

      {/* staggered bouncing dots */}
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${cfg.dotColor} animate-bounce`}
            style={{ animationDelay: `${i * 0.15}s`, animationDuration: "0.9s" }}
          />
        ))}
      </div>
    </div>
  );

  if (fullScreen) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center">
        {spinner}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-28">
      {spinner}
    </div>
  );
}
