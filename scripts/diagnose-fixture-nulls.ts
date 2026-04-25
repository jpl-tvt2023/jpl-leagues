import "dotenv/config";
import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_CONNECTION_URL not set");

  const leagueSlugArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const client = createClient({ url, authToken });

  const leagues = await client.execute({
    sql: leagueSlugArg
      ? "SELECT id, slug, name, format FROM leagues WHERE slug = ?"
      : "SELECT id, slug, name, format FROM leagues",
    args: leagueSlugArg ? [leagueSlugArg] : [],
  });

  if (leagues.rows.length === 0) {
    console.log(leagueSlugArg ? `No league with slug "${leagueSlugArg}"` : "No leagues in DB");
    return;
  }

  console.log(`Scanning ${leagues.rows.length} league(s) for orphan / ghost-team fixtures`);
  console.log("=".repeat(80));

  for (const l of leagues.rows) {
    const leagueId = l.id as string;
    const slug = l.slug as string;
    const format = l.format as string;

    const orphans = await client.execute({
      sql: `
        SELECT
          f.id AS fixture_id,
          f.home_team_id,
          f.away_team_id,
          f.competition_type,
          gw.number AS gw_number,
          th.id AS home_exists,
          th.name AS home_name,
          th.is_ghost AS home_ghost,
          ta.id AS away_exists,
          ta.name AS away_name,
          ta.is_ghost AS away_ghost
        FROM fixtures f
        JOIN gameweeks gw ON gw.id = f.gameweek_id
        LEFT JOIN teams th ON th.id = f.home_team_id
        LEFT JOIN teams ta ON ta.id = f.away_team_id
        WHERE gw.league_id = ?
          AND (
               th.id IS NULL
            OR ta.id IS NULL
            OR th.name IS NULL OR th.name = ''
            OR ta.name IS NULL OR ta.name = ''
          )
      `,
      args: [leagueId],
    });

    const totalFixtures = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM fixtures f JOIN gameweeks gw ON gw.id = f.gameweek_id WHERE gw.league_id = ?`,
      args: [leagueId],
    });
    const totalCount = (totalFixtures.rows[0]?.n as number) ?? 0;

    if (orphans.rows.length === 0) {
      console.log(`OK    [${format.padEnd(13)}] ${slug} — ${totalCount} fixtures, no null / empty teams`);
      continue;
    }

    console.log(`BAD   [${format.padEnd(13)}] ${slug} — ${orphans.rows.length} of ${totalCount} fixtures have null / empty team`);
    const byKind: Record<string, number> = {
      orphan_fk_home: 0,
      orphan_fk_away: 0,
      empty_name_home: 0,
      empty_name_away: 0,
    };
    const examples: string[] = [];
    for (const r of orphans.rows) {
      const homeMissing = r.home_exists === null;
      const awayMissing = r.away_exists === null;
      const homeEmpty = !homeMissing && (r.home_name === null || r.home_name === "");
      const awayEmpty = !awayMissing && (r.away_name === null || r.away_name === "");
      if (homeMissing) byKind.orphan_fk_home++;
      if (awayMissing) byKind.orphan_fk_away++;
      if (homeEmpty) byKind.empty_name_home++;
      if (awayEmpty) byKind.empty_name_away++;
      if (examples.length < 3) {
        examples.push(
          `    fixture=${r.fixture_id} gw=${r.gw_number} comp=${r.competition_type ?? "null"} ` +
          `home=${homeMissing ? `MISSING(${r.home_team_id})` : `${r.home_name ?? "<null>"}${r.home_ghost ? " (ghost)" : ""}`} ` +
          `away=${awayMissing ? `MISSING(${r.away_team_id})` : `${r.away_name ?? "<null>"}${r.away_ghost ? " (ghost)" : ""}`}`
        );
      }
    }
    console.log(`      breakdown: ${JSON.stringify(byKind)}`);
    for (const ex of examples) console.log(ex);
  }

  console.log("=".repeat(80));
  console.log("Done. Share the output so we can pick the right Phase 1 repair branch.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
