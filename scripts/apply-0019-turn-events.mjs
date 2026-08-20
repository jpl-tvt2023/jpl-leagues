// One-shot: apply migration 0019_auction_turn_events to prod, then record it in
// `__drizzle_migrations` so `db:migrate` doesn't try to re-run it.
//
// Idempotent — every statement is guarded by an existence check, so it is safe to re-run.
// Purely additive (one new table, one index, two new columns): no existing row is rewritten and
// nothing is dropped, so it is safe to run against a paused live auction.
//
// Run with: dotenv -e .env.local -- node scripts/apply-0019-turn-events.mjs
//   (or: node -r dotenv/config scripts/apply-0019-turn-events.mjs dotenv_config_path=.env.local)

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

const TAG = "0019_auction_turn_events";
const client = createClient({ url, authToken });

async function columnExists(table, column) {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return res.rows.some((r) => r.name === column);
}

async function objectExists(name) {
  const res = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE name = ?`,
    args: [name],
  });
  return res.rows.length > 0;
}

console.log(`Target: ${url}\n`);

// Counts before, so an additive migration can be proven additive.
const before = {};
for (const t of ["auction_sessions", "auction_bids", "teams", "auction_ownership"]) {
  before[t] = Number((await client.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
}
console.log("row counts before:", before);

// --- 1. auction_turn_events table ---
if (await objectExists("auction_turn_events")) {
  console.log("[skip] auction_turn_events already exists");
} else {
  console.log("[apply] auction_turn_events");
  await client.execute(`
    CREATE TABLE auction_turn_events (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      league_id text NOT NULL,
      team_id text,
      nominator_index integer,
      event text NOT NULL,
      actor text NOT NULL,
      detail text,
      created_at integer NOT NULL,
      FOREIGN KEY (session_id) REFERENCES auction_sessions(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (league_id) REFERENCES leagues(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON UPDATE no action ON DELETE set null
    )
  `);
  console.log("[done] auction_turn_events created");
}

// --- 2. index ---
if (await objectExists("auction_turn_events_session_created")) {
  console.log("[skip] auction_turn_events_session_created already exists");
} else {
  console.log("[apply] auction_turn_events_session_created");
  await client.execute(
    `CREATE INDEX auction_turn_events_session_created ON auction_turn_events (session_id, created_at)`
  );
  console.log("[done] index created");
}

// --- 3. auction_sessions.makeup_queue ---
if (await columnExists("auction_sessions", "makeup_queue")) {
  console.log("[skip] auction_sessions.makeup_queue already exists");
} else {
  console.log("[apply] auction_sessions.makeup_queue");
  await client.execute(`ALTER TABLE auction_sessions ADD COLUMN makeup_queue text DEFAULT '[]' NOT NULL`);
  console.log("[done] makeup_queue added (existing rows default to '[]')");
}

// --- 4. auction_sessions.ring_return_index ---
if (await columnExists("auction_sessions", "ring_return_index")) {
  console.log("[skip] auction_sessions.ring_return_index already exists");
} else {
  console.log("[apply] auction_sessions.ring_return_index");
  await client.execute(`ALTER TABLE auction_sessions ADD COLUMN ring_return_index integer`);
  console.log("[done] ring_return_index added (null = not mid make-up sequence)");
}

// --- 5. record in __drizzle_migrations (hash scheme matches seed-drizzle-migrations-table.mjs) ---
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

// Counts after — must be identical.
const after = {};
for (const t of ["auction_sessions", "auction_bids", "teams", "auction_ownership"]) {
  after[t] = Number((await client.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
}
console.log("row counts after: ", after);
const unchanged = Object.keys(before).every((k) => before[k] === after[k]);
console.log(unchanged ? "\nRow counts unchanged — migration was additive." : "\n[ALERT] row counts changed!");

console.log("\nMigration 0019 applied.");
process.exit(unchanged ? 0 : 1);
