/**
 * Trades and ownership history: does a trade leave every gameweek credited to the right team, and
 * every ledger matching its purse?
 *
 * Scoring gives a player to a team for GW n when `acquiredGw < n AND (releasedGw IS NULL OR
 * releasedGw >= n)`. A trade used to move the row to its new team in place, which erased the
 * seller's window: reprocessing an earlier gameweek credited the buyer. It also moved the
 * "Purchased" ledger entry from the seller to the buyer, so both Finance ledgers stopped matching
 * their purses. This drives the real `executeTrade` and `buildTeamLedger` to check both, plus the
 * guards around them.
 *
 * Point it at a scratch DB, never dev or prod (TEST_FPL_STUB keeps it off the real FPL API):
 *   DATABASE_URL="file:./scratch.db" npx drizzle-kit push --force
 *   TEST_FPL_STUB=1 DATABASE_URL="file:./scratch.db" npx tsx scripts/verify-trade-ownership.ts
 */
import { db } from "@/lib/db";
import { leagues, teams, auctionOwnership, gameweeks, tradeProposals } from "@/lib/db/schema";
import { executeTrade } from "@/lib/formats/auction/trade";
import { buildTeamLedger } from "@/lib/formats/auction/finance";
import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";

const LEAGUE_ID = "zz-verify-trade";
const [A, B, C] = ["zz-vt-a", "zz-vt-b", "zz-vt-c"];
const BUDGET = 100_000_000;
const HOUR = 60 * 60 * 1000;
const LIVE = ["active", "deadwood", "pending_release"];

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}

async function reset() {
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID)); // cascades
}

let seq = 0;
/** A row the team bought for `price`, with the team's purse and spend moved to match. */
async function own(teamId: string, fplElementId: number, price: number, status = "active") {
  const id = `zz-vt-own-${++seq}`;
  await db.insert(auctionOwnership).values({
    id, leagueId: LEAGUE_ID, teamId, fplElementId, playerName: `P${fplElementId}`, elementType: 3,
    purchasePrice: price, acquiredGw: 0, status, releaseRefund: status === "pending_release" ? price / 2 : null,
  });
  const [t] = await db.select().from(teams).where(eq(teams.id, teamId));
  await db.update(teams).set({ purse: t.purse - price, totalSpent: t.totalSpent + price }).where(eq(teams.id, teamId));
  return id;
}

async function proposal(proposer: string, target: string, offered: string[], requested: string[], cash: number) {
  const id = `zz-vt-trade-${++seq}`;
  const row = {
    id, leagueId: LEAGUE_ID, proposerTeamId: proposer, targetTeamId: target,
    offeredPlayerIds: JSON.stringify(offered), requestedPlayerIds: JSON.stringify(requested),
    cashOffered: cash, status: "accepted",
  };
  await db.insert(tradeProposals).values(row);
  return row;
}

async function seed() {
  await db.insert(leagues).values({
    id: LEAGUE_ID, slug: LEAGUE_ID, name: "ZZ Verify Trade", sport: "fpl", format: "auction", season: "2026-27",
    initialBudget: BUDGET,
  });
  for (const id of [A, B, C]) {
    await db.insert(teams).values({ id, name: id, leagueId: LEAGUE_ID, password: "x", purse: BUDGET });
  }
  const now = Date.now();
  await db.insert(gameweeks).values([
    { id: `${LEAGUE_ID}-gw10`, number: 10, leagueId: LEAGUE_ID, deadline: new Date(now - 72 * HOUR) },
    { id: `${LEAGUE_ID}-gw11`, number: 11, leagueId: LEAGUE_ID, deadline: new Date(now + 96 * HOUR) },
  ]);
}

/** Who scoring credits with this player for `gw` — the predicate from scoring.ts. */
async function scoredBy(fplElementId: number, gw: number): Promise<string[]> {
  const rows = await db
    .select({ teamId: auctionOwnership.teamId })
    .from(auctionOwnership)
    .where(and(
      eq(auctionOwnership.leagueId, LEAGUE_ID),
      eq(auctionOwnership.fplElementId, fplElementId),
      lt(auctionOwnership.acquiredGw, gw),
      or(isNull(auctionOwnership.releasedGw), gte(auctionOwnership.releasedGw, gw)),
    ));
  return rows.map((r) => r.teamId).sort();
}

async function ledgerMatchesPurse(teamId: string, label: string) {
  const [t] = await db.select().from(teams).where(eq(teams.id, teamId));
  const ledger = await buildTeamLedger(LEAGUE_ID, teamId);
  check(ledger?.currentPurse === t.purse, `${label}: ledger purse ${ledger?.currentPurse} = purse ${t.purse}`);
}

