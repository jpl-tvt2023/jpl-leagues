/**
 * League points a TVT chip gained its team in one gameweek — the figure beside each chip on the
 * fixtures page's Chips & hits card.
 *
 * "Gained" is the scorer's own number: what `gameweek_chips.pointsAwarded` stores, which is the
 * EXTRA points only (see api/gameweeks/[gw]/route.ts) — Win-Win 2 minus the natural result,
 * Double Pointer the natural result again, a Challenge its match points. So the card agrees with
 * the standings' CP/BP column. Plus one thing the stored figure leaves out: a Double Pointer that
 * took the group bonus doubled it, and that extra point is booked as BP rather than CP. The chip
 * still earned it, so it is counted here.
 *
 * A Win-Win on a win therefore reads 0 — the win already paid its 2 points (W +1, CP/BP +0 in the
 * table). `note: "match won"` says so on the card, so a 0 there is not read as a dud chip.
 *
 * While a gameweek is live nothing is stored yet, so Win-Win and Double Pointer go through
 * computeGameweekAwards on the one fixture side — the processor's own rules, which is what decides
 * whether a Win-Win is voided — and the figure is marked provisional. The group bonus is not
 * guessed at: it is decided across the whole group when the gameweek is scored.
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
  /** A few words shown beside the chip, e.g. "match won" for a Win-Win the win made redundant. */
  note?: string;
}

const PROVISIONAL = " Provisional until the gameweek is scored.";

function natural(own: number, opp: number): number {
  return own > opp ? 2 : own === opp ? 1 : 0;
}

function points(n: number, unit = "league point"): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "Won 180–150" once scored, "Winning 180–150" while live. */
function result(own: number, opp: number, live: boolean): string {
  const word = own > opp ? (live ? "Winning" : "Won") : own === opp ? (live ? "Level at" : "Drew") : live ? "Losing" : "Lost";
  return `${word} ${own}–${opp}`;
}

/** Null when there is nothing to go on yet: no score, no stored figure. */
export function tvtChipGain(input: TvtChipGainInput): TvtChipGain | null {
  if (input.isWasted) {
    return { points: 0, provisional: false, detail: input.wastedReason || "Wasted. No chip points were awarded." };
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
    return {
      points: base + bonus,
      provisional: false,
      detail: describe(input.chipType, own, opp, base + bonus, bonus > 0, false),
      ...matchWon(input.chipType, nat, false),
    };
  }

  if (!scored) return null;
  if (input.predictedWasteReason) {
    return { points: 0, provisional: true, detail: `May be wasted: ${input.predictedWasteReason}.${PROVISIONAL}` };
  }
  const hits = input.hits ?? 0;
  const award = computeGameweekAwards({
    fixtures: [{
      fixtureId: "f", groupId: null, homeTeamId: "side", awayTeamId: "opp",
      homeScore: own, awayScore: opp, homeHits: hits, awayHits: 0,
    }],
    chips: [{ chipId: "chip", teamId: "side", chipType: input.chipType, wastedReason: null }],
  }).chips[0];
  const gained = award?.pointsAwarded ?? 0;
  if (award?.hadNegativeHits) {
    return {
      points: gained,
      provisional: true,
      detail: `Void: the team has taken ${points(hits, "point")} of transfer hits, and Win-Win does not apply once a hit is taken.${PROVISIONAL}`,
    };
  }
  return {
    points: gained,
    provisional: true,
    detail: describe(input.chipType, own, opp, gained, false, true) + PROVISIONAL,
    ...matchWon(input.chipType, natural(own, opp), true),
  };
}

/** A Win-Win whose team won its match gained nothing — the win earned the 2 points. Said, not implied. */
function matchWon(chipType: string, nat: number | null, live: boolean): { note?: string } {
  return chipType === "W" && nat === 2 ? { note: live ? "winning" : "match won" } : {};
}

function describe(
  chipType: string,
  own: number | null,
  opp: number | null,
  gained: number,
  doubledBonus: boolean,
  live: boolean,
): string {
  if (own == null || opp == null) return `${points(gained)} awarded by the chip.`;
  const nat = natural(own, opp);
  const head = `${result(own, opp, live)}.`;
  if (chipType === "W") {
    if (nat === 2) {
      return live
        ? `${head} A win earns 2 league points on its own, so Win-Win would add none.`
        : `${head} The win had already earned 2 league points, so Win-Win added none.`;
    }
    return live
      ? `${head} Win-Win would raise the result from ${nat} to 2 league points.`
      : `${head} Win-Win raised the result from ${nat} to 2 league points.`;
  }
  if (nat === 0) {
    return `${head} With no match points to double, Double Pointer ${live ? "would add" : "added"} none.`;
  }
  const doubled = live
    ? `${head} Double Pointer would double the match points from ${nat} to ${nat * 2}.`
    : `${head} Double Pointer doubled the match points from ${nat} to ${nat * 2}.`;
  return doubledBonus ? `${doubled} It also doubled the group bonus from 1 to 2.` : doubled;
}

function challengeGain(input: TvtChipGainInput): TvtChipGain | null {
  const c = input.challenge ?? null;
  const stored = input.pointsAwarded ?? c?.pointsAwarded ?? null;
  if (stored == null && !c) return null;
  const gained = stored ?? natural(c!.challengerScore, c!.challengedScore);
  const provisional = stored == null;
  if (!c) return { points: gained, provisional, detail: `Challenge settled: ${points(gained, "chip point")} awarded.` };
  const { challengerScore: a, challengedScore: b, challengedTeamName: them } = c;
  const line = provisional
    ? a > b ? `Leading ${them} ${a}–${b} in the challenge.` : a === b ? `Level with ${them} at ${a}–${b} in the challenge.` : `Trailing ${them} ${a}–${b} in the challenge.`
    : a > b ? `Beat ${them} ${a}–${b} in the challenge.` : a === b ? `Drew with ${them} ${a}–${b} in the challenge.` : `Lost to ${them} ${a}–${b} in the challenge.`;
  return { points: gained, provisional, detail: provisional ? line + PROVISIONAL : line };
}
