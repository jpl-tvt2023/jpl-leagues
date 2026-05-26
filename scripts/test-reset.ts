/**
 * Test database reset + seed.
 *
 * Invoked via `npm run test:reset` (which loads .env.test before running).
 *
 * 1. Refuses to run unless DATABASE_URL points at a `file:` URL whose path
 *    contains "test" (so a misconfigured shell can never touch Turso or
 *    dev.db). This is the only safety net between this script and prod.
 * 2. Deletes the existing SQLite file (and -shm / -wal sidecars).
 * 3. Runs `drizzle-kit push` against the empty file to recreate every table.
 * 4. Seeds one superadmin user that every spec reuses for setup.
 */

import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { users } from "../src/lib/db/schema";

const TEST_SUPERADMIN = {
  email: "test-super@jpl.local",
  name: "Test Superadmin",
  password: "testpass1234",
};

function guardDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) {
    throw new Error(
      `test-reset.ts refuses to run unless DATABASE_URL is a file: URL (got ${url ?? "<unset>"}).`,
    );
  }
  // The file path must include "test" to make accidental mis-pointing impossible.
  // Accepts file:./test.db, file:test.db, file:/abs/path/test.db, etc.
  const filePart = url.slice("file:".length);
  if (!/test/i.test(filePart)) {
    throw new Error(
      `test-reset.ts refuses to run unless DATABASE_URL path contains "test" (got ${url}). ` +
        "This prevents accidental wipes of dev.db or other local files.",
    );
  }
  return url;
}

function resolveFilePath(url: string): string {
  // file:./test.db   → ./test.db
  // file:test.db     → test.db
  // file:/abs/x.db   → /abs/x.db
  const raw = url.slice("file:".length);
  return path.resolve(process.cwd(), raw);
}

function wipeDb(filePath: string) {
  for (const suffix of ["", "-shm", "-wal"]) {
    const candidate = filePath + suffix;
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
      console.log(`  ✓ removed ${path.relative(process.cwd(), candidate)}`);
    }
  }
}

function runDrizzlePush() {
  // Inherit env so drizzle.config.ts sees the same DATABASE_URL.
  // shell:true is required on Windows so the locally-installed `drizzle-kit`
  // bin is resolved through node_modules\.bin.
  const result = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
    stdio: "inherit",
    env: process.env,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`drizzle-kit push failed with exit code ${result.status}`);
  }
}

async function seedSuperadmin(url: string) {
  const client = createClient({ url });
  const db = drizzle(client);

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, TEST_SUPERADMIN.email))
    .limit(1);
  if (existing.length > 0) {
    console.log(`  ✓ superadmin already present (${TEST_SUPERADMIN.email})`);
    return;
  }

  const hashed = await bcrypt.hash(TEST_SUPERADMIN.password, 10);
  await db.insert(users).values({
    id: randomUUID(),
    email: TEST_SUPERADMIN.email,
    name: TEST_SUPERADMIN.name,
    password: hashed,
    role: "superadmin",
    mustChangePassword: false,
  });
  console.log(`  ✓ seeded superadmin (${TEST_SUPERADMIN.email} / ${TEST_SUPERADMIN.password})`);
}

async function main() {
  const url = guardDatabaseUrl();
  const filePath = resolveFilePath(url);

  console.log(`\n🧪  Resetting test database at ${path.relative(process.cwd(), filePath)}\n`);
  console.log("→ wiping existing file");
  wipeDb(filePath);

  console.log("→ applying schema via drizzle-kit push");
  runDrizzlePush();

  console.log("→ seeding superadmin");
  await seedSuperadmin(url);

  console.log("\n✅  Test database ready.\n");
}

main().catch((err) => {
  console.error("\n❌  test-reset failed:\n", err);
  process.exit(1);
});
