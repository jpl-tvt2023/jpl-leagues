/**
 * Backfill Script — Migration 0002 → 0003
 *
 * After running migration 0002 (which adds nullable league_id columns to
 * groups, teams, and gameweeks), this script sets league_id on all rows
 * to the single existing league. Run this before applying migration 0003.
 *
 * Usage:
 *   TURSO_CONNECTION_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/backfill-league-id.ts
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { leagues, groups, teams, gameweeks } from "../src/lib/db/schema";
import { isNull } from "drizzle-orm";

const client = createClient({
  url: process.env.TURSO_CONNECTION_URL || "file:./tvt-league.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(client);

async function main() {
  // Find the single existing league
  const allLeagues = await db.select({ id: leagues.id, name: leagues.name }).from(leagues);

  if (allLeagues.length === 0) {
    console.error("No leagues found in the database. Create a league first via the superadmin UI.");
    process.exit(1);
  }

  if (allLeagues.length > 1) {
    console.warn(`Found ${allLeagues.length} leagues. Using the first one: "${allLeagues[0].name}" (${allLeagues[0].id})`);
    console.warn("If this is wrong, manually set the leagueId and re-run.");
  }

  const leagueId = allLeagues[0].id;
  console.log(`Backfilling league_id = "${leagueId}" (${allLeagues[0].name})`);

  // Backfill groups
  const groupResult = await db
    .update(groups)
    .set({ leagueId })
    .where(isNull(groups.leagueId));
  console.log(`  groups updated`);

  // Backfill teams
  await db
    .update(teams)
    .set({ leagueId })
    .where(isNull(teams.leagueId));
  console.log(`  teams updated`);

  // Backfill gameweeks
  await db
    .update(gameweeks)
    .set({ leagueId })
    .where(isNull(gameweeks.leagueId));
  console.log(`  gameweeks updated`);

  console.log("Backfill complete. You can now run migration 0003.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
