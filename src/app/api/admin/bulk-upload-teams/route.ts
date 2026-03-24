import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups } from "@/lib/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateId } from "@/lib/id";

// Safely convert any value to a trimmed string (handles numbers from Excel)
function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

interface TeamRow {
  teamName: string | number;
  abbreviation: string | number;
  password: string | number;
  group: string;
  player1Name: string | number;
  player1FplId: string | number;
  player2Name: string | number;
  player2FplId: string | number;
}

/**
 * POST /api/admin/bulk-upload-teams
 * Admin-only endpoint to bulk upload teams from CSV data
 */
export async function POST(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { teams: teamRows } = body as { teams: TeamRow[] };

    if (!teamRows || !Array.isArray(teamRows) || teamRows.length === 0) {
      return NextResponse.json(
        { error: "No teams data provided" },
        { status: 400 }
      );
    }

    if (teamRows.length > 500) {
      return NextResponse.json(
        { error: "Too many rows. Maximum 500 teams per upload." },
        { status: 400 }
      );
    }

    const results: { success: string[]; errors: string[] } = {
      success: [],
      errors: [],
    };

    // Ensure groups exist
    for (const groupName of ["A", "B"]) {
      const existingGroup = await db.select().from(groups).where(eq(groups.name, groupName));
      if (existingGroup.length === 0) {
        await db.insert(groups).values({ id: generateId(), name: groupName });
      }
    }

    // Process each team row
    for (let i = 0; i < teamRows.length; i++) {
      const row = teamRows[i];
      const rowNum = i + 2; // Excel row number (1-indexed + header)

      try {
        // Convert all values to strings
        const teamName = toStr(row.teamName);
        const abbreviation = toStr(row.abbreviation);
        const password = toStr(row.password);
        const group = toStr(row.group);
        const player1Name = toStr(row.player1Name);
        const player1FplId = toStr(row.player1FplId);
        const player2Name = toStr(row.player2Name);
        const player2FplId = toStr(row.player2FplId);

        // Validate required fields
        if (!teamName || !abbreviation || !password || !group ||
            !player1Name || !player1FplId || !player2Name || !player2FplId) {
          results.errors.push(`Row ${rowNum}: Missing required fields`);
          continue;
        }

        // Validate group
        const groupName = group.toUpperCase();
        if (groupName !== "A" && groupName !== "B") {
          results.errors.push(`Row ${rowNum}: Group must be A or B`);
          continue;
        }

        // Check if team name already exists
        const existingTeam = await db.select().from(teams).where(eq(teams.name, teamName));
        if (existingTeam.length > 0) {
          results.errors.push(`Row ${rowNum}: Team "${teamName}" already exists`);
          continue;
        }

        // Get group record
        const groupRecords = await db.select().from(groups).where(eq(groups.name, groupName));
        const groupRecord = groupRecords[0];

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create team
        const teamId = generateId();
        await db.insert(teams).values({
          id: teamId,
          name: teamName,
          abbreviation: abbreviation.toUpperCase(),
          password: hashedPassword,
          groupId: groupRecord.id,
          mustChangePassword: true,
        });

        // Create players
        await db.insert(players).values([
          {
            id: generateId(),
            name: player1Name,
            fplId: player1FplId,
            teamId: teamId,
          },
          {
            id: generateId(),
            name: player2Name,
            fplId: player2FplId,
            teamId: teamId,
          },
        ]);

        results.success.push(`Row ${rowNum}: Team "${teamName}" created successfully`);
      } catch (error) {
        console.error(`Error processing row ${rowNum}:`, error);
        results.errors.push(`Row ${rowNum}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    return NextResponse.json({
      message: `Processed ${teamRows.length} rows`,
      created: results.success.length,
      failed: results.errors.length,
      details: results,
    });
  } catch (error) {
    console.error("Bulk upload teams error:", error);
    return NextResponse.json(
      { error: "Failed to process bulk upload" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/bulk-upload-teams
 * Get template structure for team upload
 */
export async function GET(request: NextRequest) {
  const sessionType = request.headers.get("x-session-type");
  if (sessionType !== "admin" && sessionType !== "superadmin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  return NextResponse.json({
    template: {
      columns: [
        "Team Name",
        "Abbreviation",
        "Password",
        "Group",
        "Player1 Name",
        "Player1 FPL ID",
        "Player2 Name",
        "Player2 FPL ID",
      ],
      example: [
        "DM — Rahul",
        "DM",
        "team123",
        "A",
        "Rahul Kumar",
        "1234567",
        "Amit Singh",
        "7654321",
      ],
    },
    csvHeader: "Team Name,Abbreviation,Password,Group,Player1 Name,Player1 FPL ID,Player2 Name,Player2 FPL ID",
    csvExample: "DM — Rahul,DM,team123,A,Rahul Kumar,1234567,Amit Singh,7654321",
  });
}
