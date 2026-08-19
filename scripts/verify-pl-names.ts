/**
 * Guards the PL club name maps against FPL's season renumbering.
 *
 * FPL reassigns numeric team IDs every season. When that happened for 2026-27, the ID-keyed
 * `PL_FULL_NAMES` silently returned a *different club's* name — a team that bought Man City
 * displayed as "Newcastle United" everywhere. This script cross-checks both maps against the live
 * bootstrap so the next renumber fails loudly instead of quietly mislabelling clubs.
 *
 * Run:  npx tsx scripts/verify-pl-names.ts
 * Exits non-zero on any mismatch.
 */
import {
  PL_FULL_NAMES,
  PL_FULL_NAMES_BY_SHORT,
  getPlTeamFullName,
} from "../src/lib/data/pl-team-full-names";

interface BootstrapTeam {
  id: number;
  name: string;
  short_name: string;
}

/** Loose match: the full name must plausibly be the same club as FPL's broadcast short form. */
function namesAgree(full: string, fplName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const f = norm(full);
  const n = norm(fplName);
  if (f.includes(n) || n.includes(f)) return true;
  // FPL uses colloquial forms for a handful of clubs.
  const aliases: Record<string, string> = {
    spurs: "tottenhamhotspur",
    mancity: "manchestercity",
    manutd: "manchesterunited",
    nottmforest: "nottinghamforest",
    westham: "westhamunited",
    wolves: "wolverhamptonwanderers",
    newcastle: "newcastleunited",
    leeds: "leedsunited",
    brighton: "brightonandhovealbion",
  };
  return aliases[n] === f;
}

async function main() {
  const res = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`FPL bootstrap fetch failed: ${res.status}`);
  const teams = ((await res.json()).teams ?? []) as BootstrapTeam[];
  if (teams.length === 0) throw new Error("FPL bootstrap returned no teams");

  let failures = 0;
  const fail = (msg: string) => { failures++; console.log(`FAIL  ${msg}`); };

  console.log(`Checking ${teams.length} live PL clubs\n`);

  for (const t of teams) {
    // 1. Every live club must be in the short-keyed map (the primary, season-stable lookup).
    const byShort = PL_FULL_NAMES_BY_SHORT[t.short_name];
    if (!byShort) {
      fail(`${t.short_name} (${t.name}) missing from PL_FULL_NAMES_BY_SHORT — add it`);
    } else if (!namesAgree(byShort, t.name)) {
      fail(`${t.short_name}: short map says "${byShort}", FPL says "${t.name}"`);
    }

    // 2. The ID fallback must agree for this season, or it will mislabel rows with no stored short.
    const byId = PL_FULL_NAMES[t.id];
    if (!byId) {
      fail(`id ${t.id} (${t.name}) missing from PL_FULL_NAMES`);
    } else if (!namesAgree(byId, t.name)) {
      fail(`id ${t.id}: ID map says "${byId}", FPL says "${t.name}" — FPL has renumbered, update PL_FULL_NAMES`);
    }

    // 3. The resolver itself, as the app calls it.
    const resolved = getPlTeamFullName(t.id, t.name, t.short_name);
    if (!namesAgree(resolved, t.name)) {
      fail(`getPlTeamFullName(${t.id}, "${t.name}", "${t.short_name}") = "${resolved}"`);
    }
  }

  // 4. A stale/unknown short must never fall through to a *wrong* club — only to the fallback.
  const unknown = getPlTeamFullName(999, "Some FC", "ZZZ");
  if (unknown !== "Some FC") fail(`unknown club should fall back to "Some FC", got "${unknown}"`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  // Set exitCode rather than calling process.exit(): forcing exit while undici's keep-alive socket
  // is still open trips a libuv assertion on Windows that clobbers the status with 127.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
