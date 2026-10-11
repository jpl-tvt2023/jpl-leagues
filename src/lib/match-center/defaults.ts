/**
 * Which comparison the Match Center opens on when the URL does not say.
 *
 * Reached from the nav there is no fixture to start from, so a team opens on the fixture its
 * dashboard shows — `teamFixtureGameweek`, the same rule the dashboard route uses — with itself
 * on the left. A visitor has no dashboard; they get the first fixture of the gameweek the
 * Fixtures page would open on.
 *
 * Pure, so it unit-tests without a DB.
 */

import { pickDefaultGameweek, teamFixtureGameweek } from "@/lib/gameweeks/default-gw";

export interface MatchupFixture {
  gw: number;
  /** Gameweek deadline, epoch milliseconds. */
  deadline: number;
  homeTeamId: string;
  awayTeamId: string;
  group: string | null;
  isChallenge: boolean;
  hasResult: boolean;
}

export interface DefaultMatchup {
  gw: number;
  a: string;
  b: string;
}

/** Group A first, then a regular fixture before a challenge one; otherwise input order. */
function byListingOrder(x: MatchupFixture, y: MatchupFixture): number {
  return (x.group ?? "").localeCompare(y.group ?? "") || Number(x.isChallenge) - Number(y.isChallenge);
}

function oriented(f: MatchupFixture, team: string | null): DefaultMatchup {
  return f.awayTeamId === team
    ? { gw: f.gw, a: f.awayTeamId, b: f.homeTeamId }
    : { gw: f.gw, a: f.homeTeamId, b: f.awayTeamId };
}

/**
 * @param fixtures  the league's own fixtures (no cup fixtures), any order.
 * @param opts.gw   a gameweek the URL already fixed; only that gameweek is searched.
 * @param opts.team the team to open on, already checked to belong to this league.
 * @returns null when there is no fixture to open on at all.
 */
export function pickDefaultMatchup(
  fixtures: MatchupFixture[],
  opts: { gw?: number | null; team?: string | null; now: number },
): DefaultMatchup | null {
  const team = opts.team ?? null;
  const sorted = [...fixtures].sort(byListingOrder);

  if (team != null) {
    const theirs = sorted.filter((f) => f.homeTeamId === team || f.awayTeamId === team);
    const gw = opts.gw ?? teamFixtureGameweek(theirs.map((f) => ({ gw: f.gw, scored: f.hasResult })));
    // Home first, as the dashboard looks it up.
    const own =
      theirs.find((f) => f.gw === gw && f.homeTeamId === team) ??
      theirs.find((f) => f.gw === gw && f.awayTeamId === team);
    if (own) return oriented(own, team);
    // No fixture that gameweek (knocked out of the playoffs, or the season is over): the
    // dashboard falls back to its last result, so open on that one.
    if (opts.gw == null) {
      const before = theirs.filter((f) => f.gw < gw);
      const latestGw = before.length > 0 ? Math.max(...before.map((f) => f.gw)) : null;
      const last = theirs.find((f) => f.gw === latestGw);
      if (last) return oriented(last, team);
    }
  }

  let gw = opts.gw ?? null;
  if (gw == null) {
    const byGw = new Map<number, { deadline: number; resolved: boolean }>();
    for (const f of fixtures) {
      const seen = byGw.get(f.gw);
      byGw.set(f.gw, { deadline: f.deadline, resolved: (seen?.resolved ?? true) && f.hasResult });
    }
    gw = pickDefaultGameweek(
      [...byGw].map(([n, v]) => ({ gw: n, deadline: v.deadline, isFullyResolved: v.resolved })),
      opts.now,
    );
  }
  const first = sorted.find((f) => f.gw === gw);
  return first ? oriented(first, null) : null;
}
