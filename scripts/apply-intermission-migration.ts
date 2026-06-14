/**
 * One-off, idempotent migration runner for 0017_auction_intermission.
 *
 * Adds `intermission_seconds` + `intermission_until` to `auction_sessions` only if they don't
 * already exist. Reads the connection from env (DATABASE_URL file:/libsql: or TURSO_CONNECTION_URL +
 * TURSO_AUTH_TOKEN), mirroring src/lib/db/index.ts. Run via dotenv per-environment, e.g.:
 *   dotenv -e .env.dev   -- tsx scripts/apply-intermission-migration.ts
 *   dotenv -e .env.local -- tsx scripts/apply-intermission-migration.ts
 */
import { createClient } from "@libsql/client";

function resolveDbConfig(): { url: string; authToken?: string } {
  const direct = process.env.DATABASE_URL;
  if (direct) {
    if (direct.startsWith("file:")) return { url: direct };
    if (direct.startsWith("libsql://") || direct.startsWith("https://")) {
      return { url: direct, authToken: process.env.TURSO_AUTH_TOKEN };
    }
    throw new Error(`Unsupported DATABASE_URL scheme: ${direct}`);
  }
  const turso = process.env.TURSO_CONNECTION_URL;
  if (!turso) throw new Error("Set DATABASE_URL (file: or libsql:) or TURSO_CONNECTION_URL");
  return { url: turso, authToken: process.env.TURSO_AUTH_TOKEN };
}

async function main() {
  const cfg = resolveDbConfig();
  console.log(`[migrate] target: ${cfg.url}`);
  const client = createClient(cfg);

  const info = await client.execute("PRAGMA table_info('auction_sessions')");
  const cols = new Set(info.rows.map((r) => String(r.name)));

  const statements: { col: string; sql: string }[] = [
    { col: "intermission_seconds", sql: "ALTER TABLE `auction_sessions` ADD COLUMN `intermission_seconds` INTEGER NOT NULL DEFAULT 5" },
    { col: "intermission_until", sql: "ALTER TABLE `auction_sessions` ADD COLUMN `intermission_until` INTEGER" },
  ];

  for (const { col, sql } of statements) {
    if (cols.has(col)) {
      console.log(`[migrate] skip: column "${col}" already exists`);
      continue;
    }
    await client.execute(sql);
    console.log(`[migrate] added column "${col}"`);
  }

  console.log("[migrate] done.");
  client.close();
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
