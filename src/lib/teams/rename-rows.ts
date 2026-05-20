// Shared helper that applies the PL Club Auction rename to a list of team-keyed rows.
//
// Background: when a team has bought a PL club via the club auction, every UI surface should display
// the club's name ("Liverpool") rather than the raw team name ("Team 5"). Rather than push the
// rename into every API endpoint by hand, this helper does a single `auctionClubOwnership` query
// per league and overrides `teamName` + attaches `ownedClub` on each input row.
//
// Usage in an API route:
//   const renamed = await applyTeamRename(leagueId, rawRows);
//   return NextResponse.json({ rows: renamed });
//
// Each row must carry `teamId` and `teamName`. `teamName` is overridden in place when an ownership
// is found; otherwise the original value is preserved.

import { db } from "@/lib/db";
import { auctionClubOwnership } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { ClubTier } from "@/lib/db/schema";
import { getPlTeamFullName } from "@/lib/data/pl-team-full-names";

export interface TeamRenameOwnership {
  plTeamId: number;
  plTeamName: string;
  plTeamShort: string;
  tier: ClubTier;
}

export async function fetchClubOwnershipMap(leagueId: string): Promise<Map<string, TeamRenameOwnership>> {
  const rows = await db
    .select({
      teamId: auctionClubOwnership.teamId,
      plTeamId: auctionClubOwnership.plTeamId,
      plTeamName: auctionClubOwnership.plTeamName,
      plTeamShort: auctionClubOwnership.plTeamShort,
      tier: auctionClubOwnership.tier,
    })
    .from(auctionClubOwnership)
    .where(eq(auctionClubOwnership.leagueId, leagueId));
  const map = new Map<string, TeamRenameOwnership>();
  for (const r of rows) {
    map.set(r.teamId, {
      plTeamId: r.plTeamId,
      // Normalise legacy rows (stored as FPL short form) to the full PL name. New writes are already
      // full names, but this read-side override means we don't need a one-off backfill.
      plTeamName: getPlTeamFullName(r.plTeamId, r.plTeamName),
      plTeamShort: r.plTeamShort,
      tier: r.tier as ClubTier,
    });
  }
  return map;
}

/**
 * Apply the rename to an array of team-keyed rows. Each row's `teamName` is replaced with the owned
 * club name when ownership exists. The returned rows also carry an `ownedClub` field for UI tier-chip
 * rendering.
 */
export async function applyTeamRename<T extends { teamId: string; teamName: string }>(
  leagueId: string,
  rows: T[],
): Promise<Array<T & { ownedClub: TeamRenameOwnership | null }>> {
  const ownerships = await fetchClubOwnershipMap(leagueId);
  return rows.map((row) => {
    const ownedClub = ownerships.get(row.teamId) ?? null;
    return {
      ...row,
      teamName: ownedClub?.plTeamName ?? row.teamName,
      ownedClub,
    };
  });
}

/**
 * Variant when the row's name field isn't `teamName`. Pass a getter/setter so the helper can target
 * the right key. Useful for rows like `{ ownerTeamName: string }` in the players API.
 */
export async function applyTeamRenameKeyed<T>(
  leagueId: string,
  rows: T[],
  pickTeamId: (row: T) => string | null | undefined,
  pickTeamName: (row: T) => string,
  setTeamName: (row: T, renamed: string) => T,
): Promise<Array<T & { ownedClub: TeamRenameOwnership | null }>> {
  const ownerships = await fetchClubOwnershipMap(leagueId);
  return rows.map((row) => {
    const teamId = pickTeamId(row);
    const ownedClub = teamId ? ownerships.get(teamId) ?? null : null;
    const newName = ownedClub?.plTeamName ?? pickTeamName(row);
    const next = setTeamName(row, newName);
    return { ...next, ownedClub };
  });
}
