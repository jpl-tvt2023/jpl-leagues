/**
 * One-off repair for `auction_club_ownership` rows whose `pl_team_name` was written by the stale
 * season-scoped ID map (see pl-team-full-names.ts). Those rows name a *different club* than the one
 * the team actually won — e.g. a Man City owner stored as "Newcastle United".
 *
 * Ground truth is `pl_team_id` resolved against the live FPL bootstrap; `auction_bids` for the club
 * auction agrees with it. Only `pl_team_name` and a blank `pl_team_short` are rewritten — never
 * `pl_team_id`, `tier`, or `purchase_price`.
 *
 * Dry run:  npx dotenv -e .env.local -- npx tsx scripts/repair-club-names.ts
 * Apply:    npx dotenv -e .env.local -- npx tsx scripts/repair-club-names.ts --apply
 */
import { db } from "@/lib/db";
import { auctionClubOwnership, leagues, teams } from "@/lib/db/schema";
import { getPlTeamFullName } from "@/lib/data/pl-team-full-names";
import { eq } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

interface BootstrapTeam { id: number; name: string; short_name: string }

async function main() {
  const res = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`FPL bootstrap fetch failed: ${res.status}`);
  const bootstrap = ((await res.json()).teams ?? []) as BootstrapTeam[];
  if (bootstrap.length === 0) throw new Error("FPL bootstrap returned no teams");
  const byId = new Map(bootstrap.map((t) => [t.id, t]));

  const rows = await db
    .select({
      id: auctionClubOwnership.id,
      leagueId: auctionClubOwnership.leagueId,
      teamId: auctionClubOwnership.teamId,
      plTeamId: auctionClubOwnership.plTeamId,
      plTeamName: auctionClubOwnership.plTeamName,
      plTeamShort: auctionClubOwnership.plTeamShort,
    })
    .from(auctionClubOwnership);

  const teamNames = new Map(
    (await db.select({ id: teams.id, name: teams.name }).from(teams)).map((t) => [t.id, t.name]),
  );
  const leagueSlugs = new Map(
    (await db.select({ id: leagues.id, slug: leagues.slug }).from(leagues)).map((l) => [l.id, l.slug]),
  );

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} club ownership row(s)\n`);

  const changes: Array<{ id: string; name?: string; short?: string; label: string }> = [];

  for (const r of rows) {
    const club = byId.get(r.plTeamId);
    if (!club) {
      console.log(`SKIP  plId=${r.plTeamId} not in live bootstrap — leaving row untouched (needs manual review)`);
      continue;
    }
    const correctShort = club.short_name;
    const correctName = getPlTeamFullName(r.plTeamId, club.name, correctShort);

    const nameWrong = r.plTeamName !== correctName;
    const shortWrong = !r.plTeamShort || r.plTeamShort !== correctShort;
    const label = `${leagueSlugs.get(r.leagueId) ?? r.leagueId} / ${teamNames.get(r.teamId) ?? r.teamId}`;

    if (!nameWrong && !shortWrong) {
      console.log(`OK    ${label.padEnd(34)} plId=${String(r.plTeamId).padStart(2)}  ${correctName}`);
      continue;
    }

    console.log(`FIX   ${label.padEnd(34)} plId=${String(r.plTeamId).padStart(2)}`);
    if (nameWrong) console.log(`        name:  "${r.plTeamName}"  ->  "${correctName}"`);
    if (shortWrong) console.log(`        short: "${r.plTeamShort}"  ->  "${correctShort}"`);

    changes.push({
      id: r.id,
      ...(nameWrong ? { name: correctName } : {}),
      ...(shortWrong ? { short: correctShort } : {}),
      label,
    });
  }

  console.log(`\n${changes.length} row(s) need repair.`);

  if (!APPLY) {
    console.log("Dry run — nothing written. Re-run with --apply to write these changes.");
    return;
  }

  for (const c of changes) {
    await db
      .update(auctionClubOwnership)
      .set({
        ...(c.name !== undefined ? { plTeamName: c.name } : {}),
        ...(c.short !== undefined ? { plTeamShort: c.short } : {}),
      })
      .where(eq(auctionClubOwnership.id, c.id));
    console.log(`  repaired ${c.label}`);
  }
  console.log(`\nDone — ${changes.length} row(s) updated.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
