import "dotenv/config";
import { createClient } from "@libsql/client";

/**
 * READ-ONLY. Surfaces every auction_bids row touching Wharton in the demo-auction league
 * + current ownership state. Used to reconcile the user-reported double-sell vs. an
 * empty integrity scan (the live feed showed two SOLD events but the DB has no dups —
 * we want to know exactly what the DB recorded).
 */
async function main() {
  const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("DATABASE_URL or TURSO_CONNECTION_URL is required");
  const client = createClient({ url, authToken });

  // 1) Locate demo-auction
  const league = await client.execute("SELECT id, slug, name FROM leagues WHERE slug = 'demo-auction' LIMIT 1");
  if (league.rows.length === 0) {
    console.log("No league 'demo-auction' found.");
    return;
  }
  const leagueId = String(league.rows[0].id);
  console.log(`league: ${leagueId} (${league.rows[0].slug})\n`);

  // 2) Find Wharton by name (search bid history for any player matching)
  const bids = await client.execute({
    sql: `
      SELECT b.id AS bid_id, b.session_id, b.fpl_element_id, b.player_name, b.status,
             b.current_high_bid, b.current_high_bidder_id, b.nominator_team_id,
             b.created_at, b.updated_at
      FROM auction_bids b
      WHERE b.league_id = ? AND b.player_name LIKE '%harton%'
      ORDER BY b.created_at DESC
    `,
    args: [leagueId],
  });

  console.log(`auction_bids matching 'Wharton' in demo-auction (${bids.rows.length} rows):`);
  for (const r of bids.rows) {
    console.log(`  bid=${r.bid_id} status=${r.status} fpl=${r.fpl_element_id} player=${r.player_name} price=${r.current_high_bid} winner=${r.current_high_bidder_id} created=${r.created_at} updated=${r.updated_at}`);
  }

  // 3) Active ownership of Wharton (by fplElementId taken from the bids above)
  if (bids.rows.length > 0) {
    const fplIds = [...new Set(bids.rows.map((r) => Number(r.fpl_element_id)))];
    for (const fplId of fplIds) {
      const own = await client.execute({
        sql: `
          SELECT o.id, o.team_id, o.purchase_price, o.acquired_gw, o.status, o.created_at, o.released_gw,
                 t.name AS team_name
          FROM auction_ownership o
          LEFT JOIN teams t ON t.id = o.team_id
          WHERE o.league_id = ? AND o.fpl_element_id = ?
          ORDER BY o.created_at
        `,
        args: [leagueId, fplId],
      });
      console.log(`\nauction_ownership rows for fpl_element_id=${fplId} (${own.rows.length} row(s)):`);
      for (const r of own.rows) {
        console.log(`  ownership=${r.id} team=${r.team_name} (${r.team_id}) price=${r.purchase_price} status=${r.status} acquiredGw=${r.acquired_gw} releasedGw=${r.released_gw} created=${r.created_at}`);
      }
    }
  }

  // 4) Active session for context
  const sessions = await client.execute({
    sql: "SELECT id, type, status, cycle_number, created_at FROM auction_sessions WHERE league_id = ? ORDER BY created_at DESC LIMIT 5",
    args: [leagueId],
  });
  console.log(`\nrecent sessions:`);
  for (const r of sessions.rows) {
    console.log(`  ${r.id} type=${r.type} status=${r.status} cycle=${r.cycle_number} created=${r.created_at}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
