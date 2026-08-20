/**
 * Repair wishlist priorities: renumber every team's list densely 1..N.
 *
 * Two defects accumulated in production:
 *
 *  - **Ties.** Two teams had duplicate `priority` values (227 rows with only 188 distinct, and 152
 *    with 139). `autoNominateFromWishlist` does `ORDER BY priority` with no tiebreaker, so for those
 *    teams the auto-nomination order was non-deterministic — the engine could pick a different
 *    player on each run.
 *  - **Gaps.** DELETE never re-compacted priorities, so lists read 1, 2, 4, 7, … and the UI printed
 *    those raw numbers as the visible rank.
 *
 * Ordering is preserved: rows are renumbered by `(priority, createdAt)`, so whatever order the team
 * intended is what they keep. Ties break by insertion order, which is the only signal available.
 *
 * Idempotent — a second run reports 0 updates. Run it BEFORE applying the unique index in
 * migration 0020 (no duplicate (team, player) pairs exist today, so that index applies cleanly).
 *
 *   npx tsx scripts/normalise-wishlist-priorities.ts              # dry run (default)
 *   npx tsx scripts/normalise-wishlist-priorities.ts --apply      # write
 *
 * Targets whatever DATABASE_URL / TURSO_CONNECTION_URL resolves to — see src/lib/db/index.ts.
 */
import { db } from "@/lib/db";
import { auctionWishlists } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await db
    .select({
      id: auctionWishlists.id,
      teamId: auctionWishlists.teamId,
      priority: auctionWishlists.priority,
      createdAt: auctionWishlists.createdAt,
    })
    .from(auctionWishlists)
    .orderBy(asc(auctionWishlists.teamId), asc(auctionWishlists.priority), asc(auctionWishlists.createdAt));

  const byTeam = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTeam.get(r.teamId);
    if (list) list.push(r);
    else byTeam.set(r.teamId, [r]);
  }

  console.log(`${rows.length} wishlist rows across ${byTeam.size} teams${APPLY ? "" : "  (DRY RUN — pass --apply to write)"}\n`);

  let totalUpdates = 0;
  for (const [teamId, list] of byTeam) {
    const distinct = new Set(list.map((r) => r.priority)).size;
    const ties = list.length - distinct;
    const maxPriority = Math.max(...list.map((r) => r.priority));
    const gaps = maxPriority - list.length;

    const changes = list
      .map((row, i) => ({ row, priority: i + 1 }))
      .filter(({ row, priority }) => row.priority !== priority);

    const flags = [ties > 0 ? `${ties} tie(s)` : null, gaps > 0 ? `${gaps} gap(s)` : null]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${teamId}  n=${String(list.length).padStart(3)}  max=${String(maxPriority).padStart(3)}  ` +
        `rewrite=${String(changes.length).padStart(3)}${flags ? `  <-- ${flags}` : ""}`
    );

    if (changes.length === 0) continue;
    totalUpdates += changes.length;

    if (APPLY) {
      // One batch per team — the whole point of the reorder rewrite is to stop issuing one remote
      // round trip per row.
      const stmts = changes.map(({ row, priority }) =>
        db
          .update(auctionWishlists)
          .set({ priority })
          .where(and(eq(auctionWishlists.id, row.id), eq(auctionWishlists.teamId, teamId)))
      );
      await db.batch(stmts as [(typeof stmts)[number], ...typeof stmts]);
    }
  }

  console.log(`\n${APPLY ? "Updated" : "Would update"} ${totalUpdates} row(s).`);

  if (APPLY) {
    // Verify: every team must now be dense 1..N with no ties.
    const after = await db
      .select({ teamId: auctionWishlists.teamId, priority: auctionWishlists.priority })
      .from(auctionWishlists);
    const check = new Map<string, number[]>();
    for (const r of after) {
      const l = check.get(r.teamId);
      if (l) l.push(r.priority);
      else check.set(r.teamId, [r.priority]);
    }
    let bad = 0;
    for (const [teamId, priorities] of check) {
      priorities.sort((a, b) => a - b);
      const dense = priorities.every((p, i) => p === i + 1);
      if (!dense) {
        bad++;
        console.error(`  [FAIL] ${teamId} is not dense 1..${priorities.length}`);
      }
    }
    console.log(bad === 0 ? "Verified: every team is dense 1..N with no ties." : `${bad} team(s) still malformed.`);
    process.exitCode = bad === 0 ? 0 : 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
