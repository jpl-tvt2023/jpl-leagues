/**
 * Per-manager transfer hits, read back from a result's stored per-player breakdown.
 *
 * The gameweek processor writes `{ fplId, transferHits, … }` for every manager it scores into
 * `results.homePlayerScores` / `awayPlayerScores` (api/gameweeks/[gw]/route.ts). `transferHits`
 * there is FPL's raw `event_transfers_cost`: the >12-hit carry-forward is applied to the TEAM
 * score, never folded into this field. So it is exactly the number the per-manager Redis score
 * cache (`fpl:{leagueId}:gw{N}:{fplId}`) holds — durable, already loaded alongside the results,
 * and free to read.
 *
 * Both readers used to get it from that cache instead: league standings with a full-keyspace
 * SCAN per processed gameweek on every recompute (the app's largest Redis cost by far), and the
 * scoring carry-forward, which only found its keys because those recomputes kept refreshing a
 * 24-hour TTL.
 *
 * Kept free of imports so the unit lane can exercise it without a database.
 */

/**
 * fplId → hits for one side of one result. Null when the breakdown is not usable — absent
 * (results predating it, Continental Championship), malformed, empty, or with any entry lacking
 * an fplId or a numeric `transferHits` — so callers fall back for that gameweek rather than read
 * a partial breakdown as "nobody took a hit".
 */
export function playerHitsFromStoredScores(raw: string | null | undefined): Map<string, number> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const hits = new Map<string, number>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return null;
    const p = entry as { fplId?: unknown; transferHits?: unknown };
    if (typeof p.fplId !== "string" || p.fplId === "") return null;
    if (typeof p.transferHits !== "number" || !Number.isFinite(p.transferHits)) return null;
    hits.set(p.fplId, p.transferHits);
  }
  return hits;
}
