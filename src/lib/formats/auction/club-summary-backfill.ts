// Shared on-the-fly backfill for `auction_scores.club_result_summary`.
//
// Legacy rows (scored before migration 0007 added the column) have null clubResultSummary even
// though clubResultBonus > 0. Both the standings and gw-summary endpoints need to display a
// readable scoreline for those rows, so we recompute it via `computeClubResultBonus` at read time.
//
// We don't write back to the DB — FPL fixtures + bootstrap are Redis-cached, so the recompute is
// cheap, and keeping GET handlers side-effect-free avoids cache invalidation headaches.

import type { ClubTier } from "@/lib/db/schema";
import { computeClubResultBonus } from "./club-auction";

export interface ScoreRowForBackfill {
  teamId: string;
  gameweek: number;
  clubResultBonus: number;
  clubResultSummary: string | null;
}

export interface ClubOwnership {
  plTeamId: number;
  tier: ClubTier;
}

/**
 * For each row whose `clubResultSummary` is null and `clubResultBonus > 0`, recompute the summary
 * via `computeClubResultBonus`. Returns a Map keyed by `${teamId}:${gw}` → summary string for the
 * rows that were successfully backfilled. Callers OR the fallback into their response.
 *
 * Safe to call with an empty `clubByTeamId` (returns empty map quickly). Per-row failures
 * (FPL outage etc.) are logged and skipped so one bad GW doesn't break the whole response.
 */
export async function backfillClubSummaries(
  rows: ScoreRowForBackfill[],
  clubByTeamId: Record<string, ClubOwnership> | Map<string, ClubOwnership>,
): Promise<Map<string, string>> {
  const lookup = (teamId: string): ClubOwnership | undefined => {
    if (clubByTeamId instanceof Map) return clubByTeamId.get(teamId);
    return clubByTeamId[teamId];
  };
  const result = new Map<string, string>();
  const candidates = rows.filter((r) => r.clubResultSummary == null && (r.clubResultBonus ?? 0) > 0);
  if (candidates.length === 0) return result;

  await Promise.all(
    candidates.map(async (r) => {
      const club = lookup(r.teamId);
      if (!club) return;
      try {
        const computed = await computeClubResultBonus(club.plTeamId, club.tier, r.gameweek);
        if (computed && computed.summary) {
          result.set(`${r.teamId}:${r.gameweek}`, computed.summary);
        }
      } catch (err) {
        console.warn("[club-summary-backfill] computeClubResultBonus failed", { teamId: r.teamId, gw: r.gameweek, error: err });
      }
    }),
  );
  return result;
}
