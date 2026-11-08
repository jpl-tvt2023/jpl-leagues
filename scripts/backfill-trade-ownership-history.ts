/**
 * Backfill ownership history for trades executed before trades kept it.
 *
 * A trade used to move the ownership row to its new team in place. That erased the seller's
 * scoring window — reprocessing a gameweek from before the trade credits the buyer — and moved the
 * "Purchased" ledger entry from the seller to the buyer. executeTrade now leaves the seller a closed
 * copy of the row (status "transferred") and marks the moved row acquiredVia "trade". This rebuilds
 * that shape for completed trades from before the change:
 *
 *   - Each row's moves are read from completed trade proposals, in order (a proposal is stamped
 *     when it completes, so its updatedAt is the trade time).
 *   - Every owner before the current one gets a history row: from the window start (the row's own
 *     acquiredGw for the original buyer, the trade's gameweek for anyone who received him by trade)
 *     to the gameweek of the trade that took him away.
 *   - The row itself is left with its current owner, scoring from the last trade's gameweek.
 *
 * A row whose current team isn't the last trade's receiver (an admin moved it since), or whose
 * moves don't chain up, is reported and left alone.
 *
 * Dry run by default — prints what it would change and writes nothing:
 *   npx dotenv -e .env.local -- npx tsx scripts/backfill-trade-ownership-history.ts
 * Then, to write:
 *   npx dotenv -e .env.local -- npx tsx scripts/backfill-trade-ownership-history.ts --apply
 *
 * Needs migration 0027 (acquired_via) applied first. DATABASE_URL wins over TURSO_CONNECTION_URL
 * (see src/lib/db), so `-e .env.dev` stays local. Idempotent: a row already marked acquiredVia
 * "trade" has been done and is skipped.
 */
import { db } from "@/lib/db";
import { auctionOwnership, leagues, teams, tradeProposals } from "@/lib/db/schema";
import { getStartedGameweekNumber } from "@/lib/gameweeks/current-gw";
import { generateId } from "@/lib/id";
import { and, asc, eq } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

interface Move {
  at: Date;
  from: string;
  to: string;
}

function parseIds(raw: string): string[] {
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(APPLY ? "APPLY — writing changes" : "DRY RUN — nothing is written (pass --apply to write)");

  const trades = await db
    .select({
      id: tradeProposals.id,
      leagueId: tradeProposals.leagueId,
      leagueSlug: leagues.slug,
      proposer: tradeProposals.proposerTeamId,
      target: tradeProposals.targetTeamId,
      offered: tradeProposals.offeredPlayerIds,
      requested: tradeProposals.requestedPlayerIds,
      at: tradeProposals.updatedAt,
    })
    .from(tradeProposals)
    .innerJoin(leagues, eq(tradeProposals.leagueId, leagues.id))
    .where(and(eq(tradeProposals.status, "completed"), eq(leagues.format, "auction")))
    .orderBy(asc(tradeProposals.updatedAt));
  console.log(`${trades.length} completed trade(s)\n`);

  const movesByRow = new Map<string, { leagueSlug: string; moves: Move[] }>();
  const addMove = (rowId: string, leagueSlug: string, move: Move) => {
    const entry = movesByRow.get(rowId) ?? { leagueSlug, moves: [] };
    entry.moves.push(move);
    movesByRow.set(rowId, entry);
  };
  for (const t of trades) {
    for (const id of parseIds(t.offered)) addMove(id, t.leagueSlug, { at: t.at, from: t.proposer, to: t.target });
    for (const id of parseIds(t.requested)) addMove(id, t.leagueSlug, { at: t.at, from: t.target, to: t.proposer });
  }

  const teamName = new Map((await db.select({ id: teams.id, name: teams.name }).from(teams)).map((t) => [t.id, t.name]));
  const name = (id: string) => teamName.get(id) ?? id.slice(0, 8);

  let toSplit = 0;
  let alreadyDone = 0;
  const skipped: string[] = [];

  for (const [rowId, { leagueSlug, moves }] of movesByRow) {
    const [row] = await db.select().from(auctionOwnership).where(eq(auctionOwnership.id, rowId)).limit(1);
    if (!row) {
      skipped.push(`${leagueSlug}  ownership ${rowId}: row no longer exists (removed since the trade)`);
      continue;
    }
    if (row.acquiredVia === "trade") {
      alreadyDone++;
      continue;
    }
    const chains = moves.every((m, i) => i === 0 || m.from === moves[i - 1].to);
    const last = moves[moves.length - 1];
    if (!chains || row.teamId !== last.to) {
      skipped.push(
        `${leagueSlug}  ${row.playerName}: now with ${name(row.teamId)}, but its trades ` +
          `${chains ? `end with ${name(last.to)}` : "don't chain up"} — moved outside a trade since? left alone`
      );
      continue;
    }

    // The gameweek each trade happened in: the giving team scores him through it.
    const gws = await Promise.all(moves.map((m) => getStartedGameweekNumber(row.leagueId, m.at)));
    const history = moves.map((m, i) => ({
      ...row,
      id: generateId(),
      teamId: m.from,
      acquiredGw: i === 0 ? row.acquiredGw : gws[i - 1],
      releasedGw: gws[i],
      acquiredVia: i === 0 ? row.acquiredVia : "trade",
      status: "transferred",
      // Release snapshots belong to whoever holds the row now, not to past owners.
      releaseRefund: null,
      releaseFmv: null,
      deadwoodReason: null,
      createdAt: i === 0 ? row.createdAt : moves[i - 1].at,
      updatedAt: m.at,
    }));

    toSplit++;
    const windows = history
      .map((h) => `${name(h.teamId)} GW${h.acquiredGw + 1}–${h.releasedGw}`)
      .concat(`${name(row.teamId)} from GW${gws[gws.length - 1] + 1}`);
    console.log(`${leagueSlug}  ${row.playerName} (${row.fplElementId}): ${windows.join(" → ")}`);

    if (APPLY) {
      await db.transaction(async (tx) => {
        for (const h of history) await tx.insert(auctionOwnership).values(h);
        await tx
          .update(auctionOwnership)
          .set({ acquiredGw: gws[gws.length - 1], acquiredVia: "trade" })
          .where(and(eq(auctionOwnership.id, row.id), eq(auctionOwnership.acquiredVia, "auction")));
      });
    }
  }

  console.log(`\n${toSplit} row(s) ${APPLY ? "split" : "to split"}, ${alreadyDone} already done.`);
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} row(s) left alone — check by hand:`);
    for (const s of skipped) console.log(`  ${s}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
