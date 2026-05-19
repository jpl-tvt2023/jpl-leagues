// JPL Auction Scoring Engine
// Team score = raw FPL points + PL Club Auction synergy bonus + PL Club Auction result bonus.
//   raw            — sum of owned players' GW FPL points (existing behaviour).
//   synergy        — +50% of raw for players whose current PL club matches the team's owned club.
//   clubResult     — per-fixture tier-based bonus when the team's owned club wins/draws this GW.
// Total scoring + ranking is handled by processAuctionGameweek; this file just computes per-team breakdowns.

import { fetchElementGameweekPoints, fetchElementInfo } from "../../fpl";
import { db, auctionOwnership, auctionClubOwnership } from "../../db";
import { eq, and, lt, gte, or, isNull } from "drizzle-orm";
import { computeClubResultBonus } from "./club-auction";
import type { ClubTier } from "../../db/schema";

export interface AuctionPlayerBreakdown {
  elementId: number;
  name: string;
  /** @deprecated kept for backwards-compat with pre-club-auction breakdown rows; equal to `rawPoints`. */
  points?: number;
  rawPoints: number;
  synergyBonus: number;
  plTeamId: number | null; // current PL team — null only if FPL bootstrap doesn't resolve the element
}

export interface AuctionTeamGwScore {
  teamId: string;
  rawPoints: number;
  synergyBonus: number;
  clubResultBonus: number;
  totalPoints: number;
  playerBreakdown: AuctionPlayerBreakdown[];
  /** Human-readable footer line for the GW Results UI ("Liverpool drew Newcastle → +1 pt"). Null when team has no owned club. */
  clubResultSummary: string | null;
}

/** Synergy multiplier per the locked spec (×1.5 raw = +50% bonus on owned-club players). */
export const SYNERGY_BONUS_RATIO = 0.5;

// `computeClubResultBonus` lives in club-auction.ts so both the scorer and the gw-summary historical
// path (which back-fills tooltip summaries for legacy rows) can share it.

/**
 * Per-player data carried forward across re-processings. Captured at scoring time and stored in
 * `auctionScores.playerBreakdown` JSON, then replayed when admin re-processes the same GW.
 */
export interface PreservedPlayerData {
  /** PL team the player was registered with **at original scoring time**. Drives synergy
   *  retroactively — a mid-season transfer must NOT re-route synergy for already-scored GWs. */
  plTeamId: number | null;
  /** Final synergy bonus from the original scoring. Used only if the player has since left the
   *  PL entirely (missing from bootstrap) — otherwise synergy is recomputed using `plTeamId`. */
  synergyBonus: number;
}

/**
 * Calculate an auction team's GW score: raw + synergy + clubResult breakdown.
 *
 * Reads from `auctionOwnership` for current squad and `auctionClubOwnership` for owned-club bonus.
 * Owned-club perks (synergy + clubResult) only apply if the team owns a PL club; otherwise both are 0.
 *
 * @param preservedPlayerDataByElementId  Optional map used by reprocessing. For each owned player
 *   that has a preserved entry (i.e. the GW was scored before), the preserved `plTeamId` drives the
 *   synergy decision rather than the live bootstrap — so a mid-season transfer doesn't retroactively
 *   re-route synergy on already-scored GWs. The `synergyBonus` field is the last-known value, used
 *   as a fallback when the player is missing from the current FPL bootstrap (left the PL entirely).
 */
export async function calculateAuctionTeamScore(
  leagueId: string,
  teamId: string,
  gameweek: number,
  preservedPlayerDataByElementId?: Map<number, PreservedPlayerData>
): Promise<AuctionTeamGwScore> {
  // Squad owned during this GW
  const ownedPlayers = await db
    .select()
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueId),
        eq(auctionOwnership.teamId, teamId),
        lt(auctionOwnership.acquiredGw, gameweek),
        or(
          isNull(auctionOwnership.releasedGw),
          gte(auctionOwnership.releasedGw, gameweek),
        ),
      )
    );

  // Owned PL club (if any) — drives synergy + clubResult
  const clubRow = await db
    .select()
    .from(auctionClubOwnership)
    .where(and(eq(auctionClubOwnership.leagueId, leagueId), eq(auctionClubOwnership.teamId, teamId)))
    .limit(1);
  const ownedClubPlTeamId = clubRow[0]?.plTeamId ?? null;
  const ownedClubTier = (clubRow[0]?.tier as ClubTier | undefined) ?? null;

  // FPL data: all element GW points + element metadata (for current PL team lookup)
  const [elementPoints, elementInfo] = await Promise.all([
    fetchElementGameweekPoints(gameweek),
    fetchElementInfo(),
  ]);
  const elementById = new Map(elementInfo.map((e) => [e.id, e]));

  // Per-player breakdown. The synergy decision uses the player's PL team at the time the GW was
  // *originally* scored (snapshotted in the preserved data). Falls back to the live bootstrap on
  // first-time scoring or when no snapshot exists. This makes mid-season transfers prospective —
  // re-scoring an old GW doesn't re-route synergy to a player's new club.
  const playerBreakdown: AuctionPlayerBreakdown[] = ownedPlayers.map((p) => {
    const raw = elementPoints[p.fplElementId] ?? 0;
    const meta = elementById.get(p.fplElementId);
    const preserved = preservedPlayerDataByElementId?.get(p.fplElementId);
    // Effective PL team for synergy: prefer the historical snapshot if we have one, else live bootstrap.
    const effectivePlTeamId = preserved?.plTeamId ?? meta?.team ?? null;
    let synergyBonus = 0;
    if (ownedClubPlTeamId != null && effectivePlTeamId === ownedClubPlTeamId) {
      // ×0.5 of raw — keep the fractional value (e.g. raw 13 → synergy 6.5).
      // The DB columns are REAL; UI helper `formatPts` strips the trailing `.0` for whole numbers.
      synergyBonus = raw * SYNERGY_BONUS_RATIO;
    } else if (!meta && preserved) {
      // Player has left the PL entirely (missing from bootstrap) but we have a snapshot — preserve
      // the last-known synergy value rather than dropping it to 0.
      synergyBonus = preserved.synergyBonus;
    }
    return {
      elementId: p.fplElementId,
      name: p.playerName,
      rawPoints: raw,
      synergyBonus,
      // Persist the effective PL team into the breakdown JSON so subsequent reprocessing reads it.
      plTeamId: effectivePlTeamId,
    };
  });

  const rawPoints = playerBreakdown.reduce((sum, p) => sum + p.rawPoints, 0);
  const synergyBonus = playerBreakdown.reduce((sum, p) => sum + p.synergyBonus, 0);

  let clubResultBonus = 0;
  let clubResultSummary: string | null = null;
  if (ownedClubPlTeamId != null && ownedClubTier != null && clubRow[0]) {
    const result = await computeClubResultBonus(ownedClubPlTeamId, ownedClubTier, gameweek);
    if (result) {
      clubResultBonus = result.bonus;
      clubResultSummary = `${clubRow[0].plTeamName} (${ownedClubTier}): ${result.summary} = +${result.bonus}`;
    } else {
      // FPL outage — caller logs; default to 0 for now.
      clubResultSummary = `${clubRow[0].plTeamName}: result unavailable (FPL fixtures fetch failed)`;
    }
  }

  return {
    teamId,
    rawPoints,
    synergyBonus,
    clubResultBonus,
    totalPoints: rawPoints + synergyBonus + clubResultBonus,
    playerBreakdown,
    clubResultSummary,
  };
}
