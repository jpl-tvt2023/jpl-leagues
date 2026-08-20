/**
 * Concurrency soak for the player-auction turn cycle.
 *
 * The bugs that ate seven turns on 2026-08-19 are invisible to a single-threaded test: they only
 * appear when many independent processes run the cycle at once. In production that is ~11 SSE poll
 * loops (one per connected browser, every 2s) plus ~11 mutating REST polls (every 3s) plus every
 * page load — roughly 20 writers per second against one row of turn state. `verify-turn-order.ts`
 * pins the compare-and-swap semantics; this pins the emergent behaviour.
 *
 * It drives the REAL turn functions (`resolveExpiredBid`, `advanceNominator`,
 * `setNominationDeadline`) from N concurrent workers that mirror the SSE stream's decision tree, and
 * asserts the only thing that actually matters to a participant: every team nominates exactly once
 * per lap, in order, with nobody doubling and nobody skipped.
 *
 * Not a vacuous test: run against the code as it stood before the fixes, it reports ~36 doubles in
 * 40 lots (the same team nominating twice in a row). If a future change reintroduces a separately
 * observable "lot sold, no intermission yet" or "window claimed, lot not open yet" state, the
 * doubles count goes straight back up.
 *
 * Point it at a scratch DB, never dev or prod:
 *   DATABASE_URL="file:./scratch.db" npx drizzle-kit push --force
 *   DATABASE_URL="file:./scratch.db" npx tsx scripts/soak-turn-cycle.ts
 */
import { db } from "@/lib/db";
import { leagues, teams, auctionSessions, auctionBids, auctionOwnership } from "@/lib/db/schema";
import {
  advanceNominator,
  setNominationDeadline,
  resolveExpiredBid,
} from "@/lib/formats/auction/resolve-bid";
import { eq, and, isNotNull, asc } from "drizzle-orm";

const LEAGUE_ID = "zz-soak-turn";
const SESSION_ID = "zz-soak-turn-sess";
const TEAM_COUNT = 10;
const TEAM_IDS = Array.from({ length: TEAM_COUNT }, (_, i) => `zz-soak-${i}`);

/** How hard to hammer it — well beyond production, which is the point. */
const POLLERS = 20;
const NOMINATORS = 6;
const TICK_MS = 15;
const TARGET_LOTS = 60;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID));
  await db.insert(leagues).values({
    id: LEAGUE_ID, slug: LEAGUE_ID, name: "ZZ Soak", sport: "fpl",
    format: "auction", season: "2026-27",
  });
  for (const [i, id] of TEAM_IDS.entries()) {
    await db.insert(teams).values({ id, name: `ZZ ${i}`, leagueId: LEAGUE_ID, password: "x", purse: 100_000_000 });
  }
  await db.insert(auctionSessions).values({
    id: SESSION_ID, leagueId: LEAGUE_ID, type: "initial", status: "active",
    snakeOrder: JSON.stringify(TEAM_IDS), currentNominatorIndex: 0,
    nominationDeadline: null, intermissionUntil: null,
    // 1s intermission keeps the post-sale beat in play (that is where the races lived) while
    // keeping the soak to under a minute.
    nominationTimeoutSeconds: 60, intermissionSeconds: 1,
  });
}

async function readSession() {
  const r = await db.select().from(auctionSessions).where(eq(auctionSessions.id, SESSION_ID)).limit(1);
  return r[0];
}

async function openBid() {
  const r = await db
    .select()
    .from(auctionBids)
    .where(and(eq(auctionBids.sessionId, SESSION_ID), eq(auctionBids.status, "open")))
    .limit(1);
  return r[0];
}

/**
 * One SSE stream's poll tick, mirroring `api/auction/session/stream/route.ts`. `session` is read
 * once at the top — the stale-snapshot window that every one of these bugs exploited.
 */
async function pollerTick() {
  const session = await readSession();
  if (!session || session.status !== "active") return;
  const bid = await openBid();

  if (bid) {
    if (Date.now() > bid.expiresAt.getTime() + 2000) {
      const outcome = await resolveExpiredBid(bid);
      // No beginIntermission here — the beat is opened inside the resolution transaction,
      // mirroring the routes.
      void outcome;
    }
    return;
  }

  if (session.intermissionUntil) {
    if (new Date() < session.intermissionUntil) return;
    await advanceNominator(SESSION_ID, {
      claimIntermission: session.intermissionUntil,
      expectIndex: session.currentNominatorIndex,
      actor: "sse",
    });
    return;
  }

  if (!session.nominationDeadline) {
    await setNominationDeadline(SESSION_ID, { expectIndex: session.currentNominatorIndex, actor: "sse" });
  }
}

