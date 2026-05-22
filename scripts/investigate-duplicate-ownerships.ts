import "dotenv/config";
import { createClient } from "@libsql/client";

/**
 * READ-ONLY. Scans every league for fpl players with more than one active ownership row.
 * Used to surface the Wharton double-sell in demo-auction (and any other latent dup that
 * the missing pre-INSERT guard might have produced before this PR).
 *
 * Run with: npx tsx scripts/investigate-duplicate-ownerships.ts
 */

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("DATABASE_URL or TURSO_CONNECTION_URL is required");
  const client = createClient({ url, authToken });

  console.log("Scanning auction_ownership for duplicate active rows on same (league_id, fpl_element_id)…\n");

  const dupes = await client.execute(`
    SELECT
      league_id,
      fpl_element_id,
      COUNT(*) AS n,
      GROUP_CONCAT(id, '|') AS ownership_ids,
      GROUP_CONCAT(team_id, '|') AS team_ids,
      GROUP_CONCAT(purchase_price, '|') AS prices,
      GROUP_CONCAT(created_at, '|') AS created_ats
    FROM auction_ownership
    WHERE status = 'active'
    GROUP BY league_id, fpl_element_id
    HAVING COUNT(*) > 1
  `);

  if (dupes.rows.length === 0) {
    console.log("✓ No duplicate active ownerships found.");
    return;
  }

  for (const row of dupes.rows) {
    const leagueId = String(row.league_id);
    const fplId = Number(row.fpl_element_id);
    const ownershipIds = String(row.ownership_ids).split("|");
    const teamIds = String(row.team_ids).split("|");
    const prices = String(row.prices).split("|");
    const createdAts = String(row.created_ats).split("|");

    // Look up league + team + player name for human-readable output
    const league = await client.execute({
      sql: "SELECT slug, name FROM leagues WHERE id = ? LIMIT 1",
      args: [leagueId],
    });
    const leagueLabel = league.rows[0] ? `${league.rows[0].slug} (${league.rows[0].name})` : leagueId;

    console.log(`\n— league: ${leagueLabel}`);
    console.log(`  fpl_element_id: ${fplId}`);
    for (let i = 0; i < ownershipIds.length; i++) {
      const team = await client.execute({
        sql: "SELECT name FROM teams WHERE id = ? LIMIT 1",
        args: [teamIds[i]],
      });
      const teamName = team.rows[0]?.name ?? "?";
      console.log(`    [${i}] ownership=${ownershipIds[i]}  team=${teamName} (${teamIds[i]})  price=${prices[i]}  created=${createdAts[i]}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
