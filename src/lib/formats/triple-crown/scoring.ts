/**
 * Triple Crown Format Scoring Logic
 * Handles PL (H2H all season), Cup Group Stage (Ghost opponents), and UCL/UEL knockouts
 */

/**
 * Calculate Ghost opponent score for a cup group match
 * Ghost score = ceil(average of 4 human teams' scores in the group for this GW)
 *
 * @param humanScores - Array of exactly 4 human team scores in the cup group for the GW
 * @returns Ghost's score (integer)
 *
 * Human-vs-Ghost scoring:
 *   Win  — humanScore > ghostScore  (2 cup points)
 *   Loss — humanScore < ghostScore  (0 cup points)
 *   Draw — humanScore === ghostScore (1 cup point) — rare but possible since
 *          both scores are integers; process-gameweek treats equality as a draw.
 *
 * Human-vs-Human cup fixtures (when two real teams in the same cup group face
 * each other on a cup matchday) follow the standard H2H rule and CAN emit
 * draws (1+1 split). The UI uefa-standings page already renders a D column
 * for both branches.
 */
export function calculateGhostScore(humanScores: number[]): number {
  if (humanScores.length !== 4) {
    throw new Error(`Ghost scoring requires exactly 4 human scores, got ${humanScores.length}`);
  }

  const sum = humanScores.reduce((acc, score) => acc + score, 0);
  const average = sum / 4;
  return Math.ceil(average);
}

/**
 * Determine cup group match result between human team and Ghost opponent
 *
 * @param humanScore - The human team's FPL score for the GW
 * @param ghostScore - The calculated Ghost score (from calculateGhostScore)
 * @returns "win" | "loss" (no draws possible)
 */
export function determineGhostMatchResult(humanScore: number, ghostScore: number): "win" | "loss" {
  return humanScore > ghostScore ? "win" : "loss";
}

/**
 * Calculate cup group points from match result
 * Win = +2 points, Loss = +0 points (no draws)
 * No bonus points in cup group stage
 *
 * @param result - Match result ("win" | "loss")
 * @returns Points awarded (2 or 0)
 */
export function calculateCupGroupPoints(result: "win" | "loss"): number {
  return result === "win" ? 2 : 0;
}
