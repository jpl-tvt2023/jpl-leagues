/**
 * What every team earns from one gameweek: match points, chip adjustments, and the group bonus.
 *
 * Import-free on purpose, like `tiebreaker.ts` beside it, so the unit lane can load it without a
 * database or an FPL client — and so the live standings overlay can call exactly the same code
 * the gameweek processor does. A provisional table computed from different rules than the
 * processed one is worse than no provisional table at all.
 *
 * ## Why this takes the WHOLE gameweek at once
 *
 * The bonus is a comparison ACROSS a group — the single largest 75+ winning margin takes it —
 * so it cannot be decided one fixture at a time. The processor used to collect margins only
 * from the fixtures it happened to be processing in that pass, and then award the best of
 * *that batch*. A gameweek processed in two passes therefore awarded the group bonus twice, to
 * two different teams: once for the first batch's best margin, again for the second's.
 *
 * That is not hypothetical. The processor skips fixtures that already have a result, so any
 * gameweek where some fixtures errored and a later run picked up the rest hit it — and an
 * automatic daily run makes partial passes routine rather than rare.
 *
 * Passing every fixture, settled and new alike, is what makes the answer a property of the
 * gameweek rather than of the order someone happened to process it in. Run it over the same
 * gameweek any number of times, in any split, and it returns the same awards.
 */

/** One fixture's final (or live) state. Scores are EFFECTIVE — after carry-forward hit deduction. */
export interface AwardFixtureInput {
  fixtureId: string;
  /** Null for formats without groups; such fixtures never compete for the bonus. */
  groupId: string | null;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  /** Raw transfer hits summed across that side's managers. Win-Win is void if this is non-zero. */
  homeHits: number;
  awayHits: number;
  /**
   * Double Pointer, for a fixture whose chips are already settled.
   *
   * A gameweek's bonus depends on every fixture in the group, including ones processed on an
   * earlier pass — but those fixtures' chips have already been decided and written, and must not
   * be re-derived here. The caller passes `results.homeUsedDoublePointer` instead, which is the
   * recorded answer, and this overrides anything the chip list would imply.
   *
   * Omit for a fixture being scored now; Double Pointer is then taken from `chips`.
   *
   * ⚠️ A fixture passed this way contributes its margin and its Double Pointer status to the
   * bonus, and nothing else. Its `matchPoints` in the result is NOT authoritative — the caller
   * supplies no chips for it, so the figure is the natural result rather than the chip-adjusted
   * one already recorded against it. Read those from the stored result row, not from here.
   */
  homeUsedDoublePointer?: boolean;
  awayUsedDoublePointer?: boolean;
}

/** A declared TVT chip. `wastedReason` is the FPL chip-clash verdict, resolved by the caller. */
export interface AwardChipInput {
  chipId: string;
  teamId: string;
  /** "W" = Win-Win, "D" = Double Pointer, "C" = Challenge (scored elsewhere). */
  chipType: string;
  wastedReason: string | null;
}

export interface TeamAward {
  teamId: string;
  fixtureId: string;
  /** 2 / 1 / 0 before any chip. */
  naturalMatchPoints: number;
  /** After Win-Win and Double Pointer. */
  matchPoints: number;
  usedDoublePointer: boolean;
  gotBonus: boolean;
  /** 0, or 1, or 2 when the bonus winner played Double Pointer. */
  bonusPoints: number;
  /** What this gameweek adds to the team's league points: matchPoints + bonusPoints. */
  leaguePoints: number;
}

/** The row the processor should write back to `gameweek_chips`. `pointsAwarded` is EXTRA only. */
export interface ChipAward {
  chipId: string;
  teamId: string;
  chipType: string;
  pointsAwarded: number;
  wastedReason: string | null;
  hadNegativeHits: boolean;
}

export interface GameweekAwards {
  byTeam: Map<string, TeamAward>;
  chips: ChipAward[];
}

export interface GameweekAwardsInput {
  fixtures: readonly AwardFixtureInput[];
  chips: readonly AwardChipInput[];
}

/** Natural league points for a side: win 2, draw 1, loss 0. */
function naturalPoints(own: number, opp: number): number {
  if (own > opp) return 2;
  if (own === opp) return 1;
  return 0;
}

