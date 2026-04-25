import "dotenv/config";
import { createClient } from "@libsql/client";

const url = process.env.TURSO_CONNECTION_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error("TURSO_CONNECTION_URL not set");

async function main() {
const client = createClient({ url, authToken });

const before = await client.execute({
  sql: "SELECT id, email, role FROM users WHERE email != LOWER(email)",
  args: [],
});
console.log(`Rows with mixed-case email: ${before.rows.length}`);
for (const r of before.rows) console.log(" -", r);

const res = await client.execute({
  sql: "UPDATE users SET email = LOWER(email) WHERE email != LOWER(email)",
  args: [],
});
console.log(`Rows updated: ${res.rowsAffected}`);

const after = await client.execute({
  sql: "SELECT id, email, role FROM users",
  args: [],
});
console.log("\nAll users now:");
for (const r of after.rows) console.log(" -", r);
}

main().catch((e) => { console.error(e); process.exit(1); });
