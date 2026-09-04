// One-shot: apply migrations 0022 + 0023 directly, bypassing the out-of-sync drizzle tracker
// (drizzle/meta/_journal.json stops at 0020, so 0021-0023 are unjournaled hand-written files and
// `drizzle-kit migrate` will not see them; `drizzle-kit push` diffs schema.ts against the live DB
// and can propose table recreations, which is not something to run against prod unattended).
//
// Idempotent — every statement is guarded by an existence check, so it is safe to run against
// test, dev and prod in turn, and safe to re-run.
//
//   0022  gameweek_chips.wasted_reason
//         MISSING THIS BREAKS /api/fixtures ENTIRELY. That route does
//         `db.select().from(gameweekChips)`, which drizzle expands into an explicit column list
//         taken from schema.ts — including wasted_reason — so on a DB without the column every
//         call throws `no such column: wasted_reason` and the public fixtures page goes down for
//         every TVT league. This is the urgent half.
//
//   0023  fpl_classic_config / _entrants / _entry_gws / _awards
//         The FPL Classic format. Without these, creating one of those leagues 500s.
//
// Purely additive: one nullable column and four new tables. No existing row is read or written,
// which the row-count assertions at the end verify.
//
// Run with:
//   npx dotenv -e .env.test  -- node scripts/apply-0022-0023-fpl-classic.mjs
//   npx dotenv -e .env.dev   -- node scripts/apply-0022-0023-fpl-classic.mjs
//   npx dotenv -e .env.local -- node scripts/apply-0022-0023-fpl-classic.mjs

import { createClient } from "@libsql/client";

// .env.local points at Turso via TURSO_CONNECTION_URL; .env.test / .env.dev use a local
// DATABASE_URL file: URL. drizzle.config.ts makes the same distinction.
const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("Missing DATABASE_URL / TURSO_CONNECTION_URL");
  process.exit(1);
}

const client = createClient({ url, authToken });

async function tableExists(name) {
  const res = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
    args: ["table", name],
  });
  return res.rows.length > 0;
}

async function columnExists(table, column) {
  const res = await client.execute("PRAGMA table_info(" + table + ")");
  return res.rows.some((r) => r.name === column);
}

async function count(table) {
  const res = await client.execute("SELECT count(*) AS n FROM " + table);
  return Number(res.rows[0].n);
}

console.log("Target: " + url.slice(0, 45) + (url.length > 45 ? "…" : "") + "\n");

const chipsBefore = await count("gameweek_chips");
const leaguesBefore = await count("leagues");
console.log("gameweek_chips rows before: " + chipsBefore);
console.log("leagues rows before:        " + leaguesBefore + "\n");

// ---------------------------------------------------------------------------
// 0022_gameweek_chip_wasted_reason
// ---------------------------------------------------------------------------
console.log("-- 0022_gameweek_chip_wasted_reason --");
if (await columnExists("gameweek_chips", "wasted_reason")) {
  console.log("[skip] gameweek_chips.wasted_reason already exists");
} else {
  console.log("[apply] gameweek_chips.wasted_reason");
  await client.execute("ALTER TABLE gameweek_chips ADD wasted_reason text");
  console.log("[done] column added");
}

// ---------------------------------------------------------------------------
// 0023_fpl_classic — four tables, created in FK dependency order:
// config and entrants reference leagues; entry_gws and awards reference entrants.
// ---------------------------------------------------------------------------
console.log("\n-- 0023_fpl_classic --");

