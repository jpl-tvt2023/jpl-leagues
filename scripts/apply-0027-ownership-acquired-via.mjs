// One-shot: apply drizzle/0027_auction_ownership_acquired_via.sql —
// auction_ownership.acquired_via, and the one-live-owner index excluding 'transferred' rows.
//
// MUST RUN ON PROD BEFORE THE CODE THAT READS THE COLUMN DEPLOYS. Every
// `db.select().from(auctionOwnership)` expands into an explicit column list taken from schema.ts,
// so on a DB without it every squad, finance, scoring and trade read throws `no such column`.
// Running it early is harmless: the deployed code never names the column, and it never writes a
// 'transferred' row, so the wider index exclusion changes nothing for it.
//
// Supersedes 0026's index (released rows only); running this without 0026 first is fine too.
//
// Run with:
//   npx dotenv -e .env.test  -- node scripts/apply-0027-ownership-acquired-via.mjs
//   npx dotenv -e .env.dev   -- node scripts/apply-0027-ownership-acquired-via.mjs
//   npx dotenv -e .env.local -- node scripts/apply-0027-ownership-acquired-via.mjs
//
// THEN mark it applied so `npm run db:migrate` does not try to re-run it:
//   npx dotenv -e .env.local -- node scripts/seed-drizzle-migrations-table.mjs
//
// Idempotent: the column is added only if missing, and the index is rebuilt only if its live
// definition differs from the target (drop and create in one batch, so it is never missing).

import { createClient } from "@libsql/client";

// DATABASE_URL wins over TURSO_CONNECTION_URL so `-e .env.dev` can never fall through to prod.
const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
if (!url) {
  console.error("Missing DATABASE_URL / TURSO_CONNECTION_URL");
  process.exit(1);
}
const authToken = url.startsWith("file:") ? undefined : process.env.TURSO_AUTH_TOKEN;
const client = createClient({ url, authToken });

const INDEX = "auction_ownership_active_unique";
const CREATE =
  "CREATE UNIQUE INDEX `auction_ownership_active_unique` ON `auction_ownership` (`league_id`,`fpl_element_id`) WHERE status NOT IN ('released', 'transferred')";

const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

async function main() {
  console.log(`target: ${url}`);
  const info = await client.execute("PRAGMA table_info('auction_ownership')");
  if (info.rows.length === 0) {
    throw new Error("auction_ownership does not exist — run the base migrations first.");
  }
  if (info.rows.some((r) => String(r.name) === "acquired_via")) {
    console.log("[skip] auction_ownership.acquired_via already exists");
  } else {
    await client.execute("ALTER TABLE `auction_ownership` ADD `acquired_via` text DEFAULT 'auction' NOT NULL");
    console.log("[add]  auction_ownership.acquired_via text DEFAULT 'auction' NOT NULL");
  }

  const found = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    args: [INDEX],
  });
  const current = found.rows[0]?.sql == null ? null : String(found.rows[0].sql);
  console.log(`index now: ${current ?? "(no such index)"}`);
  if (current && normalize(current) === normalize(CREATE)) {
    console.log("[skip] index already up to date");
  } else {
    await client.batch([`DROP INDEX IF EXISTS \`${INDEX}\``, CREATE], "write");
    console.log(`[done] ${CREATE}`);
  }
  console.log("done.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => client.close());
