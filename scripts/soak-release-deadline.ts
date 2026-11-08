/**
 * Concurrency soak for the release deadline (24h before the next mini-auction).
 *
 * Nothing schedules the deadline: every auction route, the dashboard and the daily tick call
 * `confirmDueReleases`, so right after a deadline many of them run it at once — and a team may be
 * cancelling a release at that same moment. The money is only right if each refund is paid exactly
 * once and a cancelled release is never paid. This drives the real functions concurrently and
 * checks exactly that:
 *
 *   1. Before the deadline: repeated sweeps confirm nothing.
 *   2. After it: 20 sweeps plus 2 auction-start confirmations at once. Every pending release ends
 *      up released at the league's current GW, and each purse/totalRefunds moved by exactly its
 *      refunds.
 *   3. Cancel vs confirm on the same rows at once: each row ends up either cancelled (no refund)
 *      or released (refund paid once), never both.
 *   4. No mini-auction scheduled: the countdown is the next GW deadline, tentative, and a sweep
 *      past it confirms nothing.
 *
 * Point it at a scratch DB, never dev or prod:
 *   DATABASE_URL="file:./scratch.db" npx drizzle-kit push --force
 *   DATABASE_URL="file:./scratch.db" npx tsx scripts/soak-release-deadline.ts
 */
import { db } from "@/lib/db";
import { leagues, teams, auctionSessions, auctionOwnership, gameweeks } from "@/lib/db/schema";
import { confirmDueReleases, finalizePendingReleasesNow } from "@/lib/formats/auction/process-gameweek";
import { loadReleaseCountdown } from "@/lib/formats/auction/live-session";
import { and, eq, inArray } from "drizzle-orm";

const LEAGUE_ID = "zz-soak-release";
const SESSION_ID = "zz-soak-release-mini";
const TEAM_IDS = ["zz-rel-0", "zz-rel-1", "zz-rel-2", "zz-rel-3"];
const START_PURSE = 100_000_000;
const HOUR = 60 * 60 * 1000;
const SWEEPERS = 20;

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}

async function reset() {
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID)); // cascades to everything below
}

async function seed() {
  await db.insert(leagues).values({
    id: LEAGUE_ID, slug: LEAGUE_ID, name: "ZZ Release Soak", sport: "fpl", format: "auction", season: "2026-27",
  });
  for (const [i, id] of TEAM_IDS.entries()) {
    await db.insert(teams).values({ id, name: `ZZ ${i}`, leagueId: LEAGUE_ID, password: "x", purse: START_PURSE });
  }
  const now = Date.now();
  // GW10 has started (so it is the current GW), GW11 is still ahead.
  await db.insert(gameweeks).values([
    { id: `${LEAGUE_ID}-gw10`, number: 10, leagueId: LEAGUE_ID, deadline: new Date(now - 72 * HOUR) },
    { id: `${LEAGUE_ID}-gw11`, number: 11, leagueId: LEAGUE_ID, deadline: new Date(now + 96 * HOUR) },
  ]);
  await db.insert(auctionSessions).values({
    id: SESSION_ID, leagueId: LEAGUE_ID, type: "mini-auction", cycleNumber: 1, status: "pending",
    scheduledAt: new Date(now + 25 * HOUR), // deadline still an hour away
  });
}

let elementSeq = 1;
async function addOwnership(teamId: string, status: "active" | "pending_release", refund: number | null) {
  const id = `zz-own-${elementSeq}`;
  await db.insert(auctionOwnership).values({
    id, leagueId: LEAGUE_ID, teamId, fplElementId: 900_000 + elementSeq++, playerName: `P${elementSeq}`,
    purchasePrice: 10_000_000, acquiredGw: 0, status, releaseRefund: refund,
  });
  return id;
}

async function teamMoney() {
  const rows = await db.select().from(teams).where(eq(teams.leagueId, LEAGUE_ID));
  return new Map(rows.map((t) => [t.id, { purse: t.purse, totalRefunds: t.totalRefunds }]));
}

async function setScheduledAt(at: Date) {
  await db.update(auctionSessions).set({ scheduledAt: at }).where(eq(auctionSessions.id, SESSION_ID));
}

/** Run everything at once; a refused/busy writer is fine — the money check is what matters. */
async function race(tasks: (() => Promise<unknown>)[]) {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  return results.filter((r) => r.status === "rejected").length;
}

