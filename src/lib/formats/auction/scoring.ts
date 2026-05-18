// JPL Auction Scoring Engine
// Team score = raw FPL points + PL Club Auction synergy bonus + PL Club Auction result bonus.
//   raw            — sum of owned players' GW FPL points (existing behaviour).
//   synergy        — +50% of raw for players whose current PL club matches the team's owned club.
//   clubResult     — per-fixture tier-based bonus when the team's owned club wins/draws this GW.
// Total scoring + ranking is handled by processAuctionGameweek; this file just computes per-team breakdowns.

import { fetchElementGameweekPoints, fetchElementInfo } from "../../fpl";
import { db, auctionOwnership, auctionClubOwnership } from "../../db";
import { eq, and, lt, gte, or, isNull } from "drizzle-orm";
import { getFplFixturesForGw } from "../../fpl-live/players-left";
import { getClubBonusForTier } from "./club-auction";
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

/**
 * Compute the per-fixture club-result bonus for an owned club this GW.
 * - Looks up the GW's PL fixtures, filters to those involving the owned club.
 * - Awards `tier.win` for wins, `tier.draw` for draws, 0 for losses. Sums across fixtures (DGW = doubled).
 * - Returns null if FPL fixtures are unavailable — caller treats as 0 with a logged warning.
 */
async function computeClubResultBonus(
  plTeamId: number,
  tier: ClubTier,
  gw: number
): Promise<{ bonus: number; summary: string } | null> {
  const fixtures = await getFplFixturesForGw(gw);
  if (fixtures == null) return null;

  const myFixtures = fixtures.filter((f) => f.team_h === plTeamId || f.team_a === plTeamId);
  if (myFixtures.length === 0) {
    return { bonus: 0, summary: "Blank GW — no fixture, no bonus" };
  }

  let total = 0;
  const lines: string[] = [];
  for (const f of myFixtures) {
    if (!f.finished && !f.finished_provisional) {
      // Fixture not finished yet — no bonus yet
      lines.push(`fixture not yet finished`);
      continue;
    }
    const isHome = f.team_h === plTeamId;
    const myScore = (isHome ? f.team_h_score : f.team_a_score) ?? 0;
    const oppScore = (isHome ? f.team_a_score : f.team_h_score) ?? 0;
    const isWin = myScore > oppScore;
    const isDraw = myScore === oppScore;
    const bonus = getClubBonusForTier(tier, isWin, isDraw);
    total += bonus;
    if (isWin) lines.push(`won → +${bonus}`);
    else if (isDraw) lines.push(`drew → +${bonus}`);
    else lines.push(`lost → +0`);
  }
  return { bonus: total, summary: lines.join("; ") };
}

/**
 * Calculate an auction team's GW score: raw + synergy + clubResult breakdown.
 *
 * Reads from `auctionOwnership` for current squad and `auctionClubOwnership` for owned-club bonus.
 * Owned-club perks (synergy + clubResult) only apply if the team owns a PL club; otherwise both are 0.
 *
 * @param preservedSynergyByElementId  Optional map used by reprocessing: if a previously-scored player
 *   has since left the PL (no longer in FPL bootstrap), preserve their last-known synergy bonus from this
 *   map rather than dropping it to 0.
 */
export async function calculateAuctionTeamScore(
  leagueId: string,
  teamId: string,
  gameweek: number,
  preservedSynergyByElementId?: Map<number, number>
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

  // Per-player breakdown
  const playerBreakdown: AuctionPlayerBreakdown[] = ownedPlayers.map((p) => {
    const raw = elementPoints[p.fplElementId] ?? 0;
    const meta = elementById.get(p.fplElementId);
    const currentPlTeamId = meta?.team ?? null;
    let synergyBonus = 0;
    if (ownedClubPlTeamId != null && currentPlTeamId === ownedClubPlTeamId) {
      // ×0.5 of raw — integer rounding (round-half-up) keeps totals predictable.
      synergyBonus = Math.round(raw * SYNERGY_BONUS_RATIO);
    } else if (!meta && preservedSynergyByElementId?.has(p.fplElementId)) {
      // Reprocess preservation: player no longer in bootstrap → keep previously-stored synergy.
      synergyBonus = preservedSynergyByElementId.get(p.fplElementId) ?? 0;
    }
    return {
      elementId: p.fplElementId,
      name: p.playerName,
      rawPoints: raw,
      synergyBonus,
      plTeamId: currentPlTeamId,
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