/**
 * A participant nominating, mirroring `api/auction/nominate/route.ts`: read the cursor, refuse
 * during an intermission, then claim the window before opening the lot.
 *
 * Lots are opened already past their expiry so a lap completes in milliseconds rather than the
 * 30s a real bid timer takes — the cycle logic under test is identical either way.
 */
async function nominatorTick(seq: { n: number }) {
  const session = await readSession();
  if (!session || session.status !== "active") return;
  if (session.intermissionUntil && Date.now() < session.intermissionUntil.getTime()) return;
  if (!session.nominationDeadline) return;
  if (await openBid()) return;

  const snakeOrder: string[] = JSON.parse(session.snakeOrder);
  const nominatorTeamId = snakeOrder[session.currentNominatorIndex];
  if (!nominatorTeamId) return;

  // Claim + open in ONE transaction, mirroring the route. Split across two round trips, the row
  // briefly reads "no deadline, no lot open" and a poller arms the same team all over again.
  const n = ++seq.n;
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(auctionSessions)
      .set({ nominationDeadline: null, intermissionUntil: null })
      .where(and(eq(auctionSessions.id, SESSION_ID), isNotNull(auctionSessions.nominationDeadline)));
    if (claimed.rowsAffected === 0) return;

    await tx.insert(auctionBids).values({
      id: `zz-soak-bid-${n}`,
      leagueId: LEAGUE_ID,
      sessionId: SESSION_ID,
      nominatorTeamId,
      fplElementId: 100000 + n, // unique, so ownership never collides
      playerName: `ZZ Player ${n}`,
      currentHighBid: 500_000,
      currentHighBidderId: nominatorTeamId,
      minBid: 500_000,
      status: "open",
      expiresAt: new Date(Date.now() - 3000),
    });
  });
}

async function main() {
  await setup();
  console.log(`Soaking: ${POLLERS} pollers + ${NOMINATORS} nominators, target ${TARGET_LOTS} lots\n`);

  const seq = { n: 0 };
  let stop = false;
  const errors: string[] = [];

  const worker = async (fn: () => Promise<void>) => {
    while (!stop) {
      try {
        await fn();
      } catch (e) {
        errors.push(String(e));
      }
      await sleep(TICK_MS);
    }
  };

  const workers = [
    ...Array.from({ length: POLLERS }, () => worker(pollerTick)),
    ...Array.from({ length: NOMINATORS }, () => worker(() => nominatorTick(seq))),
  ];

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const done = await db
      .select({ id: auctionBids.id })
      .from(auctionBids)
      .where(and(eq(auctionBids.sessionId, SESSION_ID), eq(auctionBids.status, "sold")));
    if (done.length >= TARGET_LOTS) break;
    await sleep(250);
  }
  stop = true;
  await Promise.all(workers);

  // ---- Assertions ----
  const lots = await db
    .select({ nominatorTeamId: auctionBids.nominatorTeamId, status: auctionBids.status })
    .from(auctionBids)
    .where(eq(auctionBids.sessionId, SESSION_ID))
    .orderBy(asc(auctionBids.createdAt), asc(auctionBids.id));

  console.log(`\nResolved ${lots.length} lots, ${errors.length} worker errors\n`);
  if (errors.length) console.log("  first error:", errors[0]);

  check("produced enough lots to be meaningful", lots.length >= TARGET_LOTS, true);

  const idxOf = new Map(TEAM_IDS.map((id, i) => [id, i]));
  const seen = lots.map((l) => idxOf.get(l.nominatorTeamId) ?? -1);

  let doubles = 0;
  let skips = 0;
  const skipDetail: string[] = [];
  for (let i = 1; i < seen.length; i++) {
    const step = (seen[i] - seen[i - 1] + TEAM_COUNT) % TEAM_COUNT;
    if (step === 0) doubles++;
    if (step > 1) {
      skips += step - 1;
      skipDetail.push(`lot ${i + 1}: ${seen[i - 1]} -> ${seen[i]}`);
    }
  }

  // These two are the whole point: a double is a team nominating twice in a row, a skip is a team
  // losing its turn outright. Both are what participants actually experienced.
  check("no team nominated twice in a row", doubles, 0);
  check("no team lost its turn", skips, 0);
  if (skipDetail.length) console.log("  skips:", skipDetail.slice(0, 5).join(", "));

  // Per-lap fairness: over N complete laps every team must appear exactly N times.
  const laps = Math.floor(seen.length / TEAM_COUNT);
  if (laps > 0) {
    const counts = new Map<number, number>();
    for (const i of seen.slice(0, laps * TEAM_COUNT)) counts.set(i, (counts.get(i) ?? 0) + 1);
    const even = TEAM_IDS.every((_, i) => counts.get(i) === laps);
    check(`every team nominated exactly ${laps}x over ${laps} full lap(s)`, even, true);
  }

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
