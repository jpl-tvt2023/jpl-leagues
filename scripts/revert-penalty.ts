/**
 * Revert a missed-nomination penalty that was issued in error.
 *
 * Needed because the SSE timeout claim used to match "any non-null nomination deadline" rather than
 * the specific window the poll observed, so a stale poll could penalise a team that had just
 * nominated successfully (see the exact-match fix in the auction SSE route).
 *
 * Deletes the `team_penalties` row and decrements the team's `penalty_slots`, restoring one squad
 * slot via `effectiveMaxSquadSize`. Refuses to touch a penalty that has already been redeemed —
 * that involves purse accounting this script does not attempt to unwind.
 *
 * Dry run:  npx dotenv -e .env.local -- npx tsx scripts/revert-penalty.ts <penaltyId>
 * Apply:    npx dotenv -e .env.local -- npx tsx scripts/revert-penalty.ts <penaltyId> --apply
 */
import { db } from "@/lib/db";
import { teamPenalties, teams, leagues } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const penaltyId = args.find((a) => !a.startsWith("--"));

async function main() {
  if (!penaltyId) {
    console.error("Usage: revert-penalty.ts <penaltyId> [--apply]");
    process.exitCode = 1;
    return;
  }

  const rows = await db
    .select({
      id: teamPenalties.id,
      leagueId: teamPenalties.leagueId,
      teamId: teamPenalties.teamId,
      sessionId: teamPenalties.sessionId,
      incurredCycle: teamPenalties.incurredCycle,
      redeemedAt: teamPenalties.redeemedAt,
      redemptionPrice: teamPenalties.redemptionPrice,
      createdAt: teamPenalties.createdAt,
    })
    .from(teamPenalties)
    .where(eq(teamPenalties.id, penaltyId))
    .limit(1);

  if (rows.length === 0) {
    console.error(`No team_penalties row with id ${penaltyId}`);
    process.exitCode = 1;
    return;
  }
  const p = rows[0];

  if (p.redeemedAt !== null) {
    console.error(
      `Penalty ${penaltyId} was already redeemed at ${p.redeemedAt.toISOString()} ` +
        `for ${p.redemptionPrice}. Reverting it would need a purse refund too — refusing.`,
    );
    process.exitCode = 1;
    return;
  }

  const [team] = await db
    .select({ id: teams.id, name: teams.name, penaltySlots: teams.penaltySlots })
    .from(teams)
    .where(eq(teams.id, p.teamId))
    .limit(1);
  const [league] = await db
    .select({ slug: leagues.slug })
    .from(leagues)
    .where(eq(leagues.id, p.leagueId))
    .limit(1);

  // How many penalties this team holds in total — the slot count should track this.
  const all = await db
    .select({ id: teamPenalties.id, createdAt: teamPenalties.createdAt, redeemedAt: teamPenalties.redeemedAt })
    .from(teamPenalties)
    .where(eq(teamPenalties.teamId, p.teamId));

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — revert penalty ${penaltyId}\n`);
  console.log(`  league          ${league?.slug ?? p.leagueId}`);
  console.log(`  team            ${team?.name ?? p.teamId}`);
  console.log(`  session         ${p.sessionId}`);
  console.log(`  incurred cycle  ${p.incurredCycle}`);
  console.log(`  created         ${p.createdAt.toISOString()} (${Math.floor(p.createdAt.getTime() / 1000)})`);
  console.log(`  redeemed        no`);
  console.log(`\n  this team's penalty rows (${all.length}):`);
  for (const row of all) {
    const mark = row.id === penaltyId ? "  <-- reverting" : "";
    console.log(
      `    ${row.id}  ${row.createdAt.toISOString()}  ${row.redeemedAt ? "redeemed" : "open"}${mark}`,
    );
  }
  console.log(`\n  penalty_slots   ${team?.penaltySlots} -> ${(team?.penaltySlots ?? 1) - 1}`);
  console.log(`  penalty rows    ${all.length} -> ${all.length - 1}`);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to make these changes.");
    return;
  }

  await db.delete(teamPenalties).where(eq(teamPenalties.id, penaltyId));
  // Floor at 0 so a double run can never drive the count negative.
  await db
    .update(teams)
    .set({ penaltySlots: sql`MAX(${teams.penaltySlots} - 1, 0)` })
    .where(eq(teams.id, p.teamId));

  const [after] = await db
    .select({ penaltySlots: teams.penaltySlots })
    .from(teams)
    .where(eq(teams.id, p.teamId))
    .limit(1);
  const remaining = await db
    .select({ id: teamPenalties.id })
    .from(teamPenalties)
    .where(eq(teamPenalties.teamId, p.teamId));

  console.log(`\nDone — ${team?.name}: penalty_slots=${after?.penaltySlots}, penalty rows=${remaining.length}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
