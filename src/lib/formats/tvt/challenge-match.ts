/**
 * TVT Challenge Chip — reconstructing the challenge match.
 *
 * The Challenge Chip does NOT create a fixture. `fixtures.isChallenge` is dead code: nothing
 * writes it. The scorer (api/gameweeks/[gw]/route.ts) recomputes both teams' scores in memory,
 * compares them, and persists only `gameweekChips.pointsAwarded` — the two scorelines are
 * discarded. So there is no row to read the challenge back from.
 *
 * The numbers are still exactly recoverable, because each side's own regular fixture stores the
 * identical quantity. Both paths compute `calculateTVTTeamScore(...) - carryForward` and the
 * normal path saves it as `results.homeScore` / `awayScore`, alongside the per-player JSON. So a
 * challenge match is assembled from the two teams' own results for that gameweek.
 *
 * Deriving rather than storing is deliberate: new columns could not be backfilled without
 * re-running FPL scoring, and this way every chip already played is covered.
 *
 * ⚠️ A challenge is NOT a league fixture. It contributes nothing to played/won/pointsFor — only
 * `pointsAwarded` into the team's CP/BP. Never turn this into a real `fixtures` row: the league
 * table would count it as a match and double-count the chip's points.
 */

/** Which side of their own fixture a team sat on, and what they scored. */
export interface TeamGwResult {
  score: number;
  /** Raw JSON string, the shape PlayerBreakdown already parses. */
  playerScores: string | null;
}

export interface ChallengeChipRow {
  id: string;
  teamId: string;
  challengedTeamId: string | null;
  gameweekId: string;
  pointsAwarded: number | null;
  isProcessed: boolean;
}

export type ChallengeOutcome = "won" | "drew" | "lost" | "pending";

export interface ChallengeMatch {
  gameweek: number;
  challengerTeamName: string;
  challengedTeamName: string;
  challengerScore: number;
  challengedScore: number;
  challengerPlayerScores: string | null;
  challengedPlayerScores: string | null;
  /** 2 won, 1 drew, 0 lost. Null while the chip is unprocessed. */
  pointsAwarded: number | null;
  outcome: ChallengeOutcome;
}

/** Key for the per-gameweek, per-team result index. */
export function resultKey(gameweekId: string, teamId: string): string {
  return gameweekId + "::" + teamId;
}

/**
 * Map a processed chip's stored points to a human outcome.
 *
 * Note a DRAWN challenge awards 1, not 0 — the challenge reuses the generic TVT
 * `determineMatchResult`, whose draw case is 1 point each. The written rules only mention
 * "+2 if you win", so this is surfaced honestly rather than rounded away.
 */
export function challengeOutcome(pointsAwarded: number | null, isProcessed: boolean): ChallengeOutcome {
  if (!isProcessed || pointsAwarded === null) return "pending";
  if (pointsAwarded >= 2) return "won";
  if (pointsAwarded === 1) return "drew";
  return "lost";
}

/**
 * Pure core: assemble challenge matches from already-loaded rows.
 *
 * Separated from the DB access so it unit-tests without a database (the repo's `test:unit`
 * suite is pure-function only). `buildChallengeMatches` is the thin DB wrapper.
 *
 * A chip is omitted entirely unless BOTH sides have a scored fixture that gameweek — a team on
 * a bye, or a gameweek not yet scored, yields no match and the UI falls back to naming the
 * challenged team only.
 */
export function resolveChallengeMatches(
  chips: ChallengeChipRow[],
  gameweekNumberById: Map<string, number>,
  teamNameById: Map<string, string>,
  resultsByGwTeam: Map<string, TeamGwResult>,
): Map<string, ChallengeMatch> {
  const out = new Map<string, ChallengeMatch>();

  for (const chip of chips) {
    if (!chip.challengedTeamId) continue;

    const gwNumber = gameweekNumberById.get(chip.gameweekId);
    if (gwNumber === undefined) continue;

    const challengerName = teamNameById.get(chip.teamId);
    const challengedName = teamNameById.get(chip.challengedTeamId);
    if (!challengerName || !challengedName) continue;

    const challenger = resultsByGwTeam.get(resultKey(chip.gameweekId, chip.teamId));
    const challenged = resultsByGwTeam.get(resultKey(chip.gameweekId, chip.challengedTeamId));
    // Both sides or nothing — half a scoreline is worse than none.
    if (!challenger || !challenged) continue;

    out.set(chip.id, {
      gameweek: gwNumber,
      challengerTeamName: challengerName,
      challengedTeamName: challengedName,
      challengerScore: challenger.score,
      challengedScore: challenged.score,
      challengerPlayerScores: challenger.playerScores,
      challengedPlayerScores: challenged.playerScores,
      pointsAwarded: chip.isProcessed ? chip.pointsAwarded ?? 0 : null,
      outcome: challengeOutcome(chip.pointsAwarded, chip.isProcessed),
    });
  }

  return out;
}

/** Human summary line for the tooltip header. Chip-points wording, never match-result wording. */
export function challengeOutcomeLabel(m: ChallengeMatch): string {
  switch (m.outcome) {
    case "won":  return `Won the challenge · +${m.pointsAwarded} chip points`;
    case "drew": return `Drew the challenge · +${m.pointsAwarded} chip point`;
    case "lost": return "Lost the challenge · no chip points";
    default:     return "Challenge not yet scored";
  }
}
