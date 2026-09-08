/**
 * When a league's chip set stops being editable.
 *
 * A league's three chips are agreed before kick-off and fixed for the season — they are never
 * swapped mid-season. That is a competition rule, and this module is where the code enforces it
 * rather than leaving it as a convention.
 *
 * Why it has to be enforced rather than trusted: `enabledChips` must hold EXACTLY three codes
 * (see validateEnabledChipsArray), so a change is always a SWAP, and the chip leaving the set may
 * already have been played. Both display paths filter chip history by the CURRENT set —
 * `api/fixtures/route.ts` for the fixture cards and `api/standings/route.ts` for the CP/BP
 * tooltip — while `lib/standings/league-stage.ts` sums `pointsAwarded` with no such filter. A
 * mid-season swap would therefore leave a team's points in the league table with nothing on
 * screen accounting for them, silently and with no error.
 *
 * Guarding at the write is what makes that read-time filtering provably safe, which is why
 * neither display path needs to change.
 *
 * Its own module so the superadmin PATCH (which enforces) and the superadmin league list (which
 * greys out the control) share one definition instead of drifting apart.
 */

import { db } from "@/lib/db";
import { gameweeks, gameweekChips } from "@/lib/db/schema";
import { and, eq, lte, sql } from "drizzle-orm";

/**
 * Why this league's chips are locked, or null if they are still editable.
 *
 * Two independent conditions, because either alone is enough to strand a chip:
 *
 *   - A `gameweek_chips` row exists. Even for a gameweek still in the future that is a team's
 *     declaration; swapping the chip out would leave it undeclarable and invisible.
 *   - A gameweek deadline has passed. The season is under way, so teams have been planning
 *     against the published chip set even if nobody has spent one yet.
 *
 * The string is shown to the superadmin, so it names the specific blocker rather than saying
 * "the season has started" and leaving them to work out which part.
 */
export async function findEnabledChipsLock(leagueId: string): Promise<string | null> {
  const [chipRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(gameweekChips)
    .innerJoin(gameweeks, eq(gameweekChips.gameweekId, gameweeks.id))
    .where(eq(gameweeks.leagueId, leagueId));

  const chipCount = Number(chipRow?.n ?? 0);
  if (chipCount > 0) {
    return `${chipCount} chip${chipCount === 1 ? " has" : "s have"} already been declared`;
  }

  const passed = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), lte(gameweeks.deadline, new Date())))
    .orderBy(gameweeks.number);

  if (passed.length > 0) {
    return `GW${passed[passed.length - 1].number}'s deadline has passed`;
  }

  return null;
}
