// Shared restore logic for non-auction formats (TVT + triple-crown).
//
// Scope this session: parses a backup .zip / saved-snapshot payload and restores **fixtures**.
// Teams are preserved (no wipe — same semantics as auction restore). Captains and chips restore
// is a tracked follow-up; admins continue to use the legacy per-file upload blocks for those.
//
// Cross-league + format guards live in the per-format API route, not here.

import * as XLSX from "xlsx";
import JSZip from "jszip";
import { db, teams, gameweeks, fixtures, leagues, playoffTies, challengerSurvivalEntries } from "@/lib/db";
import { eq, inArray, and } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { backups } from "@/lib/db/schema";

export interface BackupMeta {
  leagueId?: string;
  leagueSlug?: string;
  leagueName?: string;
  format?: string;
  season?: string;
  generatedAt?: string;
  backupVersion?: number;
}

export interface FixtureRow {
  Gameweek: number;
  "Home Team": string;  // teamLoginId
  "Away Team": string;  // teamLoginId
}

export interface RestorePayload {
  meta: BackupMeta | null;
  fixtures: FixtureRow[];
  // Captain + Chip arrays preserved as raw rows so a future PR can use them. Not applied today.
  rawCaptains: Record<string, unknown>[];
  rawChips: Record<string, unknown>[];
}

function parseSheetFromBuffer<T>(buf: ArrayBuffer): T[] {
  const wb = XLSX.read(buf, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<T>(sheet);
}

export async function parseRestoreZip(file: Blob): Promise<RestorePayload> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  let meta: BackupMeta | null = null;
  const metaFile = zip.file("meta.json");
  if (metaFile) {
    try {
      meta = JSON.parse(await metaFile.async("string")) as BackupMeta;
    } catch {
      meta = null;
    }
  }

  const grab = async <T>(name: string): Promise<T[]> => {
    const entry = zip.file(name);
    if (!entry) return [];
    return parseSheetFromBuffer<T>(await entry.async("arraybuffer"));
  };

  return {
    meta,
    fixtures: await grab<FixtureRow>("fixtures.xlsx"),
    rawCaptains: await grab<Record<string, unknown>>("captains.xlsx"),
    rawChips: await grab<Record<string, unknown>>("chips.xlsx"),
  };
}

/**
 * Load a saved snapshot row from the `backups` table. Filters by both id AND leagueId so a
 * cross-league restore via backupId is impossible (the SELECT returns nothing).
 */
export async function loadRestoreSnapshot(backupId: string, leagueId: string): Promise<RestorePayload | { error: string }> {
  const [row] = await db
    .select()
    .from(backups)
    .where(and(eq(backups.id, backupId), eq(backups.leagueId, leagueId)))
    .limit(1);
  if (!row) return { error: "Snapshot not found for this league" };

  const fixturesJson = row.fixturesJson ? JSON.parse(row.fixturesJson) : [];
  return {
    // The backups row has `leagueId` but not `format` — the saved-snapshot SELECT already filters
    // by both id AND leagueId so cross-league restore via backupId can't reach this code path.
    meta: { leagueId: row.leagueId },
    fixtures: fixturesJson,
    rawCaptains: row.captainsJson ? JSON.parse(row.captainsJson) : [],
    rawChips: row.chipsJson ? JSON.parse(row.chipsJson) : [],
  };
}

/**
 * Restore the fixture set for a league from a parsed payload. Wipes existing fixtures (cascades
 * to results) and re-inserts. Teams stay untouched. Captains + chips are left to a follow-up PR.
 */
export async function restoreFixtures(leagueId: string, payload: RestorePayload): Promise<{ inserted: number; warnings: string[] }> {
  const warnings: string[] = [];

  // League config
  const [league] = await db
    .select({ playoffStartGw: leagues.playoffStartGw })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) throw new Error("League not found");

  // Look up teams in this league by login ID (case-insensitive) — backups store login IDs.
  const allTeams = await db
    .select({ id: teams.id, teamLoginId: teams.teamLoginId, groupId: teams.groupId })
    .from(teams)
    .where(eq(teams.leagueId, leagueId));
  const teamByLoginId = new Map(allTeams.map((t) => [(t.teamLoginId ?? "").toLowerCase(), t]));

  // All gameweeks in this league.
  const allGameweeks = await db
    .select({ id: gameweeks.id, number: gameweeks.number })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId));
  const gwIdByNumber = new Map(allGameweeks.map((g) => [g.number, g.id]));

  // Wipe existing fixtures. ON DELETE CASCADE on `results.fixture_id` clears results automatically.
  const leagueGwIds = allGameweeks.map((g) => g.id);
  if (leagueGwIds.length > 0) {
    await db.delete(fixtures).where(inArray(fixtures.gameweekId, leagueGwIds));
    await db.delete(challengerSurvivalEntries).where(inArray(challengerSurvivalEntries.gameweekId, leagueGwIds));
  }
  await db.delete(playoffTies).where(eq(playoffTies.leagueId, leagueId));

  // Re-insert. Skip rows that can't be resolved (logged as warnings).
  let inserted = 0;
  for (let i = 0; i < payload.fixtures.length; i++) {
    const row = payload.fixtures[i];
    const rowNum = i + 2;
    const gwNumber = typeof row.Gameweek === "string" ? parseInt(row.Gameweek, 10) : row.Gameweek;
    if (!Number.isFinite(gwNumber) || gwNumber < 1 || gwNumber > 38) {
      warnings.push(`Row ${rowNum}: invalid gameweek ${row.Gameweek}`);
      continue;
    }
    const homeLogin = String(row["Home Team"] ?? "").trim().toLowerCase();
    const awayLogin = String(row["Away Team"] ?? "").trim().toLowerCase();
    const home = teamByLoginId.get(homeLogin);
    const away = teamByLoginId.get(awayLogin);
    if (!home) { warnings.push(`Row ${rowNum}: home team "${row["Home Team"]}" not found`); continue; }
    if (!away) { warnings.push(`Row ${rowNum}: away team "${row["Away Team"]}" not found`); continue; }

    let gwId = gwIdByNumber.get(gwNumber);
    if (!gwId) {
      // Create the gameweek if missing (placeholder deadline 7 days * gw from now).
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + 7 * gwNumber);
      deadline.setHours(11, 0, 0, 0);
      gwId = generateId();
      await db.insert(gameweeks).values({
        id: gwId,
        number: gwNumber,
        deadline,
        isPlayoffs: gwNumber >= league.playoffStartGw,
        leagueId,
      });
      gwIdByNumber.set(gwNumber, gwId);
    }

    await db.insert(fixtures).values({
      id: generateId(),
      gameweekId: gwId,
      homeTeamId: home.id,
      awayTeamId: away.id,
      groupId: home.groupId,
    });
    inserted++;
  }

  if (payload.rawCaptains.length > 0) {
    warnings.push(`Captains restore deferred — ${payload.rawCaptains.length} row(s) in backup. Use the Import Captain Data block to apply.`);
  }
  if (payload.rawChips.length > 0) {
    warnings.push(`Chips restore deferred — ${payload.rawChips.length} row(s) in backup. Use the Import Chip Data block to apply.`);
  }

  return { inserted, warnings };
}
