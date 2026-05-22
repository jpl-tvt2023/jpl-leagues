/**
 * Generate importable row-arrays for a league's full backup.
 *
 * Each returned array matches the column shape expected by the corresponding
 * import-* POST endpoint, so `JSON.stringify({ teams })` / `{ fixtures }` /
 * `{ captains }` / `{ chips }` round-trip cleanly.
 *
 * The backup endpoint (`/api/admin/[leagueId]/backup`) wraps these arrays into
 * .xlsx files via the `xlsx` lib and zips them. The auto-snapshot path stores
 * the same arrays as JSON in the `backups` table — re-formatting later just
 * means re-running the xlsx writer over the stored JSON.
 *
 * Skipping rules:
 *   - teams + captains arrays are null when format === "auction"
 *     (auction has its own onboarding; bulk-upload-teams refuses auction).
 *   - chips array is null when format !== "tvt" (only TVT uses gameweekChips).
 */

import { db } from "@/lib/db";
import {
  leagues,
  teams,
  gameweeks,
  fixtures,
  gameweekCaptains,
  gameweekChips,
  auctionOwnership,
  auctionClubOwnership,
  tradeProposals,
  teamPenalties,
  teamSlotUnlocks,
  auctionWishlists,
  notifications,
  auctionSessions,
  auctionBids,
  auctionBidLogs,
} from "@/lib/db/schema";
import { eq, and, inArray, isNotNull } from "drizzle-orm";

export type TeamRow = {
  "Team ID": string;
  "Team Name": string;
  Password: string;
  "Player1 Name": string;
  "Player1 FPL ID": string;
  "Player2 Name": string;
  "Player2 FPL ID": string;
  Group: string;
};

export type FixtureRow = {
  Gameweek: number;
  "Home Team": string;
  "Away Team": string;
};

// Captain rows have static Team + Players cols + dynamic 1..38 GW cols.
export type CaptainRow = Record<string, string>;

// Chip rows have a static Team col + dynamic 1..38 GW cols.
export type ChipRow = Record<string, string>;

// Auction sheets — populated only for `format === "auction"`. Use stable column names so the
// restore endpoint and Excel viewers can both read them.
export type AuctionTeamStateRow = {
  "Team ID": string;
  "Team Login ID": string;
  "Team Name": string;
  Purse: number;
  "Total Spent": number;
  "Total Income": number;
  "Total Refunds": number;
  "Penalty Slots": number;
  "Bonus Slots": number;
};
export type AuctionSquadRow = {
  "Ownership ID": string;
  "Team ID": string;
  "FPL Element ID": number;
  "Player Name": string;
  "Element Type": number | null;
  "Purchase Price": number;
  "Acquired GW": number;
  "Released GW": number | null;
  Status: string;
};
export type AuctionClubRow = {
  ID: string;
  "Team ID": string;
  "PL Team ID": number;
  "PL Team Name": string;
  "PL Team Short": string;
  Tier: string;
  "Purchase Price": number;
  "Acquired At": string;
};
export type GameweekRow = {
  ID: string;
  Number: number;
  Deadline: string;
  "Is Playoffs": boolean;
};

// ── Auction event-history rows (migration 0012). Auction-only; null for TVT/TC. ──
// Column names mirror the DB columns they restore to so the restore step is a straight map.

export type TradeRow = {
  "Trade ID": string;
  Status: string;                  // pending | accepted | rejected | vetoed | expired | completed | cancelled
  "Proposer Team ID": string;
  "Target Team ID": string;
  "Offered Player IDs": string;    // JSON-stringified array of auctionOwnership IDs
  "Requested Player IDs": string;
  "Cash Offered": number;
  "Veto Deadline": string | null;
  "Veto Votes": string;            // JSON-stringified { teamId: "veto" | "approve" }
  "Created At": string;
  "Updated At": string;
};

export type PenaltyRedemptionRow = {
  "Penalty ID": string;
  "Team ID": string;
  "Session ID": string | null;
  "Incurred Cycle": number;
  "Redeemed At": string;
  "Redemption Price": number;
  "Created At": string;
};

