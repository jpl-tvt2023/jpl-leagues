/**
 * A JPL team's gameweek as ONE squad: both managers' FPL picks merged, each PL player once,
 * with the multiplier his points actually carry into the JPL score.
 *
 * ## The effective multiplier
 *
 * A JPL team score is Σ over its two managers of (FPL points − hits), with the JPL captain's
 * net doubled. Distributed over players, a player's points are counted
 *
 *     Σ over the managers who own him of (that manager's FPL multiplier × 2 if JPL captain)
 *
 * times. Haaland captained by both managers, one of whom is the JPL captain, is 2×2 + 2×1 = ×6;
 * with Triple Captain it can reach ×9. Bench players carry ×0 unless Bench Boost is on.
 *
 * The FPL multiplier is the RESOLVED one from manager-points.ts — after the vice-captain
 * handover live, after FPL's auto-substitutions once settled — so Σ rows × points reconciles to
 * the managers' gross scores by construction. Whatever FPL adds on top of that (it settles
 * provisional bonus and substitutions on its own schedule) is reported, never hidden, as the
 * manager's `fplAdjustment`.
 *
 * Import-free apart from types and the multiplier resolvers, so the unit lane can run it.
 */

import type { FPLGameweekPicks } from "@/lib/fpl";
import type { CachedElementDetail } from "@/lib/fpl-cache";
import type { FplFixture } from "@/lib/fpl-live/players-left";
import {
  resolveLiveMultipliers,
  resolveSettledMultipliers,
  type LiveElementStat,
  type ResolvedPick,
} from "@/lib/fpl-live/manager-points";

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface SheetManagerInput {
  playerId: string;
  name: string;
  fplId: string;
  isJplCaptain: boolean;
  isTempCaptain: boolean;
  /** Null when this manager's picks could not be loaded; the side renders without them. */
  picks: FPLGameweekPicks | null;
}

export interface ElementMeta {
  id: number;
  name: string;
  /** FPL element_type: 1 GKP, 2 DEF, 3 MID, 4 FWD. */
  position: number;
  clubId: number;
}

export interface ClubMeta {
  id: number;
  short: string;
  name: string;
}

export type SheetFixture = Pick<
  FplFixture,
  "id" | "kickoff_time" | "team_h" | "team_a" | "team_h_score" | "team_a_score" | "finished" | "finished_provisional"
>;

export interface BuildTeamSheetInput {
  managers: SheetManagerInput[];
  /** FPL has concluded the gameweek (every match played, bonus confirmed). */
  settled: boolean;
  detail: Record<number, CachedElementDetail>;
  elements: ReadonlyMap<number, ElementMeta>;
  clubs: ReadonlyMap<number, ClubMeta>;
  /** This gameweek's PL fixtures. Null when FPL's fixture list could not be read. */
  gwFixtures: SheetFixture[] | null;
  /** Epoch ms, injectable for tests. */
  now: number;
}

// ── Outputs ────────────────────────────────────────────────────────────────

/** How the manager picked the player: armband, vice, starter, or bench. */
export type OwnerRole = "C" | "TC" | "VC" | "XI" | "BENCH";

export interface SheetOwner {
  fplId: string;
  managerName: string;
  role: OwnerRole;
  /** 1–4 for a bench pick (FPL order, GK first); undefined for a starter. */
  benchOrder?: number;
  /** The resolved FPL multiplier this manager applies. */
  fplMultiplier: number;
  jplCaptain: boolean;
  /** fplMultiplier × 2 if this manager is the JPL captain. */
  effective: number;
  /** Vice-captain holding the armband because the captain blanked. */
  armbandInherited?: boolean;
  /** FPL's own substitution, once the week has settled. */
  autoSubIn?: boolean;
  autoSubOut?: boolean;
  /** A live PROJECTION only — never changes `effective` or any score. */
  projectedSubOut?: boolean;
  projectedSubIn?: boolean;
}

export type MatchState = "upcoming" | "live" | "finished";

export interface SheetMatch {
  opponent: string;
  home: boolean;
  kickoff: string | null;
  state: MatchState;
  /** "2-1" from this player's club's perspective, once there is a score. */
  score: string | null;
}

export interface SheetRow {
  element: number;
  name: string;
  position: number;
  club: string;
  clubName: string;
  /** Empty for a blank gameweek; two entries for a double. */
  matches: SheetMatch[];
  points: number;
  minutes: number;
  /** `[identifier, value, points]`, straight from FPL's explain. */
  breakdown: [string, number, number][];
  owners: SheetOwner[];
  /** Σ owners' effective multipliers. */
  multiplier: number;
  /** points × multiplier — this player's share of the JPL score, before hits. */
  contribution: number;
  /** Fixtures this player's club has not kicked off yet. */
  leftToPlay: number;
  section: "xi" | "bench";
}

