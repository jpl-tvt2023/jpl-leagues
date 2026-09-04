/**
 * FPL Classic — the award registry.
 *
 * ⚠️ NO PRIZE, AMOUNT, OR CURRENCY FIELD EXISTS ON ANY AWARD, AND NONE MAY BE ADDED. This
 * platform announces winners; it does not list prizes. Say so in the Rules page copy too.
 *
 * One `compute` function per award serves BOTH paths that need it:
 *   - the freeze writer (lib/fpl-classic/sync.ts), which persists the result once a scope is
 *     fully settled, and
 *   - the provisional read (lib/fpl-classic/standings.ts's awards section — see requiredGws),
 *     which shows a live, unfrozen guess before that.
 * Sharing the function is what guarantees a frozen award and its provisional predecessor were
 * never computed by two different, silently-diverging implementations.
 *
 * Extensibility is the whole point of this file being a registry rather than bespoke code per
 * award: a new award is one object appended to AWARD_DEFINITIONS. If it needs an input that
 * doesn't exist yet, the pattern is a new NULLABLE column on `fpl_classic_entry_gws` —
 * `captainPoints` was reserved that way and deliberately never wired up (see plan notes); adding
 * a real one later needs no migration to anything already built.
 *
 * Pure and import-free so it unit-tests without a database.
 */

export interface AwardEntrantRow {
  id: string;
  playerName: string;
  entryName: string;
  firstSeenGw: number;
}

export interface AwardGwRow {
  entrantId: string;
  gw: number;
  points: number;
  netPoints: number;
  benchPoints: number;
  monthKey: string;
}

export interface AwardMonthBucket {
  key: string;
  label: string;
  gws: number[];
}

export interface AwardContext {
  entrants: AwardEntrantRow[];
  rows: AwardGwRow[];
  months: AwardMonthBucket[];
  startGameweek: number;
  settledThroughGw: number;
  metric: "net" | "gross";
  winnerCutPercent: number;
}

export interface AwardWinner {
  entrantId: string;
  position: number;
  value: number;
  isTied: boolean;
  /** Free-form, award-specific extra (e.g. { gw: 14 } for highest-gw-score). JSON-able. */
  detail?: Record<string, unknown>;
}

export interface AwardResult {
  key: string;
  label: string;
  scope: "season" | "gameweek" | "month" | "special";
  scopeKey: string;
  winners: AwardWinner[];
}

export interface AwardDefinition {
  key: string;
  label: string;
  scope: "season" | "gameweek" | "month" | "special";
  positions: number;
  /** Every scopeKey this award could ever produce, given the context (e.g. every "gw:N" it covers). */
  scopeKeys(ctx: AwardContext): string[];
  /** Which gameweeks must be settled before `scopeKey` may be frozen. */
  requiredGws(ctx: AwardContext, scopeKey: string): number[];
  /**
   * Null when the scope's inputs are not ready yet — the caller renders "not yet available".
   *
   * With `{ requireComplete: false }` the award is computed over whatever IS settled so far,
   * answering "who is leading?" instead of "who won?". The caller is then responsible for
   * labelling it as such — see AwardStatus in the winners UI. Same function either way, on
   * purpose: a leader and the eventual winner must never come from two implementations that can
   * silently disagree about eligibility, ties or the metric.
   *
   * Some awards cannot be led: a gameweek winner needs that gameweek's rows to exist at all, so
   * gw-winner ignores the flag.
   */
  compute(ctx: AwardContext, scopeKey: string, opts?: AwardComputeOptions): AwardResult | null;
}

export interface AwardComputeOptions {
  /**
   * Require every gameweek the award depends on to be settled (the default, and what the freeze
   * writer must always use). False computes a provisional "currently leading" result from partial
   * data — never write that to fpl_classic_awards.
   */
  requireComplete?: boolean;
}

function metricValue(row: AwardGwRow, metric: "net" | "gross"): number {
  return metric === "gross" ? row.points : row.netPoints;
}

/** Eligible for a gameweek award: present in the league from that gameweek onward. */
function eligibleForGw(entrant: AwardEntrantRow, gw: number): boolean {
  return entrant.firstSeenGw <= gw;
}
/** Eligible for a month award: present for the WHOLE month, not just part of it. */
function eligibleForMonth(entrant: AwardEntrantRow, monthGws: number[]): boolean {
  return entrant.firstSeenGw <= Math.min(...monthGws);
}

