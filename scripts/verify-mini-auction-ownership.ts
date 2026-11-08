/**
 * Mini-auction ownership: does a sale produce the right ownership window?
 *
 * Scoring gives a player to a team for GW n when `acquiredGw < n AND (releasedGw IS NULL OR
 * releasedGw >= n)`. Two things used to break that for mini-auctions, and this drives the real
 * `resolveBidToSold` to check both:
 *
 *   - Every sale was written with acquiredGw = 0, so a mini-auction buy scored for its new team in
 *     every earlier gameweek whenever one was scored late or reprocessed.
 *   - A released player keeps his row as history, and the ownership unique index covered every row,
 *     so buying him back failed on UNIQUE after the bid was already marked sold.
 *
 * Point it at a scratch DB, never dev or prod (TEST_FPL_STUB keeps it off the real FPL API):
 *   DATABASE_URL="file:./scratch.db" npx drizzle-kit push --force
 *   TEST_FPL_STUB=1 DATABASE_URL="file:./scratch.db" npx tsx scripts/verify-mini-auction-ownership.ts
 */
import { db } from "@/lib/db";
import { leagues, teams, auctionSessions, auctionBids, auctionOwnership, gameweeks } from "@/lib/db/schema";
import { resolveBidToSold } from "@/lib/formats/auction/resolve-bid";
import { and, eq, gte, isNull, lt, or } from "drizzle-orm";

const LEAGUE_ID = "zz-verify-mini";
const MINI_ID = "zz-verify-mini-sess";
const INITIAL_ID = "zz-verify-initial-sess";
const [SELLER, BUYER, OTHER] = ["zz-vm-seller", "zz-vm-buyer", "zz-vm-other"];
const START_PURSE = 100_000_000;
const PRICE = 1_000_000;
const HOUR = 60 * 60 * 1000;

const REBOUGHT = 910_001; // released by SELLER at GW10, bought back by BUYER
const FRESH = 910_002; // never owned, bought by BUYER in the mini-auction
const PRESEASON = 910_003; // bought by OTHER in the initial auction

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}

async function reset() {
  await db.delete(leagues).where(eq(leagues.id, LEAGUE_ID)); // cascades
}

async function seed() {
  await db.insert(leagues).values({
    id: LEAGUE_ID, slug: LEAGUE_ID, name: "ZZ Verify Mini", sport: "fpl", format: "auction", season: "2026-27",
  });
  for (const id of [SELLER, BUYER, OTHER]) {
    await db.insert(teams).values({ id, name: id, leagueId: LEAGUE_ID, password: "x", purse: START_PURSE });
  }
  const now = Date.now();
  await db.insert(gameweeks).values([
    { id: `${LEAGUE_ID}-gw10`, number: 10, leagueId: LEAGUE_ID, deadline: new Date(now - 72 * HOUR) },
    { id: `${LEAGUE_ID}-gw11`, number: 11, leagueId: LEAGUE_ID, deadline: new Date(now + 96 * HOUR) },
  ]);
  await db.insert(auctionSessions).values([
    { id: INITIAL_ID, leagueId: LEAGUE_ID, type: "initial", cycleNumber: 0, status: "active", intermissionSeconds: 0 },
    { id: MINI_ID, leagueId: LEAGUE_ID, type: "mini-auction", cycleNumber: 1, status: "active", intermissionSeconds: 0 },
  ]);
  // SELLER's release, confirmed at the GW10 deadline.
  await db.insert(auctionOwnership).values({
    id: "zz-vm-released", leagueId: LEAGUE_ID, teamId: SELLER, fplElementId: REBOUGHT, playerName: "Rebought",
    purchasePrice: 5_000_000, acquiredGw: 0, releasedGw: 10, status: "released",
  });
}