export interface ProjectedSub {
  out: number;
  in: number | null;
}

export interface SheetManagerSummary {
  playerId: string;
  fplId: string;
  name: string;
  isJplCaptain: boolean;
  isTempCaptain: boolean;
  /** FPL's raw code: wildcard | freehit | bboost | 3xc | manager — or null. */
  chip: string | null;
  /** Gross FPL points: live recompute, or `entry_history.points` once settled. */
  gross: number;
  hits: number;
  net: number;
  /** net, doubled for the JPL captain. */
  final: number;
  /** Picks could not be loaded. */
  unavailable: boolean;
  /** Settled only: entry_history.points minus what the rows add up to. Usually 0. */
  fplAdjustment: number;
  /** Live projection of FPL's end-of-week substitutions. Empty when settled. */
  projectedSubs: ProjectedSub[];
  /** Points the projected substitutions would add to `final`. */
  projectedGain: number;
}

export interface TeamSheet {
  rows: SheetRow[];
  bench: SheetRow[];
  managers: SheetManagerSummary[];
  /** Σ managers' final — before any carry-forward penalty, which the caller applies. */
  total: number;
  /** Distinct players with a multiplier who still have a fixture to play. */
  playersLeft: number;
  /** Σ multiplier × fixtures left: how much multiplied football is still to come. */
  remainingMultiplier: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const POSITION_MINIMA: Record<number, number> = { 1: 1, 2: 3, 3: 2, 4: 1 };

function roleOf(pick: ResolvedPick): OwnerRole {
  if (pick.position > 11 && pick.pickMultiplier === 0) return "BENCH";
  if (pick.is_captain) return pick.pickMultiplier >= 3 ? "TC" : "C";
  if (pick.is_vice_captain) return "VC";
  return pick.position > 11 ? "BENCH" : "XI";
}

/** Clubs that have no fixture left to finish in this gameweek. Empty = unknown. */
export function concludedClubs(gwFixtures: SheetFixture[] | null, allClubIds: Iterable<number>): Set<number> {
  const done = new Set<number>();
  if (!gwFixtures) return done;
  const remaining = new Set<number>();
  for (const f of gwFixtures) {
    if (f.finished || f.finished_provisional) continue;
    remaining.add(f.team_h);
    remaining.add(f.team_a);
  }
  for (const id of allClubIds) if (!remaining.has(id)) done.add(id);
  return done;
}

function matchState(f: SheetFixture, now: number): MatchState {
  if (f.finished || f.finished_provisional) return "finished";
  if (!f.kickoff_time) return "upcoming";
  const ko = Date.parse(f.kickoff_time);
  return Number.isFinite(ko) && ko > now ? "upcoming" : "live";
}

function matchesFor(
  clubId: number,
  gwFixtures: SheetFixture[] | null,
  clubs: ReadonlyMap<number, ClubMeta>,
  now: number,
): SheetMatch[] {
  if (!gwFixtures) return [];
  return gwFixtures
    .filter((f) => f.team_h === clubId || f.team_a === clubId)
    .sort((a, b) => Date.parse(a.kickoff_time ?? "") - Date.parse(b.kickoff_time ?? ""))
    .map((f) => {
      const home = f.team_h === clubId;
      const opp = clubs.get(home ? f.team_a : f.team_h);
      const own = home ? f.team_h_score : f.team_a_score;
      const their = home ? f.team_a_score : f.team_h_score;
      const state = matchState(f, now);
      return {
        opponent: opp?.short ?? "?",
        home,
        kickoff: f.kickoff_time,
        state,
        score: state !== "upcoming" && own != null && their != null ? `${own}-${their}` : null,
      };
    });
}

/**
 * FPL's end-of-week auto-substitutions, projected from what is known now. Display only.
 *
 * A starter is projected off when he has 0 minutes AND his club has no fixture left. The first
 * bench player, in bench order, who has played and keeps the formation legal comes on; the
 * goalkeeper can only be replaced by the bench goalkeeper. A bench player who has not played yet
 * but still could is skipped rather than guessed at — FPL waits for him, this cannot.
 */
export function projectAutoSubs(
  resolved: ResolvedPick[],
  minutesOf: (element: number) => number,
  positionOf: (element: number) => number,
  isConcluded: (element: number) => boolean,
): ProjectedSub[] {
  const starters = resolved.filter((p) => p.position <= 11).sort((a, b) => a.position - b.position);
  const bench = resolved.filter((p) => p.position > 11).sort((a, b) => a.position - b.position);
  // Bench Boost: everyone already counts, nothing to substitute.
  if (bench.some((p) => p.multiplier > 0)) return [];

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of starters) counts[positionOf(p.element)] = (counts[positionOf(p.element)] ?? 0) + 1;

