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
 *
 * ## The cut is the whole trick
 *
 * Chip eligibility is defined against the table as it stood BEFORE a gameweek, so
 * `getGroupRankingsBeforeGW(g, n)` resolves `throughGw: n - 1` internally. Sections 3 and 4
 * therefore have to compare it against `computeLeagueStageStandings(league, { throughGw: n - 1 })`
 * — the SAME cut — not against the full-season table.
 *
 * They used to pass a hardcoded `2` and compare the result against the unscoped table, i.e.
 * they asserted "the table after one gameweek equals the table after thirty". That holds only
 * while a season is one gameweek old, which is when this script was written; every run since
 * has reported noise. Sweeping every played gameweek instead of naming one is what stops the
 * same rot recurring — any constant here would decay the same way.
 *
 * ## What a green run does and does not prove
 *
 * `getGroupRankingsBeforeGW` delegates to `computeLeagueStageStandings`, so comparing the two
 * at the same cut is tautological on today's code. That is the point: it is a tripwire for a
 * future re-fork, plus a pin on the projection in chip-validation.ts (in-group `rank`, and
 * `bonusPoints` carrying CP/BP rather than the stored bonus-COUNT column). It does not
 * independently verify the ranking maths.
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

  // `maxPlayedGw` bounds the sweep in sections 3-4. Taking it from the computation the script
  // already runs is what keeps the swept range following the season with no constant to update.
  const { byGroup, maxPlayedGw } = await computeLeagueStageStandings(leagueId);

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

  const grpRows = await db.select().from(groups).where(eq(groups.leagueId, leagueId));
  const jplGroups = grpRows.filter((g) => (g.groupType ?? "jpl") !== "cup");

  // Every gameweek a chip could have been played in.
  //   from 2: `getGroupRankingsBeforeGW(g, 1)` is `throughGw: 0`, an empty all-square table.
  //           Both real callers special-case GW1 rather than consulting it, so asserting on
  //           it would pin a case the app never reaches.
  //   to maxPlayedGw + 1: the gameweek currently open for submissions, i.e. the cut live
  //           chip validation is using right now. Clamped to stageEnd + 1 so the sweep never
  //           runs past the league stage into the playoffs, where a different chip set applies.
  const firstGw = 2;
  const lastGw = Math.min(maxPlayedGw + 1, stageEnd + 1);

  console.log("\n=== 3. Challenge Chip top-2 legal targets, at each cut ===");
  console.log("=== 4. Chip ranker rank == standings rank (drives Double Pointer) ===");
  let chipOk = true;
  let dpOk = true;

  if (lastGw < firstGw) {
    // Not a pass. An empty sweep reporting "ok" is the same class of silent lie this script
    // exists to catch, so say plainly that nothing was compared.
    console.log(`  no played gameweeks yet (maxPlayedGw=${maxPlayedGw}), nothing to compare`);
  }

  for (let gw = firstGw; gw <= lastGw; gw++) {
    // The -1 is the crux. It mirrors what getGroupRankingsBeforeGW does internally; drop it
    // and the script silently compares two adjacent gameweeks and calls the difference a bug.
    const { byGroup: ref } = await computeLeagueStageStandings(leagueId, { throughGw: gw - 1 });
    const verdicts: string[] = [];
    // Buffered so the per-gameweek summary line prints above its own detail, not below it.
    const detail: string[] = [];

    for (const grp of jplGroups) {
      const canonical = ref.get(grp.name) ?? [];
      const problems: string[] = [];

      // Section 3: the Challenge Chip's legal targets are the top 2 of this cut.
      const top2 = await getTop2FromGroup(grp.id, gw);
      const wantTop2 = canonical.slice(0, 2);
      if (top2.length !== wantTop2.length || top2.some((t, i) => t.teamId !== wantTop2[i].teamId)) {
        chipOk = false;
        const got = top2.map((t) => canonical.find((c) => c.teamId === t.teamId)?.name ?? t.teamId);
        problems.push(`top 2: chip ranker says [${got.join(", ")}], canonical says [${wantTop2.map((r) => r.name).join(", ")}]`);
      }

      // Section 4: the full ranking, and the projection that carries it.
      const ranks = await getGroupRankingsBeforeGW(grp.id, gw);
      if (ranks.length !== canonical.length) {
        dpOk = false;
        problems.push(`length: chip ranker returned ${ranks.length} rows, canonical has ${canonical.length}`);
      } else {
        for (let i = 0; i < ranks.length; i++) {
          const r = ranks[i];
          const row = canonical[i];
          if (r.teamId !== row.teamId) {
            dpOk = false;
            const gotName = canonical.find((c) => c.teamId === r.teamId)?.name ?? r.teamId;
            problems.push(`position ${i + 1}: chip ranker says ${gotName}, canonical says ${row.name}`);
            continue;
          }
          // `rank` must be the in-group rank, not a global one.
          if (r.rank !== row.groupRank) {
            dpOk = false;
            problems.push(`${row.name}: chip ranker rank #${r.rank} vs standings #${row.groupRank}`);
          }
          if (r.leaguePoints !== row.leaguePoints) {
            dpOk = false;
            problems.push(`${row.name}: leaguePoints ${r.leaguePoints} vs ${row.leaguePoints}`);
          }
          // The documented trap: this field must carry CP/BP, never the stored teams.bonusPoints
          // ledger, which is a COUNT of bonuses rather than points.
          if (r.bonusPoints !== row.cbpPoints) {
            dpOk = false;
            problems.push(`${row.name}: bonusPoints ${r.bonusPoints} vs cbpPoints ${row.cbpPoints}`);
          }
        }
      }

      verdicts.push(`${grp.name} ${problems.length === 0 ? "ok" : "MISMATCH"}`);
      for (const p of problems) detail.push(`      ${grp.name}: ${p}`);
    }

    console.log(`  GW${gw} (through GW${gw - 1}): ${verdicts.join("  ")}`);
    for (const d of detail) console.log(d);
  }

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
