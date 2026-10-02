import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, leagueAdmins, teams } from "@/lib/db";
import { verifySession, SESSION_COOKIE_NAME, type SessionPayload } from "@/lib/auth";
import type { ViewerInfo } from "@/lib/league-context";

const SIGNED_OUT: ViewerInfo = { authenticated: false, type: null, dashboardHref: "/signin" };

/**
 * Who a verified session belongs to, and where their dashboard is.
 *
 * Shared by the `[leagueSlug]` layout (which bakes the viewer into every league page), the PWA
 * `/launch` route (which sends the installed app straight to the right dashboard) and the
 * account switcher (which redirects after a switch) — one branching table for "where does this
 * session live".
 */
export async function resolveViewerForSession(session: SessionPayload | null): Promise<ViewerInfo> {
  if (!session) return SIGNED_OUT;

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

  return SIGNED_OUT;
}

/** The viewer behind the current request's session cookie. Server components / route handlers only. */
export async function resolveViewer(): Promise<ViewerInfo> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return SIGNED_OUT;
  return resolveViewerForSession(await verifySession(token));
}
