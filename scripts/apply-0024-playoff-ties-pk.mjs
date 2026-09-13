// One-shot: move playoff_ties onto a composite primary key (league_id, tie_id).
//
// Why: tie_id holds a bracket-position LABEL ("RO16-A", "16T-SF-A"), unique only within a league.
// As a lone primary key it meant the first league to generate playoffs claimed every label and
// every other league's generation died on a UNIQUE violation.
//
// Run with:  dotenv -e .env.local -- node scripts/apply-0024-playoff-ties-pk.mjs
//            dotenv -e .env.dev   -- node scripts/apply-0024-playoff-ties-pk.mjs
//
// Idempotent: re-running reports "already applied" and changes nothing.
//
// ⚠️ REFUSES TO RUN IF playoff_ties HAS ANY ROWS.
//
// SQLite cannot alter a primary key in place, so this rebuilds the table. The rebuild is only
// safe to do blind while the table is empty, which is the entire premise of doing it now. If rows
// exist, the bracket has been generated and the migration needs redoing with that data in hand —
// copying it across is not obviously correct, because the rows may already encode a collision
// that the old key forced (one league silently missing ties it should have had).

import { createClient } from "@libsql/client";

const url = process.env.TURSO_CONNECTION_URL ?? process.env.DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error("Missing TURSO_CONNECTION_URL / DATABASE_URL");
  process.exit(1);
}

const client = createClient({ url, authToken });

/** True when playoff_ties is already keyed on (league_id, tie_id). */
async function alreadyApplied() {
  const info = await client.execute("PRAGMA table_info(playoff_ties)");
  // pk > 0 marks a column's position in the primary key; a composite key has two such columns.
  const pkCols = info.rows.filter((r) => Number(r.pk) > 0).map((r) => r.name);
  return pkCols.length === 2 && pkCols.includes("league_id") && pkCols.includes("tie_id");
}

async function main() {
  const exists = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: ["playoff_ties"],
  });
  if (exists.rows.length === 0) {
    console.error("playoff_ties does not exist — run the base migrations first.");
    process.exit(1);
  }

  if (await alreadyApplied()) {
    console.log("already applied — playoff_ties is keyed on (league_id, tie_id)");
    return;
  }

  const count = await client.execute("SELECT COUNT(*) AS n FROM playoff_ties");
  const rows = Number(count.rows[0].n);
  if (rows > 0) {
    console.error(
      `REFUSING TO RUN: playoff_ties holds ${rows} row(s).\n` +
      "This migration rebuilds the table and is only written for the empty case.\n" +
      "Playoffs have been generated since it was authored — re-plan the migration with that data."
    );
    process.exit(1);
  }

  console.log("playoff_ties is empty; rebuilding with a composite primary key…");

  // One transaction, not four statements.
  //
  // Sequentially, a failure between DROP and RENAME would leave the database with no
  // playoff_ties table at all. The table being empty means no data is at risk, but a missing
  // table breaks every playoff read until someone notices and repairs it by hand. batch(…,
  // "write") wraps these in a transaction so the rebuild either lands whole or not at all.
  //
  // No PRAGMA foreign_keys toggle: PRAGMA cannot change inside a transaction, and it is not
  // needed here — nothing FK-references playoff_ties (fixtures.tie_id is a soft link with no
  // constraint), so the DROP cannot cascade.
  await client.batch([
    `CREATE TABLE __new_playoff_ties (
      tie_id text NOT NULL,
      league_id text NOT NULL,
      round_name text NOT NULL,
      round_type text NOT NULL,
      home_team_id text,
      away_team_id text,
      home_aggregate integer DEFAULT 0 NOT NULL,
      away_aggregate integer DEFAULT 0 NOT NULL,
      winner_id text,
      loser_id text,
      gw1 integer NOT NULL,
      gw2 integer,
      gw3 integer,
      status text DEFAULT 'pending' NOT NULL,
      created_at integer NOT NULL,
      PRIMARY KEY (league_id, tie_id),
      FOREIGN KEY (league_id) REFERENCES leagues(id) ON UPDATE no action ON DELETE cascade,
      FOREIGN KEY (home_team_id) REFERENCES teams(id) ON UPDATE no action ON DELETE set null,
      FOREIGN KEY (away_team_id) REFERENCES teams(id) ON UPDATE no action ON DELETE set null,
      FOREIGN KEY (winner_id) REFERENCES teams(id) ON UPDATE no action ON DELETE set null,
      FOREIGN KEY (loser_id) REFERENCES teams(id) ON UPDATE no action ON DELETE set null
    )`,
    // Empty by the guard above, but copied anyway so the script stays honest about its intent.
    "INSERT INTO __new_playoff_ties SELECT * FROM playoff_ties",
    "DROP TABLE playoff_ties",
    "ALTER TABLE __new_playoff_ties RENAME TO playoff_ties",
  ], "write");


  if (!(await alreadyApplied())) {
    console.error("rebuild finished but the composite key is not in place — inspect manually");
    process.exit(1);
  }
  console.log("done — playoff_ties is keyed on (league_id, tie_id)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
