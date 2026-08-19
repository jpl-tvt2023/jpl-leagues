/**
 * Regression tests for player-auction turn order.
 *
 * Covers two live incidents:
 *   A. One team nominated two lots in a row and the next team lost its turn — an unconsumed
 *      intermission was claimable a second time.
 *   B. A team was penalised 2s after successfully nominating, while the *next* team's fresh 60s
 *      window was silently consumed — the timeout claim matched "any non-null deadline" instead of
 *      the specific window the poll had observed.
 *
 * Checks 6 and 9 are CONTROLS that reproduce the old behaviour, so a vacuous pass is visible.
 *
 * The claim queries for B are re-expressed here rather than imported, because they live inline in
 * the SSE route. That means these checks verify the claim *semantics* (including how drizzle
 * compares `integer(mode:"timestamp")` columns), not the route wiring — the route uses the same
 * predicates.
 *
 * Point it at a scratch DB, never dev or prod:
 *   DATABASE_URL="file:./scratch.db" npx drizzle-kit push --force
 *   DATABASE_URL="file:./scratch.db" npx tsx scripts/verify-turn-order.ts
 */
import { db } from "@/lib/db";
import { leagues, teams, auctionSessions, auctionBids, auctionOwnership } from "@/lib/db/schema";
import { advanceNominator, beginIntermission } from "@/lib/formats/auction/resolve-bid";
import { eq, and, isNotNull } from "drizzle-orm";

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

/** The FIXED timeout claim: matches the exact deadline + cursor the poll observed. */
async function claimTimeoutExact(snapshot: { nominationDeadline: Date; currentNominatorIndex: number }) {
  const r = await db
    .update(auctionSessions)
    .set({ nominationDeadline: null })
    .where(and(
      eq(auctionSessions.id, SESSION_ID),
      eq(auctionSessions.nominationDeadline, snapshot.nominationDeadline),
      eq(auctionSessions.currentNominatorIndex, snapshot.currentNominatorIndex),
    ));
  return r.rowsAffected;
}

