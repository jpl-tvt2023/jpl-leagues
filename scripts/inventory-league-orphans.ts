import "dotenv/config";
import { createClient } from "@libsql/client";

// Tables with a direct league_id column (by schema inspection).
const DIRECT_LEAGUE_TABLES = [
  "league_admins",
  "groups",
  "teams",
  "gameweeks",
  "playoff_ties",
  "settings",
  "auction_ownership",
  "auction_scores",
  "auction_sessions",
  "auction_wishlists",
  "auction_bids",
  "team_penalties",
  "trade_proposals",
  "notifications",
];

// Tables joined via gameweek_id -> gameweeks.league_id
const VIA_GAMEWEEK_TABLES = [
  "fixtures",
  "gameweek_captains",
  "gameweek_chips",
  "challenger_survival_entries",
];

// Tables joined via fixture_id -> fixtures -> gameweek -> league
const VIA_FIXTURE_TABLES = ["results"];

// auction_bid_logs -> auction_bids -> auction_sessions -> league
const VIA_AUCTION_BID_TABLES = ["auction_bid_logs"];

const TARGET_SLUGS = (process.argv.slice(2).filter((a) => !a.startsWith("--")));
const APPLY = process.argv.includes("--apply");

async function main() {
  const url = process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_CONNECTION_URL not set");

  const client = createClient({ url, authToken });

  const slugList = TARGET_SLUGS.length > 0 ? TARGET_SLUGS : ["tvt-fpl", "jpl-tc"];
  console.log(`Target leagues: ${slugList.join(", ")}`);
  console.log(`Mode: ${APPLY ? "APPLY (will delete)" : "DRY-RUN (no mutations)"}`);
  console.log("=".repeat(90));

  for (const slug of slugList) {
    const lg = await client.execute({
      sql: "SELECT id, name, format FROM leagues WHERE slug = ?",
      args: [slug],
    });
    if (lg.rows.length === 0) {
      console.log(`${slug}: NOT FOUND`);
      continue;
    }
    const leagueId = lg.rows[0].id as string;
    console.log(`\n${slug} (${lg.rows[0].format}) id=${leagueId}`);

    // Direct
    for (const table of DIRECT_LEAGUE_TABLES) {
      const r = await client.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE league_id = ?`, args: [leagueId] });
      const n = (r.rows[0]?.n as number) ?? 0;
      if (n > 0) console.log(`  ${table.padEnd(30)} ${n}`);
    }

    // Via gameweeks
    for (const table of VIA_GAMEWEEK_TABLES) {
      const r = await client.execute({
        sql: `SELECT COUNT(*) AS n FROM ${table} t JOIN gameweeks gw ON gw.id = t.gameweek_id WHERE gw.league_id = ?`,
        args: [leagueId],
      });
      const n = (r.rows[0]?.n as number) ?? 0;
      if (n > 0) console.log(`  ${table.padEnd(30)} ${n}  (via gameweek)`);
    }

    // Via fixture -> gameweek
    for (const table of VIA_FIXTURE_TABLES) {
      const r = await client.execute({
        sql: `
          SELECT COUNT(*) AS n
          FROM ${table} t
          JOIN fixtures f ON f.id = t.fixture_id
          JOIN gameweeks gw ON gw.id = f.gameweek_id
          WHERE gw.league_id = ?`,
        args: [leagueId],
      });
      const n = (r.rows[0]?.n as number) ?? 0;
      if (n > 0) console.log(`  ${table.padEnd(30)} ${n}  (via fixture -> gameweek)`);
    }

    // Via auction_bid -> auction_session
    for (const table of VIA_AUCTION_BID_TABLES) {
      const r = await client.execute({
        sql: `
          SELECT COUNT(*) AS n
          FROM ${table} t
          JOIN auction_bids b ON b.id = t.bid_id
          JOIN auction_sessions s ON s.id = b.session_id
          WHERE s.league_id = ?`,
        args: [leagueId],
      });
      const n = (r.rows[0]?.n as number) ?? 0;
      if (n > 0) console.log(`  ${table.padEnd(30)} ${n}  (via auction_bid)`);
    }
  }

  if (!APPLY) {
    console.log("\n" + "=".repeat(90));
    console.log("DRY-RUN complete. Re-run with --apply to actually delete.");
    return;
  }

  console.log("\n" + "=".repeat(90));
  console.log("APPLY MODE — deleting in dependency order…");

  for (const slug of slugList) {
    const lg = await client.execute({ sql: "SELECT id FROM leagues WHERE slug = ?", args: [slug] });
    if (lg.rows.length === 0) continue;
    const leagueId = lg.rows[0].id as string;

    // Delete grandchildren first, then children, then parents.
    // Order: results -> fixtures -> gameweek_captains/chips/challenger_survival -> gameweeks
    //        playoff_ties -> groups -> teams -> team_penalties -> notifications -> settings -> auction_*
    //        league_admins last

    await client.execute({
      sql: `DELETE FROM results WHERE fixture_id IN (SELECT f.id FROM fixtures f JOIN gameweeks gw ON gw.id = f.gameweek_id WHERE gw.league_id = ?)`,
      args: [leagueId],
    });
    await client.execute({
      sql: `DELETE FROM fixtures WHERE gameweek_id IN (SELECT id FROM gameweeks WHERE league_id = ?)`,
      args: [leagueId],
    });
    await client.execute({
      sql: `DELETE FROM gameweek_captains WHERE gameweek_id IN (SELECT id FROM gameweeks WHERE league_id = ?)`,
      args: [leagueId],
    });
    await client.execute({
      sql: `DELETE FROM gameweek_chips WHERE gameweek_id IN (SELECT id FROM gameweeks WHERE league_id = ?)`,
      args: [leagueId],
    });
    await client.execute({
      sql: `DELETE FROM challenger_survival_entries WHERE gameweek_id IN (SELECT id FROM gameweeks WHERE league_id = ?)`,
      args: [leagueId],
    });
    await client.execute({ sql: `DELETE FROM gameweeks WHERE league_id = ?`, args: [leagueId] });
    await client.execute({ sql: `DELETE FROM playoff_ties WHERE league_id = ?`, args: [leagueId] });
    await client.execute({ sql: `DELETE FROM groups WHERE league_id = ?`, args: [leagueId] });
    // NOTE: NOT deleting teams for these leagues because teams_rows=0 per diagnosis.
    // If that changes for other slugs, add: DELETE FROM teams WHERE league_id = ?
    await client.execute({ sql: `DELETE FROM team_penalties WHERE league_id = ?`, args: [leagueId] });
    await client.execute({ sql: `DELETE FROM notifications WHERE league_id = ?`, args: [leagueId] });
    // Leaving settings, league_admins, and auction_* intact — these are "league config", not onboarding artifacts.

    console.log(`  ${slug}: purged fixtures/results/gameweeks/groups/playoff_ties and chip/captain/survival rows.`);
  }

  console.log("APPLY complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
