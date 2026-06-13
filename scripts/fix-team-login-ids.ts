import "dotenv/config";
import { db, fkReady, leagues, teams } from "../src/lib/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

// One-off repair for teams whose login IDs / passwords were created (or mutated)
// under the old, inconsistent scheme:
//   - auto-creation stored `${slug}Team${i}` (no hyphen) + password `Team@NN`
//   - reset-password lowercased the ID (`...Team7` -> `...team7`)
// This normalises every non-ghost team to the agreed format:
//   teamLoginId = `${league.slug}-Team${N}`, password = `Team${N}`, mustChangePassword = true
//
// N is derived from the trailing digits of the current teamLoginId, falling back
// to the trailing digits of the team name ("Team 7"). Teams with no derivable
// number are skipped and reported.
//
// Dry-run by default. Pass --apply to write. Optional --league=<slug> to scope.
//   npx dotenv -e .env.local -- tsx scripts/fix-team-login-ids.ts --league=jpl-auction-mini
//   npx dotenv -e .env.local -- tsx scripts/fix-team-login-ids.ts --league=jpl-auction-mini --apply
function deriveTeamNumber(loginId: string | null, name: string): number | null {
  const fromLogin = loginId?.match(/(\d+)\s*$/)?.[1];
  if (fromLogin) return Number(fromLogin);
  const fromName = name.match(/(\d+)\s*$/)?.[1];
  if (fromName) return Number(fromName);
  return null;
}

async function main() {
  await fkReady;
  const apply = process.argv.includes("--apply");
  const leagueArg = process.argv.find((a) => a.startsWith("--league="))?.split("=")[1];

  const leagueRows = await db
    .select({ id: leagues.id, slug: leagues.slug })
    .from(leagues);
  const targetLeagues = leagueArg ? leagueRows.filter((l) => l.slug === leagueArg) : leagueRows;

  if (targetLeagues.length === 0) {
    console.log(leagueArg ? `No league found with slug "${leagueArg}".` : "No leagues found.");
    return;
  }

  let changes = 0;
  let skipped = 0;

  for (const league of targetLeagues) {
    const leagueTeams = await db
      .select({ id: teams.id, teamLoginId: teams.teamLoginId, name: teams.name, isGhost: teams.isGhost })
      .from(teams)
      .where(eq(teams.leagueId, league.id));

    for (const t of leagueTeams) {
      if (t.isGhost) continue; // ghost teams are managed automatically; never touch

      const n = deriveTeamNumber(t.teamLoginId, t.name);
      if (n === null) {
        console.log(`  SKIP [${league.slug}] id=${t.id} loginId=${t.teamLoginId} name="${t.name}" — no number derivable`);
        skipped++;
        continue;
      }

      const newLoginId = `${league.slug}-Team${n}`;
      const newPassword = `Team${n}`;

      if (t.teamLoginId === newLoginId) {
        // ID already correct; we still reset the password to the known default so
        // the user can log in (passwords are hashed, so we can't tell if it differs).
        console.log(`  PWONLY [${league.slug}] loginId=${newLoginId} -> password "${newPassword}"`);
      } else {
        console.log(`  ${t.teamLoginId} -> ${newLoginId}  (password "${newPassword}")`);
      }
      changes++;

      if (apply) {
        await db
          .update(teams)
          .set({
            teamLoginId: newLoginId,
            password: await bcrypt.hash(newPassword, 10),
            mustChangePassword: true,
          })
          .where(eq(teams.id, t.id));
      }
    }
  }

  console.log(
    `\n${apply ? "Applied" : "Would apply"} ${changes} change(s)${skipped ? `, skipped ${skipped}` : ""}.`
  );
  if (!apply && changes > 0) console.log("Dry run. Re-run with --apply to write.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .then(() => process.exit(0));
