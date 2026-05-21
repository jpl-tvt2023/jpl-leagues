// One-shot: apply migrations 0010 + 0011 directly to prod, bypassing the out-of-sync drizzle
// migration tracker. Idempotent — checks if the column/table exists before each statement.
//
// Run with: dotenv -e .env.local -- node scripts/apply-pending-migrations.mjs
//
// Safe to re-run; will report "already applied" for anything that's been done.

import { createClient } from "@libsql/client";

const url = process.env.TURSO_CONNECTION_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("Missing TURSO_CONNECTION_URL");
  process.exit(1);
}

const client = createClient({ url, authToken });

async function columnExists(table, column) {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return res.rows.some((r) => r.name === column);
}

async function tableExists(name) {
  const res = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    args: [name],
  });
  return res.rows.length > 0;
}

// 0010_team_slot_unlocks
if (await tableExists("team_slot_unlocks")) {
  console.log("[skip] team_slot_unlocks already exists");
} else {
  console.log("[apply] team_slot_unlocks");
  await client.execute(`
    CREATE TABLE team_slot_unlocks (
      id TEXT PRIMARY KEY NOT NULL,
      league_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      slot_number INTEGER NOT NULL,
      cost INTEGER NOT NULL,
      unlocked_at INTEGER NOT NULL,
      FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    )
  `);
  await client.execute(`CREATE INDEX team_slot_unlocks_team ON team_slot_unlocks (team_id)`);
  console.log("[done] team_slot_unlocks created");
}

// 0011_auction_tier
if (await columnExists("leagues", "auction_tier")) {
  console.log("[skip] leagues.auction_tier already exists");
} else {
  console.log("[apply] leagues.auction_tier");
  await client.execute(`ALTER TABLE leagues ADD COLUMN auction_tier TEXT DEFAULT 'complete' NOT NULL`);
  console.log("[done] leagues.auction_tier added");
}

console.log("\nAll pending migrations applied.");
process.exit(0);