export type SlotUnlockRow = {
  "Unlock ID": string;
  "Team ID": string;
  "Slot Number": number;
  Cost: number;
  "Unlocked At": string;
};

export type WishlistRow = {
  "Wishlist ID": string;
  "Team ID": string;
  "FPL Element ID": number;
  "Player Name": string;
  Priority: number;
  "Created At": string;
};

export type NotificationRow = {
  "Notification ID": string;
  "Team ID": string;
  Type: string;
  Title: string;
  Body: string;
  Link: string | null;
  "Read At": string | null;
  "Created At": string;
};

export type AuctionSessionRow = {
  "Session ID": string;
  Type: string;                   // "initial" | "mini-auction" | "club-auction"
  Status: string;                 // "completed" | "cancelled" — active/pending intentionally excluded
  "Cycle Number": number;
  "Snake Order": string;          // JSON array
  "Current Nominator Index": number;
  "Nomination Deadline": string | null;
  "Scheduled At": string | null;
  "Bid Timer Seconds": number;
  "Nomination Timeout Seconds": number;
  "Created At": string;
};

export type AuctionBidRow = {
  "Bid ID": string;
  "Session ID": string;
  "Nominator Team ID": string;
  "FPL Element ID": number;
  "Player Name": string;
  "Current High Bid": number;
  "Current High Bidder ID": string;
  "Min Bid": number;
  Status: string;                 // "open" | "sold" | "unsold" | "cancelled"
  "Expires At": string;
  "Created At": string;
  "Updated At": string;
};

export type AuctionBidLogRow = {
  "Bid Log ID": string;
  "Bid ID": string;
  "Team ID": string;
  Amount: number;
  Type: string;                   // "nomination" | "bid" | "sold" | "unsold"
  "Created At": string;
};

// Identity payload written into the .zip as meta.json. Restore endpoints validate the source
// leagueId against the target before any destructive operation — prevents restoring League A's
// backup into League B by accident.
export type BackupMeta = {
  leagueId: string;
  leagueSlug: string;
  leagueName: string;
  format: string;
  season: string;
  generatedAt: string;
  /** Bumped when the BackupRows payload shape changes in a breaking way. */
  backupVersion: 1;
};

export type BackupRows = {
  meta: BackupMeta;
  format: string;
  teams: TeamRow[] | null;
  fixtures: FixtureRow[];
  captains: CaptainRow[] | null;
  chips: ChipRow[] | null;
  // Auction-only sheets — null for TVT / triple-crown.
  auctionTeamsState: AuctionTeamStateRow[] | null;
  auctionSquads: AuctionSquadRow[] | null;
  auctionClubs: AuctionClubRow[] | null;
  // Available for every format — the restore endpoint reads this when recreating GW rows.
  gameweeks: GameweekRow[];
  // Auction event-history sheets (migration 0012). Auction-only; null for TVT/TC.
  auctionTrades: TradeRow[] | null;
  auctionPenaltyRedemptions: PenaltyRedemptionRow[] | null;
  auctionSlotUnlocks: SlotUnlockRow[] | null;
  auctionWishlists: WishlistRow[] | null;
  auctionNotifications: NotificationRow[] | null;
  auctionSessionsHistory: AuctionSessionRow[] | null;
  auctionBids: AuctionBidRow[] | null;
  auctionBidLogs: AuctionBidLogRow[] | null;
};

/**
 * Placeholder password emitted for every team in the backup. Bcrypt hashes
 * cannot be reversed, and re-importing requires plaintext (bulk-upload-teams
 * re-hashes via bcrypt). On restore, admin must hand out new passwords or use
 * the per-team "edit team" flow to set them.
 */
const PASSWORD_PLACEHOLDER = "RESET_REQUIRED";

