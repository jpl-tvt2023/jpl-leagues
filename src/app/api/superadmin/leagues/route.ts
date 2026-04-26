import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, teams, gameweeks } from "@/lib/db/schema";
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

  try {
    const id = generateId();
    const resolvedBudget = format === "auction" ? (initialBudget ?? 100_000_000) : 100_000_000;

    await db.insert(leagues).values({
      id, slug, name, sport, format, season, isActive: true,
      teamSize: resolvedTeamSize,
      groupCount: resolvedGroupCount,
      playoffStartGw: resolvedPlayoffStartGw,
      enabledChips: JSON.stringify(resolvedEnabledChips),
      initialBudget: resolvedBudget,
      isSimulated: format === "auction" ? (isSimulated ?? false) : false,
    });

    // Auto-create placeholder team accounts for every format. Teams complete
    // their own profile (name, players) on first login via /setup.
    let createdTeams = 0;
    for (let i = 1; i <= resolvedTeamSize; i++) {
      const padded = String(i).padStart(2, "0");
      const loginId = `${slug}Team${i}`;
      const plainPassword = `Team@${padded}`;
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      await db.insert(teams).values({
        id: generateId(),
        teamLoginId: loginId,
        name: `Team ${i}`,
        leagueId: id,
        password: hashedPassword,
        mustChangePassword: true,
        isProfileComplete: false,
        ...(format === "auction" ? { purse: resolvedBudget } : {}),
      });
      createdTeams++;
    }

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
  } catch {
    return NextResponse.json({ error: "League with that slug already exists" }, { status: 409 });
  }
}
