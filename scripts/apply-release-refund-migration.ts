/**
 * One-off, idempotent migration runner for 0018_auction_release_refund.
 * Adds `release_refund` to `auction_ownership` only if it doesn't already exist.
 * Run per-environment:  dotenv -e .env.dev -- tsx scripts/apply-release-refund-migration.ts
 *                       dotenv -e .env.local -- tsx scripts/apply-release-refund-migration.ts
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
  const info = await client.execute("PRAGMA table_info('auction_ownership')");
  const cols = new Set(info.rows.map((r) => String(r.name)));
  if (cols.has("release_refund")) {
    console.log('[migrate] skip: column "release_refund" already exists');
  } else {
    await client.execute("ALTER TABLE `auction_ownership` ADD COLUMN `release_refund` INTEGER");
    console.log('[migrate] added column "release_refund"');
  }
  console.log("[migrate] done.");
  client.close();
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
