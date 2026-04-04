import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";
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
 * mode: "full" (default) — 8 columns, creates teams fully formed with players.
 *   isProfileComplete = true. No setup wizard needed.
 *   Columns: teamName, abbreviation, password, group, player1Name, player1FplId, player2Name, player2FplId
 *
 * mode: "credentials" — 3 columns, creates teams with credentials only.
 *   isProfileComplete = false. Team completes their profile via setup wizard on first login.
 *   Columns: teamName, password, group
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
      .select({ groupCount: leagues.groupCount })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    if (!leagueRecord.length) return NextResponse.json({ error: "League not found" }, { status: 404 });
    const { groupCount } = leagueRecord[0];

    // Ensure groups exist for this league
    const groupNames = groupCount === 1 ? ["A"] : ["A", "B"];
    for (const groupName of groupNames) {
      const existingGroup = await db.select().from(groups).where(
        and(eq(groups.name, groupName), eq(groups.leagueId, leagueId))
      );
      if (existingGroup.length === 0) {
        await db.insert(groups).values({ id: generateId(), name: groupName, leagueId });
      }
    }

    // Process each team row
    for (let i = 0; i < teamRows.length; i++) {
      const row = teamRows[i];
      const rowNum = i + 2; // Excel row number (1-indexed + header)

      try {
        const teamName = toStr(row.teamName);
        const password = toStr(row.password);
        const group = toStr(row.group);

        if (!teamName || !password || (groupCount !== 1 && !group)) {
          uploadResults.errors.push(`Row ${rowNum}: Missing required fields`);
          continue;
        }

        // Resolve group
        let groupName: string;
        if (groupCount === 1) {
          groupName = "A";
        } else {
          groupName = group.toUpperCase();
          if (groupName !== "A" && groupName !== "B") {
            uploadResults.errors.push(`Row ${rowNum}: Group must be A or B`);
            continue;
          }
        }

        // Duplicate check within this league
        const existingTeam = await db.select().from(teams).where(
          and(eq(teams.name, teamName), eq(teams.leagueId, leagueId))
        );
        if (existingTeam.length > 0) {
          uploadResults.errors.push(`Row ${rowNum}: Team "${teamName}" already exists`);
          continue;
        }

        // Fetch group record
        const groupRecords = await db.select().from(groups).where(
          and(eq(groups.name, groupName), eq(groups.leagueId, leagueId))
        );
        const groupRecord = groupRecords[0];

        // ---- MODE: CREDENTIALS ONLY ----
        if (mode === "credentials") {
          const abbreviation = teamName
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(0, 4)
            .toUpperCase();
          if (!abbreviation) {
            uploadResults.errors.push(`Row ${rowNum}: Team name must contain at least one alphanumeric character`);
            continue;
          }

          const hashedPassword = await bcrypt.hash(password, 10);
          await db.insert(teams).values({
            id: generateId(),
            name: teamName,
            abbreviation,
            password: hashedPassword,
            groupId: groupRecord.id,
            mustChangePassword: true,
            isProfileComplete: false,
            leagueId,
          });
          uploadResults.success.push(`Row ${rowNum}: "${teamName}" created (awaiting profile setup)`);
          continue;
        }

        // ---- MODE: FULL SETUP ----
        const abbreviation = toStr(row.abbreviation);
        const player1Name = toStr(row.player1Name);
        const player1FplId = toStr(row.player1FplId);
        const player2Name = toStr(row.player2Name);
        const player2FplId = toStr(row.player2FplId);

        if (!abbreviation || !player1Name || !player1FplId || !player2Name || !player2FplId) {
          uploadResults.errors.push(`Row ${rowNum}: Missing required fields (abbreviation, player names, FPL IDs)`);
          continue;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const teamId = generateId();

        await db.insert(teams).values({
          id: teamId,
          name: teamName,
          abbreviation: abbreviation.toUpperCase(),
          password: hashedPassword,
          groupId: groupRecord.id,
          mustChangePassword: true,
          isProfileComplete: true,
          leagueId,
        });

        await db.insert(players).values([
          { id: generateId(), name: player1Name, fplId: player1FplId, teamId },
          { id: generateId(), name: player2Name, fplId: player2FplId, teamId },
        ]);

        uploadResults.success.push(`Row ${rowNum}: "${teamName}" created successfully`);
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
      columns: ["Team Name", "Abbreviation", "Password", "Group", "Player1 Name", "Player1 FPL ID", "Player2 Name", "Player2 FPL ID"],
      example: ["DM — Rahul", "DM", "team123", "A", "Rahul Kumar", "1234567", "Amit Singh", "7654321"],
      csvHeader: "Team Name,Abbreviation,Password,Group,Player1 Name,Player1 FPL ID,Player2 Name,Player2 FPL ID",
      note: "Teams are created fully formed. isProfileComplete = true. No setup wizard needed.",
    },
    credentials: {
      columns: ["Team Name", "Password", "Group"],
      example: ["TVT-League 1-Team1", "BAB@1234", "A"],
      csvHeader: "Team Name,Password,Group",
      note: "Teams log in and complete their own profile (name, abbreviation, players) via setup wizard.",
    },
  });
}