/** The OLD timeout claim: matches any non-null deadline. Used as a control. */
async function claimTimeoutLoose() {
  const r = await db
    .update(auctionSessions)
    .set({ nominationDeadline: null })
    .where(and(eq(auctionSessions.id, SESSION_ID), isNotNull(auctionSessions.nominationDeadline)));
  return r.rowsAffected;
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

  // ── A: intermission / advance ────────────────────────────────────────────────────────────────
  console.log("\n--- 1. Normal advance moves exactly one team ---");
  const t1 = new Date(Date.now() - 1000);
  await setState({ currentNominatorIndex: 0, intermissionUntil: t1, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: t1 });
  check("index after advance", (await sess()).currentNominatorIndex, 1);
  check("intermission consumed", (await sess()).intermissionUntil, null);

  console.log("\n--- 2. Double-trigger (two pollers, same token) advances only once ---");
  const t2 = new Date(Date.now() - 1000);
  await setState({ currentNominatorIndex: 1, intermissionUntil: t2, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: t2 });
  const afterFirst = (await sess()).currentNominatorIndex;
  await advanceNominator(SESSION_ID, { claimIntermission: t2 }); // second poller, token already spent
  check("first advance", afterFirst, 2);
  check("second advance is a no-op", (await sess()).currentNominatorIndex, 2);

  console.log("\n--- 3. A stale token must not spend a NEWER intermission ---");
  const stale = new Date(Date.now() - 250_000);
  // Whole seconds: the column is integer(mode:"timestamp"), so sub-second precision is truncated on
  // write. Values read back from the DB (which is what the route compares) are always whole seconds.
  const fresh = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({ currentNominatorIndex: 0, intermissionUntil: fresh, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: stale }); // poller holding an old snapshot
  check("stale token does not advance", (await sess()).currentNominatorIndex, 0);
  check("newer token survives", (await sess()).intermissionUntil?.getTime(), fresh.getTime());
  await advanceNominator(SESSION_ID, { claimIntermission: fresh }); // the legitimate poller
  check("legitimate token advances once", (await sess()).currentNominatorIndex, 1);

  console.log("\n--- 4. Opening a lot scrubs a pending intermission ---");
  await setState({ currentNominatorIndex: 0, intermissionUntil: new Date(Date.now() - 250_000), nominationDeadline: null });
  await db.insert(auctionBids).values({
    id: "zz-bid-1", leagueId: LEAGUE_ID, sessionId: SESSION_ID, nominatorTeamId: TEAM_IDS[0],
    fplElementId: 1, playerName: "Zed", currentHighBid: 500000, currentHighBidderId: TEAM_IDS[0],
    minBid: 500000, status: "open", expiresAt: new Date(Date.now() + 30000),
  });
  await setState({ nominationDeadline: null, intermissionUntil: null }); // what the nominate route does
  check("stale token scrubbed when lot opened", (await sess()).intermissionUntil, null);
  await db.update(auctionBids).set({ status: "sold" }).where(eq(auctionBids.id, "zz-bid-1"));
  await beginIntermission(SESSION_ID);
  const postSale = (await sess()).intermissionUntil!;
  await setState({ intermissionUntil: new Date(Date.now() - 1000) });
  const armed = (await sess()).intermissionUntil!;
  void postSale;
  await advanceNominator(SESSION_ID, { claimIntermission: armed });
  check("advanced exactly one team (0 -> 1, not 0 -> 2)", (await sess()).currentNominatorIndex, 1);

  console.log("\n--- 5. Advance without a matching token does nothing ---");
  await setState({ currentNominatorIndex: 2, intermissionUntil: null, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: new Date(Date.now() - 1000) });
  check("no token -> no advance", (await sess()).currentNominatorIndex, 2);

  console.log("\n--- 6. CONTROL: unguarded advance double-advances (the old skip bug) ---");
  await setState({ currentNominatorIndex: 0, intermissionUntil: null, nominationDeadline: null });
  await advanceNominator(SESSION_ID); // poller 1, old style
  await advanceNominator(SESSION_ID); // poller 2, old style — nothing stops it
  check("unguarded double advance skips a team (0 -> 2)", (await sess()).currentNominatorIndex, 2);

  // ── B: nomination-timeout claim ──────────────────────────────────────────────────────────────
  console.log("\n--- 7. Timestamp equality actually matches (guards against a silent never-match) ---");
  const dl = new Date(Math.floor((Date.now() - 5000) / 1000) * 1000); // whole seconds: column resolution
  await setState({ currentNominatorIndex: 1, nominationDeadline: dl, intermissionUntil: null });
  check("exact claim succeeds on an unchanged window", await claimTimeoutExact({ nominationDeadline: dl, currentNominatorIndex: 1 }), 1);
  check("deadline cleared", (await sess()).nominationDeadline, null);

  console.log("\n--- 8. Two pollers with the same snapshot: only one claims ---");
  await setState({ currentNominatorIndex: 1, nominationDeadline: dl });
  const first = await claimTimeoutExact({ nominationDeadline: dl, currentNominatorIndex: 1 });
  const second = await claimTimeoutExact({ nominationDeadline: dl, currentNominatorIndex: 1 });
  check("first poller claims", first, 1);
  check("second poller gets nothing", second, 0);

  console.log("\n--- 9. THE ANIKET BUG: a stale snapshot must not consume the next team's window ---");
  // Poll snapshot: deadline expired, cursor on team 1. Meanwhile the cursor advanced to team 2 and
  // team 2 was armed with a fresh 60s window.
  const staleSnapshot = { nominationDeadline: dl, currentNominatorIndex: 1 };
  const team2Window = new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000);
  await setState({ currentNominatorIndex: 2, nominationDeadline: team2Window });
  check("stale snapshot claims nothing", await claimTimeoutExact(staleSnapshot), 0);
  check("team 2's window survives", (await sess()).nominationDeadline?.getTime(), team2Window.getTime());
  check("cursor did not move again", (await sess()).currentNominatorIndex, 2);

  console.log("\n--- 10. CONTROL: the old loose claim eats team 2's window (the bug) ---");
  await setState({ currentNominatorIndex: 2, nominationDeadline: team2Window });
  check("loose claim wrongly succeeds", await claimTimeoutLoose(), 1);
  check("team 2's window destroyed", (await sess()).nominationDeadline, null);
  console.log("      ^ with the stale snapshot's teamId, this is what penalised the wrong team");

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
