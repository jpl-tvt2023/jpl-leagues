import "dotenv/config";
import { db, fkReady, leagues, teams } from "../src/lib/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl?.startsWith("file:")) {
    throw new Error(`verify-fk.ts is dev-only (got DATABASE_URL=${dbUrl})`);
  }
  await fkReady;

  const pragma = await db.run(sql`PRAGMA foreign_keys`);
  console.log("PRAGMA foreign_keys =", pragma.rows[0]);

  // 1. Orphan insert should fail (teams.leagueId references a non-existent league).
  try {
    await db.insert(teams).values({
      id: randomUUID(),
      name: "Orphan Test",
      leagueId: "non-existent-league-id",
      abbreviation: "OT",
      password: "x",
    });
    console.error("FAIL: orphan insert succeeded; FK constraint not enforced");
    process.exit(1);
  } catch (e: any) {
    const code = e?.code ?? e?.cause?.code;
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY" || code === "SQLITE_CONSTRAINT") {
      console.log("OK: orphan insert correctly rejected by FK constraint");
    } else {
      throw e;
    }
  }

  // 2. Cascade: insert league + team, delete league, team should disappear.
  const leagueId = randomUUID();
  await db.insert(leagues).values({
    id: leagueId,
    slug: `verify-${leagueId.slice(0, 8)}`,
    name: "Verify League",
    sport: "fpl",
    format: "tvt",
    season: "2099-00",
  });
  const teamId = randomUUID();
  await db.insert(teams).values({
    id: teamId,
    name: "Verify Team",
    leagueId,
    abbreviation: "VT",
    password: "x",
  });
  await db.delete(leagues).where(sql`id = ${leagueId}`);
  const remaining = await db.select().from(teams).where(sql`id = ${teamId}`);
  if (remaining.length === 0) {
    console.log("OK: deleting league cascaded to team");
  } else {
    console.error("FAIL: team survived league delete; cascade not active");
    process.exit(1);
  }

  console.log("All FK checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
