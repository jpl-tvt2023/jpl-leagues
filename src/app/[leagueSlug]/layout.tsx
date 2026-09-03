import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, leagues, leagueAdmins, teams } from "@/lib/db";
import { fplClassicConfig } from "@/lib/db/schema";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { LeagueProvider, type LeagueInfo, type ViewerInfo } from "@/lib/league-context";
import { getFormatPalette, FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
import { DEFAULT_RELEASE_CYCLE_GWS, parseReleaseCycleGws } from "@/lib/formats/auction/cycle";

function parseEnabledChips(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

async function resolveViewer(): Promise<ViewerInfo> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return { authenticated: false, type: null, dashboardHref: "/signin" };
  const session = await verifySession(token);
  if (!session) return { authenticated: false, type: null, dashboardHref: "/signin" };

  if (session.type === "superadmin") {
    return {
      authenticated: true,
      type: "superadmin",
      userId: session.id,
      dashboardHref: "/admin",
    };
  }

  if (session.type === "admin") {
    const rows = await db
      .select({ leagueId: leagueAdmins.leagueId })
      .from(leagueAdmins)
      .where(eq(leagueAdmins.userId, session.id))
      .limit(2);
    const adminLeagueId = rows[0]?.leagueId ?? null;
    return {
      authenticated: true,
      type: "admin",
      userId: session.id,
      adminLeagueId,
      dashboardHref: adminLeagueId ? `/admin/${adminLeagueId}` : "/admin",
    };
  }

  if (session.type === "team") {
    const teamRow = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, session.id))
      .limit(1);
    const teamId = teamRow[0]?.id;
    return {
      authenticated: true,
      type: "team",
      teamId,
      dashboardHref: "/dashboard",
    };
  }

  return { authenticated: false, type: null, dashboardHref: "/signin" };
}

export default async function LeagueLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ leagueSlug: string }>;
}) {
  const { leagueSlug } = await params;

  // Defensive: if a newly-added schema column (e.g. auction_tier) lags behind its migration on the
  // target DB, the full projection throws and every /[leagueSlug]/* route breaks. Fall back to a
  // minimal projection that omits the newest optional column(s) so pages stay up. The missing
  // column renders with its TypeScript-side default. Same pattern used in buildTeamLedger.
  let row:
    | {
        id: string;
        slug: string;
        name: string;
        sport: string;
        format: string;
        season: string;
        teamSize: number;
        groupCount: number;
        playoffStartGw: number;
        enabledChips: string;
        initialBudget: number;
        auctionTier: "primary" | "complete";
        startGameweek: number;
        releaseCycleGws: string;
      }
    | undefined;
  try {
    const leagueRows = await db
      .select({
        id: leagues.id,
        slug: leagues.slug,
        name: leagues.name,
        sport: leagues.sport,
        format: leagues.format,
        season: leagues.season,
        teamSize: leagues.teamSize,
        groupCount: leagues.groupCount,
        playoffStartGw: leagues.playoffStartGw,
        enabledChips: leagues.enabledChips,
        initialBudget: leagues.initialBudget,
        auctionTier: leagues.auctionTier,
        startGameweek: leagues.startGameweek,
        releaseCycleGws: leagues.releaseCycleGws,
      })
      .from(leagues)
      .where(eq(leagues.slug, leagueSlug))
      .limit(1);
    row = leagueRows[0];
  } catch (err) {
    console.warn("[layout] leagues SELECT failed — falling back to minimal columns. Pending migration?", err);
    const fallbackRows = await db
      .select({
        id: leagues.id,
        slug: leagues.slug,
        name: leagues.name,
        sport: leagues.sport,
        format: leagues.format,
        season: leagues.season,
        teamSize: leagues.teamSize,
        groupCount: leagues.groupCount,
        playoffStartGw: leagues.playoffStartGw,
        enabledChips: leagues.enabledChips,
        initialBudget: leagues.initialBudget,
      })
      .from(leagues)
      .where(eq(leagues.slug, leagueSlug))
      .limit(1);
    const minimal = fallbackRows[0];
    row = minimal
      ? {
          ...minimal,
          auctionTier: "complete" as const,
          startGameweek: 1,
          releaseCycleGws: JSON.stringify(DEFAULT_RELEASE_CYCLE_GWS),
        }
      : undefined;
  }
  if (!row) notFound();

  const league: LeagueInfo = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sport: row.sport,
    format: row.format,
    season: row.season,
    teamSize: row.teamSize,
    groupCount: row.groupCount,
    playoffStartGw: row.playoffStartGw,
    enabledChips: parseEnabledChips(row.enabledChips),
    initialBudget: row.initialBudget,
    auctionTier: row.auctionTier,
    startGameweek: row.startGameweek,
    releaseCycleGws: parseReleaseCycleGws(row.releaseCycleGws),
  };

  // fpl-classic only, and its own try/catch: a `fpl_classic_config` table that lags behind its
  // migration must degrade to a missing `fplLeagueId` (the page still renders, minus the FPL
  // deep-link), never take down this or any other format's league page the way a failure in the
  // main `leagues` query above would. Gated on format so the extra query never runs for the
  // other three formats at all.
  if (row.format === FPL_CLASSIC_FORMAT) {
    try {
      const [config] = await db
        .select({
          fplLeagueId: fplClassicConfig.fplLeagueId,
          scoringMetric: fplClassicConfig.scoringMetric,
          winnerCutPercent: fplClassicConfig.winnerCutPercent,
        })
        .from(fplClassicConfig)
        .where(eq(fplClassicConfig.leagueId, row.id))
        .limit(1);
      league.fplLeagueId = config?.fplLeagueId ?? null;
      league.fplScoringMetric = (config?.scoringMetric as "net" | "gross") ?? "net";
      league.fplWinnerCutPercent = config?.winnerCutPercent ?? 30;
    } catch (err) {
      console.warn("[layout] fpl_classic_config SELECT failed — continuing without fplLeagueId.", err);
    }
  }

  const viewer = await resolveViewer();

  // Per-format page background gradient. Applied here so every page under
  // /[leagueSlug]/* picks up the format identity in one place. Individual page
  // wrappers may also set their own bg-* classes — those stack on top.
  const palette = getFormatPalette(league.format, league.teamSize);

  return (
    <LeagueProvider value={{ league, viewer }}>
      <div className={`min-h-screen ${palette.pageBg}`}>{children}</div>
    </LeagueProvider>
  );
}
