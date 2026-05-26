/**
 * Direct Drizzle client bound to the test SQLite file. Specs use this for
 * fast setup writes that don't have a clean API (e.g. seeding gameweek scores,
 * inspecting computed standings, asserting backup row counts).
 *
 * The client is intentionally created lazily so importing this module from
 * playwright.config.ts (or before .env.test is loaded) doesn't crash on a
 * missing DATABASE_URL.
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "../../src/lib/db/schema";

let _db: ReturnType<typeof drizzle> | null = null;

export function testDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) {
    throw new Error(
      `tests/harness/db.ts: DATABASE_URL must be a file: URL (got ${url ?? "<unset>"}). ` +
        "Are you running tests with `npm run test:e2e` (which loads .env.test)?",
    );
  }
  if (!/test/i.test(url)) {
    throw new Error(
      `tests/harness/db.ts: refusing to connect to ${url} — path must contain "test".`,
    );
  }
  const client = createClient({ url });
  // Match production index.ts behaviour — referential integrity matters in tests too.
  void client.execute("PRAGMA foreign_keys = ON");
  _db = drizzle(client, { schema });
  return _db;
}

export { schema };
