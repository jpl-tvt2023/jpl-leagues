/**
 * The fixtures page's GW stats, computed from compact per-manager facts.
 *
 * The server sends one row per FPL manager (their picks, chip, hits, transfers) and this folds
 * them into rankings. Done on the client, from the same facts, so switching between All /
 * Group A / Group B and opening a drill-down cost nothing — and every number on the panel can
 * show exactly which managers it was counted from.
 *
 * Import-free on purpose so the unit lane can run it.
 */

/** Pick flags, bitwise: 1 = captain, 2 = vice-captain. */
export const PICK_CAPTAIN = 1;
export const PICK_VICE = 2;

export interface GwStatsManager {
  fplId: string;
  name: string;
  teamId: string;
  teamName: string;
  group: string | null;
  /**
   * `[element, multiplier, flags]` for all fifteen picks. The multiplier is the resolved one
   * (vice-captain handover applied), so it is what that player's points actually count. Null when
   * this manager's picks could not be read.
   */
  picks: [number, number, number][] | null;
  /** FPL's raw `active_chip`: wildcard | freehit | bboost | 3xc | manager. */
  chip: string | null;
  hits: number;
  /** Gross FPL points this gameweek. Null when unknown. */
  gross: number | null;
  /** Transfers made for this gameweek. Null when not (yet) known. */
  transfers: { in: number[]; out: number[] } | null;
}

export interface GwStatsElement {
  /** web_name */
  n: string;
  /** element_type 1–4 */
  pos: number;
  /** club short name */
  club: string;
  /** gameweek points so far */
  pts: number;
}

export interface GwStatsPayload {
  gameweek: number;
  /** "upcoming" before the deadline: picks are secret and nothing is sent. */
  status: "upcoming" | "ok";
  settled: boolean;
  managers: GwStatsManager[];
  elements: Record<number, GwStatsElement>;
  /** Every manager's picks were read. */
  picksComplete: boolean;
  /** Every manager's transfers were read. */
  transfersComplete: boolean;
  generatedAt: string;
}

export interface StatManagerRef {
  fplId: string;
  name: string;
  teamName: string;
  /** e.g. "C", "TC", "×2", "−8". */
  note?: string;
}

export interface StatEntry {
  element: number;
  name: string;
  club: string;
  pos: number;
  /** The ranked number: a count, or points. */
  value: number;
  /** value as a share of the managers counted, when it is a count. */
  pct?: number;
  /** Secondary line, e.g. "3 TC" or "EO 142%". */
  extra?: string;
  managers: StatManagerRef[];
}

export interface AggregatedGwStats {
  /** Managers in scope whose picks are known. */
  managerCount: number;
  captained: StatEntry[];
  transfersIn: StatEntry[];
  transfersOut: StatEntry[];
  /** Managers whose transfers counted (known, and not on Wildcard / Free Hit). */
  transferManagers: number;
  /** Managers left out of transfers because they played Wildcard or Free Hit. */
  transferChipManagers: StatManagerRef[];
  owned: StatEntry[];
  topScorers: StatEntry[];
  fplChips: { code: string; label: string; managers: StatManagerRef[] }[];
  hits: { total: number; takers: (StatManagerRef & { hits: number })[] };
  topManagers: (StatManagerRef & { gross: number; net: number })[];
}

const CHIP_DISPLAY: Record<string, [string, string]> = {
  wildcard: ["WC", "Wildcard"],
  freehit: ["FH", "Free Hit"],
  bboost: ["BB", "Bench Boost"],
  "3xc": ["TC", "Triple Captain"],
  manager: ["AM", "Assistant Manager"],
};

/** Transfers on these chips are excluded from in/out: they are not ordinary moves. */
const TRANSFER_EXCLUDED_CHIPS = new Set(["wildcard", "freehit"]);

export type StatsScope = "all" | string;

export function managersInScope(payload: GwStatsPayload, scope: StatsScope): GwStatsManager[] {
  return scope === "all" ? payload.managers : payload.managers.filter((m) => m.group === scope);
}

function ref(m: GwStatsManager, note?: string): StatManagerRef {
  return { fplId: m.fplId, name: m.name, teamName: m.teamName, ...(note ? { note } : {}) };
}

