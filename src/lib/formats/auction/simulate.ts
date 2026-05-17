/**
 * Simulated Auction — auto-assigns players via snake draft.
 *
 * Used for testing post-auction features (scoring, releases, trades, finance)
 * without sitting through an entire live auction.
 *
 * When a session is started in a simulated league, this runs instead of
 * the live nomination/bidding flow. Each team gets 14 players assigned
 * by snake order, sorted by FPL total_points descending.
 *
 * Purchase price = FPL now_cost × 100,000 (e.g. Haaland 130 → £13M).
 * If a player would exceed remaining purse, use 500K floor price.
 */

import { db } from "@/lib/db";
import { auctionOwnership, auctionSessions, teams, leagues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { fetchElementInfo } from "@/lib/fpl";
import {
  MAX_SQUAD_SIZE,
  effectiveMaxSquadSize,
  emptyCounts,
  validateAddPlayer,
  type SquadCounts,
} from "./squad-rules";

const DEFAULT_MIN_BID = 500_000;

/**
 * Run a simulated snake draft for a league's auction session.
 *
 * 1. Fetches FPL bootstrap → sorted by total_points desc
 * 2. Iterates snake order for 14 rounds, assigning best available player
 * 3. Creates auctionOwnership records, deducts purse/totalSpent
 * 4. Marks session as "completed"
 */
export async function simulateAuction(
  leagueId: string,
  sessionId: string
): Promise<{ playersAssigned: number }> {
  // Fetch session → snake order
  const [session] = await db
    .select()
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);

  if (!session) throw new Error("Session not found");

  const snakeOrder: string[] = JSON.parse(session.snakeOrder);
  if (snakeOrder.length === 0) throw new Error("Empty snake order");

  // Fetch league initial budget
  const [league] = await db
    .select({ initialBudget: leagues.initialBudget })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  const initialBudget = league?.initialBudget ?? 100_000_000;

  // Fetch all teams with their current purse state
  const leagueTeams = await db
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));

  const teamMap = new Map(leagueTeams.map((t) => [t.id, t]));

  // Track remaining purse per team (start from initialBudget since this is a fresh auction)
  const remainingPurse = new Map<string, number>();
  // Track per-team squad position counts so each pick can be checked against the
  // 1 GK / 3 DEF / 3 MID / 1 FWD minimum via validateAddPlayer.
  const teamCounts = new Map<string, SquadCounts>();
  for (const t of leagueTeams) {
    remainingPurse.set(t.id, initialBudget);
    teamCounts.set(t.id, emptyCounts());
  }

  // Fetch FPL players sorted by total_points desc
  const elements = await fetchElementInfo();
  const sortedPlayers = [...elements].sort(
    (a, b) => b.total_points - a.total_points
  );

  const assignedElementIds = new Set<number>();
  let totalAssigned = 0;
  const now = new Date();

  // Track cumulative spend per team for batch DB update
  const teamSpend = new Map<string, number>();

  // Collect all ownership records — bulk insert after loop to avoid Vercel timeout
  const ownershipRecords: (typeof auctionOwnership.$inferInsert)[] = [];

  // Snake draft: up to MAX_SQUAD_SIZE rounds. Each pick must pass
  // validateAddPlayer so the final squad meets 1 GK / 3 DEF / 3 MID / 1 FWD.
  for (let round = 0; round < MAX_SQUAD_SIZE; round++) {
    // Snake: even rounds go forward, odd rounds go reverse
    const order =
      round % 2 === 0 ? [...snakeOrder] : [...snakeOrder].reverse();

    for (const teamId of order) {
      const team = teamMap.get(teamId);
      if (!team) continue;

      const penaltySlots = team.penaltySlots ?? 0;
      const maxSlots = effectiveMaxSquadSize(penaltySlots);
      if (round >= maxSlots) continue;

      const purse = remainingPurse.get(teamId) ?? 0;
      const counts = teamCounts.get(teamId);
      if (!counts) continue;

      let assigned = false;
      for (const player of sortedPlayers) {
        if (assignedElementIds.has(player.id)) continue;

        // Position feasibility — would this addition still let the squad
        // reach the 1/3/3/1 minimum with the slots that remain?
        const feasibility = validateAddPlayer(counts, penaltySlots, player.element_type);
        if (!feasibility.ok) continue;

        // Pricing — real (FPL now_cost × 100K), else floor as last-resort.
        let price = player.now_cost * 100_000;
        if (price > purse) price = DEFAULT_MIN_BID;
        if (price > purse) continue;

        ownershipRecords.push({
          id: generateId(),
          leagueId,
          teamId,
          fplElementId: player.id,
          playerName: player.web_name,
          elementType: player.element_type,
          purchasePrice: price,
          acquiredGw: 0,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });

        assignedElementIds.add(player.id);
        remainingPurse.set(teamId, purse - price);
        teamSpend.set(teamId, (teamSpend.get(teamId) ?? 0) + price);
        if (player.element_type === 1 || player.element_type === 2 || player.element_type === 3 || player.element_type === 4) {
          counts[player.element_type as 1 | 2 | 3 | 4]++;
        }
        counts.total++;
        totalAssigned++;
        assigned = true;
        break;
      }

      if (!assigned) {
        console.warn(
          `[simulate] No feasible+affordable player for team ${teamId} in round ${round}`,
          { counts, purse: remainingPurse.get(teamId), penaltySlots }
        );
      }
    }
  }

  // Single bulk insert — one DB round trip instead of 140 sequential awaits
  if (ownershipRecords.length > 0) {
    await db.insert(auctionOwnership).values(ownershipRecords);
  }

  // Update each team's purse and totalSpent in DB
  for (const [teamId, spent] of teamSpend) {
    const newPurse = initialBudget - spent;
    await db
      .update(teams)
      .set({
        purse: newPurse,
        totalSpent: spent,
        updatedAt: now,
      })
      .where(eq(teams.id, teamId));
  }

  // Mark session as completed
  await db
    .update(auctionSessions)
    .set({ status: "completed" })
    .where(eq(auctionSessions.id, sessionId));

  return { playersAssigned: totalAssigned };
}