/** Rank a list of {entrantId, value} by value descending, competition ranking (1,1,3). */
function rankByValue(items: { entrantId: string; value: number }[]): { entrantId: string; value: number; rank: number }[] {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const out: { entrantId: string; value: number; rank: number }[] = [];
  let rank = 0;
  let seen = 0;
  let prev: number | null = null;
  for (const item of sorted) {
    seen++;
    if (prev === null || item.value !== prev) {
      rank = seen;
      prev = item.value;
    }
    out.push({ ...item, rank });
  }
  return out;
}

function topNWinners(ranked: { entrantId: string; value: number; rank: number }[], n: number): AwardWinner[] {
  return ranked
    .filter((r) => r.rank <= n)
    .map((r) => ({
      entrantId: r.entrantId,
      position: r.rank,
      value: r.value,
      isTied: ranked.filter((x) => x.rank === r.rank).length > 1,
    }));
}

/* ── season-podium: top 1..N by season total, N = ceil(entrantCount * winnerCutPercent / 100) ── */

const seasonPodium: AwardDefinition = {
  key: "season-podium",
  label: "Season Winners",
  scope: "season",
  positions: 3, // display cap for the "podium" framing; the full cut list is separate (standings page)
  scopeKeys: () => ["season"],
  requiredGws: (ctx) => Array.from({ length: 38 - ctx.startGameweek + 1 }, (_, i) => ctx.startGameweek + i),
  compute(ctx, _scopeKey, opts) {
    // Complete only when the season has actually ended. Relaxed, this is the current top of the
    // table over everything settled so far — the leaders, not the winners.
    if ((opts?.requireComplete ?? true) && ctx.settledThroughGw < 38) return null;
    const totals = new Map<string, number>();
    for (const row of ctx.rows) {
      const entrant = ctx.entrants.find((e) => e.id === row.entrantId);
      if (!entrant) continue;
      totals.set(row.entrantId, (totals.get(row.entrantId) ?? 0) + metricValue(row, ctx.metric));
    }
    const ranked = rankByValue([...totals.entries()].map(([entrantId, value]) => ({ entrantId, value })));
    return { key: this.key, label: this.label, scope: this.scope, scopeKey: "season", winners: topNWinners(ranked, this.positions) };
  },
};

/* ── gw-winner: the top scorer(s) of one gameweek ── */

const gwWinner: AwardDefinition = {
  key: "gw-winner",
  label: "Gameweek Winner",
  scope: "gameweek",
  positions: 1,
  scopeKeys: (ctx) => {
    const gws = new Set(ctx.rows.map((r) => r.gw));
    return [...gws].sort((a, b) => a - b).map((gw) => `gw:${gw}`);
  },
  requiredGws: (_ctx, scopeKey) => [Number(scopeKey.split(":")[1])],
  compute(ctx, scopeKey) {
    const gw = Number(scopeKey.split(":")[1]);
    if (!Number.isInteger(gw) || gw > ctx.settledThroughGw) return null;
    const rows = ctx.rows.filter((r) => r.gw === gw);
    const eligible = rows.filter((r) => {
      const e = ctx.entrants.find((x) => x.id === r.entrantId);
      return e && eligibleForGw(e, gw);
    });
    if (eligible.length === 0) return null;
    const ranked = rankByValue(eligible.map((r) => ({ entrantId: r.entrantId, value: metricValue(r, ctx.metric) })));
    return { key: this.key, label: this.label, scope: this.scope, scopeKey, winners: topNWinners(ranked, this.positions) };
  },
};

/* ── month-winner: top scorer(s) across a complete month ── */

const monthWinner: AwardDefinition = {
  key: "month-winner",
  label: "Monthly Winner",
  scope: "month",
  positions: 1,
  scopeKeys: (ctx) => ctx.months.map((m) => `month:${m.key}`),
  requiredGws: (ctx, scopeKey) => {
    const key = scopeKey.split(":").slice(1).join(":");
    return ctx.months.find((m) => m.key === key)?.gws ?? [];
  },
  compute(ctx, scopeKey, opts) {
    const key = scopeKey.split(":").slice(1).join(":");
    const month = ctx.months.find((m) => m.key === key);
    if (!month) return null;
    // A month award is only real once every one of its gameweeks is settled — a partially-settled
    // month would crown the wrong manager permanently. Relaxed, it reports who leads the month so
    // far, over the settled subset only.
    if ((opts?.requireComplete ?? true) && !month.gws.every((gw) => gw <= ctx.settledThroughGw)) return null;
    const countedGws = month.gws.filter((gw) => gw <= ctx.settledThroughGw);
    if (countedGws.length === 0) return null;

    const totals = new Map<string, number>();
    for (const row of ctx.rows) {
      if (!countedGws.includes(row.gw)) continue;
      const entrant = ctx.entrants.find((e) => e.id === row.entrantId);
      if (!entrant || !eligibleForMonth(entrant, month.gws)) continue;
      totals.set(row.entrantId, (totals.get(row.entrantId) ?? 0) + metricValue(row, ctx.metric));
    }
    if (totals.size === 0) return null;
    const ranked = rankByValue([...totals.entries()].map(([entrantId, value]) => ({ entrantId, value })));
    return { key: this.key, label: this.label, scope: this.scope, scopeKey, winners: topNWinners(ranked, this.positions) };
  },
};

