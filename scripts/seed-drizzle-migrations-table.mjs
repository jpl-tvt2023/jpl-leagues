// One-shot: seed `__drizzle_migrations` on prod with the SHA-256 hashes Drizzle expects for every
// already-applied migration. Without this, `npm run db:migrate` tries to re-apply migrations
// 0001-0009 (which were originally pushed without journal updates) and fails on "table already
// exists" errors.
//
// Idempotent: only inserts rows that aren't already present (by hash).
//
// Run with: dotenv -e .env.local -- node scripts/seed-drizzle-migrations-table.mjs

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

const drizzleDir = path.resolve("drizzle");
const journalPath = path.join(drizzleDir, "meta", "_journal.json");
const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

const client = createClient({ url, authToken });

// Ensure the tracking table exists (matches the shape Drizzle's libsql migrator creates).
await client.execute(`
  CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash text NOT NULL,
    created_at numeric
  )
`);

// Fetch existing hashes so we don't insert duplicates.
const existing = await client.execute("SELECT hash FROM __drizzle_migrations");
const existingHashes = new Set(existing.rows.map((r) => r.hash));

let inserted = 0;
let skipped = 0;

for (const entry of journal.entries) {
  const sqlPath = path.join(drizzleDir, `${entry.tag}.sql`);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const hash = crypto.createHash("sha256").update(sql).digest("hex");

  if (existingHashes.has(hash)) {
    console.log(`[skip] ${entry.tag} — already in __drizzle_migrations`);
    skipped++;
    continue;
  }

  await client.execute({
    sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    args: [hash, entry.when],
  });
  console.log(`[seed] ${entry.tag} → hash ${hash.slice(0, 12)}…, created_at ${entry.when}`);
  inserted++;
}

console.log(`\nDone. inserted=${inserted} skipped=${skipped} total=${journal.entries.length}`);
process.exit(0);