export async function generateBackupRows(leagueId: string): Promise<BackupRows> {
  const [league] = await db
    .select({
      id: leagues.id,
      slug: leagues.slug,
      name: leagues.name,
      format: leagues.format,
      season: leagues.season,
    })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) throw new Error(`League ${leagueId} not found`);

  const meta: BackupMeta = {
    leagueId: league.id,
    leagueSlug: league.slug,
    leagueName: league.name,
    format: league.format,
    season: league.season,
    generatedAt: new Date().toISOString(),
    backupVersion: 1,
  };

  // ── Teams + players + group ──
  let teamsRows: TeamRow[] | null = null;
  if (league.format !== "auction") {
    const teamRows = await db.query.teams.findMany({
      where: and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)),
      with: { players: true, group: true },
    });
    teamsRows = teamRows.map(t => {
      const [p1, p2] = t.players;
      return {
        "Team ID": t.teamLoginId ?? "",
        "Team Name": t.name,
        Password: PASSWORD_PLACEHOLDER,
        "Player1 Name": p1?.name ?? "",
        "Player1 FPL ID": p1?.fplId ?? "",
        "Player2 Name": p2?.name ?? "",
        "Player2 FPL ID": p2?.fplId ?? "",
        Group: t.group?.name ?? "",
      };
    });
  }

  // ── Fixtures (PL only — playoff fixtures are auto-generated by advance) ──
  const allGameweeks = await db
    .select({ id: gameweeks.id, number: gameweeks.number })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId));
  const gwIdToNumber = new Map(allGameweeks.map(gw => [gw.id, gw.number]));
  const allGwIds = allGameweeks.map(gw => gw.id);

  const fixturesData = allGwIds.length === 0 ? [] : await db.query.fixtures.findMany({
    where: and(inArray(fixtures.gameweekId, allGwIds), eq(fixtures.isPlayoff, false)),
    with: { homeTeam: true, awayTeam: true },
  });
  const fixturesRows: FixtureRow[] = fixturesData
    .map(f => ({
      Gameweek: gwIdToNumber.get(f.gameweekId) ?? 0,
      "Home Team": f.homeTeam?.teamLoginId ?? "",
      "Away Team": f.awayTeam?.teamLoginId ?? "",
    }))
    .filter(r => r.Gameweek > 0 && r["Home Team"] && r["Away Team"])
    .sort((a, b) => a.Gameweek - b.Gameweek);

  // ── Captains: one row per (team, player); cell n = "C" if that player was captain in GW n ──
  let captainsRows: CaptainRow[] | null = null;
  if (league.format !== "auction" && allGwIds.length > 0) {
    const captainRows = await db.query.gameweekCaptains.findMany({
      where: inArray(gameweekCaptains.gameweekId, allGwIds),
      with: { player: { with: { team: true } } },
    });
    // Index by playerId × gw → "C"
    const captainByPlayerGw = new Map<string, Set<number>>();
    for (const c of captainRows) {
      if (!c.player?.id) continue;
      const gwNum = gwIdToNumber.get(c.gameweekId);
      if (!gwNum) continue;
      let set = captainByPlayerGw.get(c.player.id);
      if (!set) { set = new Set(); captainByPlayerGw.set(c.player.id, set); }
      set.add(gwNum);
    }

    // Need teams+players ordering. Reuse the team query above when not auction
    const teamsForCaptains = teamsRows
      ? await db.query.teams.findMany({
          where: and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)),
          with: { players: true },
        })
      : [];

    captainsRows = [];
    for (const t of teamsForCaptains) {
      for (const p of t.players) {
        const captainGws = captainByPlayerGw.get(p.id) ?? new Set();
        const row: CaptainRow = {
          Team: t.teamLoginId ?? "",
          Players: p.name,
        };
        for (let gw = 1; gw <= 38; gw++) {
          row[String(gw)] = captainGws.has(gw) ? "C" : "";
        }
        captainsRows.push(row);
      }
    }
  }

  // ── Chips: one row per team; cell n = chip code or "" ──
  let chipsRows: ChipRow[] | null = null;
  if (league.format === "tvt" && allGwIds.length > 0) {
    const chipsData = await db.query.gameweekChips.findMany({
      where: inArray(gameweekChips.gameweekId, allGwIds),
      with: { team: true, challengedTeam: true },
    });

    // Index by teamId × gw → encoded chip cell value
    const chipsByTeamGw = new Map<string, Map<number, string>>();
    for (const c of chipsData) {
      const gwNum = gwIdToNumber.get(c.gameweekId);
      if (!gwNum || !c.teamId) continue;
      const code = encodeChipCell(c.chipType, c.isValid, c.challengedTeam?.teamLoginId ?? null);
      if (!code) continue;
      let perTeam = chipsByTeamGw.get(c.teamId);
      if (!perTeam) { perTeam = new Map(); chipsByTeamGw.set(c.teamId, perTeam); }
      perTeam.set(gwNum, code);
    }

    const teamsForChips = await db.query.teams.findMany({
      where: and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)),
    });
    chipsRows = teamsForChips.map(t => {
      const perGw = chipsByTeamGw.get(t.id);
      const row: ChipRow = { Team: t.teamLoginId ?? "" };
      for (let gw = 1; gw <= 38; gw++) {
        row[String(gw)] = perGw?.get(gw) ?? "";
      }
      return row;
    });
  }

  // ── Gameweeks shape — id / number / deadline / isPlayoffs. Available for every format. ──
  const gwRows = await db
    .select({
      id: gameweeks.id,
      number: gameweeks.number,
      deadline: gameweeks.deadline,
      isPlayoffs: gameweeks.isPlayoffs,
    })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId));
  const gameweeksRows: GameweekRow[] = gwRows
    .map((g) => ({
      ID: g.id,
      Number: g.number,
      Deadline: g.deadline.toISOString(),
      "Is Playoffs": Boolean(g.isPlayoffs),
    }))
    .sort((a, b) => a.Number - b.Number);

  // ── Auction sheets — populated only for auction leagues. ──
  let auctionTeamsState: AuctionTeamStateRow[] | null = null;
  let auctionSquads: AuctionSquadRow[] | null = null;
  let auctionClubs: AuctionClubRow[] | null = null;
  // Event-history sheets (migration 0012). Auction-only.
  let auctionTradesRows: TradeRow[] | null = null;
  let auctionPenaltyRedemptionsRows: PenaltyRedemptionRow[] | null = null;
  let auctionSlotUnlocksRows: SlotUnlockRow[] | null = null;
  let auctionWishlistsRows: WishlistRow[] | null = null;
  let auctionNotificationsRows: NotificationRow[] | null = null;
  let auctionSessionsHistoryRows: AuctionSessionRow[] | null = null;
  let auctionBidsRows: AuctionBidRow[] | null = null;
  let auctionBidLogsRows: AuctionBidLogRow[] | null = null;
  if (league.format === "auction") {
    const [
      auctionTeamRows,
      ownershipRows,
      clubRows,
      tradeRows,
      penaltyRows,
      slotUnlockRows,
      wishlistRowsRaw,
      notificationRows,
      sessionRows,
      bidRows,
    ] = await Promise.all([
      db.select({
        id: teams.id,
        teamLoginId: teams.teamLoginId,
        name: teams.name,
        purse: teams.purse,
        totalSpent: teams.totalSpent,
        totalIncome: teams.totalIncome,
        totalRefunds: teams.totalRefunds,
        penaltySlots: teams.penaltySlots,
        bonusSlots: teams.bonusSlots,
      })
        .from(teams)
        .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false))),
      db.select().from(auctionOwnership).where(eq(auctionOwnership.leagueId, leagueId)),
      db.select().from(auctionClubOwnership).where(eq(auctionClubOwnership.leagueId, leagueId)),
      // All trade proposals — every status, so the audit trail is preserved.
      db.select().from(tradeProposals).where(eq(tradeProposals.leagueId, leagueId)),
      // Only REDEEMED penalty rows — pending penalties live on the active teamsState (penaltySlots).
      db.select().from(teamPenalties).where(
        and(eq(teamPenalties.leagueId, leagueId), isNotNull(teamPenalties.redeemedAt)),
      ),
      db.select().from(teamSlotUnlocks).where(eq(teamSlotUnlocks.leagueId, leagueId)),
      db.select().from(auctionWishlists).where(eq(auctionWishlists.leagueId, leagueId)),
      db.select().from(notifications).where(eq(notifications.leagueId, leagueId)),
      // Only completed/cancelled sessions — active/pending intentionally excluded (admin reschedules).
      db.select().from(auctionSessions).where(
        and(eq(auctionSessions.leagueId, leagueId), inArray(auctionSessions.status, ["completed", "cancelled"])),
      ),
      db.select().from(auctionBids).where(eq(auctionBids.leagueId, leagueId)),
    ]);

    // Bid logs are joined via bidId — only pull logs whose bids belong to this league.
    const bidIds = bidRows.map((b) => b.id);
    const bidLogRows = bidIds.length > 0
      ? await db.select().from(auctionBidLogs).where(inArray(auctionBidLogs.bidId, bidIds))
      : [];

    auctionTeamsState = auctionTeamRows.map((t) => ({
      "Team ID": t.id,
      "Team Login ID": t.teamLoginId ?? "",
      "Team Name": t.name,
      Purse: t.purse,
      "Total Spent": t.totalSpent,
      "Total Income": t.totalIncome,
      "Total Refunds": t.totalRefunds,
      "Penalty Slots": t.penaltySlots,
      "Bonus Slots": t.bonusSlots ?? 0,
    }));

    auctionSquads = ownershipRows.map((o) => ({
      "Ownership ID": o.id,
      "Team ID": o.teamId,
      "FPL Element ID": o.fplElementId,
      "Player Name": o.playerName,
      "Element Type": o.elementType ?? null,
      "Purchase Price": o.purchasePrice,
      "Acquired GW": o.acquiredGw,
      "Released GW": o.releasedGw ?? null,
      Status: o.status,
    }));

    auctionClubs = clubRows.map((c) => ({
      ID: c.id,
      "Team ID": c.teamId,
      "PL Team ID": c.plTeamId,
      "PL Team Name": c.plTeamName,
      "PL Team Short": c.plTeamShort,
      Tier: c.tier,
      "Purchase Price": c.purchasePrice,
      "Acquired At": c.acquiredAt.toISOString(),
    }));

    auctionTradesRows = tradeRows.map((t) => ({
      "Trade ID": t.id,
      Status: t.status,
      "Proposer Team ID": t.proposerTeamId,
      "Target Team ID": t.targetTeamId,
      "Offered Player IDs": t.offeredPlayerIds,
      "Requested Player IDs": t.requestedPlayerIds,
      "Cash Offered": t.cashOffered,
      "Veto Deadline": t.vetoDeadline ? t.vetoDeadline.toISOString() : null,
      "Veto Votes": t.vetoVotes,
      "Created At": t.createdAt.toISOString(),
      "Updated At": t.updatedAt.toISOString(),
    }));

    auctionPenaltyRedemptionsRows = penaltyRows.map((p) => ({
      "Penalty ID": p.id,
      "Team ID": p.teamId,
      "Session ID": p.sessionId,
      "Incurred Cycle": p.incurredCycle,
      "Redeemed At": p.redeemedAt!.toISOString(), // isNotNull filter guarantees non-null
      "Redemption Price": p.redemptionPrice ?? 0,
      "Created At": p.createdAt.toISOString(),
    }));

    auctionSlotUnlocksRows = slotUnlockRows.map((u) => ({
      "Unlock ID": u.id,
      "Team ID": u.teamId,
      "Slot Number": u.slotNumber,
      Cost: u.cost,
      "Unlocked At": u.unlockedAt.toISOString(),
    }));

    auctionWishlistsRows = wishlistRowsRaw.map((w) => ({
      "Wishlist ID": w.id,
      "Team ID": w.teamId,
      "FPL Element ID": w.fplElementId,
      "Player Name": w.playerName,
      Priority: w.priority,
      "Created At": w.createdAt.toISOString(),
    }));

    auctionNotificationsRows = notificationRows.map((n) => ({
      "Notification ID": n.id,
      "Team ID": n.teamId,
      Type: n.type,
      Title: n.title,
      Body: n.body,
      Link: n.link,
      "Read At": n.readAt ? n.readAt.toISOString() : null,
      "Created At": n.createdAt.toISOString(),
    }));

    auctionSessionsHistoryRows = sessionRows.map((s) => ({
      "Session ID": s.id,
      Type: s.type,
      Status: s.status,
      "Cycle Number": s.cycleNumber,
      "Snake Order": s.snakeOrder,
      "Current Nominator Index": s.currentNominatorIndex,
      "Nomination Deadline": s.nominationDeadline ? s.nominationDeadline.toISOString() : null,
      "Scheduled At": s.scheduledAt ? s.scheduledAt.toISOString() : null,
      "Bid Timer Seconds": s.bidTimerSeconds,
      "Nomination Timeout Seconds": s.nominationTimeoutSeconds,
      "Created At": s.createdAt.toISOString(),
    }));

    auctionBidsRows = bidRows.map((b) => ({
      "Bid ID": b.id,
      "Session ID": b.sessionId,
      "Nominator Team ID": b.nominatorTeamId,
      "FPL Element ID": b.fplElementId,
      "Player Name": b.playerName,
      "Current High Bid": b.currentHighBid,
      "Current High Bidder ID": b.currentHighBidderId,
      "Min Bid": b.minBid,
      Status: b.status,
      "Expires At": b.expiresAt.toISOString(),
      "Created At": b.createdAt.toISOString(),
      "Updated At": b.updatedAt.toISOString(),
    }));

    auctionBidLogsRows = bidLogRows.map((l) => ({
      "Bid Log ID": l.id,
      "Bid ID": l.bidId,
      "Team ID": l.teamId,
      Amount: l.amount,
      Type: l.type,
      "Created At": l.createdAt.toISOString(),
    }));
  }

  return {
    meta,
    format: league.format,
    teams: teamsRows,
    fixtures: fixturesRows,
    captains: captainsRows,
    chips: chipsRows,
    auctionTeamsState,
    auctionSquads,
    auctionClubs,
    gameweeks: gameweeksRows,
    auctionTrades: auctionTradesRows,
    auctionPenaltyRedemptions: auctionPenaltyRedemptionsRows,
    auctionSlotUnlocks: auctionSlotUnlocksRows,
    auctionWishlists: auctionWishlistsRows,
    auctionNotifications: auctionNotificationsRows,
    auctionSessionsHistory: auctionSessionsHistoryRows,
    auctionBids: auctionBidsRows,
    auctionBidLogs: auctionBidLogsRows,
  };
}

/**
 * Encode a stored gameweekChips row back into the cell value the import-chips
 * endpoint accepts. Mirrors the parse logic in `import-chips/route.ts:117-149`.
 *  - "W" / "D" / "C" / "SL" / "CB" / "UD" — valid chip
 *  - "WW" / "DW" / "CW" / "SLW" / "CBW" / "UDW" — wasted chip
 *  - "C:OPP" — Challenge Chip with opponent's teamLoginId
 */
function encodeChipCell(chipType: string, isValid: boolean, opponentLoginId: string | null): string {
  const validChips = new Set(["W", "D", "C", "SL", "CB", "UD"]);
  if (!validChips.has(chipType)) return "";
  // Wasted (round-trip marker — the parser treats W as 'wasted' suffix)
  if (!isValid) return `${chipType}W`;
  // Challenge Chip with opponent
  if (chipType === "C" && opponentLoginId) return `C:${opponentLoginId}`;
  return chipType;
}
