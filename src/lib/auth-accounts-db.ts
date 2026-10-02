import { inArray, eq } from "drizzle-orm";
import { db, leagues, teams, users } from "@/lib/db";
import type { StoredAccount } from "./auth-accounts";

/** What the account switcher shows for one signed-in account. Never includes the token. */
export interface AccountDescription {
  label: string;
  sublabel: string | null;
  loginId: string | null;
}

/**
 * Display rows for stored accounts, keyed by `StoredAccount.key`. An account whose team or user no
 * longer exists (deleted since sign-in) is absent from the map — callers treat that as signed out.
 *
 * Two queries regardless of how many accounts are stored (at most five).
 */
export async function describeAccounts(accounts: StoredAccount[]): Promise<Map<string, AccountDescription>> {
  const out = new Map<string, AccountDescription>();
  const teamIds = accounts.filter((a) => a.session.type === "team").map((a) => a.session.id);
  const userIds = accounts.filter((a) => a.session.type !== "team").map((a) => a.session.id);

  if (teamIds.length > 0) {
    const rows = await db
      .select({
        id: teams.id,
        name: teams.name,
        loginId: teams.teamLoginId,
        leagueName: leagues.name,
      })
      .from(teams)
      .innerJoin(leagues, eq(teams.leagueId, leagues.id))
      .where(inArray(teams.id, teamIds));
    for (const r of rows) {
      out.set(`team:${r.id}`, { label: r.name, sublabel: r.leagueName, loginId: r.loginId });
    }
  }

  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const a of accounts) {
      if (a.session.type === "team") continue;
      const u = byId.get(a.session.id);
      if (!u) continue;
      out.set(a.key, {
        label: u.name || u.email,
        sublabel: a.session.type === "superadmin" ? "Platform admin" : "League admin",
        loginId: u.email,
      });
    }
  }

  return out;
}