/* ── highest-gw-score: the single biggest gameweek haul of the season ── */

const highestGwScore: AwardDefinition = {
  key: "highest-gw-score",
  label: "Highest Gameweek Score",
  scope: "special",
  positions: 1,
  scopeKeys: () => ["season"],
  requiredGws: (ctx) => Array.from({ length: 38 - ctx.startGameweek + 1 }, (_, i) => ctx.startGameweek + i),
  compute(ctx, _scopeKey, opts) {
    if ((opts?.requireComplete ?? true) && ctx.settledThroughGw < 38) return null;
    if (ctx.rows.length === 0) return null;
    const best = new Map<string, { value: number; gw: number }>();
    for (const row of ctx.rows) {
      const value = metricValue(row, ctx.metric);
      const cur = best.get(row.entrantId);
      if (!cur || value > cur.value) best.set(row.entrantId, { value, gw: row.gw });
    }
    const ranked = rankByValue([...best.entries()].map(([entrantId, v]) => ({ entrantId, value: v.value })));
    const winners = topNWinners(ranked, this.positions).map((w) => ({
      ...w,
      detail: { gw: best.get(w.entrantId)!.gw },
    }));
    return { key: this.key, label: this.label, scope: this.scope, scopeKey: "season", winners };
  },
};

/* ── best-bench: most points left on the bench across the season ── */

const bestBench: AwardDefinition = {
  key: "best-bench",
  label: "Best Bench Points",
  scope: "special",
  positions: 1,
  scopeKeys: () => ["season"],
  requiredGws: (ctx) => Array.from({ length: 38 - ctx.startGameweek + 1 }, (_, i) => ctx.startGameweek + i),
  compute(ctx, _scopeKey, opts) {
    if ((opts?.requireComplete ?? true) && ctx.settledThroughGw < 38) return null;
    const totals = new Map<string, number>();
    for (const row of ctx.rows) {
      totals.set(row.entrantId, (totals.get(row.entrantId) ?? 0) + row.benchPoints);
    }
    if (totals.size === 0) return null;
    const ranked = rankByValue([...totals.entries()].map(([entrantId, value]) => ({ entrantId, value })));
    return { key: this.key, label: this.label, scope: this.scope, scopeKey: "season", winners: topNWinners(ranked, this.positions) };
  },
};

export const AWARD_DEFINITIONS: AwardDefinition[] = [
  seasonPodium,
  gwWinner,
  monthWinner,
  highestGwScore,
  bestBench,
];

/** Every (award, scopeKey) pair this context could produce results for. */
export function allScopes(ctx: AwardContext): { award: AwardDefinition; scopeKey: string }[] {
  const out: { award: AwardDefinition; scopeKey: string }[] = [];
  for (const award of AWARD_DEFINITIONS) {
    for (const scopeKey of award.scopeKeys(ctx)) out.push({ award, scopeKey });
  }
  return out;
}

/** True when every gameweek an award scope needs is already settled — the freeze gate. */
export function isScopeReady(ctx: AwardContext, award: AwardDefinition, scopeKey: string): boolean {
  const needed = award.requiredGws(ctx, scopeKey);
  if (needed.length === 0) return false;
  return needed.every((gw) => gw <= ctx.settledThroughGw);
}

/** Compute every award this context can currently produce (frozen or provisional — caller decides). */
export function computeAllAwards(ctx: AwardContext): AwardResult[] {
  const out: AwardResult[] = [];
  for (const { award, scopeKey } of allScopes(ctx)) {
    const result = award.compute(ctx, scopeKey);
    if (result) out.push(result);
  }
  return out;
}
