// JPL Auction — server-side release pricing: FMV from the team's recorded points, plus a live FPL
// read to decide deadwood. Shared by /api/auction/release and scripts/reprice-pending-releases.ts.
// The rules themselves live in ./release-refund (pure, client-safe).

import { db, auctionOwnership, auctionScores } from "../../db";
import { and, eq } from "drizzle-orm";
import { withDbRetry } from "../../db/errors";
import { calculateFMV } from "./economy";
import {
  classifyDeadwood,
  lastFinishedGames,
  priceReleaseRefund,
  type DeadwoodReason,
  type RefundBreakdown,
} from "./release-refund";
import { fetchElementHistory, fetchElementInfo } from "../../fpl";
import { getAllFplFixtures } from "../../fpl-live/players-left";
import { withFplBudget } from "../../fpl/gateway";

type PricedOwnership = Pick<
  typeof auctionOwnership.$inferSelect,
  "leagueId" | "teamId" | "fplElementId" | "purchasePrice"
>;

export interface ReleasePricing {
  breakdown: RefundBreakdown;
  /** FPL bootstrap status at pricing time; null when he's no longer in FPL's player list. */
  fplStatus: string | null;
  /** His last (up to 5) finished games, newest first. Empty when his FPL status alone decided it. */
  lastGames: { round: number; minutes: number }[];
}

/**
 * FPL couldn't be read, so deadwood can't be judged. Callers answer "try again" rather than
 * falling back to the standard rate — quietly pricing a deadwood player at 50% costs real money.
 */
export class FplAvailabilityError extends Error {
  constructor(cause: unknown) {
    super(`FPL availability check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FplAvailabilityError";
  }
}

/** Price a release as of now. Throws FplAvailabilityError when FPL can't be read. */
export async function priceRelease(ownership: PricedOwnership): Promise<ReleasePricing> {
  const [totalPoints, availability] = await Promise.all([
    rawPointsForTeam(ownership),
    readAvailability(ownership.fplElementId),
  ]);
  const fmv = calculateFMV(ownership.purchasePrice, totalPoints);
  return {
    breakdown: priceReleaseRefund(ownership.purchasePrice, fmv, availability.deadwoodReason),
    fplStatus: availability.fplStatus,
    lastGames: availability.lastGames,
  };
}

/**
 * Cumulative RAW points the player has scored for this team — the FMV input, mirroring the squad
 * API (synergy never compounds into FMV).
 */
async function rawPointsForTeam(ownership: PricedOwnership): Promise<number> {
  const playerScores = await withDbRetry("release points read", () =>
    db
      .select({ playerBreakdown: auctionScores.playerBreakdown })
      .from(auctionScores)
      .where(and(eq(auctionScores.leagueId, ownership.leagueId), eq(auctionScores.teamId, ownership.teamId)))
  );
  let totalPoints = 0;
  for (const s of playerScores) {
    try {
      const breakdown: Array<{ elementId: number; points?: number; rawPoints?: number }> = JSON.parse(s.playerBreakdown);
      for (const p of breakdown) {
        if (p.elementId === ownership.fplElementId) totalPoints += p.rawPoints ?? p.points ?? 0;
      }
    } catch { /* tolerate malformed rows */ }
  }
  return totalPoints;
}

/**
 * Is the player deadwood right now? The bootstrap status settles "transferred / loaned out";
 * otherwise his last 5 finished games decide it.
 */
async function readAvailability(fplElementId: number): Promise<{
  deadwoodReason: DeadwoodReason | null;
  fplStatus: string | null;
  lastGames: { round: number; minutes: number }[];
}> {
  try {
    return await withFplBudget({ lane: "background", label: "auction release pricing", max: 3 }, async () => {
      const elements = await fetchElementInfo();
      // An empty list is a bad payload, not "everyone left the league" — refuse rather than pay 80%.
      if (elements.length === 0) throw new Error("FPL player list is empty");
      const fplStatus = elements.find((e) => e.id === fplElementId)?.status ?? null;
      if (fplStatus === null || fplStatus === "u") {
        return { deadwoodReason: classifyDeadwood(fplStatus, []), fplStatus, lastGames: [] };
      }

      const [history, fixtures] = await Promise.all([fetchElementHistory(fplElementId), getAllFplFixtures()]);
      if (fixtures == null) throw new Error("FPL fixtures list unavailable");
      // A game still in progress hasn't settled his minutes, so only completed games count.
      const finished = new Set(fixtures.filter((f) => f.finished || f.finished_provisional).map((f) => f.id));
      const games = history
        .filter((h) => finished.has(h.fixture))
        .map((h) => ({ round: h.round, kickoffTime: h.kickoff_time, minutes: h.minutes }));
      return {
        deadwoodReason: classifyDeadwood(fplStatus, games),
        fplStatus,
        lastGames: lastFinishedGames(games).map(({ round, minutes }) => ({ round, minutes })),
      };
    });
  } catch (err) {
    throw new FplAvailabilityError(err);
  }
}
