import "dotenv/config";
import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_CONNECTION_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_CONNECTION_URL not set");

  const client = createClient({ url, authToken });

  const exists = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'",
    args: [],
  });
  if (exists.rows.length > 0) {
    console.log("notifications table already exists — skipping");
  } else {
    await client.execute(`CREATE TABLE notifications (
  id text PRIMARY KEY NOT NULL,
  team_id text NOT NULL,
  league_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  link text,
  read_at integer,
  created_at integer NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id),
  FOREIGN KEY (league_id) REFERENCES leagues(id)
)`);
    console.log("Created notifications table");
  }

  const idx = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='index' AND name='notifications_team_unread'",
    args: [],
  });
  if (idx.rows.length > 0) {
    console.log("notifications_team_unread index already exists — skipping");
  } else {
    await client.execute("CREATE INDEX notifications_team_unread ON notifications (team_id, read_at)");
    console.log("Created notifications_team_unread index");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
