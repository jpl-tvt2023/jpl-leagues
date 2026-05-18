// Verify the 0006 migration: schema columns present, defaults populated on existing rows,
// and the standings seed (auto-applied on first GET) hasn't been seeded yet (we want the API to
// own that on first visit).

import { createClient } from "@libsql/client";

function resolveConfig(): { url: string; authToken?: string } {
  const direct = process.env.DATABASE_URL;
  if (direct) {
    if (direct.startsWith("file:")) return { url: direct };
    if (direct.startsWith("libsql://") || direct.startsWith("https://")) {
      return { url: direct, authToken: process.env.TURSO_AUTH_TOKEN };
    }
  }
  const turso = process.env.TURSO_CONNECTION_URL;
  if (!turso) throw new Error("Set DATABASE_URL or TURSO_CONNECTION_URL");
  return { url: turso, authToken: process.env.TURSO_AUTH_TOKEN };
}

async function main() {
  const cfg = resolveConfig();
  const target = cfg.url.startsWith("file:") ? "dev" : "prod";
  const client = createClient(cfg);

  console.log(`Verifying ${target} (${cfg.url})\n`);

  // 1. New tables exist
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('auction_club_ownership','pl_standings_config') ORDER BY name");
  console.log("1) New tables:", tables.rows.map((r) => r.name));

  // 2. auction_scores has the 3 new columns
  const cols = await client.execute("PRAGMA table_info(auction_scores)");
  const colNames = cols.rows.map((r) => r.name);
  const newCols = ["raw_points", "synergy_bonus", "club_result_bonus"].filter((c) => colNames.includes(c));
  console.log("2) auction_scores new columns:", newCols);

  // 3. leagues has the new toggle column
  const leagueCols = await client.execute("PRAGMA table_info(leagues)");
  const hasClubFlag = leagueCols.rows.map((r) => r.name).includes("club_auction_enabled");
  console.log("3) leagues.club_auction_enabled present:", hasClubFlag);

  // 4. Existing auction_scores rows have default values populated
  const scoreCount = await client.execute("SELECT COUNT(*) AS c FROM auction_scores");
  const totalScores = Number(scoreCount.rows[0]?.c ?? 0);
  if (totalScores > 0) {
    const sample = await client.execute("SELECT raw_points, synergy_bonus, club_result_bonus FROM auction_scores LIMIT 3");
    console.log(`4) auction_scores has ${totalScores} rows; sample defaults:`);
    for (const r of sample.rows) console.log("   ", r);
  } else {
    console.log("4) auction_scores is empty (dev DB)");
  }

  // 5. Existing leagues rows have the toggle defaulted to 0/false
  const leagueRows = await client.execute("SELECT id, slug, club_auction_enabled FROM leagues");
  console.log(`5) leagues (${leagueRows.rows.length} rows):`);
  for (const r of leagueRows.rows) {
    console.log(`    ${String(r.slug).padEnd(28)} clubAuctionEnabled=${r.club_auction_enabled}`);
  }

  // 6. pl_standings_config — should be empty until first API hit
  const cfgRows = await client.execute("SELECT id, season FROM pl_standings_config");
  console.log(`6) pl_standings_config: ${cfgRows.rows.length} rows (expect 0 until first /api/superadmin/pl-standings GET)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
