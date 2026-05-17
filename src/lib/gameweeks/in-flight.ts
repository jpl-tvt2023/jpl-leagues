import { db } from "@/lib/db";
import { auctionScores, fixtures, gameweeks, leagues, results } from "@/lib/db/schema";
import { and, desc, eq, inArray, lte } from "drizzle-orm";

/**
 * Returns the gameweek number that is currently "in flight" for a league —
 * i.e. its deadline has passed but the GW is not yet fully processed.
 *
 * For the auction format: in flight = highest GW where deadline ≤ now and no
 * auctionScores rows exist for it yet.
 *
 * For TVT / triple-crown: in flight = highest GW where deadline ≤ now and at
 * least one fixture for that GW lacks a result.
 *
 * Returns null if the latest deadline-passed GW has been fully processed (or
 * if no GW has had its deadline pass yet).
 *
 * This is distinct from `getCurrentGameweekNumber` in `current-gw.ts`, which
 * returns the highest passed-deadline GW regardless of processing state.
 * "In flight" is intentionally narrower so the players-left indicator and
 * auction live mode only fire while there is something live to show.
 */
export async function getInFlightGameweekNumber(leagueId: string): Promise<number | null> {
  const [league] = await db
    .select({ id: leagues.id, format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) return null;

  const now = new Date();

  // Candidate GWs: deadline already passed, sorted desc so we check newest first.
  const passed = await db
    .select({ id: gameweeks.id, number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), lte(gameweeks.deadline, now)))
    .orderBy(desc(gameweeks.number));

  if (passed.length === 0) return null;

  if (league.format === "auction") {
    // Pull all auctionScores rows for this league once; any GW that has at
    // least one row is considered "processed" for the live-mode trigger.
    const scoreRows = await db
      .select({ gameweekId: auctionScores.gameweekId })
      .from(auctionScores)
      .where(eq(auctionScores.leagueId, leagueId));
    const processedGwIds = new Set(scoreRows.map((r) => r.gameweekId));
    for (const gw of passed) {
      if (!processedGwIds.has(gw.id)) return gw.number;
    }
    return null;
  }

  // TVT / triple-crown: a GW is "in flight" if any of its fixtures has no
  // result row yet. We check the newest passed-deadline GW first.
  for (const gw of passed) {
    const gwFixtures = await db
      .select({ id: fixtures.id })
      .from(fixtures)
      .where(eq(fixtures.gameweekId, gw.id));
    if (gwFixtures.length === 0) continue;
    const fixtureIds = gwFixtures.map((f) => f.id);
    const resultRows = await db
      .select({ fixtureId: results.fixtureId })
      .from(results)
      .where(inArray(results.fixtureId, fixtureIds));
    if (resultRows.length < fixtureIds.length) return gw.number;
  }

  return null;
}
