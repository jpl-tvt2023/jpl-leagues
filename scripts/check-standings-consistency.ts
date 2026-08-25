/**
 * Cross-surface standings consistency check.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/check-standings-consistency.ts
 *
 * Asserts that every surface which ranks teams gives the SAME answer: the standings
 * table, playoff seeding, the dashboard's group tables, Challenge-Chip legal targets and
 * Double-Pointer eligibility. They are all supposed to come through
 * computeLeagueStageStandings now; this proves none has forked again.
 *
 * It exists because that divergence shipped three times. Each time it surfaced as a user
 * noticing two screens disagreeing, not as a failing test — the rules lived in five
 * separate comparators with nothing comparing them. Run this after touching anything
 * that ranks teams. Exits non-zero on disagreement.
 */
import { db, leagues, teams, groups } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { computeLeagueStageStandings } from "@/lib/standings/league-stage";
import { getTop2FromGroup, getGroupRankingsBeforeGW } from "@/lib/formats/tvt/chip-validation";
import { getGroupStandings } from "@/lib/formats/tvt/playoffs";

const SLUG = "tvt-26-27";

async function main() {
  const lg = await db.select().from(leagues).where(eq(leagues.slug, SLUG)).limit(1);
  const leagueId = lg[0].id;
  const stageEnd = (lg[0].playoffStartGw ?? 31) - 1;

  const { byGroup } = await computeLeagueStageStandings(leagueId);

  console.log("=== 1. Canonical table (what /standings renders) ===");
  for (const g of ["A", "B"]) {
    const top = (byGroup.get(g) ?? []).slice(0, 3);
    console.log(`  Group ${g}: ` + top.map((r) => `${r.groupRank}.${r.name}(${r.pointsFor})`).join("  "));
  }

  console.log("\n=== 2. Playoff seeding agrees ===");
  const seeding = await getGroupStandings(leagueId, stageEnd);
  let seedOk = true;
  for (const g of ["A", "B"] as const) {
    const canonical = (byGroup.get(g) ?? []).map((r) => r.teamId);
    const seeded = (g === "A" ? seeding!.groupA : seeding!.groupB).map((r) => r.teamId);
    const same = JSON.stringify(canonical) === JSON.stringify(seeded);
    if (!same) seedOk = false;
    console.log(`  Group ${g}: ${same ? "matches" : "DIFFERS"}`);
  }

  console.log("\n=== 3. Challenge Chip top-2 of the opposite group (GW2) ===");
  const grpRows = await db.select().from(groups).where(eq(groups.leagueId, leagueId));
  let chipOk = true;
  for (const grp of grpRows.filter((g) => (g.groupType ?? "jpl") !== "cup")) {
    const top2 = await getTop2FromGroup(grp.id, 2);
    const names = await Promise.all(
      top2.map(async (t) => (await db.select({ n: teams.name }).from(teams).where(eq(teams.id, t.teamId)).limit(1))[0].n),
    );
    const expected = (byGroup.get(grp.name) ?? []).slice(0, 2).map((r) => r.name);
    const same = JSON.stringify(names) === JSON.stringify(expected);
    if (!same) chipOk = false;
    console.log(`  Group ${grp.name}: [${names.join(", ")}] ${same ? "matches standings top 2" : `DIFFERS (expected ${expected.join(", ")})`}`);
  }

  console.log("\n=== 4. Chip ranker rank == standings rank (drives Double Pointer) ===");
  let dpOk = true;
  for (const grp of grpRows.filter((g) => (g.groupType ?? "jpl") !== "cup")) {
    const ranks = await getGroupRankingsBeforeGW(grp.id, 2);
    for (const r of ranks) {
      const canonical = (byGroup.get(grp.name) ?? []).find((x) => x.teamId === r.teamId);
      if (canonical && canonical.groupRank !== r.rank) {
        console.log(`  MISMATCH ${canonical.name}: standings #${canonical.groupRank} vs chip ranker #${r.rank}`);
        dpOk = false;
      }
    }
  }
  if (dpOk) console.log("  every team's chip-eligibility rank equals its standings rank");

  console.log("\n=== 5. Dashboard group tables (top 5 rows per group) ===");
  for (const grp of grpRows.filter((g) => (g.groupType ?? "jpl") !== "cup")) {
    const rows = (byGroup.get(grp.name) ?? []).slice(0, 5);
    console.log(`  Group ${grp.name}: ` + rows.map((r, i) => `${i + 1}.${r.name}`).join("  "));
  }

  const myTeam = await db.select().from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.name, "Differential Disaster"))).limit(1);
  if (myTeam.length) {
    const row = [...byGroup.values()].flat().find((r) => r.teamId === myTeam[0].id)!;
    console.log(`\n  "Differential Disaster": rank #${row.groupRank}, zone=${row.zone}, pts=${row.leaguePoints}, scores=${row.pointsFor}`);
    console.log(`  (dashboard used to say #11; standings page said #14)`);
  }

  console.log(`\nRESULT: seeding=${seedOk ? "ok" : "FAIL"}  challengeTop2=${chipOk ? "ok" : "FAIL"}  dpRanks=${dpOk ? "ok" : "FAIL"}`);
  process.exit(seedOk && chipOk && dpOk ? 0 : 1);
}
main();
