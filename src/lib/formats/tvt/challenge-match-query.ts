/**
 * DB wrapper for the Challenge Chip match derivation.
 *
 * Split from `challenge-match.ts` on purpose: that file stays import-free so it unit-tests
 * without a database (same reasoning as gameweeks/default-gw.ts). All the pure logic lives
 * there; this file only fetches the rows it needs.
 */

import { db } from "@/lib/db";
import { fixtures, gameweeks, teams } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  resolveChallengeMatches,
  resultKey,
  type ChallengeChipRow,
  type ChallengeMatch,
  type TeamGwResult,
} from "./challenge-match";

/**
 * Resolve the challenge match for each Challenge Chip, keyed by chip id.
 *
 * `chips` must already be filtered to chipType "C" AND past their gameweek's deadline — the
 * disclosure gate is the caller's job because it also governs the non-challenge chips they
 * are rendering alongside these.
 *
 * One query per table regardless of how many chips are passed; no N+1. The gameweek ids
 * already scope the reads to a single league, so no leagueId is needed.
 */
export async function buildChallengeMatches(
  chips: ChallengeChipRow[],
): Promise<Map<string, ChallengeMatch>> {
  const withTarget = chips.filter((c) => c.challengedTeamId);
  if (withTarget.length === 0) return new Map();

  const gameweekIds = [...new Set(withTarget.map((c) => c.gameweekId))];
  const teamIds = [
    ...new Set(withTarget.flatMap((c) => [c.teamId, c.challengedTeamId as string])),
  ];

  const [gwRows, teamRows, fixtureRows] = await Promise.all([
    db
      .select({ id: gameweeks.id, number: gameweeks.number })
      .from(gameweeks)
      .where(inArray(gameweeks.id, gameweekIds)),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(inArray(teams.id, teamIds)),
    // Every fixture in the affected gameweeks, with its result. The challenged team sits in a
    // different group, so this cannot be narrowed to the challenger's own fixtures.
    db.query.fixtures.findMany({
      where: inArray(fixtures.gameweekId, gameweekIds),
      with: { result: true },
    }),
  ]);

  const gameweekNumberById = new Map(gwRows.map((g) => [g.id, g.number]));
  const teamNameById = new Map(teamRows.map((t) => [t.id, t.name]));

  // Index each team's own score for the gameweek, from whichever side of their fixture they
  // played. This is the same effective (carry-forward adjusted) score the challenge scorer used.
  const resultsByGwTeam = new Map<string, TeamGwResult>();
  for (const f of fixtureRows) {
    if (!f.result) continue;
    resultsByGwTeam.set(resultKey(f.gameweekId, f.homeTeamId), {
      score: f.result.homeScore,
      playerScores: f.result.homePlayerScores ?? null,
    });
    resultsByGwTeam.set(resultKey(f.gameweekId, f.awayTeamId), {
      score: f.result.awayScore,
      playerScores: f.result.awayPlayerScores ?? null,
    });
  }

  return resolveChallengeMatches(withTarget, gameweekNumberById, teamNameById, resultsByGwTeam);
}
