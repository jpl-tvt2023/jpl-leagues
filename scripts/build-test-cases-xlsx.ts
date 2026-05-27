/**
 * Build the master test-case workbook from per-module JSON sources.
 *
 * Reads every file in test-cases/sources/, validates the schema, then writes
 * test-cases/jpl-leagues-test-cases.xlsx using the existing `xlsx` (SheetJS)
 * dependency. Produces:
 *   - Cover           project metadata + totals
 *   - Table of Contents
 *   - Traceability Matrix (Requirement ID → Test Case IDs)
 *   - Test Summary    aggregate counts
 *   - <one sheet per module>
 *
 * Run with: npm run test-cases:build
 */

import "dotenv/config";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

// ---------- Types matching the JSON source schema ----------

type ModuleStatus = "ba-drafting" | "qa-writing" | "qa-signed-off";

interface UserStory {
  id: string;
  asA: string;
  iWant: string;
  soThat: string;
  sourceRefs?: string[];
}

interface BusinessRule {
  id: string;
  rule: string;
  sourceRefs?: string[];
}

interface AcceptanceCriterion {
  id: string;
  given: string;
  when: string;
  then: string;
  linksTo: string;
}

interface TestCase {
  id: string;
  feature: string;
  scenario: string;
  type: string;
  priority: string;
  preconditions: string;
  testData: string;
  testSteps: string[];
  expectedResult: string;
  postconditions: string;
  requirementId: string;
  author: string;
  createdDate: string;
  status: string;
  notes: string;
}

interface GapFlag {
  id: string;
  raisedBy: string;
  raisedDate: string;
  against: string;
  issue: string;
  resolution: string | null;
}

interface Defect {
  id: string;
  title: string;
  severity: string;
  status: string;
  discoveredBy: string;
  discoveredDate: string;
  description: string;
  expectedBehaviour: string;
  actualBehaviour: string;
  sourceRefs: string[];
  linkedBusinessRules?: string[];
  linkedAcceptanceCriteria?: string[];
  linkedGapFlags?: string[];
  pinningTestCases?: string[];
  notes?: string;
  resolution?: string | null;
  resolutionDate?: string | null;
}

interface ModuleFile {
  moduleId: string;
  moduleName: string;
  sheetName: string;
  status: ModuleStatus;
  owners: { ba: string; qa: string };
  requirements: {
    version: number;
    businessContext: string;
    userStories: UserStory[];
    businessRules: BusinessRule[];
    acceptanceCriteria: AcceptanceCriterion[];
  };
  testCases: TestCase[];
  gapFlags: GapFlag[];
  defects?: Defect[];
}

// Stakeholder-facing companion record for a single defect. The engineer-facing
// record lives on the per-module JSON; this layer is plain English only.
interface LaymanEntry {
  title: string;
  summary: string;
  fix: string;
  example: string | null;
}
type LaymanFile = Record<string, LaymanEntry>;

// ---------- Validation ----------

const TEST_CASE_TYPES = new Set(["Positive", "Negative", "Edge", "Boundary", "Smoke", "Regression"]);
const PRIORITIES = new Set(["P1", "P2", "P3"]);
const STATUSES = new Set(["Not Executed", "Pass", "Fail", "Blocked"]);
const DEFECT_SEVERITIES = new Set(["Critical", "Major", "Minor", "Cosmetic"]);
const DEFECT_STATUSES = new Set(["Open", "Triage", "Confirmed", "Fixed", "Wont Fix", "Accepted", "Duplicate"]);
const OPEN_DEFECT_STATUSES = new Set(["Open", "Triage", "Confirmed"]);

