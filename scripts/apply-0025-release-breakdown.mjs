// One-shot: apply drizzle/0025_auction_release_breakdown.sql —
// auction_ownership.release_fmv (integer) and auction_ownership.deadwood_reason (text).
//
// MUST RUN ON PROD BEFORE THE CODE THAT READS THESE COLUMNS DEPLOYS. Every
// `db.select().from(auctionOwnership)` expands into an explicit column list taken from schema.ts,
// so on a DB without them every squad, finance, scoring and release read throws `no such column`.
// Adding them early is harmless: the currently deployed code never names them.
//
// Purely additive: two nullable columns, no existing row read or written.
//
// Run with:
//   npx dotenv -e .env.test  -- node scripts/apply-0025-release-breakdown.mjs
//   npx dotenv -e .env.dev   -- node scripts/apply-0025-release-breakdown.mjs
//   npx dotenv -e .env.local -- node scripts/apply-0025-release-breakdown.mjs
//
// THEN mark it applied so `npm run db:migrate` does not try to re-run it:
//   npx dotenv -e .env.local -- node scripts/seed-drizzle-migrations-table.mjs
//
// Idempotent: each column is guarded by an existence check, so re-running changes nothing.

import { createClient } from "@libsql/client";

// DATABASE_URL wins over TURSO_CONNECTION_URL so `-e .env.dev` can never fall through to prod.
const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
if (!url) {
  console.error("Missing DATABASE_URL / TURSO_CONNECTION_URL");
  process.exit(1);
}
const authToken = url.startsWith("file:") ? undefined : process.env.TURSO_AUTH_TOKEN;
const client = createClient({ url, authToken });

const COLUMNS = [
  ["release_fmv", "integer"],
  ["deadwood_reason", "text"],
];

async function main() {
  console.log(`target: ${url}`);
  const info = await client.execute("PRAGMA table_info('auction_ownership')");
  if (info.rows.length === 0) {
    throw new Error("auction_ownership does not exist — run the base migrations first.");
  }
  const existing = new Set(info.rows.map((r) => String(r.name)));
  for (const [name, type] of COLUMNS) {
    if (existing.has(name)) {
      console.log(`[skip] auction_ownership.${name} already exists`);
      continue;
    }
    await client.execute(`ALTER TABLE \`auction_ownership\` ADD \`${name}\` ${type}`);
    console.log(`[add]  auction_ownership.${name} ${type}`);
  }
  console.log("done.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => client.close());