  const used = new Set<number>();
  const subs: ProjectedSub[] = [];
  for (const starter of starters) {
    if (minutesOf(starter.element) > 0 || !isConcluded(starter.element)) continue;
    const outPos = positionOf(starter.element);
    let chosen: number | null = null;
    for (const b of bench) {
      if (used.has(b.element) || minutesOf(b.element) === 0) continue;
      const inPos = positionOf(b.element);
      if ((outPos === 1) !== (inPos === 1)) continue; // GK only for GK
      const after = { ...counts, [outPos]: counts[outPos] - 1, [inPos]: counts[inPos] + 1 };
      if ([1, 2, 3, 4].some((pos) => after[pos] < POSITION_MINIMA[pos])) continue;
      chosen = b.element;
      used.add(b.element);
      counts[outPos] -= 1;
      counts[inPos] += 1;
      break;
    }
    subs.push({ out: starter.element, in: chosen });
  }
  return subs;
}

// ── Builder ────────────────────────────────────────────────────────────────

export function buildTeamSheet(input: BuildTeamSheetInput): TeamSheet {
  const { managers, settled, detail, elements, clubs, gwFixtures, now } = input;

  const statOf = (el: number): LiveElementStat => ({ points: detail[el]?.p ?? 0, minutes: detail[el]?.m ?? 0 });
  // Only picked elements are ever looked up. Absent from `detail` means 0 points, 0 minutes.
  const stats: Record<number, LiveElementStat> = {};
  for (const m of managers) for (const p of m.picks?.picks ?? []) stats[p.element] = statOf(p.element);
  const positionOf = (el: number) => elements.get(el)?.position ?? 3;
  const concluded = concludedClubs(gwFixtures, clubs.keys());
  const concludedElements = new Set<number>();
  for (const [id, meta] of elements) if (concluded.has(meta.clubId)) concludedElements.add(id);

  const rowsByElement = new Map<number, SheetRow>();
  const summaries: SheetManagerSummary[] = [];

  for (const m of managers) {
    const jplFactor = m.isJplCaptain ? 2 : 1;
    if (!m.picks) {
      summaries.push({
        playerId: m.playerId, fplId: m.fplId, name: m.name,
        isJplCaptain: m.isJplCaptain, isTempCaptain: m.isTempCaptain,
        chip: null, gross: 0, hits: 0, net: 0, final: 0, unavailable: true,
        fplAdjustment: 0, projectedSubs: [], projectedGain: 0,
      });
      continue;
    }

    const resolved = settled
      ? resolveSettledMultipliers(m.picks, stats)
      : resolveLiveMultipliers(m.picks, { stats, concludedElements });

    let summed = 0;
    for (const pick of resolved) {
      summed += statOf(pick.element).points * pick.multiplier;

      let row = rowsByElement.get(pick.element);
      if (!row) {
        const meta = elements.get(pick.element);
        const club = clubs.get(meta?.clubId ?? -1);
        const matches = matchesFor(meta?.clubId ?? -1, gwFixtures, clubs, now);
        row = {
          element: pick.element,
          name: meta?.name ?? `#${pick.element}`,
          position: meta?.position ?? 3,
          club: club?.short ?? "?",
          clubName: club?.name ?? "",
          matches,
          points: statOf(pick.element).points,
          minutes: statOf(pick.element).minutes,
          breakdown: detail[pick.element]?.b ?? [],
          owners: [],
          multiplier: 0,
          contribution: 0,
          leftToPlay: matches.filter((x) => x.state === "upcoming").length,
          section: "bench",
        };
        rowsByElement.set(pick.element, row);
      }
      const effective = pick.multiplier * jplFactor;
      row.owners.push({
        fplId: m.fplId,
        managerName: m.name,
        role: roleOf(pick),
        ...(pick.position > 11 ? { benchOrder: pick.position - 11 } : {}),
        fplMultiplier: pick.multiplier,
        jplCaptain: m.isJplCaptain,
        effective,
        ...(pick.armbandInherited ? { armbandInherited: true } : {}),
        ...(pick.autoSubIn ? { autoSubIn: true } : {}),
        ...(pick.autoSubOut ? { autoSubOut: true } : {}),
      });
      row.multiplier += effective;
    }

    const projectedSubs =
      settled ? [] : projectAutoSubs(resolved, (el) => statOf(el).minutes, positionOf, (el) => concludedElements.has(el));
    let projectedGain = 0;
    for (const sub of projectedSubs) {
      const outOwner = rowsByElement.get(sub.out)?.owners.find((o) => o.fplId === m.fplId);
      if (outOwner) outOwner.projectedSubOut = true;
      if (sub.in != null) {
        const inOwner = rowsByElement.get(sub.in)?.owners.find((o) => o.fplId === m.fplId);
        if (inOwner) inOwner.projectedSubIn = true;
        projectedGain += statOf(sub.in).points * jplFactor;
      }
    }

    const gross = settled ? m.picks.entry_history.points : summed;
    const hits = m.picks.entry_history.event_transfers_cost ?? 0;
    const net = gross - hits;
    summaries.push({
      playerId: m.playerId, fplId: m.fplId, name: m.name,
      isJplCaptain: m.isJplCaptain, isTempCaptain: m.isTempCaptain,
      chip: m.picks.active_chip ?? null,
      gross, hits, net, final: net * jplFactor,
      unavailable: false,
      fplAdjustment: settled ? gross - summed : 0,
      projectedSubs,
      projectedGain,
    });
  }

  const all = [...rowsByElement.values()];
  for (const row of all) {
    row.contribution = row.points * row.multiplier;
    // A player counts in the XI if ANY manager starts him; benched-by-both is the bench.
    row.section = row.owners.some((o) => o.role !== "BENCH" || o.fplMultiplier > 0) ? "xi" : "bench";
  }

  const byPosition = (a: SheetRow, b: SheetRow) =>
    a.position - b.position || b.multiplier - a.multiplier || b.contribution - a.contribution || a.name.localeCompare(b.name);
  const benchOrder = (r: SheetRow) => Math.min(...r.owners.map((o) => o.benchOrder ?? 9));
  const rows = all.filter((r) => r.section === "xi").sort(byPosition);
  const bench = all.filter((r) => r.section === "bench").sort((a, b) => benchOrder(a) - benchOrder(b) || byPosition(a, b));

  return {
    rows,
    bench,
    managers: summaries,
    total: summaries.reduce((s, m) => s + m.final, 0),
    playersLeft: rows.filter((r) => r.multiplier > 0 && r.leftToPlay > 0).length,
    remainingMultiplier: rows.reduce((s, r) => s + r.multiplier * r.leftToPlay, 0),
  };
}

