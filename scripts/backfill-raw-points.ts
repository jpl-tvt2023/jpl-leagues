// One-off backfill for legacy auction_scores rows that pre-date the PL Club Auction columns.
//
// Before 0006, `auction_scores.total_points` was the only points column. The 0006 migration added
// `raw_points`, `synergy_bonus`, `club_result_bonus` with DEFAULT 0 — so existing rows now show
// raw_points=0 + total_points=(real). For any pre-club-auction GW, synergy=0 and clubResult=0 by
// definition (no team owned a PL club yet), so raw_points must equal total_points.
//
// This script idempotently sets raw_points = total_points for rows where raw_points = 0 and
// total_points > 0, leaving any actively-scored club-auction rows untouched.

import { createClient } from "@libsql/client";

function resolveConfig(): { url: string; authToken?: string } {
  const direct = process.env.DATABASE_URL;
  if (direct) {
    if (direct.startsWith("file:")) return { url: direct };
    if (direct.startsWith("libsql://") || direct.startsWith("https://")) {
      return { url: direct, authToken: process.env.TURSO_AUTH_TOKEN };
    }
  }
  const turso = process.env.TURSO_CONNECTION_URL;
  if (!turso) throw new Error("Set DATABASE_URL or TURSO_CONNECTION_URL");
  return { url: turso, authToken: process.env.TURSO_AUTH_TOKEN };
}

async function main() {
  const cfg = resolveConfig();
  const target = cfg.url.startsWith("file:") ? "dev" : "prod";
  console.log(`Backfilling raw_points on ${target} (${cfg.url})`);

  const client = createClient(cfg);

  const before = await client.execute(
    "SELECT COUNT(*) AS c FROM auction_scores WHERE raw_points = 0 AND total_points > 0"
  );
  const candidates = Number(before.rows[0]?.c ?? 0);
  console.log(`Candidates: ${candidates} row(s) with raw_points=0 and total_points>0`);

  if (candidates === 0) {
    console.log("Nothing to backfill — done.");
    return;
  }

  const result = await client.execute(
    "UPDATE auction_scores SET raw_points = total_points WHERE raw_points = 0 AND total_points > 0"
  );
  console.log(`Updated: ${result.rowsAffected} row(s)`);

  const after = await client.execute(
    "SELECT COUNT(*) AS c FROM auction_scores WHERE raw_points = 0 AND total_points > 0"
  );
  console.log(`Remaining candidates: ${Number(after.rows[0]?.c ?? 0)} (should be 0)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
