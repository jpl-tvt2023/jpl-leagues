// One-shot: apply drizzle/0026_auction_ownership_active_unique_partial.sql — make
// auction_ownership_active_unique skip released rows.
//
// Why: a released player keeps his ownership row as history, and the old index covered every row,
// so buying him back in a mini-auction failed on UNIQUE — after the bid had already been marked
// sold, leaving the lot sold to nobody and the buyer uncharged.
//
// SAFE TO RUN ANY TIME, before or after the code deploys — but before the next mini-auction. The
// new index is strictly looser than the old one, so existing data always satisfies it and nothing
// that worked before can start failing. Drop and create run as one batch, so the table is never
// without the index.
//
// Run with:
//   npx dotenv -e .env.test  -- node scripts/apply-0026-ownership-partial-unique.mjs
//   npx dotenv -e .env.dev   -- node scripts/apply-0026-ownership-partial-unique.mjs
//   npx dotenv -e .env.local -- node scripts/apply-0026-ownership-partial-unique.mjs
//
// THEN mark it applied so `npm run db:migrate` does not try to re-run it:
//   npx dotenv -e .env.local -- node scripts/seed-drizzle-migrations-table.mjs
//
// Idempotent: if the live index is already partial it changes nothing.

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
  "CREATE UNIQUE INDEX `auction_ownership_active_unique` ON `auction_ownership` (`league_id`,`fpl_element_id`) WHERE status <> 'released'";

async function main() {
  console.log(`target: ${url}`);
  const found = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    args: [INDEX],
  });
  const current = found.rows[0]?.sql == null ? null : String(found.rows[0].sql);
  console.log(`current: ${current ?? "(no such index)"}`);
  if (current && /\bWHERE\b/i.test(current)) {
    console.log("[skip] already partial");
    return;
  }
  await client.batch([`DROP INDEX IF EXISTS \`${INDEX}\``, CREATE], "write");
  console.log(`[done] ${CREATE}`);
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => client.close());
