#!/usr/bin/env node
/**
 * Reset Database Script
 * Drops all tables from the live Turso database.
 * Run this once when switching to db:push workflow.
 * Then run: npm run db:push
 */

const { createClient } = require("@libsql/client");
const fs = require("fs");
const path = require("path");

// Load .env.local manually
const envPath = path.join(__dirname, "../.env.local");
const envLines = fs.readFileSync(envPath, "utf-8").split("\n");
for (const line of envLines) {
  const eq = line.indexOf("=");
  if (eq > 0) {
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    process.env[key] = value;
  }
}

const url = process.env.TURSO_CONNECTION_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url || !authToken) {
  console.error(
    "❌ TURSO_CONNECTION_URL and TURSO_AUTH_TOKEN required from .env.local"
  );
  process.exit(1);
}

const client = createClient({ url, authToken });

async function run() {
  try {
    console.log("🔄 Resetting database...\n");

    // Disable foreign keys temporarily
    await client.execute("PRAGMA foreign_keys = OFF");

    // Get all table names
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    const tables = result.rows.map((row) => row.name);

    if (tables.length === 0) {
      console.log("ℹ️  No tables found. Database already empty.\n");
    } else {
      console.log(`Found ${tables.length} table(s):`);
      for (const table of tables) {
        console.log(`  • ${table}`);
      }
      console.log("\nDropping all tables...\n");

      for (const table of tables) {
        await client.execute(`DROP TABLE IF EXISTS \`${table}\``);
        console.log(`✓ Dropped: ${table}`);
      }
    }

    // Re-enable foreign keys
    await client.execute("PRAGMA foreign_keys = ON");

    console.log(
      "\n✅ Database reset complete!\n" +
      "   Next step: npm run db:push\n" +
      "   This will recreate all tables from src/lib/db/schema.ts\n"
    );
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

run();
