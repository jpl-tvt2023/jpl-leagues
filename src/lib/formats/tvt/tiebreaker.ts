/**
 * Canonical league-stage tiebreaker — the ONLY place this rule is defined.
 *
 *   1) Total League Points
 *   2) Total Overall Score (`pointsFor`, the value the standings table's "Scores" column renders)
 *   3) Most Wins
 *   4) Head-to-Head match points (points each team earned against the other)
 *   5) CP/BP — chips + bonus points (`cbpPoints`, the value the standings table renders)
 *   6) Total FPL Score (`fplNetScore`)
 *
 * Matches the published rules (src/app/[leagueSlug]/_components/rules/shared.tsx).
 *
 * Tiers 2 and 6 are both "scores" and are NOT the same number:
 *   - `pointsFor` is the match score — each player's points net of hits, WITH the captain
 *     doubled, and net of any carry-forward hit deduction. It is what decides W/D/L.
 *   - `fplNetScore` is the flat sum of each player's points net of hits, with NO captain
 *     doubling. Reach for `fplScore - transferHits` when computing it, never `finalScore`.
 * Because `pointsFor` is a four-figure cumulative total, tier 2 settles nearly every tie in
 * practice and tiers 3-6 are rarely reached. That is the rule as published, not an accident.
 *
 * Three historic defects this signature exists to prevent:
 *   - Stopping at the CP/BP tier meant a group where everyone is level (e.g. every GW1 winner
 *     on 2 pts / 1 W / 0 H2H / 0 CP/BP) fell through to DB row order, i.e. alphabetical.
 *   - That tier read the stored `teams.bonusPoints` column — bonus only, and frequently 0 —
 *     rather than the displayed CP/BP. `bonusPoints` is deliberately absent from
 *     `TeamStanding` so it cannot be reintroduced.
 *   - The last tier used to compare `pointsFor`, which left "Total Overall Score" unimplemented
 *     and made the final tier a duplicate of the tier that should have run second. Teams were
 *     ordered on wins while a higher overall score sat one row below.
 *
 * Every consumer must call this: /api/standings (displayed table + the previous-GW
 * snapshot behind the ▲/▼ arrows), TVT playoff seeding, and the bracket preview.
 *
 * This module deliberately has NO imports. It used to live in scoring.ts, which pulls
 * in the FPL client and through it the DB — meaning the one piece of pure logic most
 * worth unit-testing could not be loaded without a live DATABASE_URL.
 */

export interface TeamStanding {
  teamId: string;
  leaguePoints: number;
  wins: number;
  /** teamId -> match points (W=2, D=1, L=0) this team earned against them. */
  headToHeadRecord: Record<string, number>;
  cbpPoints: number;
  /** Tier 2 "Total Overall Score" — the match score, captain doubled. The "Scores" column. */
  pointsFor: number;
  /** Tier 6 "Total FPL Score" — each player's points net of hits, NO captain doubling. */
  fplNetScore: number;
}

export function compareTiebreaker(a: TeamStanding, b: TeamStanding): number {
  // 1) Total League Points
  if (a.leaguePoints !== b.leaguePoints) {
    return b.leaguePoints - a.leaguePoints;
  }

  // 2) Total Overall Score — the "Scores" column, captain doubling included
  if (a.pointsFor !== b.pointsFor) {
    return b.pointsFor - a.pointsFor;
  }

  // 3) Most Wins
  if (a.wins !== b.wins) {
    return b.wins - a.wins;
  }

  // 4) Head-to-Head
  const aH2H = a.headToHeadRecord[b.teamId] || 0;
  const bH2H = b.headToHeadRecord[a.teamId] || 0;
  if (aH2H !== bH2H) {
    return bH2H - aH2H;
  }

  // 5) CP/BP (chips + bonus)
  if (a.cbpPoints !== b.cbpPoints) {
    return b.cbpPoints - a.cbpPoints;
  }

  // 6) Total FPL Score — no captain doubling
  return b.fplNetScore - a.fplNetScore;
}
