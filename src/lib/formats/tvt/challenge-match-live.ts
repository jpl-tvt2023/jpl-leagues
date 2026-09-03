/**
 * TVT Challenge Chip — assembling the challenge match while the gameweek is still live.
 *
 * `challenge-match.ts` rebuilds a challenge from persisted `results` rows, which only exist once
 * the gameweek has been scored. That left the tooltip showing a bare "challenging X" string for
 * the whole week the challenge was actually being played — the one week anybody cares about it.
 *
 * The live numbers are already on the client: the fixtures page polls `/api/fixtures/live` and
 * holds `LiveFixtureScore[]` for the whole gameweek, and each of those carries exactly the four
 * fields a challenge side needs (team id, team name, score, per-player array). So the live match
 * is assembled in the browser from data already in hand — no extra FPL call, no extra DB read, no
 * server cache to invalidate.
 *
 * ⚠️ A live match is NOT a result. `pointsAwarded` stays null and `outcome` is "live", never
 * "won"/"drew"/"lost": the chip's points are decided by the scorer when the gameweek concludes,
 * and a leading challenger who ends up losing must not have been told they won. Callers must also
 * prefer a persisted `ChallengeMatch` over a live one whenever both exist — a settled result never
 * gets overwritten by a live snapshot.
 *
 * Pure and import-free (bar a type) for the same reason as `challenge-match.ts`: the repo's
 * `test:unit` suite runs pure functions only, with no database.
 */

import type { ChallengeMatch } from "./challenge-match";

/** One side of a live challenge, projected from a `LiveFixtureScore`'s home or away half. */
export interface LiveChallengeSide {
  teamId: string;
  teamName: string;
  score: number;
  /** The side's per-player array, in the shape `PlayerBreakdown` renders. */
  players: unknown[];
}

/** The chip fields needed to locate both sides. */
export interface LiveChallengeChip {
  teamId: string;
  challengedTeamId: string | null;
  /** The gameweek the chip was played in — always the live one for a live match. */
  gameweek: number;
}

/**
 * Index both halves of every live fixture by team id.
 *
 * Takes the whole gameweek's fixtures rather than the challenger's own: the challenged team sits
 * in a different group, so their score is never on the challenger's fixture.
 */
export function indexLiveSides(
  liveScores: {
    homeTeamId: string;
    awayTeamId: string;
    homeTeamName: string;
    awayTeamName: string;
    homeScore: number;
    awayScore: number;
    homePlayers: unknown[];
    awayPlayers: unknown[];
  }[],
): Map<string, LiveChallengeSide> {
  const out = new Map<string, LiveChallengeSide>();
  for (const f of liveScores) {
    out.set(f.homeTeamId, {
      teamId: f.homeTeamId,
      teamName: f.homeTeamName,
      score: f.homeScore,
      players: f.homePlayers ?? [],
    });
    out.set(f.awayTeamId, {
      teamId: f.awayTeamId,
      teamName: f.awayTeamName,
      score: f.awayScore,
      players: f.awayPlayers ?? [],
    });
  }
  return out;
}

/**
 * Build the in-progress challenge match for one chip, or null when it cannot be built.
 *
 * Null whenever either side is missing — a team on a bye, or live scores that have not loaded.
 * Same rule as the settled path: half a scoreline is worse than none.
 */
export function buildLiveChallengeMatch(
  chip: LiveChallengeChip,
  sidesByTeamId: Map<string, LiveChallengeSide>,
): ChallengeMatch | null {
  if (!chip.challengedTeamId) return null;

  const challenger = sidesByTeamId.get(chip.teamId);
  const challenged = sidesByTeamId.get(chip.challengedTeamId);
  if (!challenger || !challenged) return null;

  return {
    gameweek: chip.gameweek,
    challengerTeamName: challenger.teamName,
    challengedTeamName: challenged.teamName,
    challengerScore: challenger.score,
    challengedScore: challenged.score,
    // Stringified because PlayerBreakdown reads these off a synthetic fixture's `result`, whose
    // player-score fields are the raw JSON the database stores. Matching that shape is what lets
    // the live and settled tooltips share one renderer.
    challengerPlayerScores: JSON.stringify(challenger.players),
    challengedPlayerScores: JSON.stringify(challenged.players),
    pointsAwarded: null,
    outcome: "live",
  };
}
