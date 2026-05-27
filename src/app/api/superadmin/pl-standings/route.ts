import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { plStandingsConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { fetchBootstrapData } from "@/lib/fpl";
import {
  PL_STANDINGS_SEED_ID,
  PL_STANDINGS_SEED_SEASON,
  PL_STANDINGS_SEED_TOP8,
  PL_STANDINGS_SEED_MID,
  PL_STANDINGS_SEED_PROMOTED,
} from "@/lib/data/pl-standings-seed";

type BootstrapTeam = { id: number; name: string; short_name: string };

type StandingsConfigResponse = {
  id: string;
  season: string;
  top8: number[];
  mid: number[];
  promoted: number[];
  updatedAt: string | null;
  plTeams: BootstrapTeam[]; // current FPL bootstrap teams for the picker UI
};

async function readOrSeedConfig() {
  const existing = await db.query.plStandingsConfig.findFirst({
    where: eq(plStandingsConfig.id, PL_STANDINGS_SEED_ID),
  });
  if (existing) return existing;

  const now = new Date();
  await db.insert(plStandingsConfig).values({
    id: PL_STANDINGS_SEED_ID,
    season: PL_STANDINGS_SEED_SEASON,
    top8: JSON.stringify(PL_STANDINGS_SEED_TOP8),
    mid: JSON.stringify(PL_STANDINGS_SEED_MID),
    promoted: JSON.stringify(PL_STANDINGS_SEED_PROMOTED),
    updatedAt: now,
  });
  return {
    id: PL_STANDINGS_SEED_ID,
    season: PL_STANDINGS_SEED_SEASON,
    top8: JSON.stringify(PL_STANDINGS_SEED_TOP8),
    mid: JSON.stringify(PL_STANDINGS_SEED_MID),
    promoted: JSON.stringify(PL_STANDINGS_SEED_PROMOTED),
    updatedAt: now,
  };
}

function parseIdList(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number");
  } catch {
    return [];
  }
}

/**
 * GET /api/superadmin/pl-standings
 * Returns the singleton standings config + current FPL bootstrap team list for the picker.
 * Seeds the row on first read.
 */
export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const config = await readOrSeedConfig();

  let plTeams: BootstrapTeam[] = [];
  try {
    const bootstrap = await fetchBootstrapData();
    const raw = (bootstrap.teams ?? []) as Array<{ id: number; name: string; short_name: string }>;
    plTeams = raw
      .map((t) => ({ id: t.id, name: t.name, short_name: t.short_name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error("Failed to fetch FPL bootstrap for standings picker:", err);
  }

  const response: StandingsConfigResponse = {
    id: config.id,
    season: config.season,
    top8: parseIdList(config.top8),
    mid: parseIdList(config.mid),
    promoted: parseIdList(config.promoted),
    updatedAt: config.updatedAt instanceof Date ? config.updatedAt.toISOString() : null,
    plTeams,
  };
  return NextResponse.json(response);
}

/**
 * PUT /api/superadmin/pl-standings
 * Body: { season, top8: number[], mid: number[], promoted: number[] }
 * Validates: top8 has exactly 8 IDs, mid has 9, promoted has 3, no duplicates across lists.
 */
export async function PUT(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  let body: { season?: unknown; top8?: unknown; mid?: unknown; promoted?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const season = typeof body.season === "string" ? body.season.trim() : "";
  if (!season) {
    return NextResponse.json({ error: "season is required" }, { status: 400 });
  }

  const isIntArray = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every((x) => Number.isInteger(x));

  if (!isIntArray(body.top8) || body.top8.length !== 8) {
    return NextResponse.json({ error: "top8 must be an array of exactly 8 integer team IDs" }, { status: 400 });
  }
  if (!isIntArray(body.mid) || body.mid.length !== 9) {
    return NextResponse.json({ error: "mid must be an array of exactly 9 integer team IDs" }, { status: 400 });
  }
  if (!isIntArray(body.promoted) || body.promoted.length !== 3) {
    return NextResponse.json({ error: "promoted must be an array of exactly 3 integer team IDs" }, { status: 400 });
  }

  const all = [...body.top8, ...body.mid, ...body.promoted];
  if (new Set(all).size !== all.length) {
    return NextResponse.json({ error: "Team IDs must be unique across top8 / mid / promoted" }, { status: 400 });
  }
  if (all.length !== 20) {
    return NextResponse.json({ error: "Total of top8 + mid + promoted must be 20 team IDs" }, { status: 400 });
  }

  let validTeamIds: Set<number>;
  try {
    const bootstrap = await fetchBootstrapData();
    const raw = (bootstrap.teams ?? []) as Array<{ id: number }>;
    validTeamIds = new Set(raw.map((t) => t.id));
  } catch (err) {
    console.error("Failed to fetch FPL bootstrap for PUT pl-standings validation:", err);
    return NextResponse.json(
      { error: "Unable to verify team IDs against FPL bootstrap; try again shortly" },
      { status: 503 }
    );
  }

  if (validTeamIds.size === 0) {
    return NextResponse.json(
      { error: "FPL bootstrap returned no teams; cannot validate IDs" },
      { status: 503 }
    );
  }

  const invalidIds = all.filter((id) => !validTeamIds.has(id));
  if (invalidIds.length > 0) {
    return NextResponse.json(
      {
        error: `Team IDs not in current FPL bootstrap: ${invalidIds.join(", ")}`,
        invalidIds,
      },
      { status: 400 }
    );
  }

  await readOrSeedConfig();

  const now = new Date();
  await db
    .update(plStandingsConfig)
    .set({
      season,
      top8: JSON.stringify(body.top8),
      mid: JSON.stringify(body.mid),
      promoted: JSON.stringify(body.promoted),
      updatedAt: now,
    })
    .where(eq(plStandingsConfig.id, PL_STANDINGS_SEED_ID));

  return NextResponse.json({
    success: true,
    season,
    top8: body.top8,
    mid: body.mid,
    promoted: body.promoted,
    updatedAt: now.toISOString(),
  });
}