export function computeGameweekAwards(input: GameweekAwardsInput): GameweekAwards {
  const byTeam = new Map<string, TeamAward>();
  const chipAwards: ChipAward[] = [];

  const chipsByTeam = new Map<string, AwardChipInput[]>();
  for (const chip of input.chips) {
    const list = chipsByTeam.get(chip.teamId);
    if (list) list.push(chip);
    else chipsByTeam.set(chip.teamId, [chip]);
  }

  // groupId -> the 75+ winners in it, for the bonus comparison further down.
  const groupMargins = new Map<string, { teamId: string; margin: number }[]>();

  for (const fixture of input.fixtures) {
    const sides = [
      {
        teamId: fixture.homeTeamId,
        own: fixture.homeScore,
        opp: fixture.awayScore,
        hits: fixture.homeHits,
        settledDoublePointer: fixture.homeUsedDoublePointer,
      },
      {
        teamId: fixture.awayTeamId,
        own: fixture.awayScore,
        opp: fixture.homeScore,
        hits: fixture.awayHits,
        settledDoublePointer: fixture.awayUsedDoublePointer,
      },
    ];

    for (const side of sides) {
      const natural = naturalPoints(side.own, side.opp);
      let matchPoints = natural;
      let usedDoublePointer = side.settledDoublePointer ?? false;

      // Chips are applied in the order given, which is the order the processor's own loop
      // applied them. A team holding both W and D is not expected, but if it ever happened the
      // last one written would win there too — so this must not silently improve on it.
      for (const chip of chipsByTeam.get(side.teamId) ?? []) {
        // The clash check comes before any chip's own rules. A wasted chip is spent but awards
        // nothing, so the side keeps its natural result.
        if (chip.wastedReason) {
          chipAwards.push({
            chipId: chip.chipId,
            teamId: chip.teamId,
            chipType: chip.chipType,
            pointsAwarded: 0,
            wastedReason: chip.wastedReason,
            hadNegativeHits: false,
          });
          continue;
        }

        if (chip.chipType === "W") {
          if (side.hits > 0) {
            // Win-Win is void for a side that took any transfer hit: spent, no effect.
            chipAwards.push({
              chipId: chip.chipId,
              teamId: chip.teamId,
              chipType: chip.chipType,
              pointsAwarded: 0,
              wastedReason: null,
              hadNegativeHits: true,
            });
          } else {
            // 2 points regardless of result. A Win-Win side can still take the bonus (2+1=3).
            matchPoints = 2;
            chipAwards.push({
              chipId: chip.chipId,
              teamId: chip.teamId,
              chipType: chip.chipType,
              pointsAwarded: 2 - natural,
              wastedReason: null,
              hadNegativeHits: false,
            });
          }
        } else if (chip.chipType === "D") {
          matchPoints = natural * 2;
          usedDoublePointer = true;
          chipAwards.push({
            chipId: chip.chipId,
            teamId: chip.teamId,
            chipType: chip.chipType,
            pointsAwarded: natural,
            wastedReason: null,
            hadNegativeHits: false,
          });
        }
        // "C" (Challenge) is scored on its own path and contributes nothing here — but a
        // wasted one is still recorded above, exactly as the processor does.
      }

      byTeam.set(side.teamId, {
        teamId: side.teamId,
        fixtureId: fixture.fixtureId,
        naturalMatchPoints: natural,
        matchPoints,
        usedDoublePointer,
        gotBonus: false,
        bonusPoints: 0,
        leaguePoints: matchPoints,
      });
    }

    // Only a winning side with a 75+ margin enters the bonus comparison.
    const margin = Math.abs(fixture.homeScore - fixture.awayScore);
    if (fixture.groupId && margin >= 75 && fixture.homeScore !== fixture.awayScore) {
      const winnerId =
        fixture.homeScore > fixture.awayScore ? fixture.homeTeamId : fixture.awayTeamId;
      const list = groupMargins.get(fixture.groupId);
      if (list) list.push({ teamId: winnerId, margin });
      else groupMargins.set(fixture.groupId, [{ teamId: winnerId, margin }]);
    }
  }

  // Per group: the largest margin takes the bonus, ties share it.
  for (const margins of groupMargins.values()) {
    if (margins.length === 0) continue;
    let highest = margins[0].margin;
    for (const m of margins) if (m.margin > highest) highest = m.margin;

    for (const m of margins) {
      if (m.margin !== highest) continue;
      const award = byTeam.get(m.teamId);
      if (!award) continue;
      // Double Pointer doubles the bonus too: (2+1) x 2 = 6 for the gameweek.
      const bonusPoints = award.usedDoublePointer ? 2 : 1;
      award.gotBonus = true;
      award.bonusPoints = bonusPoints;
      award.leaguePoints = award.matchPoints + bonusPoints;
    }
  }

  return { byTeam, chips: chipAwards };
}
