/**
 * Canonical league-stage tiebreaker — the ONLY place this rule is defined.
 *
 *   1) Total League Points
 *   2) Most Wins
 *   3) Head-to-Head match points (points each team earned against the other)
 *   4) CP/BP — chips + bonus points (`cbpPoints`, the value the standings table renders)
 *   5) Total FPL Score (`pointsFor`)
 *
 * Matches the published rules (src/app/[leagueSlug]/_components/rules/shared.tsx).
 *
 * Two historic defects this signature exists to prevent:
 *   - Stopping at tier 4 meant a group where everyone is level (e.g. every GW1 winner on
 *     2 pts / 1 W / 0 H2H / 0 CP/BP) fell through to DB row order, i.e. alphabetical.
 *   - Tier 4 read the stored `teams.bonusPoints` column — bonus only, and frequently 0 —
 *     rather than the displayed CP/BP. `bonusPoints` is deliberately absent from
 *     `TeamStanding` so it cannot be reintroduced.
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
  pointsFor: number;
}

export function compareTiebreaker(a: TeamStanding, b: TeamStanding): number {
  // 1) Total League Points
  if (a.leaguePoints !== b.leaguePoints) {
    return b.leaguePoints - a.leaguePoints;
  }

  // 2) Most Wins
  if (a.wins !== b.wins) {
    return b.wins - a.wins;
  }

  // 3) Head-to-Head
  const aH2H = a.headToHeadRecord[b.teamId] || 0;
  const bH2H = b.headToHeadRecord[a.teamId] || 0;
  if (aH2H !== bH2H) {
    return bH2H - aH2H;
  }

  // 4) CP/BP (chips + bonus)
  if (a.cbpPoints !== b.cbpPoints) {
    return b.cbpPoints - a.cbpPoints;
  }

  // 5) Total FPL Score
  return b.pointsFor - a.pointsFor;
}
