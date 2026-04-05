import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups, leagues } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

// Safely convert any value to a trimmed string (handles numbers from Excel)
function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * POST /api/admin/[leagueId]/bulk-upload-teams
 * Supports two modes via the `mode` field in the request body:
 *
 * mode: "full" (default) — 9 columns, creates teams fully formed with players.
 *   isProfileComplete = true. No setup wizard needed.
 *   Columns: Team ID, Team Name, Abbreviation, Password, Group, Player1 Name, Player1 FPL ID, Player2 Name, Player2 FPL ID
 *
 * mode: "credentials" — 2 columns, creates teams with credentials only.
 *   isProfileComplete = false. Team completes their profile via setup wizard on first login.
 *   Columns: Team ID, Password
 *   Note: Group is not specified; teams auto-assigned to group "A", admin can reassign via group assignment UI.
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { teams: teamRows, mode = "full" } = body as {
      teams: Record<string, string | number>[];
      mode?: "full" | "credentials";
    };

    if (!teamRows || !Array.isArray(teamRows) || teamRows.length === 0) {
      return NextResponse.json({ error: "No teams data provided" }, { status: 400 });
    }

    if (teamRows.length > 500) {
      return NextResponse.json({ error: "Too many rows. Maximum 500 teams per upload." }, { status: 400 });
    }

    if (mode !== "full" && mode !== "credentials") {
      return NextResponse.json({ error: 'mode must be "full" or "credentials"' }, { status: 400 });
    }

    const uploadResults: { success: string[]; errors: string[] } = { success: [], errors: [] };

    // Fetch league config
    const leagueRecord = await db
      .select({ groupCount: leagues.groupCount, format: leagues.format })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    if (!leagueRecord.length) return NextResponse.json({ error: "League not found" }, { status: 404 });
    const { groupCount, format: leagueFormat } = leagueRecord[0];

    // Only create PL groups for TVT 2-group (32-team) format
    // Triple Crown uses cup groups (created separately), and single-group TVT doesn't require explicit groups
    if (leagueFormat !== "triple-crown" && (groupCount ?? 2) === 2) {
      const groupNames = ["A", "B"];
      for (const groupName of groupNames) {
        const existingGroup = await db.select().from(groups).where(
          and(eq(groups.name, groupName), eq(groups.leagueId, leagueId))
        );
        if (existingGroup.length === 0) {
          await db.insert(groups).values({ id: generateId(), name: groupName, leagueId });
        }
      }
    }

    // Process each team row
    for (let i = 0; i < teamRows.length; i++) {
      const row = teamRows[i];
      const rowNum = i + 2; // Excel row number (1-indexed + header)

      try {
        const teamLoginId = toStr(row.teamLoginId);
        const password = toStr(row.password);
        const group = toStr(row.group);

        if (!teamLoginId || !password) {
          uploadResults.errors.push(`Row ${rowNum}: Missing required fields`);
          continue;
        }

        // Validate teamLoginId format (alphanumeric, underscore, hyphen; 3-30 chars)
        if (!/^[A-Za-z0-9_-]{3,30}$/.test(teamLoginId)) {
          uploadResults.errors.push(`Row ${rowNum}: Team ID must be 3–30 alphanumeric/underscore/hyphen characters`);
          continue;
        }

        // Global uniqueness check on teamLoginId
        const existingLoginId = await db.select().from(teams).where(
          eq(teams.teamLoginId, teamLoginId)
        );
        if (existingLoginId.length > 0) {
          uploadResults.errors.push(`Row ${rowNum}: Team ID "${teamLoginId}" already exists globally`);
          continue;
        }

        // ---- MODE: CREDENTIALS ONLY ----
        if (mode === "credentials") {
          // No group assigned in credentials mode (admin assigns via group assignment UI later)
          const hashedPassword = await bcrypt.hash(password, 10);
          await db.insert(teams).values({
            id: generateId(),
            teamLoginId,
            name: teamLoginId, // Use login ID as placeholder name (team sets display name during setup)
            abbreviation: "", // Will be set during setup
            password: hashedPassword,
            groupId: null, // No group assigned in credentials mode
            mustChangePassword: true,
            isProfileComplete: false,
            leagueId,
          });
          uploadResults.success.push(`Row ${rowNum}: "${teamLoginId}" created (awaiting setup wizard)`);
          continue;
        }

        // ---- MODE: FULL SETUP ----
        const teamName = toStr(row.teamName);
        const abbreviation = toStr(row.abbreviation);
        const player1Name = toStr(row.player1Name);
        const player1FplId = toStr(row.player1FplId);
        const player2Name = toStr(row.player2Name);
        const player2FplId = toStr(row.player2FplId);

        if (!teamName || !abbreviation || !player1Name || !player1FplId || !player2Name || !player2FplId) {
          uploadResults.errors.push(`Row ${rowNum}: Missing required fields (team name, abbreviation, player names, FPL IDs)`);
          continue;
        }

        // Per-league uniqueness check on display name (teamName) - case-insensitive
        const existingTeamFull = await db.select().from(teams).where(
          and(sql`LOWER(REPLACE(${teams.name}, ' ', '')) = LOWER(REPLACE(${teamName}, ' ', ''))`, eq(teams.leagueId, leagueId))
        );
        if (existingTeamFull.length > 0) {
          uploadResults.errors.push(`Row ${rowNum}: Team name "${teamName}" already exists in this league`);
          continue;
        }

        // Resolve group (optional; null if not provided)
        let groupIdFull: string | null = null;
        if (group) {
          const groupNameResolved = group.toUpperCase();
          if (groupNameResolved !== "A" && groupNameResolved !== "B") {
            uploadResults.errors.push(`Row ${rowNum}: Group must be A or B`);
            continue;
          }

          const groupRecordsFull = await db.select().from(groups).where(
            and(eq(groups.name, groupNameResolved), eq(groups.leagueId, leagueId))
          );
          const groupRecordFull = groupRecordsFull[0];
          groupIdFull = groupRecordFull ? groupRecordFull.id : null;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const teamId = generateId();

        await db.insert(teams).values({
          id: teamId,
          teamLoginId,
          name: teamName,
          abbreviation: abbreviation.toUpperCase(),
          password: hashedPassword,
          groupId: groupIdFull,
          mustChangePassword: true,
          isProfileComplete: true,
          leagueId,
        });

        await db.insert(players).values([
          { id: generateId(), name: player1Name, fplId: player1FplId, teamId },
          { id: generateId(), name: player2Name, fplId: player2FplId, teamId },
        ]);

        uploadResults.success.push(`Row ${rowNum}: "${teamLoginId}" (${teamName}) created successfully`);
      } catch (error) {
        console.error(`Error processing row ${rowNum}:`, error);
        uploadResults.errors.push(`Row ${rowNum}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    await invalidateLeaguePageCache(leagueId);
    return NextResponse.json({
      message: `Processed ${teamRows.length} rows`,
      created: uploadResults.success.length,
      failed: uploadResults.errors.length,
      details: uploadResults,
    });
  } catch (error) {
    console.error("Bulk upload teams error:", error);
    return NextResponse.json({ error: "Failed to process bulk upload" }, { status: 500 });
  }
}

/**
 * GET /api/admin/[leagueId]/bulk-upload-teams
 * Returns template info for both upload modes
 */
export async function GET(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  return NextResponse.json({
    full: {
      columns: ["Team ID", "Team Name", "Abbreviation", "Password", "Group", "Player1 Name", "Player1 FPL ID", "Player2 Name", "Player2 FPL ID"],
      example: ["team_001", "DM — Rahul", "DM", "team123", "A", "Rahul Kumar", "1234567", "Amit Singh", "7654321"],
      csvHeader: "Team ID,Team Name,Abbreviation,Password,Group,Player1 Name,Player1 FPL ID,Player2 Name,Player2 FPL ID",
      note: "Teams are created fully formed. isProfileComplete = true. No setup wizard needed.",
    },
    credentials: {
      columns: ["Team ID", "Password"],
      example: ["team_001", "BAB@1234"],
      csvHeader: "Team ID,Password",
      note: "Teams log in and complete their own profile (login ID, display name, abbreviation, players) via setup wizard. Auto-assigned to Group A.",
    },
  });
}
