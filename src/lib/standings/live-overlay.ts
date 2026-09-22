/**
 * The league table as it stands *right now*, with an in-progress gameweek folded in.
 *
 * Scoring is triggered by hand from the Operations tab, so between the final whistle and
 * someone pressing the button the table showed last week while the fixtures tab beside it
 * showed this week's live scores. This closes that gap without touching the settled
 * computation: `computeLeagueStageStandings` and both its caches are left exactly as they are,
 * and their output is folded forward here.
 *
 * Import-free but for `compareTiebreaker`, so the unit lane can exercise it without a database.
 * The same shape as `challenge-match-live.ts`, and for the same reason.
 *
 * ## Two rules that keep it honest
 *
 * **Only fixtures with no result are folded in.** A processed fixture is already counted in the
 * rows handed to this function; adding it again would double it. That one rule is also what
 * makes an admin's processing win automatically — the moment a result row is written, that
 * fixture stops being live and drops out of the overlay on the next read.
 *
 * **Chip and bonus points come from `computeGameweekAwards`**, the same function the gameweek
 * processor uses. They are not approximated and not omitted: a provisional table that quietly
 * left out a Win-Win, or a 75+ bonus worth a league point, would move teams past each other for
 * reasons the reader cannot see. The caller resolves the awards because deciding the bonus
 * needs every fixture in the group, settled ones included.
 *
 * What the overlay does NOT do is persist anything. These rows exist for one response.
 */

import { compareTiebreaker } from "@/lib/formats/tvt/tiebreaker";
import type { LeagueStageRow } from "@/lib/standings/league-stage";
import type { TeamAward } from "@/lib/formats/tvt/gameweek-awards";

/**
 * A live fixture, structurally. Deliberately narrower than `LiveFixtureScore` so this module
 * does not depend on the cache layer and a test can build one by hand.
 */
export interface LiveFixtureLike {
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homePlayers?: { name?: string; transferHits: number; fplScore?: number }[];
  awayPlayers?: { name?: string; transferHits: number; fplScore?: number }[];
}

export interface ApplyLiveOptions {
  /** The gameweek these fixtures belong to — stamped on any hit-penalty entry it creates. */
  gameweek: number;
  /**
   * `leagues.format`. Decides which of the settled table's carve-outs apply.
   *
   * Continental Championship scores nothing but the 2/1/0 ledger: its processor writes
   * `homeGotBonus: false` on every result and has no awarding logic at all, and
   * `league-stage.ts` skips hit penalties for it (:291) and reads `leaguePoints` from the stored
   * column (:401). Applying chips, a 75+ bonus or a hit penalty here would INVENT points its
   * settled table never gives — the provisional table has to agree with the real one by
   * construction, not by the caller remembering to pass an empty awards map.
   */
  leagueFormat: string;
}

/** More than this many raw hits in one gameweek costs the team a league point. */
const HIT_PENALTY_THRESHOLD = 12;

/** Natural league points for a side: win 2, draw 1, loss 0. */
function naturalPoints(own: number, opp: number): number {
  if (own > opp) return 2;
  if (own === opp) return 1;
  return 0;
}

/** A copy deep enough that nothing we mutate is shared with the caller's (possibly cached) rows. */
function cloneRow(row: LeagueStageRow): LeagueStageRow {
  return {
    ...row,
    headToHeadRecord: { ...row.headToHeadRecord },
    bpsEntries: [...row.bpsEntries],
    hitPenaltyGws: [...row.hitPenaltyGws],
    rawChips: [...row.rawChips],
    players: [...row.players],
  };
}

/**
 * Fold live fixtures into settled standings and re-sort.
 *
 * Returns a new array; the input rows are never mutated. Ranking (`groupRank`, `zone`) is NOT
 * applied here — the caller re-ranks with `rankAndZone` so there is exactly one implementation
 * of that, shared with the settled path.
 */
