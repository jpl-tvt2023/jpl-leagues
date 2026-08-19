/**
 * Regression test for club-auction nominator rotation.
 *
 * Guards the fix for the incident where a nominator who was outbid kept being re-armed on the spot,
 * so one team hogged every nomination until they finally won a club.
 *
 * Point it at a scratch DB, never dev or prod:
 *   DATABASE_URL="file:./scratch.db" npx drizzle-kit push --force
 *   DATABASE_URL="file:./scratch.db" npx tsx scripts/verify-club-ring.ts
 */
import { db } from "@/lib/db";
import { leagues, teams, auctionSessions, auctionClubOwnership } from "@/lib/db/schema";
import { advanceClubNominator, setClubNominationDeadline, getClubLessTeamIds } from "@/lib/formats/auction/club-auction";
import { eq } from "drizzle-orm";

const LEAGUE_ID = "zz-verify-club-ring";
const SESSION_ID = "zz-verify-club-sess";
const TEAM_IDS = ["zz-t0", "zz-t1", "zz-t2", "zz-t3"];

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
async function sess() {
  const r = await db.select().from(auctionSessions).where(eq(auctionSessions.id, SESSION_ID)).limit(1);
  return r[0];
}
async function clearDeadline() {
  await db.update(auctionSessions).set({ nominationDeadline: null }).where(eq(auctionSessions.id, SESSION_ID));
}
async function giveClub(teamId: string, plTeamId: number) {
  await db.insert(auctionClubOwnership).values({
    id: `zz-own-${teamId}`, leagueId: LEAGUE_ID, teamId, plTeamId,
    plTeamName: `Club ${plTeamId}`, plTeamShort: `C${plTeamId}`, tier: "mid",
    purchasePrice: 500_000, acquiredAt: new Date(), createdAt: new Date(),
  });
}

async function main() {
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID));
  await db.insert(leagues).values({
    id: LEAGUE_ID, slug: LEAGUE_ID, name: "ZZ Verify", sport: "fpl",
    format: "auction", season: "2026-27", clubAuctionEnabled: true,
  });
  for (const [i, id] of TEAM_IDS.entries()) {
    await db.insert(teams).values({ id, name: `ZZ Team ${i}`, leagueId: LEAGUE_ID, password: "x", purse: 100_000_000 });
  }
  await db.insert(auctionSessions).values({
    id: SESSION_ID, leagueId: LEAGUE_ID, type: "club-auction", status: "active",
    snakeOrder: JSON.stringify(TEAM_IDS), currentNominatorIndex: 0,
    nominationDeadline: null, nominationTimeoutSeconds: 60,
  });

  console.log("\n--- Outbid nominator must not keep the mic ---");
  await setClubNominationDeadline(SESSION_ID);
  check("start armed at index", (await sess()).currentNominatorIndex, 0);
  for (const expected of [1, 2, 3, 0]) {
    await clearDeadline();
    await advanceClubNominator(SESSION_ID);
    check("advance -> index", (await sess()).currentNominatorIndex, expected);
  }

  console.log("\n--- Duplicate advance is a no-op ---");
  await clearDeadline();
  await advanceClubNominator(SESSION_ID);
  const after = (await sess()).currentNominatorIndex;
  await advanceClubNominator(SESSION_ID);
  check("duplicate no-op", (await sess()).currentNominatorIndex, after);

  console.log("\n--- Intermission claim: advance only with a token, exactly once ---");
  await db.update(auctionSessions)
    .set({ currentNominatorIndex: 0, nominationDeadline: null, intermissionUntil: new Date(Date.now() - 1000) })
    .where(eq(auctionSessions.id, SESSION_ID));
  await advanceClubNominator(SESSION_ID, { clearIntermission: true });
  check("advanced with token", (await sess()).currentNominatorIndex, 1);
  check("token consumed", (await sess()).intermissionUntil, null);
  await clearDeadline();
  await advanceClubNominator(SESSION_ID, { clearIntermission: true });
  check("no token -> no advance", (await sess()).currentNominatorIndex, 1);

  console.log("\n--- Club owners skipped; last club-less team re-armed; then idles ---");
  await db.update(auctionSessions).set({ currentNominatorIndex: 0, intermissionUntil: null }).where(eq(auctionSessions.id, SESSION_ID));
  await giveClub("zz-t1", 1);
  await clearDeadline();
  await advanceClubNominator(SESSION_ID);
  check("skips club-owner at 1", (await sess()).currentNominatorIndex, 2);
  await giveClub("zz-t2", 2); await giveClub("zz-t3", 3);
  await clearDeadline();
  await advanceClubNominator(SESSION_ID);
  check("wraps to lone club-less team", (await sess()).currentNominatorIndex, 0);
  check("clubless count", (await getClubLessTeamIds(LEAGUE_ID)).length, 1);
  await giveClub("zz-t0", 4);
  await clearDeadline();
  await advanceClubNominator(SESSION_ID);
  check("idles with no deadline", (await sess()).nominationDeadline, null);
  check("still active", (await sess()).status, "active");

  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID));
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — temp league cleaned up`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(async (e) => {
  console.error(e);
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID)).catch(() => {});
  process.exitCode = 1;
});
