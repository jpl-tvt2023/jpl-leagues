import "dotenv/config";
import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_CONNECTION_URL not set");
  console.log(`DB: ${url.replace(/\/\/[^.]*\./, "//***.")}`);

  const client = createClient({ url, authToken });

  const total = await client.execute({ sql: "SELECT COUNT(*) AS n FROM teams", args: [] });
  console.log(`Total team rows in DB: ${total.rows[0]?.n}`);

  const byLeague = await client.execute({
    sql: `SELECT league_id, COUNT(*) AS n, SUM(CASE WHEN is_ghost THEN 1 ELSE 0 END) AS ghosts FROM teams GROUP BY league_id`,
    args: [],
  });
  for (const r of byLeague.rows) {
    const lg = await client.execute({ sql: "SELECT slug FROM leagues WHERE id = ?", args: [r.league_id as string] });
    console.log(`  league_id=${r.league_id} (${lg.rows[0]?.slug ?? "UNKNOWN"}) teams=${r.n} ghosts=${r.ghosts}`);
  }

  // Are there team IDs referenced by fixtures that exist anywhere in teams (even wrong league)?
  const sampleRefs = await client.execute({
    sql: `
      SELECT DISTINCT f.home_team_id AS id
      FROM fixtures f
      JOIN gameweeks gw ON gw.id = f.gameweek_id
      JOIN leagues l ON l.id = gw.league_id
      WHERE l.slug IN ('tvt-fpl', 'jpl-tc')
      LIMIT 20
    `,
    args: [],
  });
  const ids = sampleRefs.rows.map((r) => r.id as string);
  console.log(`\nSample fixture.home_team_id values from tvt-fpl / jpl-tc:`);
  for (const id of ids) {
    const hit = await client.execute({ sql: "SELECT id, name, league_id FROM teams WHERE id = ?", args: [id] });
    if (hit.rows.length === 0) {
      console.log(`  ${id} -> NOT in teams table at all`);
    } else {
      console.log(`  ${id} -> ${hit.rows[0].name} (league ${hit.rows[0].league_id})`);
    }
  }

  // Tables with "team" data — maybe teams were renamed or moved?
  const tables = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%team%'",
    args: [],
  });
  console.log(`\nTables matching %team%: ${tables.rows.map((r) => r.name).join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
