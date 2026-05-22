import { NextRequest, NextResponse } from "next/server";
import {
  db,
  leagues,
  teams,
  auctionBids,
  auctionBidLogs,
  auctionSessions,
  auctionOwnership,
  auctionClubOwnership,
  auctionScores,
  teamPenalties,
  tradeProposals,
  teamSlotUnlocks,
  auctionWishlists,
  notifications,
} from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { backups } from "@/lib/db/schema";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateId } from "@/lib/id";
import * as XLSX from "xlsx";
import JSZip from "jszip";

export const maxDuration = 60;

/**
 * POST /api/admin/[leagueId]/restore-auction
 *
 * Restores the auction-state portion of a league from a backup. Two input modes:
 *
 *   1. Body { backupId: "..." } — restore from a stored snapshot in `backups` table.
 *   2. multipart/form-data with a `file` field — restore from an uploaded .zip
 *      (the same format produced by `/api/admin/[leagueId]/backup`).
 *
 * Algorithm:
 *   1. Parse the payload — pull `auctionTeamsState`, `auctionSquads`, `auctionClubs` row arrays.
 *   2. Validate every `teamId` references an existing team in this league.
 *   3. Wipe current auction-state DB rows (mirrors the Reset Auction "initial" branch).
 *   4. Insert ownership + club rows; restore per-team purse / totalSpent / totalIncome /
 *      totalRefunds / penaltySlots.
 *   5. `auctionScores` is intentionally NOT restored — admin reprocesses GWs after restore so the
 *      scorer regenerates them from the restored ownership state. Scores are derivable; ownership
 *      is the only authoritative state we need to bring back.
 */

interface AuctionTeamStateRow {
  "Team ID": string;
  "Team Login ID": string;
  "Team Name": string;
  Purse: number;
  "Total Spent": number;
  "Total Income": number;
  "Total Refunds": number;
  "Penalty Slots": number;
  "Bonus Slots"?: number;
}
interface AuctionSquadRow {
  "Ownership ID": string;
  "Team ID": string;
  "FPL Element ID": number;
  "Player Name": string;
  "Element Type": number | null;
  "Purchase Price": number;
  "Acquired GW": number;
  "Released GW": number | null;
  Status: string;
}
interface AuctionClubRow {
  ID: string;
  "Team ID": string;
  "PL Team ID": number;
  "PL Team Name": string;
  "PL Team Short": string;
  Tier: string;
  "Purchase Price": number;
  "Acquired At": string;
}

// ── Auction event-history rows (migration 0012). Column names mirror the row keys produced by
// generate.ts so the restore step is a straight map back into DB columns. ──

interface TradeRow {
  "Trade ID": string;
  Status: string;
  "Proposer Team ID": string;
  "Target Team ID": string;
  "Offered Player IDs": string;
  "Requested Player IDs": string;
  "Cash Offered": number;
  "Veto Deadline": string | null;
  "Veto Votes": string;
  "Created At": string;
  "Updated At": string;
}
interface PenaltyRedemptionRow {
  "Penalty ID": string;
  "Team ID": string;
  "Session ID": string | null;
  "Incurred Cycle": number;
  "Redeemed At": string;
  "Redemption Price": number;
  "Created At": string;
}
interface SlotUnlockRow {
  "Unlock ID": string;
  "Team ID": string;
  "Slot Number": number;
  Cost: number;
  "Unlocked At": string;
}
interface WishlistRow {
  "Wishlist ID": string;
  "Team ID": string;
  "FPL Element ID": number;
  "Player Name": string;
  Priority: number;
  "Created At": string;
}
interface NotificationRow {
  "Notification ID": string;
  "Team ID": string;
  Type: string;
  Title: string;
  Body: string;
  Link: string | null;
  "Read At": string | null;
  "Created At": string;
}
interface AuctionSessionRow {
  "Session ID": string;
  Type: string;
  Status: string;
  "Cycle Number": number;
  "Snake Order": string;
  "Current Nominator Index": number;
  "Nomination Deadline": string | null;
  "Scheduled At": string | null;
  "Bid Timer Seconds": number;
  "Nomination Timeout Seconds": number;
  "Created At": string;
}
interface AuctionBidRow {
  "Bid ID": string;
  "Session ID": string;
  "Nominator Team ID": string;
  "FPL Element ID": number;
  "Player Name": string;
  "Current High Bid": number;
  "Current High Bidder ID": string;
  "Min Bid": number;
  Status: string;
  "Expires At": string;
  "Created At": string;
  "Updated At": string;
}
interface AuctionBidLogRow {
  "Bid Log ID": string;
  "Bid ID": string;
  "Team ID": string;
  Amount: number;
  Type: string;
  "Created At": string;
}