function validateModule(file: string, mod: ModuleFile): string[] {
  const errs: string[] = [];
  const req = (k: keyof ModuleFile, v: unknown) => {
    if (v === undefined || v === null) errs.push(`${file}: missing field "${String(k)}"`);
  };
  req("moduleId", mod.moduleId);
  req("moduleName", mod.moduleName);
  req("sheetName", mod.sheetName);
  req("status", mod.status);
  req("requirements", mod.requirements);
  req("testCases", mod.testCases);

  if (mod.sheetName && mod.sheetName.length > 31) {
    errs.push(`${file}: sheetName "${mod.sheetName}" exceeds Excel's 31-char limit`);
  }

  // Collect requirement IDs for traceability checks
  const reqIds = new Set<string>();
  (mod.requirements?.userStories ?? []).forEach((s, i) => {
    if (!s.id) errs.push(`${file}: userStories[${i}] missing id`);
    else reqIds.add(s.id);
  });
  (mod.requirements?.businessRules ?? []).forEach((r, i) => {
    if (!r.id) errs.push(`${file}: businessRules[${i}] missing id`);
    else reqIds.add(r.id);
  });
  (mod.requirements?.acceptanceCriteria ?? []).forEach((a, i) => {
    if (!a.id) errs.push(`${file}: acceptanceCriteria[${i}] missing id`);
    else reqIds.add(a.id);
  });

  // Test cases
  const tcIds = new Set<string>();
  (mod.testCases ?? []).forEach((tc, i) => {
    const where = `${file}: testCases[${i}] (${tc.id ?? "<missing id>"})`;
    if (!tc.id) errs.push(`${where} missing id`);
    else if (tcIds.has(tc.id)) errs.push(`${where} duplicate id`);
    else tcIds.add(tc.id);

    if (!tc.scenario) errs.push(`${where} missing scenario`);
    if (!tc.testSteps || tc.testSteps.length === 0) errs.push(`${where} missing/empty testSteps`);
    if (!tc.expectedResult) errs.push(`${where} missing expectedResult`);
    if (tc.type && !TEST_CASE_TYPES.has(tc.type)) {
      errs.push(`${where} unknown type "${tc.type}" (expected one of ${[...TEST_CASE_TYPES].join(", ")})`);
    }
    if (tc.priority && !PRIORITIES.has(tc.priority)) {
      errs.push(`${where} unknown priority "${tc.priority}" (expected P1/P2/P3)`);
    }
    if (tc.status && !STATUSES.has(tc.status)) {
      errs.push(`${where} unknown status "${tc.status}"`);
    }
    if (tc.requirementId && !reqIds.has(tc.requirementId)) {
      errs.push(`${where} requirementId "${tc.requirementId}" does not exist in this module's requirements`);
    }
  });

  // Defects (optional array)
  const defectIds = new Set<string>();
  (mod.defects ?? []).forEach((d, i) => {
    const where = `${file}: defects[${i}] (${d.id ?? "<missing id>"})`;
    if (!d.id) errs.push(`${where} missing id`);
    else if (defectIds.has(d.id)) errs.push(`${where} duplicate id`);
    else defectIds.add(d.id);
    if (!d.title) errs.push(`${where} missing title`);
    if (d.severity && !DEFECT_SEVERITIES.has(d.severity)) {
      errs.push(`${where} unknown severity "${d.severity}" (expected one of ${[...DEFECT_SEVERITIES].join(", ")})`);
    }
    if (d.status && !DEFECT_STATUSES.has(d.status)) {
      errs.push(`${where} unknown status "${d.status}" (expected one of ${[...DEFECT_STATUSES].join(", ")})`);
    }
    // Validate cross-references against this module's IDs.
    (d.linkedBusinessRules ?? []).forEach((rid) => {
      if (!reqIds.has(rid)) errs.push(`${where} linkedBusinessRules entry "${rid}" not found in this module's requirements`);
    });
    (d.linkedAcceptanceCriteria ?? []).forEach((rid) => {
      if (!reqIds.has(rid)) errs.push(`${where} linkedAcceptanceCriteria entry "${rid}" not found in this module's requirements`);
    });
    (d.pinningTestCases ?? []).forEach((tcid) => {
      if (!tcIds.has(tcid)) errs.push(`${where} pinningTestCases entry "${tcid}" not found in this module's testCases`);
    });
  });

  return errs;
}

