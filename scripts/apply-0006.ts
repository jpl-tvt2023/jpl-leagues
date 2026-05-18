// One-shot migration runner for 0006_pl_club_auction.sql.
//
// Why this exists: drizzle-kit push refuses to add a NOT NULL column when existing rows are present,
// even when the schema declares a DEFAULT — it surfaces a "data loss" prompt that's impractical to
// answer non-interactively. The 0006 migration file already contains the correct
// `ALTER TABLE ... DEFAULT X NOT NULL` statements that SQLite executes safely (existing rows get
// the default). This script just streams those statements at the libsql client.
//
// Usage:
//   npx dotenv -e .env.local -- tsx scripts/apply-0006.ts   # prod
//   npx dotenv -e .env.dev   -- tsx scripts/apply-0006.ts   # dev (idempotent — fails harmless if already applied)

import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
import { join } from "path";

function resolveConfig(): { url: string; authToken?: string } {
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
  const cfg = resolveConfig();
  const target = cfg.url.startsWith("file:") ? `local file (${cfg.url})` : cfg.url;
  console.log(`Applying 0006_pl_club_auction.sql → ${target}`);

  const client = createClient(cfg);
  await client.execute("PRAGMA foreign_keys = ON");

  const sqlPath = join(process.cwd(), "drizzle", "0006_pl_club_auction.sql");
  const raw = readFileSync(sqlPath, "utf-8");

  // Split on drizzle's statement breakpoint marker, strip blanks/comments.
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  let applied = 0;
  let skippedExisting = 0;
  let failed = 0;
  for (const sql of statements) {
    const summary = sql.split("\n")[0].slice(0, 80);
    try {
      await client.execute(sql);
      console.log(`  ✓ ${summary}`);
      applied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // SQLite duplicates (table exists, column exists, index exists) are expected if we re-run.
      if (/already exists|duplicate column name/i.test(msg)) {
        console.log(`  · ${summary} — already in place, skipping`);
        skippedExisting++;
      } else {
        console.error(`  ✗ ${summary}`);
        console.error(`    ${msg}`);
        failed++;
      }
    }
  }

  console.log(`\nSummary: ${applied} applied, ${skippedExisting} already-in-place, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
