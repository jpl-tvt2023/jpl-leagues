// One-shot: apply migration 0020_wishlist_indexes to prod, then record it in `__drizzle_migrations`.
//
// Idempotent — each index is created only if absent, so re-running is safe.
// Purely additive (two indexes, no column or row changes).
//
// IMPORTANT: `auction_wishlists_team_element` is UNIQUE on (team_id, fpl_element_id) — i.e. per
// TEAM. Different teams may hold identical wishlists; this only stops one team listing the same
// player twice, which the old GET handler used to clean up by DELETING rows inline on every read.
// The script refuses to create it if any duplicate pair exists.
//
// Run with: node -r dotenv/config scripts/apply-0020-wishlist-indexes.mjs dotenv_config_path=.env.local

import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const url = process.env.TURSO_CONNECTION_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("Missing TURSO_CONNECTION_URL");
  process.exit(1);
}

const TAG = "0020_wishlist_indexes";
const client = createClient({ url, authToken });

async function objectExists(name) {
  const res = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE name = ?`,
    args: [name],
  });
  return res.rows.length > 0;
}

console.log(`Target: ${url}\n`);

const before = Number((await client.execute("SELECT count(*) AS n FROM auction_wishlists")).rows[0].n);
console.log("wishlist rows before:", before);

// --- 1. lookup index: every read and every reorder is scoped to one team, ordered by priority ---
if (await objectExists("auction_wishlists_team_priority")) {
  console.log("[skip] auction_wishlists_team_priority already exists");
} else {
  console.log("[apply] auction_wishlists_team_priority");
  await client.execute(
    `CREATE INDEX auction_wishlists_team_priority ON auction_wishlists (team_id, priority)`
  );
  console.log("[done] index created");
}

// --- 2. unique index: one entry per player PER TEAM ---
if (await objectExists("auction_wishlists_team_element")) {
  console.log("[skip] auction_wishlists_team_element already exists");
} else {
  const dupes = await client.execute(
    `SELECT team_id, fpl_element_id, count(*) AS n
       FROM auction_wishlists
      GROUP BY team_id, fpl_element_id
     HAVING count(*) > 1`
  );
  if (dupes.rows.length > 0) {
    console.error(
      `[abort] ${dupes.rows.length} duplicate (team, player) pair(s) exist — resolve them first:`
    );
    for (const r of dupes.rows.slice(0, 10)) {
      console.error(`  team ${r.team_id} player ${r.fpl_element_id} x${r.n}`);
    }
    process.exit(1);
  }
  console.log("[apply] auction_wishlists_team_element (unique, per team)");
  await client.execute(
    `CREATE UNIQUE INDEX auction_wishlists_team_element ON auction_wishlists (team_id, fpl_element_id)`
  );
  console.log("[done] unique index created");
}

// --- 3. record in __drizzle_migrations (hash scheme matches seed-drizzle-migrations-table.mjs) ---
const journal = JSON.parse(fs.readFileSync(path.resolve("drizzle", "meta", "_journal.json"), "utf8"));
const entry = journal.entries.find((e) => e.tag === TAG);
if (!entry) {
  console.error(`\n[warn] ${TAG} not found in _journal.json — skipping migration tracking`);
} else {
  const sql = fs.readFileSync(path.resolve("drizzle", `${TAG}.sql`), "utf8");
  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  const existing = await client.execute({
    sql: "SELECT 1 FROM __drizzle_migrations WHERE hash = ?",
    args: [hash],
  });
  if (existing.rows.length > 0) {
    console.log(`[skip] ${TAG} already tracked in __drizzle_migrations`);
  } else {
    await client.execute({
      sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      args: [hash, entry.when],
    });
    console.log(`[done] ${TAG} tracked → ${hash.slice(0, 12)}…`);
  }
}

const after = Number((await client.execute("SELECT count(*) AS n FROM auction_wishlists")).rows[0].n);
console.log("wishlist rows after: ", after);
console.log(before === after ? "\nRow count unchanged — migration was additive." : "\n[ALERT] row count changed!");

console.log("\nMigration 0020 applied.");
process.exit(before === after ? 0 : 1);