// ---------- Sheet builders ----------

const TC_COLUMNS = [
  "Test Case ID",
  "Module",
  "Feature",
  "Scenario",
  "Type",
  "Priority",
  "Pre-conditions",
  "Test Data",
  "Test Steps",
  "Expected Result",
  "Post-conditions",
  "Requirement ID",
  "Author",
  "Created Date",
  "Status",
  "Notes",
];

function moduleSheetRows(mod: ModuleFile): Record<string, string>[] {
  return mod.testCases.map((tc) => ({
    "Test Case ID": tc.id,
    "Module": mod.moduleName,
    "Feature": tc.feature ?? "",
    "Scenario": tc.scenario ?? "",
    "Type": tc.type ?? "",
    "Priority": tc.priority ?? "",
    "Pre-conditions": tc.preconditions ?? "",
    "Test Data": tc.testData ?? "",
    "Test Steps": Array.isArray(tc.testSteps) ? tc.testSteps.join("\n") : "",
    "Expected Result": tc.expectedResult ?? "",
    "Post-conditions": tc.postconditions ?? "",
    "Requirement ID": tc.requirementId ?? "",
    "Author": tc.author ?? "",
    "Created Date": tc.createdDate ?? "",
    "Status": tc.status ?? "Not Executed",
    "Notes": tc.notes ?? "",
  }));
}

function applyCommonSheetStyle(sheet: XLSX.WorkSheet, columnCount: number, dataRowCount: number) {
  // Freeze the header row
  (sheet as { ["!freeze"]?: unknown })["!freeze"] = { xSplit: 0, ySplit: 1 };
  // Auto-filter the data range
  if (dataRowCount > 0) {
    const lastColLetter = XLSX.utils.encode_col(columnCount - 1);
    sheet["!autofilter"] = { ref: `A1:${lastColLetter}${dataRowCount + 1}` };
  }
}

function setColumnWidths(sheet: XLSX.WorkSheet, widths: number[]) {
  sheet["!cols"] = widths.map((wch) => ({ wch }));
}

