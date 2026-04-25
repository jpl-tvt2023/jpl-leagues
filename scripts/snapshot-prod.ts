import "dotenv/config";
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Read-only snapshot of every table to a timestamped JSON file under ./backups/.
 * Use before any destructive op (e.g. reset-prod.ts).
 */

const TABLES = [
  "users",
  "leagues",
  "league_admins",
  "groups",
  "teams",
  "players",
  "gameweeks",
  "fixtures",
  "results",
  "gameweek_captains",
  "gameweek_chips",
  "playoff_ties",
  "challenger_survival_entries",
  "settings",
  "audit_logs",
  "auction_ownership",
  "auction_scores",
  "auction_sessions",
  "auction_wishlists",
  "auction_bids",
  "auction_bid_logs",
  "team_penalties",
  "trade_proposals",
  "notifications",
];

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("Set DATABASE_URL or TURSO_CONNECTION_URL");

  const client = createClient({ url, authToken });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = "backups";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `snapshot-${ts}.json`);

  console.log(`Source: ${url}`);
  console.log(`Output: ${file}`);

  const dump: Record<string, unknown[]> = {};
  let totalRows = 0;
  for (const table of TABLES) {
    try {
      const r = await client.execute(`SELECT * FROM ${table}`);
      dump[table] = r.rows.map((row) => ({ ...row }));
      totalRows += r.rows.length;
      console.log(`  ${table.padEnd(34)} ${r.rows.length}`);
    } catch (e: any) {
      console.warn(`  ${table.padEnd(34)} SKIPPED (${e?.message ?? e})`);
      dump[table] = [];
    }
  }

  writeFileSync(file, JSON.stringify({ source: url, takenAt: new Date().toISOString(), tables: dump }, null, 2));
  console.log(`\nWrote ${totalRows} rows across ${TABLES.length} tables to ${file}`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
