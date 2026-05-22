/**
 * Render a backup row-set into a zipped bundle of .xlsx files.
 * Shared between:
 *   - GET /api/admin/[leagueId]/backup           — current state, generated live
 *   - GET /api/admin/[leagueId]/backups/[id]     — historical snapshot from `backups` table
 */

import * as XLSX from "xlsx";
import JSZip from "jszip";
import type { BackupRows } from "./generate";

export async function buildBackupZip(rows: BackupRows): Promise<ArrayBuffer> {
  const zip = new JSZip();
  // meta.json carries the source league identity. Restore endpoints validate this against the
  // target league before doing anything destructive. Always written, regardless of format.
  zip.file("meta.json", JSON.stringify(rows.meta, null, 2));
  if (rows.teams) zip.file("teams.xlsx", buildXlsxBuffer(rows.teams, "Teams"));
  zip.file("fixtures.xlsx", buildXlsxBuffer(rows.fixtures, "Fixtures"));
  if (rows.captains) zip.file("captains.xlsx", buildXlsxBuffer(rows.captains, "Captains"));
  if (rows.chips) zip.file("chips.xlsx", buildXlsxBuffer(rows.chips, "Chips"));
  // Auction sheets — only present when the league format produced them.
  if (rows.auctionTeamsState) zip.file("auction_teams_state.xlsx", buildXlsxBuffer(rows.auctionTeamsState, "Teams State"));
  if (rows.auctionSquads) zip.file("auction_squads.xlsx", buildXlsxBuffer(rows.auctionSquads, "Squads"));
  if (rows.auctionClubs) zip.file("auction_clubs.xlsx", buildXlsxBuffer(rows.auctionClubs, "Clubs"));
  // Gameweeks shape — always emitted when the league has gameweeks; restore reads this.
  if (rows.gameweeks.length > 0) zip.file("gameweeks.xlsx", buildXlsxBuffer(rows.gameweeks, "Gameweeks"));
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

export function backupZipFilename(slug: string, stampDate: Date): string {
  return `backup-${slug}-${formatTimestamp(stampDate)}.zip`;
}

function buildXlsxBuffer(rows: Record<string, unknown>[], sheetName: string): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
