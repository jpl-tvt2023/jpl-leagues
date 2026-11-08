/**
 * Backfill `acquiredGw` on players bought in mini-auctions, and report any lot sold to nobody.
 *
 * Until the fix, every sale was written with acquiredGw = 0, so a mini-auction buy counted for its
 * new team in every earlier gameweek whenever one was scored late or reprocessed. This sets each
 * such row to the gameweek the sale happened in (the highest league GW whose deadline had passed
 * at the sale), the same rule resolveBidToSold now uses.
 *
 * It also lists mini-auction bids marked sold that never got an ownership row: the other bug,
 * where buying back a released player failed on the unique index after the bid was marked sold.
 * Those need a person to decide (award the player and charge the purse, or void the lot); the
 * script only reports them.
 *
 * Dry run by default — prints what it would change and writes nothing:
 *   npx dotenv -e .env.local -- npx tsx scripts/backfill-mini-auction-acquired-gw.ts
 * Then, to write:
 *   npx dotenv -e .env.local -- npx tsx scripts/backfill-mini-auction-acquired-gw.ts --apply
 *
 * DATABASE_URL wins over TURSO_CONNECTION_URL (see src/lib/db), so `-e .env.dev` stays local.
 * Idempotent: rows already carrying the right gameweek are left alone.
 */
import { db } from "@/lib/db";
import { auctionBids, auctionOwnership, auctionSessions, gameweeks, leagues } from "@/lib/db/schema";
import { and, desc, eq, lte } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
/** A sale's ownership row is stamped with the same instant as the bid's sold time. */
const SAME_SALE_MS = 60_000;

async function gwAt(leagueId: string, at: Date): Promise<number> {
  const [row] = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), lte(gameweeks.deadline, at)))
    .orderBy(desc(gameweeks.number))
    .limit(1);
  return row?.number ?? 0;
}

async function main() {
  console.log(APPLY ? "APPLY — writing changes" : "DRY RUN — nothing is written (pass --apply to write)");

  const sold = await db
    .select({
      bidId: auctionBids.id,
      leagueId: auctionBids.leagueId,
      leagueSlug: leagues.slug,
      cycleNumber: auctionSessions.cycleNumber,
      fplElementId: auctionBids.fplElementId,
      playerName: auctionBids.playerName,
      winnerId: auctionBids.currentHighBidderId,
      price: auctionBids.currentHighBid,
      soldAt: auctionBids.updatedAt,
    })
    .from(auctionBids)
    .innerJoin(auctionSessions, eq(auctionBids.sessionId, auctionSessions.id))
    .innerJoin(leagues, eq(auctionBids.leagueId, leagues.id))
    .where(and(eq(auctionSessions.type, "mini-auction"), eq(auctionBids.status, "sold")));
  console.log(`${sold.length} sold mini-auction lot(s)\n`);

  let toFix = 0;
  let alreadyRight = 0;
  const orphans: typeof sold = [];

  for (const lot of sold) {
    const candidates = await db
      .select()
      .from(auctionOwnership)
      .where(and(eq(auctionOwnership.leagueId, lot.leagueId), eq(auctionOwnership.fplElementId, lot.fplElementId)));
    // Matched by sale time, not team: a trade since may have moved the row to another team. Rows
    // received in a trade are skipped — their window starts at the trade, and the buyer's own
    // window is the history copy, which keeps the sale's createdAt.
    const row = candidates.find(
      (c) => c.acquiredVia !== "trade" && Math.abs(c.createdAt.getTime() - lot.soldAt.getTime()) <= SAME_SALE_MS
    );
    if (!row) {
      orphans.push(lot);
      continue;
    }

    const want = await gwAt(lot.leagueId, lot.soldAt);
    if (row.acquiredGw === want) {
      alreadyRight++;
      continue;
    }
    toFix++;
    console.log(
      `${lot.leagueSlug}  Mini-Auction #${lot.cycleNumber}  ${lot.playerName} (${lot.fplElementId})  ` +
        `sold ${lot.soldAt.toISOString()}  acquiredGw ${row.acquiredGw} → ${want}`
    );
    if (APPLY) {
      await db.update(auctionOwnership).set({ acquiredGw: want }).where(eq(auctionOwnership.id, row.id));
    }
  }

  console.log(`\n${toFix} row(s) ${APPLY ? "fixed" : "to fix"}, ${alreadyRight} already right.`);

  if (orphans.length > 0) {
    console.log(`\n${orphans.length} lot(s) marked sold with NO ownership row — the player was never awarded and the`);
    console.log("buyer never charged (almost certainly a re-buy hitting the old unique index). Decide each by hand:");
    for (const lot of orphans) {
      console.log(
        `  ${lot.leagueSlug}  Mini-Auction #${lot.cycleNumber}  ${lot.playerName} (${lot.fplElementId})  ` +
          `winner ${lot.winnerId}  £${lot.price}  bid ${lot.bidId}  sold ${lot.soldAt.toISOString()}`
      );
    }
  } else {
    console.log("No sold lots without an ownership row.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
