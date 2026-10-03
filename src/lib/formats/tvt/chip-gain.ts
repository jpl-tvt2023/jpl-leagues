/**
 * League points a TVT chip gained its team in one gameweek — the figure beside each chip on the
 * fixtures page's Chips & hits card.
 *
 * "Gained" is the scorer's own number: what `gameweek_chips.pointsAwarded` stores, which is the
 * EXTRA points only (see api/gameweeks/[gw]/route.ts) — Win-Win 2 minus the natural result,
 * Double Pointer the natural result again, a Challenge its match points. Plus one thing the
 * stored figure leaves out: a Double Pointer that took the group bonus doubled it, and that extra
 * point is booked as BP rather than CP. The chip still earned it, so it is counted here.
 *
 * While a gameweek is live nothing is stored yet, so Win-Win and Double Pointer go through
 * computeGameweekAwards on the one fixture side — the processor's own rules — and the figure is
 * marked provisional. The group bonus is not guessed at: it is decided across the whole group
 * when the gameweek is scored.
 *
 * Import-free apart from gameweek-awards (itself import-free), so the unit lane can run it.
 */

import { computeGameweekAwards } from "./gameweek-awards";

export interface TvtChipGainInput {
  /** "W" Win-Win, "D" Double Pointer, "C" Challenge. */
  chipType: string;
  /** The scorer's verdict: spent, but awarded nothing. */
  isWasted: boolean;
  /** Why, when the scorer recorded it. */
  wastedReason?: string | null;
  /**
   * `gameweek_chips.pointsAwarded` once processed. Null before that — and undefined from a
   * fixtures payload cached before the field existed, which is why the settled branch can still
   * derive the figure from the result.
   */
  pointsAwarded?: number | null;
  /** The side's own fixture score, stored or live. Null before there is one, or on a bye. */
  own: number | null;
  opp: number | null;
  /** `own`/`opp` come from a stored result rather than live scores. */
  settled: boolean;
  /** Live only: transfer hits summed across the side. Any hit voids Win-Win. */
  hits?: number;
  /** Live only: an FPL chip clash predicted from chip history, which will waste the chip. */
  predictedWasteReason?: string | null;
  /** Settled only: the side took the group bonus while on Double Pointer, which doubled it. */
  doubledBonus?: boolean;
  /** Challenge only: the rebuilt challenge, settled or live. */
  challenge?: {
    challengedTeamName: string;
    challengerScore: number;
    challengedScore: number;
    pointsAwarded: number | null;
  } | null;
}

export interface TvtChipGain {
  points: number;
  /** Worked out from live scores; the scorer decides it when the gameweek is scored. */
  provisional: boolean;
  /** One line saying where the figure came from, for the tooltip. */
  detail: string;
}

const PROVISIONAL = " · provisional until the gameweek is scored";

function natural(own: number, opp: number): number {
  return own > opp ? 2 : own === opp ? 1 : 0;
}

function verb(own: number, opp: number): string {
  return own > opp ? "Won" : own === opp ? "Drew" : "Lost";
}

/** Null when there is nothing to go on yet: no score, no stored figure. */
export function tvtChipGain(input: TvtChipGainInput): TvtChipGain | null {
  if (input.isWasted) {
    return { points: 0, provisional: false, detail: input.wastedReason || "Wasted — no chip points" };
  }
  if (input.chipType === "C") return challengeGain(input);
  if (input.chipType !== "W" && input.chipType !== "D") return null;

  const { own, opp } = input;
  const scored = own != null && opp != null;
  const stored = input.pointsAwarded ?? null;
  const bonus = input.chipType === "D" && input.doubledBonus ? 1 : 0;

  if (stored != null || input.settled) {
    if (stored == null && !scored) return null;
    const nat = scored ? natural(own, opp) : null;
    const base = stored ?? (input.chipType === "W" ? 2 - nat! : nat!);
    return { points: base + bonus, provisional: false, detail: describe(input.chipType, own, opp, base + bonus, bonus > 0) };
  }

  if (!scored) return null;
  if (input.predictedWasteReason) {
    return { points: 0, provisional: true, detail: `May be wasted — ${input.predictedWasteReason}${PROVISIONAL}` };
  }
  const hits = input.hits ?? 0;
  const award = computeGameweekAwards({
    fixtures: [{
      fixtureId: "f", groupId: null, homeTeamId: "side", awayTeamId: "opp",
      homeScore: own, awayScore: opp, homeHits: hits, awayHits: 0,
    }],
    chips: [{ chipId: "chip", teamId: "side", chipType: input.chipType, wastedReason: null }],
  }).chips[0];
  const points = award?.pointsAwarded ?? 0;
  const detail = award?.hadNegativeHits
    ? `Void — ${hits} pts of transfer hits`
    : describe(input.chipType, own, opp, points, false);
  return { points, provisional: true, detail: detail + PROVISIONAL };
}

function describe(chipType: string, own: number | null, opp: number | null, points: number, doubledBonus: boolean): string {
  if (own == null || opp == null) return `+${points} league pts`;
  const nat = natural(own, opp);
  const head = `${verb(own, opp)} ${own}–${opp}`;
  if (chipType === "W") return `${head} · league pts ${nat} → 2`;
  return `${head} · match pts ${nat} → ${nat * 2}${doubledBonus ? " · bonus 1 → 2" : ""}`;
}

function challengeGain(input: TvtChipGainInput): TvtChipGain | null {
  const c = input.challenge ?? null;
  const stored = input.pointsAwarded ?? c?.pointsAwarded ?? null;
  if (stored == null && !c) return null;
  const points = stored ?? natural(c!.challengerScore, c!.challengedScore);
  const provisional = stored == null;
  if (!c) return { points, provisional, detail: `Challenge · +${points} chip pts` };
  const { challengerScore: a, challengedScore: b, challengedTeamName: them } = c;
  const line = a > b ? `Beat ${them} ${a}–${b}` : a === b ? `Drew with ${them} ${a}–${b}` : `Lost to ${them} ${a}–${b}`;
  return { points, provisional, detail: provisional ? line + PROVISIONAL : line };
}
