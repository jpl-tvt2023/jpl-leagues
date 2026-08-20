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
import {
  advanceNominator,
  beginIntermission,
  setNominationDeadline,
  handleNominationTimeout,
} from "@/lib/formats/auction/resolve-bid";
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

  // ── C: the arm-the-current-cursor fallback ───────────────────────────────────────────────────
  console.log("\n--- 11. setNominationDeadline must not arm during an intermission ---");
  // The race: selling a lot takes two writes (mark the bid sold, then open the intermission). A poll
  // tick landing between them sees no open bid, no intermission and no deadline — and its snapshot
  // still points at the team that just sold. Unguarded, it armed that team a second time.
  await setState({
    currentNominatorIndex: 2,
    intermissionUntil: new Date(Date.now() + 5000),
    nominationDeadline: null,
  });
  await setNominationDeadline(SESSION_ID, { expectIndex: 2 });
  check("no window armed while an intermission is pending", (await sess()).nominationDeadline, null);
  check("cursor untouched", (await sess()).currentNominatorIndex, 2);

  console.log("\n--- 12. setNominationDeadline must not arm a cursor the caller did not observe ---");
  await setState({ currentNominatorIndex: 3, intermissionUntil: null, nominationDeadline: null });
  await setNominationDeadline(SESSION_ID, { expectIndex: 2 }); // stale snapshot: thought cursor was 2
  check("stale cursor arms nothing", (await sess()).nominationDeadline, null);
  await setNominationDeadline(SESSION_ID, { expectIndex: 3 }); // fresh snapshot
  check("matching cursor arms the window", (await sess()).nominationDeadline !== null, true);

  console.log("\n--- 13. CONTROL: the old unguarded arm re-arms the team that just sold ---");
  await setState({
    currentNominatorIndex: 2,
    intermissionUntil: new Date(Date.now() + 5000),
    nominationDeadline: null,
  });
  await db
    .update(auctionSessions)
    .set({ nominationDeadline: new Date(Date.now() + 60_000) }) // old style: bare write by session id
    .where(eq(auctionSessions.id, SESSION_ID));
  check("unguarded arm lands mid-intermission", (await sess()).nominationDeadline !== null, true);
  console.log("      ^ that window belonged to the team that had just sold — their second nomination");

  console.log("\n--- 14. expectIndex stops a double advance with no intermission token ---");
  await setState({ currentNominatorIndex: 0, intermissionUntil: null, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { expectIndex: 0 }); // poller 1
  await advanceNominator(SESSION_ID, { expectIndex: 0 }); // poller 2, same snapshot — must no-op
  check("advanced exactly one team (0 -> 1)", (await sess()).currentNominatorIndex, 1);

  // ── D: missed turn ends with an intermission, not a bare advance ──────────────────────────────
  console.log("\n--- 15. A missed turn opens an intermission instead of advancing directly ---");
  await setState({ currentNominatorIndex: 1, intermissionUntil: null, nominationDeadline: null });
  const outcome = await handleNominationTimeout(SESSION_ID, TEAM_IDS[1], LEAGUE_ID);
  check("no wishlist -> penalised", outcome, "penalised");
  check("cursor has NOT moved yet", (await sess()).currentNominatorIndex, 1);
  check("intermission opened", (await sess()).intermissionUntil !== null, true);
  const penaltyBeat = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({ intermissionUntil: penaltyBeat });
  await advanceNominator(SESSION_ID, { claimIntermission: penaltyBeat });
  check("then exactly one advance (1 -> 2)", (await sess()).currentNominatorIndex, 2);

  // ── E: make-up turns ─────────────────────────────────────────────────────────────────────────
  console.log("\n--- 16. A make-up turn is inserted; the ring resumes where it stopped ---");
  const beat1 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({
    currentNominatorIndex: 1,
    intermissionUntil: beat1,
    nominationDeadline: null,
    makeupQueue: JSON.stringify([TEAM_IDS[3]]),
    ringReturnIndex: null,
  });
  await advanceNominator(SESSION_ID, { claimIntermission: beat1 });
  check("make-up team armed", (await sess()).currentNominatorIndex, 3);
  check("ring position parked", (await sess()).ringReturnIndex, 1);
  check("queue drained", (await sess()).makeupQueue, "[]");
  check("window armed for them", (await sess()).nominationDeadline !== null, true);

  // Their lot resolves — the ring must now continue from team 1, i.e. to team 2. NOT from team 3.
  const beat2 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({ intermissionUntil: beat2, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: beat2 });
  check("ring resumes at 2, not 4", (await sess()).currentNominatorIndex, 2);
  check("parked position cleared", (await sess()).ringReturnIndex, null);

  console.log("\n--- 17. Two make-up turns drain in order before the ring resumes ---");
  const beat3 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({
    currentNominatorIndex: 1,
    intermissionUntil: beat3,
    nominationDeadline: null,
    makeupQueue: JSON.stringify([TEAM_IDS[3], TEAM_IDS[0]]),
    ringReturnIndex: null,
  });
  await advanceNominator(SESSION_ID, { claimIntermission: beat3 });
  check("first make-up armed", (await sess()).currentNominatorIndex, 3);
  const beat4 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({ intermissionUntil: beat4, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: beat4 });
  check("second make-up armed", (await sess()).currentNominatorIndex, 0);
  check("ring position still parked at 1", (await sess()).ringReturnIndex, 1);
  const beat5 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({ intermissionUntil: beat5, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: beat5 });
  check("ring resumes at 2", (await sess()).currentNominatorIndex, 2);

  console.log("\n--- 18. Unknown queue entries are dropped, not stalled on ---");
  const beat6 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({
    currentNominatorIndex: 1,
    intermissionUntil: beat6,
    nominationDeadline: null,
    makeupQueue: JSON.stringify(["zz-not-a-team"]),
    ringReturnIndex: null,
  });
  await advanceNominator(SESSION_ID, { claimIntermission: beat6 });
  check("fell through to the ring (1 -> 2)", (await sess()).currentNominatorIndex, 2);
  check("bogus queue cleared", (await sess()).makeupQueue, "[]");

  console.log("\n--- 19. A make-up advance is single-shot under two pollers ---");
  const beat7 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({
    currentNominatorIndex: 1,
    intermissionUntil: beat7,
    nominationDeadline: null,
    makeupQueue: JSON.stringify([TEAM_IDS[3], TEAM_IDS[0]]),
    ringReturnIndex: null,
  });
  await advanceNominator(SESSION_ID, { claimIntermission: beat7 });
  await advanceNominator(SESSION_ID, { claimIntermission: beat7 }); // token already spent
  check("only the first make-up was armed", (await sess()).currentNominatorIndex, 3);
  check("one entry left in the queue", JSON.parse((await sess()).makeupQueue).length, 1);

  // ── F: admin rectification ───────────────────────────────────────────────────────────────────
  // The writes below are re-expressed from `admin/[leagueId]/auction-corrections/route.ts` for the
  // same reason the timeout claims are: they live inline in the route. What is verified here is the
  // resulting state machine, which is where the turn bugs lived.
  console.log("\n--- 20. Voiding a live lot moves no money and returns the turn ---");
  await setState({
    currentNominatorIndex: 2,
    nominationDeadline: new Date(Date.now() + 60_000),
    intermissionUntil: null,
    makeupQueue: "[]",
    ringReturnIndex: null,
  });
  await db.insert(auctionBids).values({
    id: "zz-bid-void", leagueId: LEAGUE_ID, sessionId: SESSION_ID, nominatorTeamId: TEAM_IDS[2],
    fplElementId: 77, playerName: "ZZ Voidable", currentHighBid: 4_000_000, currentHighBidderId: TEAM_IDS[1],
    minBid: 500_000, status: "open", expiresAt: new Date(Date.now() + 30_000),
  });
  const purseBefore = (await db.select().from(teams).where(eq(teams.id, TEAM_IDS[1])).limit(1))[0];

  // What `cancel-nomination` does: flip the open lot to cancelled, clear the timers, and hand the
  // nominator their turn back. Ownership and purse are only ever written by `resolveBidToSold`,
  // which has not run — so there is nothing to unwind.
  const voided = await db
    .update(auctionBids)
    .set({ status: "cancelled" })
    .where(and(eq(auctionBids.id, "zz-bid-void"), eq(auctionBids.status, "open")));
  await setState({
    nominationDeadline: null,
    intermissionUntil: null,
    makeupQueue: JSON.stringify([TEAM_IDS[2]]),
  });
  const purseAfter = (await db.select().from(teams).where(eq(teams.id, TEAM_IDS[1])).limit(1))[0];
  const ownedAfter = await db
    .select({ id: auctionOwnership.id })
    .from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, LEAGUE_ID), eq(auctionOwnership.fplElementId, 77)));

  check("lot voided", voided.rowsAffected, 1);
  check("high bidder's purse unchanged", purseAfter.purse, purseBefore.purse);
  check("high bidder's spend unchanged", purseAfter.totalSpent, purseBefore.totalSpent);
  check("no ownership row was created", ownedAfter.length, 0);
  check("nominator is owed a turn", (await sess()).makeupQueue, JSON.stringify([TEAM_IDS[2]]));

  console.log("\n--- 21. Full rectification: skipped team goes first, then the voided nominator ---");
  // Admin grants the skipped team (3) the front of the queue, ahead of the voided nominator (2).
  await setState({ makeupQueue: JSON.stringify([TEAM_IDS[3], TEAM_IDS[2]]) });
  await setNominationDeadline(SESSION_ID, { expectIndex: 2 }); // what the poll does on resume
  check("skipped team armed first", (await sess()).currentNominatorIndex, 3);
  check("ring parked at the pre-correction cursor", (await sess()).ringReturnIndex, 2);

  const rBeat1 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({ intermissionUntil: rBeat1, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: rBeat1 });
  check("voided nominator armed second", (await sess()).currentNominatorIndex, 2);
  check("ring still parked at 2", (await sess()).ringReturnIndex, 2);

  const rBeat2 = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
  await setState({ intermissionUntil: rBeat2, nominationDeadline: null });
  await advanceNominator(SESSION_ID, { claimIntermission: rBeat2 });
  check("ring resumes at 3 — exactly where it would have been", (await sess()).currentNominatorIndex, 3);
  check("no correction state left behind", (await sess()).ringReturnIndex, null);
  check("queue empty", (await sess()).makeupQueue, "[]");

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