interface ParsedPayload {
  teamsState: AuctionTeamStateRow[];
  squads: AuctionSquadRow[];
  clubs: AuctionClubRow[];
  // Event-history (migration 0012). Empty arrays for pre-PR backups — every restore loop is a no-op.
  trades: TradeRow[];
  penaltyRedemptions: PenaltyRedemptionRow[];
  slotUnlocks: SlotUnlockRow[];
  wishlists: WishlistRow[];
  notifications: NotificationRow[];
  sessions: AuctionSessionRow[];
  bids: AuctionBidRow[];
  bidLogs: AuctionBidLogRow[];
}

// Identity payload extracted from meta.json inside the .zip. Cross-league + cross-format restore
// is rejected before any destructive operation. Returns null when the .zip has no meta.json (pre-PR
// backups) — caller decides whether to allow.
interface ZipMeta {
  leagueId?: string;
  leagueSlug?: string;
  leagueName?: string;
  format?: string;
  season?: string;
  generatedAt?: string;
  backupVersion?: number;
}

function parseSheetFromBuffer<T>(buf: ArrayBuffer): T[] {
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<T>(sheet);
}

async function parseFromZip(file: Blob): Promise<{ payload: ParsedPayload; meta: ZipMeta | null }> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const grab = async <T>(name: string): Promise<T[]> => {
    const entry = zip.file(name);
    if (!entry) return [];
    const ab = await entry.async("arraybuffer");
    return parseSheetFromBuffer<T>(ab);
  };
  let meta: ZipMeta | null = null;
  const metaFile = zip.file("meta.json");
  if (metaFile) {
    try {
      meta = JSON.parse(await metaFile.async("string")) as ZipMeta;
    } catch {
      // Malformed meta.json — treat as missing so the caller surfaces the friendly error.
      meta = null;
    }
  }
  return {
    payload: {
      teamsState: await grab<AuctionTeamStateRow>("auction_teams_state.xlsx"),
      squads: await grab<AuctionSquadRow>("auction_squads.xlsx"),
      clubs: await grab<AuctionClubRow>("auction_clubs.xlsx"),
      // Event-history sheets — empty when the .zip predates migration 0012.
      trades: await grab<TradeRow>("auction_trades.xlsx"),
      penaltyRedemptions: await grab<PenaltyRedemptionRow>("auction_penalty_redemptions.xlsx"),
      slotUnlocks: await grab<SlotUnlockRow>("auction_slot_unlocks.xlsx"),
      wishlists: await grab<WishlistRow>("auction_wishlists.xlsx"),
      notifications: await grab<NotificationRow>("auction_notifications.xlsx"),
      sessions: await grab<AuctionSessionRow>("auction_sessions.xlsx"),
      bids: await grab<AuctionBidRow>("auction_bids.xlsx"),
      bidLogs: await grab<AuctionBidLogRow>("auction_bid_logs.xlsx"),
    },
    meta,
  };
}

async function parseFromStoredBackup(backupId: string, leagueId: string): Promise<ParsedPayload | { error: string }> {
  const [row] = await db
    .select()
    .from(backups)
    .where(and(eq(backups.id, backupId), eq(backups.leagueId, leagueId)))
    .limit(1);
  if (!row) return { error: "Backup not found" };
  return {
    teamsState: row.auctionTeamsStateJson ? JSON.parse(row.auctionTeamsStateJson) : [],
    squads: row.auctionSquadsJson ? JSON.parse(row.auctionSquadsJson) : [],
    clubs: row.auctionClubsJson ? JSON.parse(row.auctionClubsJson) : [],
    // Migration 0012 — null for pre-PR rows.
    trades: row.tradesJson ? JSON.parse(row.tradesJson) : [],
    penaltyRedemptions: row.penaltyRedemptionsJson ? JSON.parse(row.penaltyRedemptionsJson) : [],
    slotUnlocks: row.slotUnlocksJson ? JSON.parse(row.slotUnlocksJson) : [],
    wishlists: row.wishlistsJson ? JSON.parse(row.wishlistsJson) : [],
    notifications: row.notificationsJson ? JSON.parse(row.notificationsJson) : [],
    sessions: row.auctionSessionsJson ? JSON.parse(row.auctionSessionsJson) : [],
    bids: row.auctionBidsJson ? JSON.parse(row.auctionBidsJson) : [],
    bidLogs: row.auctionBidLogsJson ? JSON.parse(row.auctionBidLogsJson) : [],
  };
}