// ── Head to head ───────────────────────────────────────────────────────────

export interface ElementEdge {
  element: number;
  name: string;
  points: number;
  /** This side's multiplier minus the other side's. */
  net: number;
  /** points × net — what this player is worth to this side in the head-to-head. */
  swing: number;
  common: boolean;
}

export interface SheetComparison {
  /** Per element: the two sides' multipliers. */
  byElement: Record<number, { a: number; b: number; common: boolean }>;
  /** Players where A out-multiplies B, best swing first. */
  aEdges: ElementEdge[];
  bEdges: ElementEdge[];
}

/**
 * Who owns what across the two compared teams.
 *
 * "Common" means both JPL teams own the player at all. A common player only cancels out when the
 * multipliers match — Haaland ×4 against ×2 is still a two-times-Haaland edge, which is why the
 * edges are by multiplier difference rather than by ownership.
 */
export function compareSheets(a: TeamSheet, b: TeamSheet): SheetComparison {
  const index = (s: TeamSheet) => new Map([...s.rows, ...s.bench].map((r) => [r.element, r]));
  const ai = index(a);
  const bi = index(b);
  const byElement: SheetComparison["byElement"] = {};
  const aEdges: ElementEdge[] = [];
  const bEdges: ElementEdge[] = [];

  for (const el of new Set([...ai.keys(), ...bi.keys()])) {
    const ra = ai.get(el);
    const rb = bi.get(el);
    const ma = ra?.multiplier ?? 0;
    const mb = rb?.multiplier ?? 0;
    const common = !!ra && !!rb;
    byElement[el] = { a: ma, b: mb, common };
    const row = ra ?? rb!;
    if (ma > mb) aEdges.push({ element: el, name: row.name, points: row.points, net: ma - mb, swing: row.points * (ma - mb), common });
    if (mb > ma) bEdges.push({ element: el, name: row.name, points: row.points, net: mb - ma, swing: row.points * (mb - ma), common });
  }
  const order = (x: ElementEdge, y: ElementEdge) => y.swing - x.swing || y.net - x.net || x.name.localeCompare(y.name);
  return { byElement, aEdges: aEdges.sort(order), bEdges: bEdges.sort(order) };
}
