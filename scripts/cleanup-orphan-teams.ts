import "dotenv/config";
import { db, fkReady, leagues, teams } from "../src/lib/db";
import { sql } from "drizzle-orm";

// Detects (and optionally deletes) team rows whose leagueId no longer resolves
// to a row in `leagues`. Such rows can exist if FK enforcement was off at the
// time, or if a prior non-transactional creation flow half-failed. Pass --apply
// to actually delete; default is dry-run.
async function main() {
  await fkReady;
  const apply = process.argv.includes("--apply");

  const allTeams = await db.select({ id: teams.id, teamLoginId: teams.teamLoginId, leagueId: teams.leagueId, name: teams.name }).from(teams);
  const allLeagueIds = new Set((await db.select({ id: leagues.id }).from(leagues)).map((l) => l.id));

  const orphans = allTeams.filter((t) => !allLeagueIds.has(t.leagueId));

  if (orphans.length === 0) {
    console.log("No orphan teams found.");
    return;
  }

  console.log(`Found ${orphans.length} orphan team rows:`);
  for (const o of orphans) {
    console.log(`  - id=${o.id} loginId=${o.teamLoginId} name=${o.name} leagueId=${o.leagueId}`);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to delete these rows.");
    return;
  }

  for (const o of orphans) {
    await db.delete(teams).where(sql`id = ${o.id}`);
  }
  console.log(`Deleted ${orphans.length} orphan team rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
