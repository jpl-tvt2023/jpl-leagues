import "dotenv/config";
import { createClient } from "@libsql/client";
import { createInterface } from "readline";

/**
 * One-shot destructive reset. Wipes every row from every table EXCEPT a single
 * superadmin user row. Designed to be run against either prod (Turso) or dev
 * (file:./dev.db). Refuses to run without --confirm matching the superadmin email.
 *
 * After this script: run `npm run db:push` (or `db:push:dev`) to re-apply the
 * cascading-FK schema against the now-near-empty tables. With FK pragma and
 * cascades in place, the orphan-row class of bug cannot recur.
 *
 * Usage:
 *   tsx scripts/reset-prod.ts --confirm <superadmin-email>
 *   tsx scripts/reset-prod.ts --confirm <superadmin-email> --dry-run   (default)
 *   tsx scripts/reset-prod.ts --confirm <superadmin-email> --apply
 */

// Tables in delete order: children before parents. Without FK cascades enforced
// (current prod state), order matters or DELETE will fail / leave orphans.
const DELETE_ORDER: string[] = [
  // Auction grandchildren
  "auction_bid_logs",
  "auction_bids",
  "auction_wishlists",
  "auction_scores",
  "auction_ownership",
  "team_penalties",
  "auction_sessions",
  "trade_proposals",

  // Result/fixture chain
  "results",
  "challenger_survival_entries",
  "gameweek_captains",
  "gameweek_chips",
  "fixtures",
  "playoff_ties",
  "gameweeks",

  // Notifications & settings
  "notifications",
  "settings",
  "audit_logs",

  // Players → teams → groups
  "players",
  "teams",
  "groups",

  // League admin mappings → leagues
  "league_admins",
  "leagues",

  // Users handled separately (preserve superadmin)
];

async function confirmTty(promptText: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const confirmIdx = args.indexOf("--confirm");
  const confirmEmail = confirmIdx >= 0 ? args[confirmIdx + 1] : undefined;
  const apply = args.includes("--apply");

  if (!confirmEmail) {
    throw new Error("Refusing to run: pass --confirm <superadmin-email>");
  }

  const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("Set DATABASE_URL or TURSO_CONNECTION_URL");

  console.log(`Target DB: ${url}`);
  console.log(`Mode: ${apply ? "APPLY (will delete)" : "DRY-RUN"}`);
  console.log("=".repeat(80));

  const client = createClient({ url, authToken });
  // Best-effort: enable cascades so dependent rows go with their parents on Turso.
  // No-op on file URLs already pragma'd by dev workflow.
  await client.execute("PRAGMA foreign_keys = ON");

  // 1) Identify superadmin
  const superRes = await client.execute({
    sql: "SELECT id, email, name FROM users WHERE role = 'superadmin'",
    args: [],
  });
  if (superRes.rows.length === 0) {
    throw new Error("No superadmin user found — refusing to wipe a DB with no recovery account");
  }
  if (superRes.rows.length > 1) {
    throw new Error(`Found ${superRes.rows.length} superadmins — refusing to guess which one to keep`);
  }
  const superadmin = superRes.rows[0];
  console.log(`Superadmin to preserve: ${superadmin.email} (id=${superadmin.id}, name=${superadmin.name})`);

  if (superadmin.email !== confirmEmail) {
    throw new Error(`--confirm value (${confirmEmail}) does not match superadmin email (${superadmin.email})`);
  }

  // 2) Snapshot row counts (for audit)
  console.log("\nCurrent row counts:");
  for (const table of [...DELETE_ORDER, "users"]) {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    const n = Number(r.rows[0]?.n ?? 0);
    if (n > 0) console.log(`  ${table.padEnd(34)} ${n}`);
  }

  if (!apply) {
    console.log("\nDRY-RUN. Re-run with --apply to actually delete.");
    await client.close();
    return;
  }

  // 3) Final TTY confirmation when applying
  console.log("\n" + "!".repeat(80));
  console.log(`! ABOUT TO WIPE EVERY ROW EXCEPT superadmin ${superadmin.email}`);
  console.log(`! Target: ${url}`);
  console.log("!".repeat(80));
  const ok = await confirmTty('Type "yes" to proceed: ');
  if (!ok) {
    console.log("Aborted.");
    await client.close();
    return;
  }

  // 4) Delete in dependency order
  console.log("\nDeleting…");
  for (const table of DELETE_ORDER) {
    const r = await client.execute(`DELETE FROM ${table}`);
    console.log(`  ${table.padEnd(34)} deleted (${r.rowsAffected} rows)`);
  }

  // 5) Prune users to superadmin
  const userDel = await client.execute({
    sql: "DELETE FROM users WHERE id != ?",
    args: [String(superadmin.id)],
  });
  console.log(`  users (non-superadmin)          deleted (${userDel.rowsAffected} rows)`);

  // 6) Verify
  console.log("\nFinal row counts:");
  for (const table of [...DELETE_ORDER, "users"]) {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    const n = Number(r.rows[0]?.n ?? 0);
    console.log(`  ${table.padEnd(34)} ${n}`);
  }

  console.log("\nReset complete. Next step: run `npm run db:push` (or db:push:dev) to apply the cascade schema.");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
