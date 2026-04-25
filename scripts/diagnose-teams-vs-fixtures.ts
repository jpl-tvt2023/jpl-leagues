import "dotenv/config";
import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_CONNECTION_URL not set");

  const client = createClient({ url, authToken });

  const leagues = await client.execute({
    sql: "SELECT id, slug, name, format FROM leagues ORDER BY slug",
    args: [],
  });

  console.log("league / teams in teams table / distinct teamIds referenced by fixtures / overlap");
  console.log("=".repeat(100));

  for (const l of leagues.rows) {
    const leagueId = l.id as string;
    const slug = l.slug as string;

    const teamsInTable = await client.execute({
      sql: "SELECT id, name, is_ghost FROM teams WHERE league_id = ?",
      args: [leagueId],
    });

    const refs = await client.execute({
      sql: `
        SELECT DISTINCT team_id FROM (
          SELECT f.home_team_id AS team_id FROM fixtures f JOIN gameweeks gw ON gw.id = f.gameweek_id WHERE gw.league_id = ?
          UNION
          SELECT f.away_team_id AS team_id FROM fixtures f JOIN gameweeks gw ON gw.id = f.gameweek_id WHERE gw.league_id = ?
        )
      `,
      args: [leagueId, leagueId],
    });

    const teamIdsInTable = new Set(teamsInTable.rows.map((r) => r.id as string));
    const refIds = refs.rows.map((r) => r.team_id as string);
    const overlap = refIds.filter((id) => teamIdsInTable.has(id)).length;
    const missing = refIds.filter((id) => !teamIdsInTable.has(id));

    console.log(`${slug.padEnd(25)} teams_rows=${String(teamsInTable.rows.length).padEnd(4)} fx_team_refs=${String(refIds.length).padEnd(4)} overlap=${String(overlap).padEnd(4)} missing=${missing.length}`);

    if (teamsInTable.rows.length > 0 && teamsInTable.rows.length <= 4) {
      for (const t of teamsInTable.rows) {
        console.log(`    team row: id=${t.id} name=${t.name} ghost=${t.is_ghost}`);
      }
    } else if (teamsInTable.rows.length > 0) {
      console.log(`    (sample) ${teamsInTable.rows.slice(0, 3).map((t) => `${t.id}:${t.name}`).join(", ")} ...`);
    }
    if (missing.length > 0 && missing.length <= 4) {
      for (const id of missing) console.log(`    missing ref: ${id}`);
    }
  }

  // Also: are there teams in `teams` whose league_id points nowhere, or whose league_id differs?
  console.log("=".repeat(100));
  const orphanTeams = await client.execute({
    sql: `
      SELECT t.id, t.league_id, t.name
      FROM teams t
      LEFT JOIN leagues l ON l.id = t.league_id
      WHERE l.id IS NULL
    `,
    args: [],
  });
  console.log(`Teams with invalid league_id: ${orphanTeams.rows.length}`);
  for (const r of orphanTeams.rows.slice(0, 5)) {
    console.log(`    id=${r.id} league_id=${r.league_id} name=${r.name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