const tables = [
  {
    name: "fpl_classic_config",
    ddl: `CREATE TABLE fpl_classic_config (
      league_id text PRIMARY KEY NOT NULL,
      fpl_league_id integer NOT NULL,
      fpl_league_name text,
      fpl_start_event integer,
      start_gameweek integer DEFAULT 1 NOT NULL,
      scoring_metric text DEFAULT 'net' NOT NULL,
      winner_cut_percent integer DEFAULT 30 NOT NULL,
      entrants_synced_at integer,
      entrant_count integer DEFAULT 0 NOT NULL,
      settled_through_gw integer DEFAULT 0 NOT NULL,
      last_sync_error text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (league_id) REFERENCES leagues(id) ON UPDATE no action ON DELETE cascade
    )`,
    indexes: [
      "CREATE INDEX fpl_classic_config_fpl_league ON fpl_classic_config (fpl_league_id)",
    ],
  },
  {
    name: "fpl_classic_entrants",
    ddl: `CREATE TABLE fpl_classic_entrants (
      id text PRIMARY KEY NOT NULL,
      league_id text NOT NULL,
      fpl_entry_id integer NOT NULL,
      entry_name text NOT NULL,
      player_name text NOT NULL,
      joined_time integer,
      first_seen_gw integer DEFAULT 1 NOT NULL,
      total_points integer DEFAULT 0 NOT NULL,
      last_rank integer,
      is_active integer DEFAULT true NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (league_id) REFERENCES leagues(id) ON UPDATE no action ON DELETE cascade
    )`,
    indexes: [
      "CREATE UNIQUE INDEX fpl_classic_entrants_league_entry_unique ON fpl_classic_entrants (league_id,fpl_entry_id)",
      "CREATE INDEX fpl_classic_entrants_league_total ON fpl_classic_entrants (league_id,total_points)",
    ],
  },
  {
    name: "fpl_classic_entry_gws",
    ddl: `CREATE TABLE fpl_classic_entry_gws (
      id text PRIMARY KEY NOT NULL,
      league_id text NOT NULL,
      entrant_id text NOT NULL,
      gw integer NOT NULL,
      points integer NOT NULL,
      transfer_cost integer DEFAULT 0 NOT NULL,
      net_points integer NOT NULL,
      total_points integer NOT NULL,
      overall_rank integer,
      bench_points integer DEFAULT 0 NOT NULL,
      chip text,
      month_key text NOT NULL,
      created_at integer NOT NULL,
      FOREIGN KEY (league_id) REFERENCES leagues(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (entrant_id) REFERENCES fpl_classic_entrants(id) ON UPDATE no action ON DELETE cascade
    )`,
    indexes: [
      "CREATE UNIQUE INDEX fpl_classic_entry_gws_unique ON fpl_classic_entry_gws (entrant_id,gw)",
      "CREATE INDEX fpl_classic_entry_gws_league_gw_net ON fpl_classic_entry_gws (league_id,gw,net_points)",
      "CREATE INDEX fpl_classic_entry_gws_league_month ON fpl_classic_entry_gws (league_id,month_key)",
    ],
  },
  {
    name: "fpl_classic_awards",
    ddl: `CREATE TABLE fpl_classic_awards (
      id text PRIMARY KEY NOT NULL,
      league_id text NOT NULL,
      award_type text NOT NULL,
      scope_key text NOT NULL,
      position integer DEFAULT 1 NOT NULL,
      entrant_id text NOT NULL,
      value integer NOT NULL,
      is_tied integer DEFAULT false NOT NULL,
      detail text,
      computed_at integer NOT NULL,
      computed_through_gw integer,
      recompute_count integer DEFAULT 0 NOT NULL,
      FOREIGN KEY (league_id) REFERENCES leagues(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (entrant_id) REFERENCES fpl_classic_entrants(id) ON UPDATE no action ON DELETE cascade
    )`,
    indexes: [
      "CREATE UNIQUE INDEX fpl_classic_awards_unique ON fpl_classic_awards (league_id,award_type,scope_key,position,entrant_id)",
      "CREATE INDEX fpl_classic_awards_league_type ON fpl_classic_awards (league_id,award_type)",
    ],
  },
];

for (const t of tables) {
  if (await tableExists(t.name)) {
    console.log("[skip] " + t.name + " already exists");
    continue;
  }
  console.log("[apply] " + t.name);
  await client.execute(t.ddl);
  for (const idx of t.indexes) await client.execute(idx);
  console.log("[done] table + " + t.indexes.length + " index(es) created");
}

// ---------------------------------------------------------------------------
// Additive proof: nothing above touches an existing row.
// ---------------------------------------------------------------------------
const chipsAfter = await count("gameweek_chips");
const leaguesAfter = await count("leagues");
console.log("\ngameweek_chips rows after:  " + chipsAfter);
console.log("leagues rows after:         " + leaguesAfter);

const unchanged = chipsBefore === chipsAfter && leaguesBefore === leaguesAfter;
console.log(unchanged ? "\nRow counts unchanged — migration was additive." : "\n[ALERT] row count changed!");
console.log(unchanged ? "\nMigrations 0022 + 0023 applied." : "");
process.exit(unchanged ? 0 : 1);
