import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, teams, groups, fplClassicConfig, fplClassicEntrants } from "@/lib/db/schema";
import { eq, count } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { getCurrentGameweekNumber } from "@/lib/gameweeks/current-gw";
import { validateEnabledChipsArray } from "@/lib/formats/tvt/chip-validation";
import { DEFAULT_RELEASE_CYCLE_GWS, validateReleaseCycleGws } from "@/lib/formats/auction/cycle";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
import {
  fetchClassicLeagueStandings,
  FplClassicLeagueNotFoundError,
  type FplClassicStandingsPayload,
} from "@/lib/fpl/classic-league";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";
import bcrypt from "bcryptjs";

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }
  // Defensive: schema may include columns (e.g. auction_tier) that lag the prod migration. Fall back
  // to a minimal projection so the admin can still see/manage existing leagues until the migration
  // is applied. Newly-added columns receive their TypeScript-side defaults.
  let all: Array<typeof leagues.$inferSelect>;
  try {
    all = await db.select().from(leagues).orderBy(leagues.createdAt);
  } catch (err) {
    console.warn("[superadmin/leagues] full SELECT failed — falling back to minimal projection. Pending migration?", err);
    const fallback = await db
      .select({
        id: leagues.id,
        slug: leagues.slug,
        name: leagues.name,
        sport: leagues.sport,
        format: leagues.format,
        season: leagues.season,
        isActive: leagues.isActive,
        teamSize: leagues.teamSize,
        groupCount: leagues.groupCount,
        playoffStartGw: leagues.playoffStartGw,
        enabledChips: leagues.enabledChips,
        initialBudget: leagues.initialBudget,
        isSimulated: leagues.isSimulated,
        clubAuctionEnabled: leagues.clubAuctionEnabled,
        createdAt: leagues.createdAt,
      })
      .from(leagues)
      .orderBy(leagues.createdAt);
    all = fallback.map((row) => ({
      ...row,
      auctionTier: "complete" as const,
      startGameweek: 1,
      releaseCycleGws: JSON.stringify(DEFAULT_RELEASE_CYCLE_GWS),
    }));
  }

  // Attach quick stats to each league
  const leaguesWithStats = await Promise.all(
    all.map(async (league) => {
      const [teamCountRow] = await db
        .select({ count: count() })
        .from(teams)
        .where(eq(teams.leagueId, league.id));

      const currentGameweek = await getCurrentGameweekNumber(league.id);

      return {
        ...league,
        teamCount: teamCountRow?.count ?? 0,
        currentGameweek,
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
  const {
    slug, name, sport, format, season, teamSize, groupCount, playoffStartGw, enabledChips,
    initialBudget, isSimulated, clubAuctionEnabled, auctionTier, startGameweek, releaseCycleGws,
    // fpl-classic only.
    fplLeagueId, scoringMetric, winnerCutPercent,
  } = body;

  const isFplClassic = format === FPL_CLASSIC_FORMAT;

  // fpl-classic derives both slug and name from the FPL league itself (see below) — the
  // superadmin supplies only the FPL league id, never a slug or a name to remember.
  if (!sport || !format || !season) {
    return NextResponse.json({ error: "sport, format, and season are required" }, { status: 400 });
  }
  if (!isFplClassic && (!slug || !name)) {
    return NextResponse.json({ error: "slug, name, sport, format, and season are required" }, { status: 400 });
  }

  // Mutable so the fpl-classic branch below can fill in what the request never sent. Every other
  // format leaves these exactly equal to the request body — no behaviour change for them.
  let resolvedSlug: string = slug;
  let resolvedName: string = name;

  // Format-specific validation and defaults
  let resolvedTeamSize: number;
  let resolvedGroupCount: number;
  let resolvedPlayoffStartGw: number;
  let resolvedEnabledChips: string[];
  // Auction-only. Non-auction formats are pinned to the GW1 / legacy-cadence defaults
  // below so the columns can never mean anything for TVT / Continental Championship.
  let resolvedStartGameweek = 1;
  let resolvedReleaseCycleGws = [...DEFAULT_RELEASE_CYCLE_GWS];
  // fpl-classic only.
  let resolvedScoringMetric: "net" | "gross" = "net";
  let resolvedWinnerCutPercent = 30;
  let classicPayload: FplClassicStandingsPayload | null = null;
  let fplLeagueIdNum: number | null = null;

  if (format === "continental-championship") {
    // Continental Championship: hardcoded values
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
    const candidateChips = enabledChips ?? ["D", "W", "C"];
    const chipCheck = validateEnabledChipsArray(candidateChips);
    if (!chipCheck.ok) {
      return NextResponse.json({ error: chipCheck.error }, { status: 400 });
    }
    resolvedEnabledChips = chipCheck.chips;
  } else if (format === "auction") {
    // JPL Auction: no groups, no playoffs, no chips
    resolvedTeamSize = teamSize ?? 10;
    resolvedGroupCount = 0;
    resolvedPlayoffStartGw = 39; // effectively no playoffs
    resolvedEnabledChips = [];

    // Scoring begins here; create-gameweeks never seeds rows below it.
    resolvedStartGameweek = startGameweek ?? 1;
    if (!Number.isInteger(resolvedStartGameweek) || resolvedStartGameweek < 1 || resolvedStartGameweek > 38) {
      return NextResponse.json({ error: "Auction startGameweek must be an integer between 1 and 38" }, { status: 400 });
    }

    // Validated against the start GW so a boundary can't sit before the league begins.
    if (releaseCycleGws !== undefined) {
      const cycleCheck = validateReleaseCycleGws(releaseCycleGws, resolvedStartGameweek);
      if (!cycleCheck.ok) {
        return NextResponse.json({ error: cycleCheck.error }, { status: 400 });
      }
      resolvedReleaseCycleGws = cycleCheck.gws;
    } else {
      // Default 10/20/30 can fall outside a late start; keep only what's reachable,
      // and fall back to the final gameweek so releases still finalize at some point.
      const reachable = DEFAULT_RELEASE_CYCLE_GWS.filter((gw) => gw >= resolvedStartGameweek);
      resolvedReleaseCycleGws = reachable.length > 0 ? reachable : [38];
    }
  } else if (isFplClassic) {
    // Public, read-only, no login accounts. teamSize=0 below is how "no placeholder team
    // accounts" is achieved: the existing `for (let i = 1; i <= resolvedTeamSize; i++)` account
    // loop further down becomes a no-op by construction — zero edits to that loop, so every
    // other format's account creation is provably untouched.
    resolvedTeamSize = 0;
    resolvedGroupCount = 0;
    resolvedPlayoffStartGw = 39; // no playoffs
    resolvedEnabledChips = [];

    fplLeagueIdNum = Number(fplLeagueId);
    if (!Number.isInteger(fplLeagueIdNum) || fplLeagueIdNum <= 0) {
      return NextResponse.json({ error: "fplLeagueId must be a positive integer" }, { status: 400 });
    }
    // A narrowed local copy: TS cannot carry the guard above's narrowing into a closure that
    // captures the outer `let`, since the closure could in principle run after a reassignment.
    const validatedFplLeagueId = fplLeagueIdNum;

    resolvedStartGameweek = startGameweek ?? 1;
    if (!Number.isInteger(resolvedStartGameweek) || resolvedStartGameweek < 1 || resolvedStartGameweek > 38) {
      return NextResponse.json({ error: "startGameweek must be an integer between 1 and 38" }, { status: 400 });
    }

    if (scoringMetric !== undefined) {
      if (scoringMetric !== "net" && scoringMetric !== "gross") {
        return NextResponse.json({ error: 'scoringMetric must be "net" or "gross"' }, { status: 400 });
      }
      resolvedScoringMetric = scoringMetric;
    }

    if (winnerCutPercent !== undefined) {
      const cut = Number(winnerCutPercent);
      if (!Number.isInteger(cut) || cut < 1 || cut > 100) {
        return NextResponse.json({ error: "winnerCutPercent must be an integer between 1 and 100" }, { status: 400 });
      }
      resolvedWinnerCutPercent = cut;
    }

    // FPL I/O happens HERE — before the transaction, never inside it: a libSQL transaction pinned
    // for the seconds an outbound HTTP call can take is exactly the mistake every other write path
    // in this codebase avoids. This also means a half-created league is impossible: either the
    // fetch fails and nothing is written, or it succeeds and the transaction below is pure DB work.
    try {
      classicPayload = await withFplBudget(
        { lane: "background", label: "fpl-classic create", max: 30 },
        () => fetchClassicLeagueStandings(validatedFplLeagueId, { lane: "background" }),
      );
    } catch (err) {
      if (err instanceof FplClassicLeagueNotFoundError) {
        return NextResponse.json({ error: `No FPL league found with id ${validatedFplLeagueId}` }, { status: 400 });
      }
      if (err instanceof FplUnavailableError) {
        return NextResponse.json(
          { error: "FPL is temporarily unavailable — try again in a moment" },
          { status: 503 },
        );
      }
      throw err;
    }

    // Derived, never supplied: the same FPL league id recurs across seasons, so a second season
    // of the same mini-league needs a slug distinct from the first. Uniqueness is still enforced
    // by the existing pre-check just below — this is a good-faith default, not the last word.
    resolvedSlug = `league-${fplLeagueIdNum}`;
    const slugTaken = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.slug, resolvedSlug)).limit(1);
    if (slugTaken.length > 0) {
      resolvedSlug = `league-${fplLeagueIdNum}-${String(season).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    }
    resolvedName = classicPayload.league.name;
  } else {
    return NextResponse.json({ error: `Format "${format}" is not supported` }, { status: 400 });
  }

  // Pre-check slug to give a precise error before doing any inserts. (For fpl-classic this is a
  // second look at whatever the block above already derived and single-checked — cheap, and it
  // closes the race between that check and this request's own transaction.)
  const existing = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.slug, resolvedSlug)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: `A league with slug "${resolvedSlug}" already exists` }, { status: 409 });
  }

  const id = generateId();
  // Default Complete tier; only meaningful for auction leagues. Anything other than the literal
  // "primary" string falls back to "complete".
  const resolvedAuctionTier: "primary" | "complete" =
    format === "auction" && auctionTier === "primary" ? "primary" : "complete";

  try {
    let createdTeams = 0;

    await db.transaction(async (tx) => {
      await tx.insert(leagues).values({
        id, slug: resolvedSlug, name: resolvedName, sport, format, season, isActive: true,
        teamSize: resolvedTeamSize,
        groupCount: resolvedGroupCount,
        playoffStartGw: resolvedPlayoffStartGw,
        enabledChips: JSON.stringify(resolvedEnabledChips),
        // initialBudget is auction-only. For non-auction formats let the schema
        // default fire so the explicit write here can't confuse readers into
        // thinking the column means something for TVT/Continental Championship.
        ...(format === "auction" ? { initialBudget: initialBudget ?? 100_000_000 } : {}),
        isSimulated: format === "auction" ? (isSimulated ?? false) : false,
        // PL Club Auction toggle — only meaningful on auction leagues; force false elsewhere
        clubAuctionEnabled: format === "auction" ? Boolean(clubAuctionEnabled) : false,
        auctionTier: resolvedAuctionTier,
        startGameweek: resolvedStartGameweek,
        releaseCycleGws: JSON.stringify(resolvedReleaseCycleGws),
      });

      // For TVT, pre-create the PL groups and split teams across them so the
      // admin doesn't have to assign every team manually. groupCount=1 → all
      // teams in Group A; groupCount=2 → first half in A, second half in B.
      const tvtGroupIds: string[] = [];
      if (format === "tvt" && resolvedGroupCount > 0) {
        const groupNames = resolvedGroupCount === 2 ? ["A", "B"] : ["A"];
        for (const gn of groupNames) {
          const gid = generateId();
          await tx.insert(groups).values({ id: gid, name: gn, leagueId: id, groupType: "jpl" });
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
      // (fpl-classic: resolvedTeamSize is 0, so this loop runs zero times — see the comment on
      // the fpl-classic branch above for why that is how "no login accounts" is guaranteed.)
      for (let i = 1; i <= resolvedTeamSize; i++) {
        const loginId = `${resolvedSlug}-Team${i}`;
        const plainPassword = `Team${i}`;
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
          ...(format === "auction" ? { purse: initialBudget ?? 100_000_000 } : {}),
        });
        createdTeams++;
      }

      // fpl-classic: seed the config row plus every entrant fetched above. Nothing here creates
      // a `teams` row — this format's roster lives entirely in fplClassicEntrants, keyed by FPL
      // entry id, exactly as the isolation requirement calls for.
      if (isFplClassic && classicPayload) {
        await tx.insert(fplClassicConfig).values({
          leagueId: id,
          fplLeagueId: fplLeagueIdNum!,
          fplLeagueName: classicPayload.league.name,
          fplStartEvent: classicPayload.league.startEvent,
          startGameweek: resolvedStartGameweek,
          scoringMetric: resolvedScoringMetric,
          winnerCutPercent: resolvedWinnerCutPercent,
          entrantsSyncedAt: new Date(),
          entrantCount: classicPayload.entries.length,
          settledThroughGw: 0,
        });

        const joinedTimeByEntry = new Map(
          classicPayload.newEntries.map((e) => [e.entry, e.joinedTime]),
        );

        // Everyone present at league creation is a founding member — the same gameweek the
        // league itself starts scoring from. A manager who shows up in a LATER sync (after
        // someone joins the FPL mini-league mid-season) gets that later gameweek instead; see
        // syncRoster in lib/fpl-classic/sync.ts.
        const entrantRows = classicPayload.entries.map((entry) => ({
          id: generateId(),
          leagueId: id,
          fplEntryId: entry.entry,
          entryName: entry.entryName,
          playerName: entry.playerName,
          joinedTime: joinedTimeByEntry.get(entry.entry)
            ? new Date(joinedTimeByEntry.get(entry.entry)!)
            : null,
          firstSeenGw: resolvedStartGameweek,
          totalPoints: entry.total,
          lastRank: entry.rank,
          isActive: true,
        }));

        // Chunked defensively — a page cap of 1000 entrants in one statement is more than any
        // real mini-league needs, but there is no reason to find out where libSQL's limit is.
        const CHUNK = 200;
        for (let i = 0; i < entrantRows.length; i += CHUNK) {
          await tx.insert(fplClassicEntrants).values(entrantRows.slice(i, i + CHUNK));
        }
      }
    });

    return NextResponse.json({
      success: true,
      id, slug: resolvedSlug, name: resolvedName, sport, format, season,
      isActive: true,
      teamSize: resolvedTeamSize,
      groupCount: resolvedGroupCount,
      playoffStartGw: resolvedPlayoffStartGw,
      enabledChips: resolvedEnabledChips,
      auctionTier: resolvedAuctionTier,
      startGameweek: resolvedStartGameweek,
      releaseCycleGws: resolvedReleaseCycleGws,
      teamCount: createdTeams,
      currentGameweek: null,
      ...(isFplClassic && classicPayload ? {
        fplLeagueId: fplLeagueIdNum,
        fplLeagueName: classicPayload.league.name,
        scoringMetric: resolvedScoringMetric,
        winnerCutPercent: resolvedWinnerCutPercent,
        entrantCount: classicPayload.entries.length,
        truncated: classicPayload.truncated,
      } : {}),
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
      return NextResponse.json({ error: `A league with slug "${resolvedSlug}" already exists` }, { status: 409 });
    }
    return NextResponse.json({ error: `Failed to create league: ${msg}` }, { status: 500 });
  }
}
