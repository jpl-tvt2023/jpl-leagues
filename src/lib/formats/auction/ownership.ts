// Player-ownership helpers for the auction.
//
// Centralised so the nominate route, the bid resolver, and any future caller share one source of
// truth for "is this FPL player already owned in this league?". The DB has a partial unique index
// (status="active") but in practice we want to check + refuse BEFORE inserting so the user gets a
// clear 409 instead of a constraint-violation 500.

import { db } from "@/lib/db";
import { auctionOwnership } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";

// Statuses that mean "this player is still in someone's squad and can NOT be re-auctioned".
// `pending_release` is a transitional state: the owning team has marked the player for release but
// the release hasn't been confirmed yet (24h before the next mini-auction, or at its start — see
// `confirmDueReleases` / `finalizePendingReleasesNow`). Until then the player is still in the squad and must not appear on
// nomination lists. Treating `pending_release` as ownerless was the root cause of the demo-auction
// "Wharton phantom-sold" bug (see Section E.10 of the plan).
const OWNED_STATUSES = ["active", "pending_release"] as const;

/**
 * Statuses of a row that is still part of a squad. The others — "released", and "transferred" (the
 * seller's copy after a trade) — are closed scoring windows kept as history: scoring and reprocessing
 * read them, squads and actions must not. Mirrors the one-live-owner index in schema.ts.
 */
export const LIVE_OWNERSHIP_STATUSES: string[] = ["active", "deadwood", "pending_release"];

/**
 * Returns the team id that currently owns `fplElementId` in `leagueId`, or null if unowned.
 * Matches rows whose status is `active` OR `pending_release` — both mean the player is still in
 * someone's squad.
 */
export async function ownerOfPlayer(
  leagueId: string,
  fplElementId: number,
): Promise<string | null> {
  const rows = await db
    .select({ teamId: auctionOwnership.teamId })
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueId),
        eq(auctionOwnership.fplElementId, fplElementId),
        inArray(auctionOwnership.status, OWNED_STATUSES as unknown as string[]),
      ),
    )
    .limit(1);
  return rows[0]?.teamId ?? null;
}

/**
 * Shorthand: true if the player has an active or pending_release ownership row in the league.
 */
export async function isPlayerOwned(
  leagueId: string,
  fplElementId: number,
): Promise<boolean> {
  return (await ownerOfPlayer(leagueId, fplElementId)) !== null;
}
