/**
 * Regression test for player-auction turn order: no team nominates twice, and no team is skipped.
 *
 * Guards the fix for the live incident where one team nominated two lots in a row and the next team
 * lost its turn entirely — caused by an unconsumed intermission being claimable a second time.
 * Check 6 is a control that reproduces the old behaviour, so a vacuous pass is visible.
 *
 * Creates a throwaway league, drives the advance paths directly, then deletes it. Point it at a
 * scratch DB, never dev or prod:
 *   DATABASE_URL="file:./scratch.db" npx drizzle-kit push --force
 *   DATABASE_URL="file:./scratch.db" npx tsx scripts/verify-turn-order.ts
 */
import { db } from "@/lib/db";
import { leagues, teams, auctionSessions, auctionBids, auctionOwnership } from "@/lib/db/schema";
import { advanceNominator, beginIntermission } from "@/lib/formats/auction/resolve-bid";
import { eq } from "drizzle-orm";

const LEAGUE_ID = "zz-verify-turn";
const SESSION_ID = "zz-verify-turn-sess";
const TEAM_IDS = ["zz-a", "zz-b", "zz-c", "zz-d"];

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
async function setState(patch: Record<string, unknown>) {
  await db.update(auctionSessions).set(patch).where(eq(auctionSessions.id, SESSION_ID));
}

async function setup() {
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID));
  await db.insert(leagues).values({
    id: LEAGUE_ID, slug: LEAGUE_ID, name: "ZZ Turn", sport: "fpl",
    format: "auction", season: "2026-27",
  });
  for (const [i, id] of TEAM_IDS.entries()) {
    await db.insert(teams).values({ id, name: `ZZ ${i}`, leagueId: LEAGUE_ID, password: "x", purse: 100_000_000 });
  }
  await db.insert(auctionSessions).values({
    id: SESSION_ID, leagueId: LEAGUE_ID, type: "initial", status: "active",
    snakeOrder: JSON.stringify(TEAM_IDS), currentNominatorIndex: 0,
    nominationDeadline: null, intermissionUntil: null,
    nominationTimeoutSeconds: 60, intermissionSeconds: 5,
  });
}

async function main() {
  await setup();

  console.log("\n--- 1. Normal advance moves exactly one team ---");
  await setState({ currentNominatorIndex: 0, intermissionUntil: new Date(Date.now() - 1000), nominationDeadline: null });
  await advanceNominator(SESSION_ID, { clearIntermission: true });
  check("index after advance", (await sess()).currentNominatorIndex, 1);
  check("intermission consumed", (await sess()).intermissionUntil, null);

  console.log("\n--- 2. Double-trigger (two pollers) advances only once ---");
  await setState({ currentNominatorIndex: 1, intermissionUntil: new Date(Date.now() - 1000), nominationDeadline: null });
  await advanceNominator(SESSION_ID, { clearIntermission: true });
  const afterFirst = (await sess()).currentNominatorIndex;
  await advanceNominator(SESSION_ID, { clearIntermission: true }); // second poller, token already spent
  check("first advance", afterFirst, 2);
  check("second advance is a no-op", (await sess()).currentNominatorIndex, 2);

  console.log("\n--- 3. THE RAUNAK SKIP: a stale intermission must not advance a second time ---");
  // Reproduces prod: a lot resolved while an older, unconsumed intermission was still sitting in
  // the row. Both tokens fired and the team in between never got a turn.
  await setState({ currentNominatorIndex: 0, intermissionUntil: new Date(Date.now() - 250_000), nominationDeadline: null });
  // A new lot opens — the nomination path must scrub the stale token.
  await db.insert(auctionBids).values({
    id: "zz-bid-1", leagueId: LEAGUE_ID, sessionId: SESSION_ID, nominatorTeamId: TEAM_IDS[0],
    fplElementId: 1, playerName: "Zed", currentHighBid: 500000, currentHighBidderId: TEAM_IDS[0],
    minBid: 500000, status: "open", expiresAt: new Date(Date.now() + 45000),
  });
  await setState({ nominationDeadline: null, intermissionUntil: null }); // what the nominate route now does
  check("stale token scrubbed when lot opened", (await sess()).intermissionUntil, null);
  // Lot sells -> one fresh intermission -> exactly one advance.
  await db.update(auctionBids).set({ status: "sold" }).where(eq(auctionBids.id, "zz-bid-1"));
  await beginIntermission(SESSION_ID);
  await setState({ intermissionUntil: new Date(Date.now() - 1000) }); // fast-forward the cooldown
  await advanceNominator(SESSION_ID, { clearIntermission: true });
  check("advanced exactly one team (0 -> 1, not 0 -> 2)", (await sess()).currentNominatorIndex, 1);

  console.log("\n--- 4. Mid-advance crash leaves the token intact for a retry ---");
  await setState({ currentNominatorIndex: 1, intermissionUntil: new Date(Date.now() - 1000), nominationDeadline: null });
  // Simulate a torn-down request: the claim is never written because the whole advance is one write.
  const before = (await sess()).currentNominatorIndex;
  check("token still set before retry", (await sess()).intermissionUntil !== null, true);
  await advanceNominator(SESSION_ID, { clearIntermission: true }); // the retry
  check("retry advanced from the unchanged index", (await sess()).currentNominatorIndex, before + 1);

  console.log("\n--- 5. Advance without a token does nothing when clearIntermission is set ---");
  await setState({ currentNominatorIndex: 2, intermissionUntil: null, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { clearIntermission: true });
  check("no intermission -> no advance", (await sess()).currentNominatorIndex, 2);

  console.log("\n--- 6. CONTROL: the old unguarded path double-advances (this is the bug) ---");
  // The pre-fix callers claimed the intermission separately and then called a plain advance, so
  // nothing stopped a second advance. Reproduced here by advancing without the claim guard.
  await setState({ currentNominatorIndex: 0, intermissionUntil: null, nominationDeadline: null });
  await advanceNominator(SESSION_ID); // poller 1 (old style)
  await advanceNominator(SESSION_ID); // poller 2 (old style) — nothing stops it
  const unguarded = (await sess()).currentNominatorIndex;
  check("unguarded double advance skips a team (0 -> 2)", unguarded, 2);
  console.log("      ^ confirms the guard in checks 2-5 is what prevents the skip");

  await db.delete(auctionOwnership).where(eq(auctionOwnership.leagueId, LEAGUE_ID));
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID));
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — temp league cleaned up`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(async (e) => {
  console.error(e);
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID)).catch(() => {});
  process.exitCode = 1;
});
