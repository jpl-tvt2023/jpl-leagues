import { db } from "@/lib/db";
import { gameweeks } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { fetchBootstrapData } from "@/lib/fpl";

/**
 * Reconcile this league's gameweek deadlines with FPL's current truth.
 *
 * `gameweeks.deadline` is populated once at league creation and never updated
 * after, so any mid-season FPL deadline shift (e.g. a Friday early kickoff
 * that bumps the Thursday cut-off) leaves our DB stale. The in-flight GW
 * detection in `getInFlightGameweekNumber` and live-mode triggers downstream
 * read from this column, so stale values make the players-left indicator and
 * auction live mode engage at slightly wrong times.
 *
 * This helper is idempotent and cheap: it reads the (cached) FPL bootstrap,
 * compares each event's `deadline_time` to our stored value, and writes only
 * the rows that actually differ. Typically updates 0 rows.
 *
 * Triggered exclusively from the Superadmin "Run Auto-Processing for All
 * Leagues" flow in [src/lib/cron/process-all.ts] — never on an automatic
 * schedule.
 */
export async function syncGameweekDeadlines(leagueId: string): Promise<{ updated: number }> {
  let bootstrap: { events?: { id: number; deadline_time: string }[] };
  try {
    bootstrap = await fetchBootstrapData();
  } catch (e) {
    console.warn("[sync-deadlines] bootstrap fetch failed for league", leagueId, e);
    return { updated: 0 };
  }

  const events = bootstrap.events ?? [];
  if (events.length === 0) return { updated: 0 };

  const stored = await db
    .select({ id: gameweeks.id, number: gameweeks.number, deadline: gameweeks.deadline })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId));
  const byNumber = new Map(stored.map((g) => [g.number, g]));

  let updated = 0;
  for (const ev of events) {
    if (!ev.deadline_time) continue;
    const row = byNumber.get(ev.id);
    if (!row) continue; // a GW row not yet created for this league — skip
    const fplDeadline = new Date(ev.deadline_time);
    if (!Number.isFinite(fplDeadline.getTime())) continue;
    // SQLite stores timestamps to second granularity via `mode: "timestamp"`;
    // compare epoch-seconds to avoid spurious millisecond drift updates.
    const fplSec = Math.floor(fplDeadline.getTime() / 1000);
    const dbSec = Math.floor(row.deadline.getTime() / 1000);
    if (fplSec === dbSec) continue;
    await db
      .update(gameweeks)
      .set({ deadline: fplDeadline, updatedAt: new Date() })
      .where(and(eq(gameweeks.leagueId, leagueId), eq(gameweeks.number, ev.id)));
    updated++;
  }

  if (updated > 0) {
    console.log(`[sync-deadlines] updated ${updated} row(s) for league ${leagueId}`);
  }
  return { updated };
}
