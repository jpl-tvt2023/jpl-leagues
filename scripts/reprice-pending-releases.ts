/**
 * Reprice every still-pending auction release under the current rule:
 *   refund = 50% of purchase price (80% for deadwood) + 100% of the FMV gain.
 *
 * Releases marked before this rule shipped carry a refund snapshotted under the old one (50% of
 * FMV) and no breakdown. They haven't been paid yet, so they're repriced as if marked now — exactly
 * what the team would get by cancelling and re-marking — and each team is notified of the new
 * amount and how it's worked out. Finalized (paid) releases are never touched.
 *
 * A row that would come out LOWER is reported and left alone, even with --apply.
 *
 * Needs auction_ownership.release_fmv / deadwood_reason (scripts/apply-0025-release-breakdown.mjs).
 * Run right after the deploy, before a mini-auction starts or a release GW finalizes pending rows.
 *
 * Dry run:  npx dotenv -e .env.local -- npx tsx scripts/reprice-pending-releases.ts
 * Apply:    npx dotenv -e .env.local -- npx tsx scripts/reprice-pending-releases.ts --apply
 */
import { db } from "@/lib/db";
import { auctionOwnership, leagues, teams } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { creditedRefund } from "@/lib/formats/auction/economy";
import { priceRelease } from "@/lib/formats/auction/release-pricing";
import { describeDeadwoodReason, formatMoney, formatRefundBreakdown } from "@/lib/formats/auction/release-refund";
import { createNotification } from "@/lib/notifications";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

const APPLY = process.argv.includes("--apply");

async function main() {
  const pending = await db
    .select()
    .from(auctionOwnership)
    .where(eq(auctionOwnership.status, "pending_release"));
  console.log(`${pending.length} pending release(s). ${APPLY ? "APPLYING." : "Dry run — pass --apply to write."}\n`);
  if (pending.length === 0) return;

  const teamName = new Map(
    (await db.select({ id: teams.id, name: teams.name }).from(teams)).map((t) => [t.id, t.name])
  );
  const leagueSlug = new Map(
    (await db.select({ id: leagues.id, slug: leagues.slug }).from(leagues)).map((l) => [l.id, l.slug])
  );

  let repriced = 0;
  let skippedLower = 0;
  const touchedLeagues = new Set<string>();

  for (const o of pending) {
    const before = creditedRefund(o);
    // FPL failing here aborts the whole run on purpose: a partial reprice is worse than none.
    const { breakdown, lastGames } = await priceRelease(o);
    const after = breakdown.refund;
    const verdict = breakdown.deadwoodReason
      ? `deadwood (${describeDeadwoodReason(breakdown.deadwoodReason)})`
      : `standard (last games: ${lastGames.map((g) => `${g.minutes}'`).join(" ") || "none"})`;

    console.log(`${teamName.get(o.teamId) ?? o.teamId} · ${o.playerName}`);
    console.log(`  ${formatMoney(before)} → ${formatMoney(after)}   ${verdict}`);
    console.log(`  ${formatRefundBreakdown(breakdown)}`);

    if (after < before) {
      console.log("  ⚠ would LOWER the refund — left unchanged; decide by hand");
      skippedLower++;
      continue;
    }
    if (!APPLY) continue;

    // updatedAt is left alone on purpose: the Finance ledger dates a pending release by it, and
    // the team marked it then, not now. Guarded on status so a release that finalized while this
    // ran isn't rewritten after it was paid.
    const updated = await db
      .update(auctionOwnership)
      .set({ releaseRefund: after, releaseFmv: breakdown.fmv, deadwoodReason: breakdown.deadwoodReason })
      .where(and(eq(auctionOwnership.id, o.id), eq(auctionOwnership.status, "pending_release")))
      .returning({ id: auctionOwnership.id });
    if (updated.length === 0) {
      console.log("  ✗ no longer pending — skipped");
      continue;
    }

    const slug = leagueSlug.get(o.leagueId);
    await createNotification({
      teamId: o.teamId,
      leagueId: o.leagueId,
      type: "release_refund",
      title: `Release refund updated: ${o.playerName}`,
      body:
        `${formatMoney(before)} → ${formatMoney(after)} under the new release rule — ` +
        `${breakdown.deadwoodReason ? "deadwood: " : ""}${formatRefundBreakdown(breakdown)}.`,
      link: slug ? `/${slug}/squad` : undefined,
    });
    repriced++;
    touchedLeagues.add(o.leagueId);
    console.log("  ✓ repriced + team notified");
  }

  for (const leagueId of touchedLeagues) {
    await invalidateLeaguePageCache(leagueId).catch((err) =>
      console.warn(`  standings cache invalidation failed for ${leagueId}:`, err)
    );
  }

  console.log(
    `\n${APPLY ? `Repriced ${repriced}` : `Would reprice ${pending.length - skippedLower}`} of ${pending.length}` +
      (skippedLower ? `; ${skippedLower} would go lower and were left alone.` : ".")
  );
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
