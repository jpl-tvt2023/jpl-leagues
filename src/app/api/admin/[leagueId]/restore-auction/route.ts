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

interface ParsedPayload {
  teamsState: AuctionTeamStateRow[];
  squads: AuctionSquadRow[];
  clubs: AuctionClubRow[];
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
  ]);
  const orphan = [...refTeamIds].filter((id) => !validTeamIds.has(id));
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
    },
    next: "Admin should reprocess each GW to regenerate auction scores from the restored ownership state.",
  });
}
