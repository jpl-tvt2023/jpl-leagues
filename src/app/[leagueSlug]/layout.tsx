import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, leagues, leagueAdmins, teams } from "@/lib/db";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { LeagueProvider, type LeagueInfo, type ViewerInfo } from "@/lib/league-context";
import { getFormatPalette } from "@/lib/format-palette";

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
    })
    .from(leagues)
    .where(eq(leagues.slug, leagueSlug))
    .limit(1);

  const row = leagueRows[0];
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
  };

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
