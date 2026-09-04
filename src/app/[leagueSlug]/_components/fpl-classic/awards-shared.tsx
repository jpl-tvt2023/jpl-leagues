"use client";

/**
 * Award rendering shared by the FPL Classic standings and winners pages.
 *
 * Extracted rather than copied: the badge that tells a reader whether a winner is settled is the
 * single most consequential piece of copy in this format. Two divergent copies is how a page ends
 * up calling someone a winner when they are merely ahead.
 *
 * ⚠️ NO PRIZE, AMOUNT, OR CURRENCY IS RENDERED HERE, AND NONE MAY BE ADDED. This platform
 * announces winners; it does not list prizes. The same warning appears on the award registry
 * (lib/fpl-classic/awards.ts) and the awards table (lib/db/schema.ts).
 */

/**
 * How settled an award is. The three states are genuinely different claims about reality and must
 * never be collapsed:
 *
 *  - `final`       a superadmin has frozen it; read verbatim from fpl_classic_awards and it will
 *                  not change even if FPL later corrects a score.
 *  - `provisional` every gameweek the award depends on is settled and it was computed from the
 *                  same rules, but it has not been made official yet.
 *  - `leading`     the award's period is NOT over. This is who is ahead right now, and saying
 *                  anything stronger than "leading" here would be a false claim.
 */
export type AwardStatus = "final" | "provisional" | "leading";

export interface AwardWinnerRow {
  entrantId: string;
  entryName: string;
  playerName: string;
  position: number;
  value: number;
  isTied: boolean;
  detail?: Record<string, unknown> | null;
}

export interface AwardGroup {
  key: string;
  label: string;
  scope: "season" | "gameweek" | "month" | "special";
  scopeKey: string;
  status: AwardStatus;
  winners: AwardWinnerRow[];
}

export interface MonthOption {
  key: string;
  label: string;
  /** The gameweeks this month contains — a month is only complete once all of them are settled. */
  gws: number[];
  isComplete: boolean;
}

/** "gw:14" -> "GW14", "month:2025-11" -> the human label if given, else the raw key, "season" -> "Season". */
export function scopeLabel(group: AwardGroup, monthLabelByKey: Map<string, string>): string {
  if (group.scope === "gameweek") return `GW${group.scopeKey.split(":")[1]}`;
  if (group.scope === "month") {
    const key = group.scopeKey.split(":").slice(1).join(":");
    return monthLabelByKey.get(key) ?? key;
  }
  return "Season";
}

export function RankPill({ rank, isTied }: { rank: number; isTied: boolean }) {
  return (
    <span className="inline-flex items-center gap-0.5 font-mono text-sm text-gray-300">
      {isTied && <span className="text-gray-500">T</span>}
      {rank}
    </span>
  );
}

const STATUS_STYLES: Record<AwardStatus, string> = {
  final: "bg-sky-500/20 text-sky-200",
  provisional: "border border-amber-400/40 text-amber-400",
  leading: "border border-amber-400/40 text-amber-400",
};

const STATUS_WORDS: Record<AwardStatus, string> = {
  final: "Final",
  provisional: "Provisional",
  leading: "Leading",
};

export function AwardStatusBadge({ status }: { status: AwardStatus }) {
  return (
    <span
      className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${STATUS_STYLES[status]}`}
      title={
        status === "final"
          ? "Confirmed. This will not change."
          : status === "provisional"
          ? "Computed from settled scores, but not yet confirmed."
          : "This period is not over. Currently ahead — not a winner yet."
      }
    >
      {STATUS_WORDS[status]}
    </span>
  );
}

/**
 * Season/special awards first (they matter most and there are only a few), then months and
 * gameweeks most-recent-first — a reader is far more likely to want last week's winner than GW1's.
 * All three states are shown together; the badge is the only thing that tells them apart, exactly
 * as the API distinguishes them.
 */
export function AwardsList({ awards, months }: { awards: AwardGroup[]; months: MonthOption[] }) {
  const monthLabelByKey = new Map(months.map((m) => [m.key, m.label]));

  const scopeSortKey = (g: AwardGroup): number => {
    if (g.scope === "season" || g.scope === "special") return -2;
    if (g.scope === "month") return -1;
    return Number(g.scopeKey.split(":")[1] ?? 0); // gameweek: higher gw sorts later, reversed below
  };
  const sorted = [...awards].sort((a, b) => {
    const av = scopeSortKey(a);
    const bv = scopeSortKey(b);
    if (av < 0 || bv < 0) return av - bv; // season/special/month buckets first, in that order
    return bv - av; // gameweeks: most recent first
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {sorted.map((group) => (
        <AwardCard key={`${group.key}::${group.scopeKey}`} group={group} monthLabelByKey={monthLabelByKey} />
      ))}
    </div>
  );
}

export function AwardCard({
  group,
  monthLabelByKey,
}: {
  group: AwardGroup;
  monthLabelByKey: Map<string, string>;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wide text-sky-300">{scopeLabel(group, monthLabelByKey)}</span>
        <AwardStatusBadge status={group.status} />
      </div>
      <div className="text-xs text-gray-400 mb-1">{group.label}</div>
      {group.winners.map((w) => (
        <div key={w.entrantId} className="flex items-center justify-between gap-2 text-sm">
          <span className="text-white font-medium truncate">
            {/* Only worth labelling the position when there's more than one winner (the season
                podium) — a single-winner award repeating "1st" everywhere is noise. */}
            {group.winners.length > 1 && <span className="text-gray-500 mr-1">{w.position}.</span>}
            {w.entryName}
            {w.isTied && <span className="text-gray-500 text-[10px] ml-1">(tied)</span>}
          </span>
          <span className="text-gray-400 shrink-0">{w.value}</span>
        </div>
      ))}
      {group.status === "leading" && (
        <p className="mt-1.5 text-[10px] text-amber-400/80">Leading — not a winner yet.</p>
      )}
    </div>
  );
}