export function applyLiveFixtures(
  rows: readonly LeagueStageRow[],
  live: readonly LiveFixtureLike[],
  awards: ReadonlyMap<string, TeamAward>,
  opts: ApplyLiveOptions,
): LeagueStageRow[] {
  const next = rows.map(cloneRow);
  if (live.length === 0) return next;

  // The two carve-outs the settled computation makes for this format, mirrored here so the
  // provisional table cannot drift from it. See ApplyLiveOptions.leagueFormat.
  const scoresExtras = opts.leagueFormat !== "continental-championship";

  const byTeamId = new Map(next.map((r) => [r.teamId, r]));

  for (const fixture of live) {
    const home = byTeamId.get(fixture.homeTeamId);
    const away = byTeamId.get(fixture.awayTeamId);
    // A side missing from the table is a ghost team or another league's fixture; skip the
    // whole fixture rather than crediting one half of it.
    if (!home || !away) continue;

    const sides = [
      {
        row: home,
        opponent: away,
        own: fixture.homeScore,
        opp: fixture.awayScore,
        players: fixture.homePlayers ?? [],
      },
      {
        row: away,
        opponent: home,
        own: fixture.awayScore,
        opp: fixture.homeScore,
        players: fixture.awayPlayers ?? [],
      },
    ];

    for (const side of sides) {
      const { row } = side;
      const natural = naturalPoints(side.own, side.opp);

      row.played += 1;
      row.pointsFor += side.own;
      row.pointsAgainst += side.opp;
      row.pointsDiff = row.pointsFor - row.pointsAgainst;

      // Tier 6: net of hits, NO captain doubling, so it cannot be read off `side.own` (which
      // is captain-doubled). The live cache carries `fplScore` per player already. With no
      // per-player detail there is nothing to sum, so fall back to the match score, matching
      // the settled path's fallback for results with no stored breakdown.
      row.fplNetScore += side.players.length > 0
        ? side.players.reduce((sum, p) => sum + (p.fplScore ?? 0) - p.transferHits, 0)
        : side.own;

      if (side.own > side.opp) row.wins += 1;
      else if (side.own === side.opp) row.draws += 1;
      else row.losses += 1;

      // Tier 4 compares match points earned against a specific opponent, and it is the
      // NATURAL result that counts there — the settled path does the same. Omit this and two
      // teams level on points and wins are separated by a head-to-head that pretends this
      // gameweek has not happened.
      row.headToHeadRecord[side.opponent.teamId] =
        (row.headToHeadRecord[side.opponent.teamId] ?? 0) + natural;

      // Chips contribute only their EXTRA over the natural result, exactly as
      // `gameweekChips.pointsAwarded` stores it, so the arithmetic matches the settled table's.
      // The bonus is deliberately NOT credited here — see the reconciliation pass below.
      const award = scoresExtras ? awards.get(row.teamId) : undefined;
      const chipExtra = award ? award.matchPoints - award.naturalMatchPoints : 0;

      row.chipPoints += chipExtra;
      row.cbpPoints += chipExtra;

      // One penalty point per player over the threshold, matching the settled rule — two
      // offenders in the same gameweek cost two points, not one.
      let hitPenalty = 0;
      for (const player of scoresExtras ? side.players : []) {
        if (player.transferHits > HIT_PENALTY_THRESHOLD) {
          row.hitPenaltyGws.push({
            gameweek: opts.gameweek,
            playerName: player.name ?? "",
            hits: player.transferHits,
          });
          hitPenalty += 1;
        }
      }
      row.hitPenaltyTotal += hitPenalty;

      // A delta, not a recompute — and that is what makes this work for both formats. TVT
      // derives `leaguePoints` from W/D/L while Continental Championship carries the stored
      // `teams.leaguePoints` column, but both award 2/1/0, so adding the difference is right
      // for either where recomputing from scratch would be wrong for one of them.
      row.leaguePoints += natural + chipExtra - hitPenalty;
    }
  }

  if (scoresExtras) reconcileBonus(next, awards, opts.gameweek);

  next.sort(compareTiebreaker);
  return next;
}

/**
 * Settle this gameweek's bonus across EVERY row, not just the live ones.
 *
 * The bonus is the largest 75+ margin in a group, which means a live fixture can take it away
 * from a team whose own fixture was processed earlier in the same gameweek. Crediting only live
 * sides would leave that team's bonus standing alongside the new one, and the provisional table
 * would show the group's bonus twice.
 *
 * So each row is moved by the DIFFERENCE between what it currently carries for this gameweek
 * and what the awards say it should. `bpsEntries` is the per-gameweek record of bonus already
 * counted, which makes a team with no result yet start from zero and fall out as a no-op when
 * nothing changes.
 */
function reconcileBonus(
  rows: LeagueStageRow[],
  awards: ReadonlyMap<string, TeamAward>,
  gameweek: number,
): void {
  for (const row of rows) {
    const want = awards.get(row.teamId)?.bonusPoints ?? 0;
    const existingIndex = row.bpsEntries.findIndex((e) => e.gameweek === gameweek);
    const have = existingIndex >= 0 ? row.bpsEntries[existingIndex].points : 0;
    if (want === have) continue;

    row.cbpPoints += want - have;
    row.leaguePoints += want - have;

    // Keep the CP/BP tooltip telling the same story as the number beside it.
    if (want === 0) row.bpsEntries.splice(existingIndex, 1);
    else if (existingIndex >= 0) row.bpsEntries[existingIndex] = { gameweek, points: want };
    else {
      row.bpsEntries.push({ gameweek, points: want });
      row.bpsEntries.sort((a, b) => a.gameweek - b.gameweek);
    }
  }
}