async function main() {
  await reset();
  await seed();

  // Each team: three pending releases with distinct refunds, plus an active player nobody may touch.
  const expected = new Map<string, number>();
  const pendingIds: string[] = [];
  for (const [i, teamId] of TEAM_IDS.entries()) {
    let sum = 0;
    for (let k = 1; k <= 3; k++) {
      const refund = (i + 1) * 1_000_000 + k * 100_000;
      pendingIds.push(await addOwnership(teamId, "pending_release", refund));
      sum += refund;
    }
    await addOwnership(teamId, "active", null);
    expected.set(teamId, sum);
  }

  // 1. Before the deadline.
  await race(Array.from({ length: 5 }, () => () => confirmDueReleases(LEAGUE_ID)));
  const stillPending = await db.select().from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, LEAGUE_ID), eq(auctionOwnership.status, "pending_release")));
  check(stillPending.length === pendingIds.length, `before the deadline nothing is confirmed (${stillPending.length}/${pendingIds.length} pending)`);

  // 2. After the deadline: everyone at once.
  await setScheduledAt(new Date(Date.now() + 23 * HOUR));
  const failed = await race([
    ...Array.from({ length: SWEEPERS }, () => () => confirmDueReleases(LEAGUE_ID)),
    () => finalizePendingReleasesNow(LEAGUE_ID),
    () => finalizePendingReleasesNow(LEAGUE_ID),
  ]);
  console.log(`      ${failed} of ${SWEEPERS + 2} concurrent callers errored (busy) — allowed`);
  await confirmDueReleases(LEAGUE_ID); // the next request after a busy one sweeps any straggler

  const released = await db.select().from(auctionOwnership).where(inArray(auctionOwnership.id, pendingIds));
  check(released.every((r) => r.status === "released"), "every pending release is confirmed");
  check(released.every((r) => r.releasedGw === 10), "releasedGw is the league's current GW (10), not the cycle number");
  const actives = await db.select().from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, LEAGUE_ID), eq(auctionOwnership.status, "active")));
  check(actives.length === TEAM_IDS.length, "active players are untouched");
  const money = await teamMoney();
  for (const teamId of TEAM_IDS) {
    const m = money.get(teamId)!;
    const want = expected.get(teamId)!;
    check(m.purse === START_PURSE + want && m.totalRefunds === want,
      `${teamId} paid exactly once: purse ${m.purse - START_PURSE} / refunds ${m.totalRefunds} (want ${want})`);
  }

  // 3. Cancel vs confirm on the same rows.
  const before = await teamMoney();
  const raceIds: string[] = [];
  const refundOf = new Map<string, number>();
  for (const [i, teamId] of TEAM_IDS.entries()) {
    for (let k = 0; k < 3; k++) {
      const refund = 500_000 + i * 10_000 + k;
      const id = await addOwnership(teamId, "pending_release", refund);
      raceIds.push(id);
      refundOf.set(id, refund);
    }
  }
  // The DELETE route's conditional revert, verbatim.
  const cancel = (id: string) => () =>
    db.update(auctionOwnership)
      .set({ status: "active", releaseRefund: null, releaseFmv: null, deadwoodReason: null, updatedAt: new Date() })
      .where(and(eq(auctionOwnership.id, id), eq(auctionOwnership.status, "pending_release")))
      .returning({ id: auctionOwnership.id });
  // Half the cancels go at once (they beat the sweepers, which read before they write) and half a
  // moment later (they arrive after the confirmation and must be refused), so both outcomes run.
  const half = raceIds.length / 2;
  const later = (fn: () => Promise<unknown>) => () => new Promise((r) => setTimeout(r, 150)).then(fn);
  await race([
    ...raceIds.slice(0, half).map(cancel),
    ...Array.from({ length: SWEEPERS }, () => () => confirmDueReleases(LEAGUE_ID)),
    ...raceIds.slice(half).map((id) => later(cancel(id))),
  ]);
  await confirmDueReleases(LEAGUE_ID);

  const after = await teamMoney();
  const rows = await db.select().from(auctionOwnership).where(inArray(auctionOwnership.id, raceIds));
  check(rows.every((r) => r.status === "active" || r.status === "released"), "every raced row ended cancelled or confirmed");
  for (const teamId of TEAM_IDS) {
    const paid = rows.filter((r) => r.teamId === teamId && r.status === "released").reduce((s, r) => s + refundOf.get(r.id)!, 0);
    const moved = after.get(teamId)!.purse - before.get(teamId)!.purse;
    check(moved === paid, `${teamId}: purse moved ${moved}, confirmed refunds ${paid} — cancelled ones unpaid`);
  }
  const cancelled = rows.filter((r) => r.status === "active").length;
  console.log(`      race outcome: ${cancelled} cancelled, ${rows.length - cancelled} confirmed`);

  // 4. No mini-auction scheduled → tentative countdown, nothing confirmed.
  await db.delete(auctionSessions).where(eq(auctionSessions.id, SESSION_ID));
  const tentativeId = await addOwnership(TEAM_IDS[0], "pending_release", 1_234_000);
  const countdown = await loadReleaseCountdown(LEAGUE_ID);
  check(countdown?.tentative === true && countdown.gw === 11, `countdown is the GW11 deadline, tentative (${JSON.stringify(countdown)})`);
  const { confirmed } = await confirmDueReleases(LEAGUE_ID, new Date(Date.now() + 200 * HOUR)); // well past GW11
  const [tentativeRow] = await db.select().from(auctionOwnership).where(eq(auctionOwnership.id, tentativeId));
  check(confirmed === 0 && tentativeRow.status === "pending_release", "passing a tentative GW deadline confirms nothing");

  await reset();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
