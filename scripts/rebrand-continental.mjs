// One-off rebrand pass: rename internal token VALUES for the Continental Championship rebrand.
// Only exact, unambiguous substrings are replaced (format value, knockout tokens, and
// field-qualified "pl" comparisons). Context-sensitive tokens (category, cupZone, display
// labels, routes) are handled separately by hand.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "tests"];
const EXT = new Set([".ts", ".tsx"]);

// Order matters only in that each pair is an exact substring swap.
const REPLACEMENTS = [
  ['/uefa-standings', '/jpl-cup-standings'],
  ['/uefa-fixtures', '/jpl-cup-fixtures'],
  ['"uefa-standings"', '"jpl-cup-standings"'],
  ['"uefa-fixtures"', '"jpl-cup-fixtures"'],
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (EXT.has(p.slice(p.lastIndexOf(".")))) out.push(p);
  }
}

const files = [];
for (const r of ROOTS) {
  try { walk(r, files); } catch { /* tests dir may not exist */ }
}

let totalFiles = 0;
let totalHits = 0;
for (const f of files) {
  let txt = readFileSync(f, "utf8");
  let fileHits = 0;
  for (const [from, to] of REPLACEMENTS) {
    if (txt.includes(from)) {
      const count = txt.split(from).length - 1;
      txt = txt.split(from).join(to);
      fileHits += count;
    }
  }
  if (fileHits > 0) {
    writeFileSync(f, txt);
    totalFiles++;
    totalHits += fileHits;
    console.log(`${fileHits}\t${f}`);
  }
}
console.log(`\n[rebrand] ${totalHits} replacements across ${totalFiles} files`);
