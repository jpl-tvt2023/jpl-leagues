import "dotenv/config";
import { createClient } from "@libsql/client";

/**
 * Cleanup for demo-auction Wharton state.
 *
 * Findings from `investigate-wharton-*.ts`:
 *  - 1 active ownership (Fulham, pending_release) — UNCHANGED, predates the mini-auction.
 *  - 2 phantom-sold auction_bids rows (a8c9464b…, 809430a8…) — never produced ownership rows
 *    because the unique-index constraint blocked INSERT once an existing row existed. No purse
 *    was deducted (resolveBidToSold threw before the purse update). Leave these as-is so the
 *    bid history remains a faithful record of what the UI displayed.
 *  - 1 orphan OPEN bid (b6c42946…) belonging to session a506097e… which is now `completed`.
 *    This is the only cleanup target — it can never resolve and shouldn't sit `open` forever.
 *
 * Action: mark the orphan open bid as `cancelled-orphan`, write an audit_logs entry, leave
 * everything else alone.
 *
 * SAFETY: dry-run by default. Set CLEANUP_APPLY=1 to actually write.
 */
async function main() {
  const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("DATABASE_URL or TURSO_CONNECTION_URL is required");
  const apply = process.env.CLEANUP_APPLY === "1";
  const client = createClient({ url, authToken });

  const ORPHAN_BID_ID = "b6c42946-e832-47d9-ac31-026b6cefe2fd";

  // Verify the orphan bid is still in the state we expect.
  const bid = await client.execute({
    sql: "SELECT id, session_id, status, league_id, player_name FROM auction_bids WHERE id = ?",
    args: [ORPHAN_BID_ID],
  });
  if (bid.rows.length === 0) {
    console.log(`[skip] orphan bid ${ORPHAN_BID_ID} no longer exists`);
    return;
  }
  const row = bid.rows[0];
  if (row.status !== "open") {
    console.log(`[skip] orphan bid ${ORPHAN_BID_ID} has status='${row.status}', expected 'open'. Nothing to do.`);
    return;
  }

  // Verify the session is actually completed (don't accidentally cancel a live bid).
  const sess = await client.execute({
    sql: "SELECT id, status FROM auction_sessions WHERE id = ?",
    args: [String(row.session_id)],
  });
  if (sess.rows[0]?.status !== "completed") {
    console.log(`[abort] session ${row.session_id} has status='${sess.rows[0]?.status}', NOT 'completed'. Refusing to cancel live bid.`);
    return;
  }

  console.log(`[plan]   would set auction_bids.id=${ORPHAN_BID_ID} status='cancelled-orphan'`);
  console.log(`[plan]   would insert audit_logs row with type='AUCTION_DATA_CLEANUP'`);
  if (!apply) {
    console.log(`\n(dry-run — re-run with CLEANUP_APPLY=1 to apply)`);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  await client.execute({
    sql: "UPDATE auction_bids SET status = 'cancelled-orphan', updated_at = ? WHERE id = ?",
    args: [now, ORPHAN_BID_ID],
  });

  await client.execute({
    sql: `INSERT INTO audit_logs (id, type, description, points_affected, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      "AUCTION_DATA_CLEANUP",
      `Cancelled orphan open Wharton bid (${ORPHAN_BID_ID}) in demo-auction — session ${row.session_id} was already completed. No purse adjustment (no ownership was ever created).`,
      0,
      now,
    ],
  });

  console.log(`[done] cancelled orphan bid + audit log entry written`);
}

main().catch((e) => { console.error(e); process.exit(1); });