function rank(
  counts: Map<number, StatManagerRef[]>,
  elements: Record<number, GwStatsElement>,
  denominator: number,
  limit: number,
  extra?: (element: number, refs: StatManagerRef[]) => string | undefined,
): StatEntry[] {
  return [...counts.entries()]
    .map(([element, managers]) => {
      const el = elements[element];
      return {
        element,
        name: el?.n ?? `#${element}`,
        club: el?.club ?? "",
        pos: el?.pos ?? 0,
        value: managers.length,
        pct: denominator > 0 ? Math.round((managers.length / denominator) * 100) : 0,
        extra: extra?.(element, managers),
        managers: [...managers].sort((a, b) => a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => b.value - a.value || (elements[b.element]?.pts ?? 0) - (elements[a.element]?.pts ?? 0) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function push(map: Map<number, StatManagerRef[]>, key: number, value: StatManagerRef) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function aggregateGwStats(payload: GwStatsPayload, scope: StatsScope, limit = 5): AggregatedGwStats {
  const all = managersInScope(payload, scope);
  const withPicks = all.filter((m) => m.picks);
  const n = withPicks.length;
  const { elements } = payload;

  // ── Captaincy (the FPL armband as picked, TC included) ──
  const captains = new Map<number, StatManagerRef[]>();
  for (const m of withPicks) {
    const cap = m.picks!.find(([, , f]) => f & PICK_CAPTAIN);
    if (cap) push(captains, cap[0], ref(m, m.chip === "3xc" ? "TC" : "C"));
  }

  // ── Ownership + effective ownership ──
  const owners = new Map<number, StatManagerRef[]>();
  const multSum = new Map<number, number>();
  for (const m of withPicks) {
    for (const [el, mult, flags] of m.picks!) {
      push(owners, el, ref(m, flags & PICK_CAPTAIN ? (mult >= 3 ? "TC" : "C") : mult === 0 ? "bench" : undefined));
      multSum.set(el, (multSum.get(el) ?? 0) + mult);
    }
  }

  // ── Transfers, Wildcard and Free Hit excluded ──
  const tIn = new Map<number, StatManagerRef[]>();
  const tOut = new Map<number, StatManagerRef[]>();
  const transferChipManagers: StatManagerRef[] = [];
  let transferManagers = 0;
  for (const m of all) {
    if (m.chip && TRANSFER_EXCLUDED_CHIPS.has(m.chip)) {
      transferChipManagers.push(ref(m, CHIP_DISPLAY[m.chip]?.[0]));
      continue;
    }
    if (!m.transfers) continue;
    transferManagers++;
    for (const el of m.transfers.in) push(tIn, el, ref(m));
    for (const el of m.transfers.out) push(tOut, el, ref(m));
  }

  // ── Top scorers among owned players ──
  const topScorers: StatEntry[] = [...owners.entries()]
    .map(([element, managers]) => {
      const el = elements[element];
      return {
        element,
        name: el?.n ?? `#${element}`,
        club: el?.club ?? "",
        pos: el?.pos ?? 0,
        value: el?.pts ?? 0,
        extra: `${managers.length} own`,
        managers,
      };
    })
    .sort((a, b) => b.value - a.value || b.managers.length - a.managers.length || a.name.localeCompare(b.name))
    .slice(0, limit);

  // ── FPL chips ──
  const chips = new Map<string, StatManagerRef[]>();
  for (const m of all) {
    if (!m.chip) continue;
    const list = chips.get(m.chip) ?? [];
    list.push(ref(m));
    chips.set(m.chip, list);
  }

  // ── Hits ──
  const takers = all
    .filter((m) => m.hits > 0)
    .map((m) => ({ ...ref(m, `−${m.hits}`), hits: m.hits }))
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));

  // ── Managers ──
  const topManagers = all
    .filter((m) => m.gross != null)
    .map((m) => ({ ...ref(m), gross: m.gross!, net: m.gross! - m.hits }))
    .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
    .slice(0, limit);

  return {
    managerCount: n,
    captained: rank(captains, elements, n, limit, (_el, refs) => {
      const tc = refs.filter((r) => r.note === "TC").length;
      return tc > 0 ? `${tc} TC` : undefined;
    }),
    transfersIn: rank(tIn, elements, transferManagers, limit),
    transfersOut: rank(tOut, elements, transferManagers, limit),
    transferManagers,
    transferChipManagers,
    owned: rank(owners, elements, n, limit, (el) =>
      n > 0 ? `EO ${Math.round(((multSum.get(el) ?? 0) / n) * 100)}%` : undefined,
    ),
    topScorers,
    fplChips: [...chips.entries()]
      .map(([raw, managers]) => ({
        code: CHIP_DISPLAY[raw]?.[0] ?? raw.toUpperCase(),
        label: CHIP_DISPLAY[raw]?.[1] ?? raw,
        managers,
      }))
      .sort((a, b) => b.managers.length - a.managers.length),
    hits: { total: takers.reduce((s, t) => s + t.hits, 0), takers },
    topManagers,
  };
}
