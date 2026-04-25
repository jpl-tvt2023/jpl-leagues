import "dotenv/config";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { users } from "../src/lib/db/schema";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const DEV_SUPERADMIN = {
  email: "dev@jplindia.local",
  name: "Dev Superadmin",
  password: "devpassword",
};

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.startsWith("file:")) {
    throw new Error(
      `dev-seed.ts refuses to run unless DATABASE_URL is file: (got ${dbUrl ?? "<unset>"}). This script is dev-only.`
    );
  }

  const client = createClient({ url: dbUrl });
  const db = drizzle(client);

  const existing = await db.select().from(users).where(eq(users.email, DEV_SUPERADMIN.email)).limit(1);
  if (existing.length > 0) {
    console.log(`Superadmin ${DEV_SUPERADMIN.email} already exists — skipping.`);
    console.log(`Sign in with: ${DEV_SUPERADMIN.email} / ${DEV_SUPERADMIN.password}`);
    return;
  }

  const hashed = await bcrypt.hash(DEV_SUPERADMIN.password, 12);
  await db.insert(users).values({
    id: randomUUID(),
    email: DEV_SUPERADMIN.email,
    name: DEV_SUPERADMIN.name,
    password: hashed,
    role: "superadmin",
    mustChangePassword: false,
  });

  console.log(`Seeded superadmin: ${DEV_SUPERADMIN.email} / ${DEV_SUPERADMIN.password}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
