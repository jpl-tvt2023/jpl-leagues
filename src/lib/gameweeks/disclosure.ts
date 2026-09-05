/**
 * How much of a league is currently public.
 *
 * Several payloads gate disclosure on a gameweek's deadline: a captain or chip row exists from
 * the moment it is DECLARED, and publishing one early would let a team read their opponent's
 * Double Pointer before choosing their own captain. The gate itself is simple — `deadline <= now`.
 *
 * The hazard is caching it. Those payloads are stored in Redis for hours and invalidated only by
 * WRITES, and a deadline passing is not a write. So the gate gets evaluated once, frozen into the
 * blob, and a gameweek's chips stay invisible long after they should have appeared — which is
 * exactly what happened on the fixtures page.
 *
 * Folding this count into the cache key fixes that without giving up the cache: when a deadline
 * passes the count changes, the old key is simply missed, and the payload is recomputed. Stale
 * entries age out on their own TTL.
 *
 * Pure and import-free so it unit-tests without a database.
 */

/** How many of these gameweeks have had their deadline pass. */
export function disclosedGwCount(
  gameweeks: { deadline: Date }[],
  now: Date = new Date(),
): number {
  let n = 0;
  for (const gw of gameweeks) {
    if (gw.deadline <= now) n++;
  }
  return n;
}
