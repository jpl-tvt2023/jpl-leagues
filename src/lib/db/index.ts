import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

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

const client = createClient(resolveDbConfig());

// Enforce referential integrity. SQLite/libSQL ship with foreign keys OFF by
// default — without this pragma, ON DELETE CASCADE is silent and orphan rows
// accumulate (the bug that motivated this hardening). The libsql client
// serializes operations on the connection, so this queues before any later
// query executes.
export const fkReady = client.execute("PRAGMA foreign_keys = ON");

export const db = drizzle(client, { schema });

export * from "./schema";
