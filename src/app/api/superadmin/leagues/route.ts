import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, teams, gameweeks, groups } from "@/lib/db/schema";
import { eq, and, max, count } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import bcrypt from "bcryptjs";

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }
  const all = await db.select().from(leagues).orderBy(leagues.createdAt);

  // Attach quick stats to each league
  const leaguesWithStats = await Promise.all(
    all.map(async (league) => {
      const [teamCountRow] = await db
        .select({ count: count() })
        .from(teams)
        .where(eq(teams.leagueId, league.id));

      const [currentGwRow] = await db
        .select({ maxGw: max(gameweeks.number) })
        .from(gameweeks)
        .where(and(eq(gameweeks.leagueId, league.id)));

      return {
        ...league,
        teamCount: teamCountRow?.count ?? 0,
        currentGameweek: currentGwRow?.maxGw ?? null,
      };
    })
  );

  return NextResponse.json({ leagues: leaguesWithStats });
}

export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { slug, name, sport, format, season, teamSize, groupCount, playoffStartGw, enabledChips, initialBudget, isSimulated } = body;

  if (!slug || !name || !sport || !format || !season) {
    return NextResponse.json({ error: "slug, name, sport, format, and season are required" }, { status: 400 });
  }

  // Format-specific validation and defaults
  let resolvedTeamSize: number;
  let resolvedGroupCount: number;
  let resolvedPlayoffStartGw: number;
  let resolvedEnabledChips: string[];

  if (format === "triple-crown") {
    // Triple Crown: hardcoded values
    resolvedTeamSize = 20;
    resolvedGroupCount = 4; // 1 PL group + 4 cup groups (managed separately)
    resolvedPlayoffStartGw = 27;
    resolvedEnabledChips = [];
  } else if (format === "tvt") {
    // TVT: derive from teamSize
    resolvedTeamSize = teamSize ?? 32;
    resolvedGroupCount = groupCount ?? (resolvedTeamSize === 32 ? 2 : 1);
    resolvedPlayoffStartGw = playoffStartGw ?? (resolvedTeamSize === 8 ? 36 : 31);

    if (![8, 16, 32].includes(resolvedTeamSize)) {
      return NextResponse.json({ error: "TVT teamSize must be 8, 16, or 32" }, { status: 400 });
    }
    if (resolvedPlayoffStartGw < 31 || resolvedPlayoffStartGw > 36) {
      return NextResponse.json({ error: "TVT playoffStartGw must be between 31 and 36" }, { status: 400 });
    }

    // Validate enabledChips: must be array of exactly 3 valid chip codes
    const VALID_CHIP_CODES = ["W", "D", "C", "SL", "CB", "UD"];
    resolvedEnabledChips = enabledChips ?? ["D", "W", "C"];
    if (
      !Array.isArray(resolvedEnabledChips) ||
      resolvedEnabledChips.length !== 3 ||
      !resolvedEnabledChips.every((c) => VALID_CHIP_CODES.includes(c)) ||
      new Set(resolvedEnabledChips).size !== 3
    ) {
      return NextResponse.json({ error: "TVT enabledChips must be an array of exactly 3 unique valid chip codes (W, D, C, SL, CB, UD)" }, { status: 400 });
    }
  } else if (format === "auction") {
    // JPL Auction: no groups, no playoffs, no chips
    resolvedTeamSize = teamSize ?? 10;
    resolvedGroupCount = 0;
    resolvedPlayoffStartGw = 39; // effectively no playoffs
    resolvedEnabledChips = [];
  } else {
    return NextResponse.json({ error: `Format "${format}" is not supported` }, { status: 400 });
  }

  // Pre-check slug to give a precise error before doing any inserts.
  const existing = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.slug, slug)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: `A league with slug "${slug}" already exists` }, { status: 409 });
  }

  const id = generateId();
  const resolvedBudget = format === "auction" ? (initialBudget ?? 100_000_000) : 100_000_000;

  try {
    let createdTeams = 0;

    await db.transaction(async (tx) => {
      await tx.insert(leagues).values({
        id, slug, name, sport, format, season, isActive: true,
        teamSize: resolvedTeamSize,
        groupCount: resolvedGroupCount,
        playoffStartGw: resolvedPlayoffStartGw,
        enabledChips: JSON.stringify(resolvedEnabledChips),
        initialBudget: resolvedBudget,
        isSimulated: format === "auction" ? (isSimulated ?? false) : false,
      });

      // For TVT, pre-create the PL groups and split teams across them so the
      // admin doesn't have to assign every team manually. groupCount=1 → all
      // teams in Group A; groupCount=2 → first half in A, second half in B.
      const tvtGroupIds: string[] = [];
      if (format === "tvt" && resolvedGroupCount > 0) {
        const groupNames = resolvedGroupCount === 2 ? ["A", "B"] : ["A"];
        for (const gn of groupNames) {
          const gid = generateId();
          await tx.insert(groups).values({ id: gid, name: gn, leagueId: id, groupType: "pl" });
          tvtGroupIds.push(gid);
        }
      }

      // Random initial allocation: shuffle team indices (Fisher-Yates), then
      // slice evenly across groups. Admin can re-shuffle or move teams from
      // the Groups tab before revealing to teams.
      const teamIndexToGroupId = new Map<number, string>();
      if (tvtGroupIds.length > 0) {
        const order = Array.from({ length: resolvedTeamSize }, (_, k) => k + 1);
        for (let k = order.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [order[k], order[j]] = [order[j], order[k]];
        }
        const perGroup = Math.ceil(resolvedTeamSize / tvtGroupIds.length);
        order.forEach((teamNum, idx) => {
          const gIdx = Math.min(Math.floor(idx / perGroup), tvtGroupIds.length - 1);
          teamIndexToGroupId.set(teamNum, tvtGroupIds[gIdx]);
        });
      }

      // Auto-create placeholder team accounts for every format. Teams complete
      // their own profile (name, players) on first login via /setup.
      for (let i = 1; i <= resolvedTeamSize; i++) {
        const padded = String(i).padStart(2, "0");
        const loginId = `${slug}Team${i}`;
        const plainPassword = `Team@${padded}`;
        const hashedPassword = await bcrypt.hash(plainPassword, 10);
        const groupId = teamIndexToGroupId.get(i);

        await tx.insert(teams).values({
          id: generateId(),
          teamLoginId: loginId,
          name: `Team ${i}`,
          leagueId: id,
          password: hashedPassword,
          mustChangePassword: true,
          isProfileComplete: false,
          ...(groupId ? { groupId } : {}),
          ...(format === "auction" ? { purse: resolvedBudget } : {}),
        });
        createdTeams++;
      }
    });

    return NextResponse.json({
      success: true,
      id, slug, name, sport, format, season,
      isActive: true,
      teamSize: resolvedTeamSize,
      groupCount: resolvedGroupCount,
      playoffStartGw: resolvedPlayoffStartGw,
      enabledChips: resolvedEnabledChips,
      teamCount: createdTeams,
      currentGameweek: null,
    });
  } catch (err) {
    console.error("[superadmin/leagues POST] failed:", err);
    // Drizzle wraps the real DB error in `cause` and only puts the SQL in `.message`.
    // Walk the cause chain so the actual SQLite/libsql reason surfaces to the client.
    const parts: string[] = [];
    let cur: unknown = err;
    while (cur && parts.length < 5) {
      if (cur instanceof Error) {
        parts.push(cur.message);
        cur = (cur as { cause?: unknown }).cause;
      } else {
        parts.push(String(cur));
        break;
      }
    }
    const msg = parts.join(" | ");

    if (/UNIQUE constraint failed:\s*teams\.team_login_id/i.test(msg) || /teams_login_id_global_unique/i.test(msg)) {
      return NextResponse.json({
        error: `Cannot create league: team login IDs like "${slug}Team1" are already in use globally. This usually means a previous creation attempt with this slug partially failed and left orphan team rows. Run scripts/cleanup-orphan-teams.ts or pick a different slug.`,
      }, { status: 409 });
    }
    if (/UNIQUE constraint failed:\s*leagues\.slug/i.test(msg)) {
      return NextResponse.json({ error: `A league with slug "${slug}" already exists` }, { status: 409 });
    }
    return NextResponse.json({ error: `Failed to create league: ${msg}` }, { status: 500 });
  }
}
