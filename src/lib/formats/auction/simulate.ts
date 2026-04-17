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

const DEFAULT_MIN_BID = 500_000;
const SQUAD_SIZE = 14;

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
  for (const t of leagueTeams) {
    remainingPurse.set(t.id, initialBudget);
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

  // Snake draft: 14 rounds
  for (let round = 0; round < SQUAD_SIZE; round++) {
    // Snake: even rounds go forward, odd rounds go reverse
    const order =
      round % 2 === 0 ? [...snakeOrder] : [...snakeOrder].reverse();

    for (const teamId of order) {
      const team = teamMap.get(teamId);
      if (!team) continue;

      const maxSlots = SQUAD_SIZE - (team.penaltySlots ?? 0);
      if (round >= maxSlots) continue;

      const purse = remainingPurse.get(teamId) ?? 0;

      // Find the best available player this team can afford
      let assigned = false;
      for (const player of sortedPlayers) {
        if (assignedElementIds.has(player.id)) continue;

        // Price = FPL now_cost × 100,000 (now_cost is in 0.1M units)
        let price = player.now_cost * 100_000;

        // If price exceeds remaining purse, use floor price
        if (price > purse) {
          price = DEFAULT_MIN_BID;
        }

        // If even floor price exceeds purse, skip (shouldn't happen with reasonable budgets)
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
        totalAssigned++;
        assigned = true;
        break;
      }

      if (!assigned) {
        // No available players (extremely unlikely with ~700 FPL players)
        console.warn(
          `[simulate] No available player for team ${teamId} in round ${round}`
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