export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [league] = await db
    .select({ id: leagues.id, format: leagues.format, initialBudget: leagues.initialBudget })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) return NextResponse.json({ error: "League not found" }, { status: 404 });
  if (league.format !== "auction") {
    return NextResponse.json({ error: "Restore is auction-format only" }, { status: 400 });
  }

  // ── Parse input ──
  const contentType = request.headers.get("content-type") ?? "";
  let payload: ParsedPayload;
  try {
    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: "Missing 'file' field in multipart body" }, { status: 400 });
      }
      const parsed = await parseFromZip(file);
      // Cross-league + format guard. Reject before any destructive operation. Saved-snapshot path
      // already enforces leagueId via the SELECT's WHERE clause.
      if (!parsed.meta) {
        return NextResponse.json(
          { error: "Backup zip is missing meta.json — please re-export from this league via Download Backup." },
          { status: 400 }
        );
      }
      if (parsed.meta.leagueId && parsed.meta.leagueId !== leagueId) {
        return NextResponse.json(
          { error: `League mismatch — this backup was taken from a different league (${parsed.meta.leagueSlug ?? parsed.meta.leagueId}). Restore aborted before any change.` },
          { status: 400 }
        );
      }
      if (parsed.meta.format && parsed.meta.format !== "auction") {
        return NextResponse.json(
          { error: `Format mismatch — this backup is for a ${parsed.meta.format} league but the target is auction.` },
          { status: 400 }
        );
      }
      payload = parsed.payload;
    } else {
      const body = await request.json();
      const backupId = typeof body?.backupId === "string" ? body.backupId : null;
      if (!backupId) {
        return NextResponse.json({ error: "Provide either a multipart `file` upload or JSON `{ backupId }`" }, { status: 400 });
      }
      const parsed = await parseFromStoredBackup(backupId, leagueId);
      if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 404 });
      payload = parsed;
    }
  } catch (err) {
    console.error("[restore-auction] parse failed:", err);
    return NextResponse.json(
      { error: "Failed to parse backup", message: err instanceof Error ? err.message : "unknown" },
      { status: 400 }
    );
  }

  // ── Validate against current league teams ──
  const leagueTeams = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  const validTeamIds = new Set(leagueTeams.map((t) => t.id));

  const refTeamIds = new Set<string>([
    ...payload.teamsState.map((r) => r["Team ID"]),
    ...payload.squads.map((r) => r["Team ID"]),
    ...payload.clubs.map((r) => r["Team ID"]),
    // Event-history rows
    ...payload.trades.flatMap((r) => [r["Proposer Team ID"], r["Target Team ID"]]),
    ...payload.penaltyRedemptions.map((r) => r["Team ID"]),
    ...payload.slotUnlocks.map((r) => r["Team ID"]),
    ...payload.wishlists.map((r) => r["Team ID"]),
    ...payload.notifications.map((r) => r["Team ID"]),
    ...payload.bids.flatMap((r) => [r["Nominator Team ID"], r["Current High Bidder ID"]]),
    ...payload.bidLogs.map((r) => r["Team ID"]),
  ]);
  const orphan = [...refTeamIds].filter((id) => id && !validTeamIds.has(id));
  if (orphan.length > 0) {
    return NextResponse.json(
      { error: `Backup references team IDs that don't exist in this league: ${orphan.slice(0, 3).join(", ")}${orphan.length > 3 ? ` (+${orphan.length - 3} more)` : ""}` },
      { status: 400 }
    );
  }

  // ── Wipe current auction state (mirrors Reset Auction "initial") ──
  try {
    const allBids = await db
      .select({ id: auctionBids.id })
      .from(auctionBids)
      .where(eq(auctionBids.leagueId, leagueId));
    if (allBids.length > 0) {
      await db.delete(auctionBidLogs).where(inArray(auctionBidLogs.bidId, allBids.map((b) => b.id)));
    }
    await db.delete(auctionBids).where(eq(auctionBids.leagueId, leagueId));
    await db.delete(auctionSessions).where(eq(auctionSessions.leagueId, leagueId));
    await db.delete(auctionOwnership).where(eq(auctionOwnership.leagueId, leagueId));
    await db.delete(auctionClubOwnership).where(eq(auctionClubOwnership.leagueId, leagueId));
    await db.delete(teamPenalties).where(eq(teamPenalties.leagueId, leagueId));
    await db.delete(auctionScores).where(eq(auctionScores.leagueId, leagueId));
    await db.delete(tradeProposals).where(eq(tradeProposals.leagueId, leagueId));
    // Event-history audit tables (migration 0012) — wipe so the restore is a clean overwrite.
    await db.delete(teamSlotUnlocks).where(eq(teamSlotUnlocks.leagueId, leagueId));
    await db.delete(auctionWishlists).where(eq(auctionWishlists.leagueId, leagueId));
    await db.delete(notifications).where(eq(notifications.leagueId, leagueId));

    // Reset per-team economy to defaults; the per-team state below will overwrite any team that
    // exists in the backup.
    await db
      .update(teams)
      .set({
        totalSpent: 0,
        totalRefunds: 0,
        totalIncome: 0,
        penaltySlots: 0,
        purse: league.initialBudget,
      })
      .where(eq(teams.leagueId, leagueId));

    // ── Insert ownership + clubs ──
    if (payload.squads.length > 0) {
      const now = new Date();
      await db.insert(auctionOwnership).values(payload.squads.map((s) => ({
        id: s["Ownership ID"] ?? generateId(),
        leagueId,
        teamId: s["Team ID"],
        fplElementId: Number(s["FPL Element ID"]),
        playerName: s["Player Name"],
        elementType: s["Element Type"] != null ? Number(s["Element Type"]) : null,
        purchasePrice: Number(s["Purchase Price"]),
        acquiredGw: Number(s["Acquired GW"]),
        releasedGw: s["Released GW"] != null ? Number(s["Released GW"]) : null,
        status: s.Status ?? "active",
        createdAt: now,
        updatedAt: now,
      })));
    }

    if (payload.clubs.length > 0) {
      const now = new Date();
      await db.insert(auctionClubOwnership).values(payload.clubs.map((c) => ({
        id: c.ID ?? generateId(),
        leagueId,
        teamId: c["Team ID"],
        plTeamId: Number(c["PL Team ID"]),
        plTeamName: c["PL Team Name"],
        plTeamShort: c["PL Team Short"],
        tier: c.Tier,
        purchasePrice: Number(c["Purchase Price"]),
        acquiredAt: c["Acquired At"] ? new Date(c["Acquired At"]) : now,
        createdAt: now,
      })));
    }

    // ── Restore per-team economy ──
    for (const t of payload.teamsState) {
      await db
        .update(teams)
        .set({
          purse: Number(t.Purse),
          totalSpent: Number(t["Total Spent"]),
          totalIncome: Number(t["Total Income"]),
          totalRefunds: Number(t["Total Refunds"]),
          penaltySlots: Number(t["Penalty Slots"]),
          // Bonus Slots may be absent in older backups taken before the column existed — default 0.
          bonusSlots: Number(t["Bonus Slots"] ?? 0),
          updatedAt: new Date(),
        })
        .where(and(eq(teams.id, t["Team ID"]), eq(teams.leagueId, leagueId)));
    }

    // ── Event-history restore (migration 0012). Strict FK-ordered. ──
    // 1. Sessions first — FK targets for bids + penaltyRedemptions.
    if (payload.sessions.length > 0) {
      await db.insert(auctionSessions).values(payload.sessions.map((s) => ({
        id: s["Session ID"],
        leagueId,
        type: s.Type,
        cycleNumber: Number(s["Cycle Number"]),
        status: s.Status,
        snakeOrder: s["Snake Order"] ?? "[]",
        currentNominatorIndex: Number(s["Current Nominator Index"] ?? 0),
        nominationDeadline: s["Nomination Deadline"] ? new Date(s["Nomination Deadline"]) : null,
        scheduledAt: s["Scheduled At"] ? new Date(s["Scheduled At"]) : null,
        bidTimerSeconds: Number(s["Bid Timer Seconds"] ?? 20),
        nominationTimeoutSeconds: Number(s["Nomination Timeout Seconds"] ?? 60),
        createdAt: new Date(s["Created At"]),
      })));
    }

    // 2. Bids — filter to bids whose sessionId is in the restored set; orphans are dropped.
    const restoredSessionIds = new Set(payload.sessions.map((s) => s["Session ID"]));
    const validBids = payload.bids.filter((b) => restoredSessionIds.has(b["Session ID"]));
    if (validBids.length > 0) {
      await db.insert(auctionBids).values(validBids.map((b) => ({
        id: b["Bid ID"],
        leagueId,
        sessionId: b["Session ID"],
        nominatorTeamId: b["Nominator Team ID"],
        fplElementId: Number(b["FPL Element ID"]),
        playerName: b["Player Name"],
        currentHighBid: Number(b["Current High Bid"]),
        currentHighBidderId: b["Current High Bidder ID"],
        minBid: Number(b["Min Bid"]),
        status: b.Status,
        expiresAt: new Date(b["Expires At"]),
        createdAt: new Date(b["Created At"]),
        updatedAt: new Date(b["Updated At"]),
      })));
    }

    // 3. Bid logs — filter to logs whose bidId was restored.
    const restoredBidIds = new Set(validBids.map((b) => b["Bid ID"]));
    const validBidLogs = payload.bidLogs.filter((l) => restoredBidIds.has(l["Bid ID"]));
    if (validBidLogs.length > 0) {
      await db.insert(auctionBidLogs).values(validBidLogs.map((l) => ({
        id: l["Bid Log ID"],
        bidId: l["Bid ID"],
        teamId: l["Team ID"],
        amount: Number(l.Amount),
        type: l.Type,
        createdAt: new Date(l["Created At"]),
      })));
    }

    // 4. Penalty redemptions — sessionId is best-effort; set to null if the session wasn't restored
    //    (the schema has onDelete: "set null" on this FK so this is the intended fallback).
    if (payload.penaltyRedemptions.length > 0) {
      await db.insert(teamPenalties).values(payload.penaltyRedemptions.map((p) => ({
        id: p["Penalty ID"],
        leagueId,
        teamId: p["Team ID"],
        sessionId: p["Session ID"] && restoredSessionIds.has(p["Session ID"]) ? p["Session ID"] : null,
        incurredCycle: Number(p["Incurred Cycle"]),
        redeemedAt: new Date(p["Redeemed At"]),
        redemptionPrice: Number(p["Redemption Price"]),
        createdAt: new Date(p["Created At"]),
      })));
    }

    // 5. Slot unlocks — no FK to sessions.
    if (payload.slotUnlocks.length > 0) {
      await db.insert(teamSlotUnlocks).values(payload.slotUnlocks.map((u) => ({
        id: u["Unlock ID"],
        leagueId,
        teamId: u["Team ID"],
        slotNumber: Number(u["Slot Number"]),
        cost: Number(u.Cost),
        unlockedAt: new Date(u["Unlocked At"]),
      })));
    }

    // 6. Trades — JSON-array player ID references aren't FK-validated by SQLite; insert all.
    if (payload.trades.length > 0) {
      await db.insert(tradeProposals).values(payload.trades.map((t) => ({
        id: t["Trade ID"],
        leagueId,
        proposerTeamId: t["Proposer Team ID"],
        targetTeamId: t["Target Team ID"],
        offeredPlayerIds: t["Offered Player IDs"] ?? "[]",
        requestedPlayerIds: t["Requested Player IDs"] ?? "[]",
        cashOffered: Number(t["Cash Offered"] ?? 0),
        status: t.Status,
        vetoDeadline: t["Veto Deadline"] ? new Date(t["Veto Deadline"]) : null,
        vetoVotes: t["Veto Votes"] ?? "{}",
        createdAt: new Date(t["Created At"]),
        updatedAt: new Date(t["Updated At"]),
      })));
    }

    // 7. Wishlists.
    if (payload.wishlists.length > 0) {
      await db.insert(auctionWishlists).values(payload.wishlists.map((w) => ({
        id: w["Wishlist ID"],
        leagueId,
        teamId: w["Team ID"],
        fplElementId: Number(w["FPL Element ID"]),
        playerName: w["Player Name"],
        priority: Number(w.Priority),
        createdAt: new Date(w["Created At"]),
      })));
    }

    // 8. Notifications.
    if (payload.notifications.length > 0) {
      await db.insert(notifications).values(payload.notifications.map((n) => ({
        id: n["Notification ID"],
        teamId: n["Team ID"],
        leagueId,
        type: n.Type,
        title: n.Title,
        body: n.Body,
        link: n.Link,
        readAt: n["Read At"] ? new Date(n["Read At"]) : null,
        createdAt: new Date(n["Created At"]),
      })));
    }
  } catch (err) {
    console.error("[restore-auction] restore failed:", err);
    return NextResponse.json(
      { error: "Restore failed mid-write — league state may be partially modified", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    restored: {
      squads: payload.squads.length,
      clubs: payload.clubs.length,
      teamsState: payload.teamsState.length,
      sessions: payload.sessions.length,
      bids: payload.bids.length,
      bidLogs: payload.bidLogs.length,
      penaltyRedemptions: payload.penaltyRedemptions.length,
      slotUnlocks: payload.slotUnlocks.length,
      trades: payload.trades.length,
      wishlists: payload.wishlists.length,
      notifications: payload.notifications.length,
    },
    next: "Admin should reprocess each GW to regenerate auction scores from the restored ownership state.",
  });
}
