import "dotenv/config";
import { createClient } from "@libsql/client";

/**
 * READ-ONLY. Deeper trace of Wharton in demo-auction — auction_bid_logs, session of each
 * bid, and team purse state for the supposed winners (Fulham + Crystal Palace).
 */
async function main() {
  const url = process.env.DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("DATABASE_URL or TURSO_CONNECTION_URL is required");
  const client = createClient({ url, authToken });

  const leagueId = "0058150b-9010-4582-abf2-58f89d4a865e";

  // bid_logs for any Wharton bid
  const logs = await client.execute({
    sql: `
      SELECT bl.bid_id, bl.team_id, bl.amount, bl.type, bl.created_at, t.name AS team_name
      FROM auction_bid_logs bl
      LEFT JOIN teams t ON t.id = bl.team_id
      WHERE bl.bid_id IN (
        SELECT id FROM auction_bids WHERE league_id = ? AND player_name LIKE '%harton%'
      )
      ORDER BY bl.created_at
    `,
    args: [leagueId],
  });
  console.log(`auction_bid_logs for Wharton (${logs.rows.length} rows):`);
  for (const r of logs.rows) {
    console.log(`  bid=${r.bid_id} type=${r.type} team=${r.team_name} amount=${r.amount} created=${r.created_at}`);
  }

  // What session does the "open" Wharton bid belong to?
  const openBid = await client.execute({
    sql: "SELECT id, session_id, created_at FROM auction_bids WHERE id = 'b6c42946-e832-47d9-ac31-026b6cefe2fd'",
  });
  if (openBid.rows.length > 0) {
    const sessId = String(openBid.rows[0].session_id);
    const sess = await client.execute({
      sql: "SELECT id, type, status, cycle_number, created_at FROM auction_sessions WHERE id = ?",
      args: [sessId],
    });
    console.log(`\nopen Wharton bid b6c42946… belongs to session:`);
    console.log(`  ${sess.rows[0]?.id} type=${sess.rows[0]?.type} status=${sess.rows[0]?.status}`);
  }

  // Fulham + Crystal Palace purse + totalSpent right now
  const teamIds = ["f633df8e-5045-4f5d-a511-d623b55caf97", "f371530d-3fd9-48ed-985c-f3dc9d7ef072"];
  for (const tid of teamIds) {
    const t = await client.execute({
      sql: "SELECT id, name, purse, total_spent, total_income, total_refunds FROM teams WHERE id = ?",
      args: [tid],
    });
    if (t.rows[0]) {
      console.log(`\nteam: ${t.rows[0].name} (${tid})`);
      console.log(`  purse=${t.rows[0].purse} totalSpent=${t.rows[0].total_spent} totalIncome=${t.rows[0].total_income} totalRefunds=${t.rows[0].total_refunds}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
