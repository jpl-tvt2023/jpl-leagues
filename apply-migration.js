#!/usr/bin/env node

import { Client } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const client = new Client({
  url: process.env.TURSO_CONNECTION_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function applyMigration() {
  try {
    console.log("Connecting to database...");

    // Try to add the columns
    const queries = [
      "ALTER TABLE `teams` ADD COLUMN `cup_group_points` integer DEFAULT 0 NOT NULL;",
      "ALTER TABLE `teams` ADD COLUMN `is_ghost` integer DEFAULT false NOT NULL;",
    ];

    for (const query of queries) {
      try {
        console.log(`Executing: ${query}`);
        await client.execute(query);
        console.log("✓ Success");
      } catch (err) {
        // Column might already exist
        if (err.message?.includes("duplicate column")) {
          console.log("✓ Column already exists");
        } else {
          console.error(`✗ Error: ${err.message}`);
        }
      }
    }

    console.log("\nMigration complete!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

applyMigration();
