import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups, leagues } from "@/lib/db";
import { eq, and, ne, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

interface TeamRow {
  teamLoginId: string;
  teamName: string;
  abbreviation?: string; // Legacy column — accepted but ignored
  password: string;
  player1Name: string;
  player1FplId: string | number;
  player2Name: string;
  player2FplId: string | number;
  group?: string | null;
}

const LOGIN_ID_RE = /^[A-Za-z0-9_-]{3,30}$/;

/**
 * POST /api/admin/[leagueId]/bulk-upload-teams
 *
 * Recovery / dev-test tool. Wipes ALL non-ghost teams in this league
 * (cascade-deletes players, fixtures, results, chip plays, captains, etc.)
 * and replaces them with the uploaded roster.
 *
 * Not available for auction leagues — auction has its own onboarding flow.
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { teams: rows } = body as { teams: TeamRow[] };

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No team rows provided" }, { status: 400 });
    }
    if (rows.length > 200) {
      return NextResponse.json({ error: "Too many rows. Maximum 200 teams per upload." }, { status: 400 });
    }

    const [leagueRecord] = await db
      .select({ format: leagues.format })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    if (!leagueRecord) return NextResponse.json({ error: "League not found" }, { status: 404 });
    if (leagueRecord.format === "auction") {
      return NextResponse.json(
        { error: "Bulk team upload is not available for auction leagues." },
        { status: 400 }
      );
    }

    // ---- Validate every row up-front; reject the whole upload on any error ----
    const errors: string[] = [];
    const seenLoginIds = new Set<string>();
    const seenNames = new Set<string>();

    const REQUIRED_FIELDS: (keyof TeamRow)[] = [
      "teamLoginId", "teamName", "password",
      "player1Name", "player1FplId", "player2Name", "player2FplId",
    ];
    const FIELD_LABELS: Record<string, string> = {
      teamLoginId: "Team ID",
      teamName: "Team Name",
      password: "Password",
      player1Name: "Player1 Name",
      player1FplId: "Player1 FPL ID",
      player2Name: "Player2 Name",
      player2FplId: "Player2 FPL ID",
    };

    rows.forEach((r, i) => {
      const rowNum = i + 1;
      const missing = REQUIRED_FIELDS.filter(f => {
        const v = r[f];
        return v === undefined || v === null || String(v).trim() === "";
      });
      if (missing.length > 0) {
        errors.push(`Row ${rowNum}: missing ${missing.map(f => FIELD_LABELS[f]).join(", ")}`);
        return;
      }
      if (!LOGIN_ID_RE.test(r.teamLoginId)) {
        errors.push(`Row ${rowNum}: Team ID "${r.teamLoginId}" must be 3–30 chars (letters, digits, _ or -)`);
      }
      if (String(r.password).length < 4) {
        errors.push(`Row ${rowNum}: Password must be at least 4 characters`);
      }
      if (!/^\d+$/.test(String(r.player1FplId).trim())) {
        errors.push(`Row ${rowNum}: Player1 FPL ID "${r.player1FplId}" must be numeric`);
      }
      if (!/^\d+$/.test(String(r.player2FplId).trim())) {
        errors.push(`Row ${rowNum}: Player2 FPL ID "${r.player2FplId}" must be numeric`);
      }
      const loginKey = r.teamLoginId.toLowerCase();
      if (seenLoginIds.has(loginKey)) errors.push(`Row ${rowNum}: duplicate Team ID "${r.teamLoginId}" appears earlier in the file`);
      seenLoginIds.add(loginKey);

      const nameKey = r.teamName.replace(/\s+/g, "").toLowerCase();
      if (seenNames.has(nameKey)) errors.push(`Row ${rowNum}: duplicate Team Name "${r.teamName}" appears earlier in the file`);
      seenNames.add(nameKey);

      if (r.group && r.group !== "A" && r.group !== "B") {
        errors.push(`Row ${rowNum}: Group "${r.group}" must be "A", "B", or empty`);
      }
    });

    if (errors.length > 0) {
      return NextResponse.json({ error: "Validation failed", details: errors }, { status: 400 });
    }

    // ---- Global teamLoginId uniqueness against OTHER leagues ----
    // (Within this league, the wipe below clears the way.)
    const loginIds = rows.map(r => r.teamLoginId);
    const conflicts = await db
      .select({ teamLoginId: teams.teamLoginId, leagueId: teams.leagueId })
      .from(teams)
      .where(and(inArray(teams.teamLoginId, loginIds), ne(teams.leagueId, leagueId)));
    if (conflicts.length > 0) {
      return NextResponse.json(
        {
          error: "Some teamLoginIds are already used in other leagues",
          details: conflicts.map(c => `"${c.teamLoginId}" exists in league ${c.leagueId}`),
        },
        { status: 400 }
      );
    }

    // ---- Wipe existing non-ghost teams (cascade FKs handle dependents) ----
    const existing = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));
    if (existing.length > 0) {
      await db.delete(teams).where(inArray(teams.id, existing.map(t => t.id)));
    }

    // ---- Resolve / create groups A and B as needed ----
    const groupIdByName = new Map<string, string>();
    const neededGroups = Array.from(new Set(rows.map(r => r.group).filter((g): g is string => g === "A" || g === "B")));
    if (neededGroups.length > 0) {
      const existingGroups = await db
        .select()
        .from(groups)
        .where(and(eq(groups.leagueId, leagueId), inArray(groups.name, neededGroups)));
      for (const g of existingGroups) groupIdByName.set(g.name, g.id);
      for (const name of neededGroups) {
        if (!groupIdByName.has(name)) {
          const gid = generateId();
          await db.insert(groups).values({ id: gid, name, leagueId, groupType: "pl" });
          groupIdByName.set(name, gid);
        }
      }
    }

    // ---- Insert new teams + players ----
    let created = 0;
    for (const r of rows) {
      const teamId = generateId();
      const hashed = await bcrypt.hash(r.password, 10);
      await db.insert(teams).values({
        id: teamId,
        teamLoginId: r.teamLoginId,
        name: r.teamName,
        password: hashed,
        mustChangePassword: true,
        isProfileComplete: true,
        groupId: r.group ? groupIdByName.get(r.group) ?? null : null,
        leagueId,
      });
      await db.insert(players).values([
        { id: generateId(), name: r.player1Name, fplId: String(r.player1FplId), teamId },
        { id: generateId(), name: r.player2Name, fplId: String(r.player2FplId), teamId },
      ]);
      created++;
    }

    return NextResponse.json({
      success: true,
      created,
      replaced: existing.length,
      message: `Replaced ${existing.length} team(s) with ${created} new team(s).`,
    });
  } catch (error) {
    console.error("Bulk upload teams error:", error);
    return NextResponse.json({ error: "Failed to bulk upload teams" }, { status: 500 });
  }
}