function buildCoverSheet(modules: ModuleFile[]): XLSX.WorkSheet {
  const totalCases = modules.reduce((s, m) => s + m.testCases.length, 0);
  const signedOff = modules.filter((m) => m.status === "qa-signed-off").length;
  const allDefects = modules.flatMap((m) => m.defects ?? []);
  const openDefects = allDefects.filter((d) => OPEN_DEFECT_STATUSES.has(d.status)).length;
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const rows = [
    ["JPL-Leagues — Test Case Workbook"],
    [],
    ["Application", "JPL-Leagues (Next.js + Drizzle + Turso/SQLite)"],
    ["Repository", "github.com/<org>/JPL-Leagues"],
    ["Document version", "Generated"],
    ["Generated at", generatedAt],
    [],
    ["Modules covered", modules.length],
    ["Modules signed off", `${signedOff} / ${modules.length}`],
    ["Total test cases", totalCases],
    ["Total defects", allDefects.length],
    ["Open defects", openDefects],
    [],
    ["Authors", "business-analyst agent + qa-tester agent (Claude Code)"],
    ["Build tool", "scripts/build-test-cases-xlsx.ts"],
    [],
    ["Sign-off"],
    ["Module", "Status", "Cases", "Defects (open/total)", "Last updated"],
    ...modules.map((m) => {
      const defs = m.defects ?? [];
      const open = defs.filter((d) => OPEN_DEFECT_STATUSES.has(d.status)).length;
      return [m.moduleName, m.status, m.testCases.length, `${open} / ${defs.length}`, ""];
    }),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  setColumnWidths(sheet, [32, 28, 12, 22, 24]);
  return sheet;
}

function buildTocSheet(modules: ModuleFile[]): XLSX.WorkSheet {
  const rows = modules.map((m, i) => {
    const defs = m.defects ?? [];
    return {
      "#": i + 1,
      "Module": m.moduleName,
      "Sheet": m.sheetName,
      "Status": m.status,
      "Cases": m.testCases.length,
      "User Stories": m.requirements.userStories.length,
      "Business Rules": m.requirements.businessRules.length,
      "Acceptance Criteria": m.requirements.acceptanceCriteria.length,
      "Open Gaps": m.gapFlags.filter((g) => g.resolution == null).length,
      "Open Defects": defs.filter((d) => OPEN_DEFECT_STATUSES.has(d.status)).length,
      "Total Defects": defs.length,
    };
  });
  const sheet = XLSX.utils.json_to_sheet(rows);
  setColumnWidths(sheet, [4, 32, 22, 16, 8, 14, 16, 22, 12, 14, 14]);
  applyCommonSheetStyle(sheet, 11, rows.length);
  return sheet;
}

function buildTraceabilitySheet(modules: ModuleFile[]): XLSX.WorkSheet {
  type Row = { "Module": string; "Requirement ID": string; "Requirement Type": string; "Description": string; "Test Case IDs": string; "# Cases": number };
  const rows: Row[] = [];

  for (const m of modules) {
    // Build a map: requirementId -> [TC IDs]
    const tcByReq = new Map<string, string[]>();
    for (const tc of m.testCases) {
      if (!tc.requirementId) continue;
      const list = tcByReq.get(tc.requirementId) ?? [];
      list.push(tc.id);
      tcByReq.set(tc.requirementId, list);
    }

    for (const s of m.requirements.userStories) {
      const tcs = tcByReq.get(s.id) ?? [];
      rows.push({
        "Module": m.moduleName,
        "Requirement ID": s.id,
        "Requirement Type": "User Story",
        "Description": `${s.asA ?? ""} | ${s.iWant ?? ""}`.slice(0, 240),
        "Test Case IDs": tcs.join(", "),
        "# Cases": tcs.length,
      });
    }
    for (const r of m.requirements.businessRules) {
      const tcs = tcByReq.get(r.id) ?? [];
      rows.push({
        "Module": m.moduleName,
        "Requirement ID": r.id,
        "Requirement Type": "Business Rule",
        "Description": (r.rule ?? "").slice(0, 240),
        "Test Case IDs": tcs.join(", "),
        "# Cases": tcs.length,
      });
    }
    for (const a of m.requirements.acceptanceCriteria) {
      const tcs = tcByReq.get(a.id) ?? [];
      rows.push({
        "Module": m.moduleName,
        "Requirement ID": a.id,
        "Requirement Type": "Acceptance Criterion",
        "Description": `Given ${a.given} | When ${a.when} | Then ${a.then}`.slice(0, 240),
        "Test Case IDs": tcs.join(", "),
        "# Cases": tcs.length,
      });
    }
  }

  const sheet = XLSX.utils.json_to_sheet(rows);
  setColumnWidths(sheet, [26, 16, 20, 80, 30, 10]);
  applyCommonSheetStyle(sheet, 6, rows.length);
  return sheet;
}

function buildSummarySheet(modules: ModuleFile[]): XLSX.WorkSheet {
  const countBy = <T extends string>(arr: TestCase[], key: keyof TestCase) => {
    const m = new Map<T, number>();
    for (const tc of arr) {
      const k = (tc[key] || "<unset>") as T;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };

  const allCases = modules.flatMap((m) => m.testCases);
  const byType = countBy<string>(allCases, "type");
  const byPrio = countBy<string>(allCases, "priority");
  const byStatus = countBy<string>(allCases, "status");

  const rows: (string | number)[][] = [];
  rows.push(["Aggregate Test Case Counts"]);
  rows.push([]);
  rows.push(["Total cases", allCases.length]);
  rows.push([]);
  rows.push(["By Type"]);
  for (const [k, v] of [...byType.entries()].sort()) rows.push([k, v]);
  rows.push([]);
  rows.push(["By Priority"]);
  for (const [k, v] of [...byPrio.entries()].sort()) rows.push([k, v]);
  rows.push([]);
  rows.push(["By Execution Status"]);
  for (const [k, v] of [...byStatus.entries()].sort()) rows.push([k, v]);
  rows.push([]);
  rows.push(["Per-Module"]);
  rows.push(["Module", "Cases", "P1", "P2", "P3", "Positive", "Negative", "Edge", "Boundary"]);
  for (const m of modules) {
    const c = m.testCases;
    rows.push([
      m.moduleName,
      c.length,
      c.filter((t) => t.priority === "P1").length,
      c.filter((t) => t.priority === "P2").length,
      c.filter((t) => t.priority === "P3").length,
      c.filter((t) => t.type === "Positive").length,
      c.filter((t) => t.type === "Negative").length,
      c.filter((t) => t.type === "Edge").length,
      c.filter((t) => t.type === "Boundary").length,
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  setColumnWidths(sheet, [32, 10, 8, 8, 8, 12, 12, 10, 12]);
  return sheet;
}

const DEFECT_COLUMNS = [
  "Defect ID",
  "Module",
  "Title",
  "Severity",
  "Status",
  "Discovered By",
  "Discovered Date",
  "Description",
  "Expected Behaviour",
  "Actual Behaviour",
  "Source References",
  "Linked Business Rules",
  "Linked Acceptance Criteria",
  "Linked Gap Flags",
  "Pinning Test Cases",
  "Notes",
  "Resolution",
  "Resolution Date",
];

function buildDefectsSheet(modules: ModuleFile[]): XLSX.WorkSheet {
  // Order defects: Critical > Major > Minor > Cosmetic, then Open statuses first.
  const sevRank: Record<string, number> = { Critical: 0, Major: 1, Minor: 2, Cosmetic: 3 };
  const statusRank = (s: string) => (OPEN_DEFECT_STATUSES.has(s) ? 0 : 1);

  type FlatDefect = Defect & { _module: string };
  const flat: FlatDefect[] = modules.flatMap((m) =>
    (m.defects ?? []).map((d) => ({ ...d, _module: m.moduleName })),
  );

  flat.sort((a, b) => {
    const sa = sevRank[a.severity] ?? 99;
    const sb = sevRank[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    const ta = statusRank(a.status);
    const tb = statusRank(b.status);
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });

  const rows = flat.map((d) => ({
    "Defect ID": d.id,
    "Module": d._module,
    "Title": d.title,
    "Severity": d.severity,
    "Status": d.status,
    "Discovered By": d.discoveredBy,
    "Discovered Date": d.discoveredDate,
    "Description": d.description,
    "Expected Behaviour": d.expectedBehaviour,
    "Actual Behaviour": d.actualBehaviour,
    "Source References": (d.sourceRefs ?? []).join("\n"),
    "Linked Business Rules": (d.linkedBusinessRules ?? []).join(", "),
    "Linked Acceptance Criteria": (d.linkedAcceptanceCriteria ?? []).join(", "),
    "Linked Gap Flags": (d.linkedGapFlags ?? []).join(", "),
    "Pinning Test Cases": (d.pinningTestCases ?? []).join(", "),
    "Notes": d.notes ?? "",
    "Resolution": d.resolution ?? "",
    "Resolution Date": d.resolutionDate ?? "",
  }));

  const sheet = rows.length > 0
    ? XLSX.utils.json_to_sheet(rows, { header: DEFECT_COLUMNS })
    : XLSX.utils.aoa_to_sheet([DEFECT_COLUMNS]);
  setColumnWidths(sheet, [16, 24, 60, 10, 12, 18, 14, 60, 50, 50, 40, 28, 28, 22, 28, 40, 40, 14]);
  applyCommonSheetStyle(sheet, DEFECT_COLUMNS.length, rows.length);
  return sheet;
}

const DEFECT_DETAILS_COLUMNS = [
  "Defect ID",
  "Title",
  "What it was",
  "What we did",
  "Example",
];

function buildDefectDetailsSheet(modules: ModuleFile[], laymans: LaymanFile): XLSX.WorkSheet {
  // Mirror buildDefectsSheet ordering: Critical > Major > Minor > Cosmetic, then defect ID asc.
  const sevRank: Record<string, number> = { Critical: 0, Major: 1, Minor: 2, Cosmetic: 3 };

  type FlatDefect = Defect & { _module: string };
  const flat: FlatDefect[] = modules.flatMap((m) =>
    (m.defects ?? []).map((d) => ({ ...d, _module: m.moduleName })),
  );

  flat.sort((a, b) => {
    const sa = sevRank[a.severity] ?? 99;
    const sb = sevRank[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });

  const rows = flat.map((d) => {
    const entry = laymans[d.id];
    return {
      "Defect ID": d.id,
      "Title": entry?.title ?? d.title,
      "What it was": entry?.summary ?? "",
      "What we did": entry?.fix ?? "",
      "Example": entry?.example ?? "",
    };
  });

  const sheet = rows.length > 0
    ? XLSX.utils.json_to_sheet(rows, { header: DEFECT_DETAILS_COLUMNS })
    : XLSX.utils.aoa_to_sheet([DEFECT_DETAILS_COLUMNS]);
  setColumnWidths(sheet, [16, 50, 80, 80, 60]);
  applyCommonSheetStyle(sheet, DEFECT_DETAILS_COLUMNS.length, rows.length);

  // Enable wrap-text on the three prose columns (Title=B, What it was=C, What we did=D, Example=E)
  // so readers see whole paragraphs without horizontal scrolling.
  const wrapCols = ["B", "C", "D", "E"];
  for (let r = 2; r <= rows.length + 1; r++) {
    for (const col of wrapCols) {
      const cellRef = `${col}${r}`;
      const cell = sheet[cellRef];
      if (cell) {
        cell.s = cell.s || {};
        cell.s.alignment = { ...(cell.s.alignment || {}), wrapText: true, vertical: "top" };
      }
    }
  }
  return sheet;
}

function loadLaymanFile(rootDir: string): LaymanFile {
  const filePath = path.join(rootDir, "test-cases", "defect-laymans.json");
  if (!existsSync(filePath)) {
    throw new Error(`Layman companion file not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`Layman companion file is malformed JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Layman companion file must be a JSON object keyed by defect ID.`);
  }
  return parsed as LaymanFile;
}

function validateLaymanCoverage(modules: ModuleFile[], laymans: LaymanFile): string[] {
  const errs: string[] = [];
  const defectIds = new Set(modules.flatMap((m) => (m.defects ?? []).map((d) => d.id)));
  const laymanIds = new Set(Object.keys(laymans));

  for (const id of defectIds) {
    if (!laymanIds.has(id)) {
      errs.push(`defect-laymans.json: missing entry for defect "${id}"`);
    }
  }
  for (const id of laymanIds) {
    if (!defectIds.has(id)) {
      errs.push(`defect-laymans.json: entry "${id}" does not correspond to any catalogued defect`);
    }
    const entry = laymans[id];
    if (!entry || typeof entry !== "object") {
      errs.push(`defect-laymans.json: entry "${id}" is not an object`);
      continue;
    }
    if (typeof entry.summary !== "string" || entry.summary.trim() === "") {
      errs.push(`defect-laymans.json: entry "${id}" has missing/empty "summary"`);
    }
    if (typeof entry.fix !== "string" || entry.fix.trim() === "") {
      errs.push(`defect-laymans.json: entry "${id}" has missing/empty "fix"`);
    }
    if (typeof entry.title !== "string" || entry.title.trim() === "") {
      errs.push(`defect-laymans.json: entry "${id}" has missing/empty "title"`);
    }
    if (entry.example !== null && typeof entry.example !== "string") {
      errs.push(`defect-laymans.json: entry "${id}" has "example" that is neither string nor null`);
    }
  }
  return errs;
}

function buildModuleSheet(mod: ModuleFile): XLSX.WorkSheet {
  const rows = moduleSheetRows(mod);
  // Always emit the header row, even when testCases is empty.
  const sheet = rows.length > 0
    ? XLSX.utils.json_to_sheet(rows, { header: TC_COLUMNS })
    : XLSX.utils.aoa_to_sheet([TC_COLUMNS]);
  setColumnWidths(sheet, [16, 24, 18, 50, 12, 8, 30, 30, 50, 50, 30, 16, 14, 14, 14, 30]);
  applyCommonSheetStyle(sheet, TC_COLUMNS.length, rows.length);
  return sheet;
}

// ---------- Main ----------

function main() {
  const root = process.cwd(); // expected: jpl-leagues/
  const sourcesDir = path.join(root, "test-cases", "sources");
  if (!existsSync(sourcesDir)) {
    throw new Error(`Sources directory not found: ${sourcesDir}. Run this from jpl-leagues/.`);
  }

  const files = readdirSync(sourcesDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new Error(`No JSON files found in ${sourcesDir}.`);
  }

  const modules: ModuleFile[] = [];
  const allErrors: string[] = [];

  for (const f of files) {
    const full = path.join(sourcesDir, f);
    let parsed: ModuleFile;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch (e) {
      allErrors.push(`${f}: invalid JSON — ${(e as Error).message}`);
      continue;
    }
    const errs = validateModule(f, parsed);
    if (errs.length > 0) allErrors.push(...errs);
    else modules.push(parsed);
  }

  // Stakeholder-facing layman summaries live in a companion file. Refuse to build
  // if it drifts from the source-of-truth defect IDs in either direction.
  const laymans = loadLaymanFile(root);
  const laymanErrors = validateLaymanCoverage(modules, laymans);
  allErrors.push(...laymanErrors);

  if (allErrors.length > 0) {
    console.error("\n❌  Validation failed:\n");
    for (const e of allErrors) console.error("  -", e);
    process.exit(1);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildCoverSheet(modules), "Cover");
  XLSX.utils.book_append_sheet(wb, buildTocSheet(modules), "TOC");
  XLSX.utils.book_append_sheet(wb, buildDefectsSheet(modules), "Defects");
  XLSX.utils.book_append_sheet(wb, buildDefectDetailsSheet(modules, laymans), "defect_details");
  XLSX.utils.book_append_sheet(wb, buildTraceabilitySheet(modules), "Traceability Matrix");
  XLSX.utils.book_append_sheet(wb, buildSummarySheet(modules), "Test Summary");
  for (const m of modules) {
    XLSX.utils.book_append_sheet(wb, buildModuleSheet(m), m.sheetName);
  }

  const outDir = path.join(root, "test-cases");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "jpl-leagues-test-cases.xlsx");
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
  writeFileSync(outPath, buf);

  const total = modules.reduce((s, m) => s + m.testCases.length, 0);
  const signedOff = modules.filter((m) => m.status === "qa-signed-off").length;
  const allDefects = modules.flatMap((m) => m.defects ?? []);
  const openDefects = allDefects.filter((d) => OPEN_DEFECT_STATUSES.has(d.status)).length;
  console.log(`\n✅  Workbook written: ${path.relative(root, outPath)}`);
  console.log(`    Modules: ${modules.length}  |  Signed off: ${signedOff}/${modules.length}  |  Cases: ${total}  |  Defects: ${openDefects} open / ${allDefects.length} total\n`);
}

main();
