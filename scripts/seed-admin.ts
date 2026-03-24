/**
 * Platform Seed Script
 *
 * Seeds: 4 admin users, 2 leagues, league_admin assignments
 *
 * Usage: ADMIN_PASSWORD=yourpass npm run seed:admin
 *
 * All admins are seeded with the same temporary password and will be
 * prompted to set their own password on first login.
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { users, leagues, leagueAdmins } from "../src/lib/db/schema";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";

const client = createClient({
  url: process.env.TURSO_CONNECTION_URL || "file:./tvt-league.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const db = drizzle(client);

async function seed() {
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    console.error("\n❌  ADMIN_PASSWORD environment variable is required.");
    console.error("   Usage: ADMIN_PASSWORD=yourSecurePassword npm run seed:admin\n");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("\n❌  Password must be at least 8 characters.\n");
    process.exit(1);
  }

  console.log("\n🌱  Seeding JPL Sports platform...\n");

  const hashed = await bcrypt.hash(password, 12);

  // ---- 1. Admin users ----
  const adminUsers = [
    { id: randomUUID(), email: "rahul@jplindia.com",    name: "Rahul",    role: "superadmin" },
    { id: randomUUID(), email: "sushank@jplindia.com",  name: "Sushank",  role: "admin" },
    { id: randomUUID(), email: "yashasva@jplindia.com", name: "Yashasva", role: "admin" },
    { id: randomUUID(), email: "aadi@jplindia.com",     name: "Aadi",     role: "admin" },
  ];

  const insertedUsers: { id: string; role: string; name: string }[] = [];
  for (const u of adminUsers) {
    try {
      await db.insert(users).values({ ...u, password: hashed, mustChangePassword: true });
      insertedUsers.push(u);
      console.log(`  ✓ User: ${u.name} <${u.email}> (${u.role})`);
    } catch {
      console.log(`  ⚠️  User ${u.email} already exists — skipping`);
    }
  }

  // ---- 2. Leagues ----
  const leagueRows = [
    {
      id: randomUUID(),
      slug: "tvt-fpl",
      name: "JPL TVT FPL",
      sport: "fpl",
      format: "tvt",
      season: "2025-26",
      isActive: true,
    },
    {
      id: randomUUID(),
      slug: "tvt-cricket",
      name: "JPL TVT Cricket",
      sport: "cricket",
      format: "tvt",
      season: "IPL 2026",
      isActive: true,
    },
  ];

  const insertedLeagues: { id: string; slug: string }[] = [];
  for (const l of leagueRows) {
    try {
      await db.insert(leagues).values(l);
      insertedLeagues.push({ id: l.id, slug: l.slug });
      console.log(`  ✓ League: ${l.name} (${l.slug})`);
    } catch {
      console.log(`  ⚠️  League ${l.slug} already exists — skipping`);
    }
  }

  // ---- 3. league_admins assignments (non-superadmin users × all leagues) ----
  const scopedUsers = insertedUsers.filter(u => u.role !== "superadmin");
  for (const league of insertedLeagues) {
    for (const user of scopedUsers) {
      try {
        await db.insert(leagueAdmins).values({
          id: randomUUID(),
          leagueId: league.id,
          userId: user.id,
        });
        console.log(`  ✓ Assigned ${user.name} → ${league.slug}`);
      } catch {
        // already assigned
      }
    }
  }

  console.log("\n✅  Seed complete!");
  console.log("   Admins sign in at /signin with their email + the shared password.");
  console.log("   Each admin will be prompted to set their own password on first login.");
  console.log("   Superadmin (Rahul): full platform access.");
  console.log("   Admins (Sushank, Yashasva, Aadi): scoped to assigned leagues.\n");
}

seed().catch(console.error);