async function snapshot() {
  const rows = await db.select().from(auctionOwnership).where(eq(auctionOwnership.leagueId, LEAGUE_ID));
  const money = await db.select().from(teams).where(eq(teams.leagueId, LEAGUE_ID));
  return JSON.stringify({
    rows: rows.map((r) => [r.id, r.teamId, r.status, r.acquiredGw, r.releasedGw]).sort(),
    money: money.map((t) => [t.id, t.purse, t.totalSpent, t.totalIncome]).sort(),
  });
}

async function tryExecute(p: Awaited<ReturnType<typeof proposal>>): Promise<string | null> {
  try {
    await executeTrade(p);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function main() {
  await reset();
  await seed();

  const X = await own(A, 920_001, 10_000_000);
  const Y = await own(B, 920_002, 9_000_000);
  for (const t of [A, B]) await ledgerMatchesPurse(t, `before any trade, ${t}`);

  // 1. A swaps X for B's Y and pays £2M on top (B nets £1.9M after the 5% tax).
  const t1 = await proposal(A, B, [X], [Y], 2_000_000);
  check((await tryExecute(t1)) === null, "trade executes");
  check(JSON.stringify(await scoredBy(920_001, 10)) === JSON.stringify([A]), "GW10 credits X to the seller (A) only");
  check(JSON.stringify(await scoredBy(920_001, 11)) === JSON.stringify([B]), "GW11 credits X to the buyer (B) only");
  check(JSON.stringify(await scoredBy(920_002, 10)) === JSON.stringify([B]), "GW10 credits Y to B only");
  check(JSON.stringify(await scoredBy(920_002, 11)) === JSON.stringify([A]), "GW11 credits Y to A only");

  const xRows = await db.select().from(auctionOwnership).where(eq(auctionOwnership.fplElementId, 920_001));
  const xLive = xRows.find((r) => r.id === X);
  const xHistory = xRows.find((r) => r.id !== X);
  check(xLive?.teamId === B && xLive.status === "active" && xLive.acquiredGw === 10 && xLive.acquiredVia === "trade",
    "X's row moved to B, keeps its id, scores from GW11, marked acquired by trade");
  check(xHistory?.teamId === A && xHistory.status === "transferred" && xHistory.acquiredGw === 0 && xHistory.releasedGw === 10,
    "A keeps a closed history row for X (GW1–10)");
  const aLive = await db.select().from(auctionOwnership)
    .where(and(eq(auctionOwnership.teamId, A), inArray(auctionOwnership.status, LIVE)));
  check(aLive.map((r) => r.fplElementId).join() === "920002", "A's live squad is just Y");
  for (const t of [A, B]) await ledgerMatchesPurse(t, `after the trade, ${t}`);

  // 2. Approving the same trade twice must not run it twice.
  const before = await snapshot();
  check((await tryExecute(t1)) !== null, "a second execute of the same trade is refused");
  check((await snapshot()) === before, "…and changes nothing");

  // 3. A trade naming a player who is no longer an active squad member rolls back entirely.
  const X2 = await own(A, 920_003, 5_000_000);
  const pending = await own(A, 920_004, 4_000_000, "pending_release");
  const Z = await own(C, 920_005, 6_000_000);
  const beforeBad = await snapshot();
  const bad = await proposal(A, C, [X2, pending], [Z], 0);
  check((await tryExecute(bad)) !== null, "a trade including a pending-release player is refused");
  check((await snapshot()) === beforeBad, "…and nothing moved: no player, no cash");
  const [badRow] = await db.select().from(tradeProposals).where(eq(tradeProposals.id, bad.id));
  check(badRow.status === "accepted", "…and the proposal is still awaiting approval");

  // 4. A chain within one gameweek: W goes A → B → C before GW11's deadline.
  const W = await own(A, 920_006, 3_000_000);
  check((await tryExecute(await proposal(A, B, [W], [], 0))) === null, "chain: A → B");
  check((await tryExecute(await proposal(B, C, [W], [], 0))) === null, "chain: B → C");
  check(JSON.stringify(await scoredBy(920_006, 10)) === JSON.stringify([A]), "chain: GW10 credits A only");
  check(JSON.stringify(await scoredBy(920_006, 11)) === JSON.stringify([C]), "chain: GW11 credits C only (B's window is empty)");
  for (const t of [A, B, C]) await ledgerMatchesPurse(t, `after the chain, ${t}`);

  // 5. History rows don't relax the one-live-owner rule.
  let rejected = false;
  try {
    await db.insert(auctionOwnership).values({
      id: "zz-vt-dup", leagueId: LEAGUE_ID, teamId: C, fplElementId: 920_001, playerName: "Dup",
      purchasePrice: 1, acquiredGw: 10, status: "active",
    });
  } catch {
    rejected = true;
  }
  check(rejected, "a second active row for a traded player is still rejected");

  await reset();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