/** An expired open bid, ready for resolveBidToSold to sell to `winner`. */
async function expiredBid(sessionId: string, fplElementId: number, winner: string) {
  const id = `zz-vm-bid-${fplElementId}`;
  const row = {
    id, leagueId: LEAGUE_ID, sessionId, nominatorTeamId: winner, fplElementId, playerName: `P${fplElementId}`,
    currentHighBid: PRICE, currentHighBidderId: winner, minBid: PRICE, status: "open",
    expiresAt: new Date(Date.now() - 10_000),
  };
  await db.insert(auctionBids).values(row);
  return row;
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

async function sell(label: string, sessionId: string, fplElementId: number, winner: string): Promise<boolean> {
  try {
    const sold = await resolveBidToSold(await expiredBid(sessionId, fplElementId, winner));
    check(sold, `${label}: resolveBidToSold sold the lot`);
    return sold;
  } catch (err) {
    // Drizzle's message is the whole SQL; the reason is on the cause.
    const msg = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    check(false, `${label}: resolveBidToSold threw — ${msg.slice(0, 160)}`);
    return false;
  }
}

async function main() {
  await reset();
  await seed();

  // 1. A never-owned player bought in the mini-auction.
  await sell("fresh mini-auction buy", MINI_ID, FRESH, BUYER);
  const [fresh] = await db.select().from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, LEAGUE_ID), eq(auctionOwnership.fplElementId, FRESH)));
  check(fresh?.acquiredGw === 10, `fresh buy acquiredGw is 10 (got ${fresh?.acquiredGw})`);
  check(JSON.stringify(await scoredBy(FRESH, 10)) === "[]", "fresh buy doesn't score GW10 for anyone");
  check(JSON.stringify(await scoredBy(FRESH, 11)) === JSON.stringify([BUYER]), "fresh buy scores GW11 for the buyer");

  // 2. The released player bought back by another team.
  const sold = await sell("re-buy of a released player", MINI_ID, REBOUGHT, BUYER);
  const rows = await db.select().from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, LEAGUE_ID), eq(auctionOwnership.fplElementId, REBOUGHT)));
  const history = rows.find((r) => r.id === "zz-vm-released");
  const rebought = rows.find((r) => r.id !== "zz-vm-released");
  check(history?.status === "released" && history.teamId === SELLER && history.releasedGw === 10, "seller's released row is untouched");
  check(rebought?.teamId === BUYER && rebought.status === "active", "buyer now has an active row for him");
  check(rebought?.acquiredGw === 10, `re-buy acquiredGw is 10 (got ${rebought?.acquiredGw})`);
  check(JSON.stringify(await scoredBy(REBOUGHT, 10)) === JSON.stringify([SELLER]), "GW10 credits the seller only");
  check(JSON.stringify(await scoredBy(REBOUGHT, 11)) === JSON.stringify([BUYER]), "GW11 credits the buyer only");
  const [buyer] = await db.select().from(teams).where(eq(teams.id, BUYER));
  const charged = START_PURSE - buyer.purse;
  check(charged === (sold ? 2 : 1) * PRICE, `buyer charged once per player won (${charged / PRICE}× the price)`);

  // 3. An initial-auction buy keeps acquiredGw 0.
  await sell("initial-auction buy", INITIAL_ID, PRESEASON, OTHER);
  const [pre] = await db.select().from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, LEAGUE_ID), eq(auctionOwnership.fplElementId, PRESEASON)));
  check(pre?.acquiredGw === 0, `initial-auction buy acquiredGw is 0 (got ${pre?.acquiredGw})`);

  // 4. The index still forbids two live rows for one player.
  let rejected = false;
  try {
    await db.insert(auctionOwnership).values({
      id: "zz-vm-dup", leagueId: LEAGUE_ID, teamId: OTHER, fplElementId: FRESH, playerName: "Dup",
      purchasePrice: 1, acquiredGw: 10, status: "active",
    });
  } catch {
    rejected = true;
  }
  check(rejected, "a second active row for the same player is still rejected");

  await reset();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
