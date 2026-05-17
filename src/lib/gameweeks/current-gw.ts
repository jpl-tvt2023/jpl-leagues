import { db } from "@/lib/db";
import { gameweeks } from "@/lib/db/schema";
import { and, asc, eq, lte } from "drizzle-orm";

/**
 * The "current" gameweek for a league is the highest-numbered gameweek whose
 * deadline has already passed. If no deadlines have passed yet, fall back to
 * the lowest-numbered gameweek (the upcoming GW1). Returns null when the
 * league has no gameweek rows at all.
 *
 * Why this exists: callers used to read `max(gameweeks.number)`, which always
 * returned 38 since gameweeks are pre-seeded for the whole season.
 */
export async function getCurrentGameweekNumber(leagueId: string): Promise<number | null> {
  const now = new Date();

  const passedRows = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), lte(gameweeks.deadline, now)));

  if (passedRows.length > 0) {
    return passedRows.reduce((m, r) => (r.number > m ? r.number : m), passedRows[0].number);
  }

  const upcoming = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId))
    .orderBy(asc(gameweeks.number))
    .limit(1);

  return upcoming[0]?.number ?? null;
}
