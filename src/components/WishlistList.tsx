"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WishlistEntry } from "@/hooks/useWishlist";
import { POSITION_LABELS, POSITION_COLORS, POSITION_ORDER } from "@/lib/fpl/positions";
import { MIN_QUOTA, validateAddPlayer, type SquadCounts } from "@/lib/formats/auction/squad-rules";
import { formatCurrency } from "@/lib/format/currency";

/** The bootstrap fields this list needs. `/api/fpl/bootstrap` already returns all of them. */
export interface WishlistElement {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  now_cost?: number;
  total_points?: number;
  status?: string;
}

export interface WishlistPlTeam {
  id: number;
  name: string;
  short_name: string;
}

export interface WishlistListProps {
  /** Display order from `useWishlist` — active entries first, owned/sold appended. */
  wishlist: WishlistEntry[];
  elementById: Map<number, WishlistElement>;
  plTeams: Map<number, WishlistPlTeam>;
  ownedElementIds: Set<number>;
  /** Move `moveId` immediately above `beforeId`; `null` sends it to the bottom. */
  onReorder: (moveId: string, beforeId: string | null) => void;
  onMoveToTop: (moveId: string) => void;
  onMoveToPosition: (moveId: string, position: number) => void;
  onNudge: (moveId: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  /** Truncate to this many rows (dashboard preview). Reordering is disabled when set. */
  maxRows?: number;
  compact?: boolean;
  /** Remaining purse, for the affordability flag. Omit to hide price warnings. */
  purse?: number | null;
  /** Current squad composition + cap, for the position-coverage banner. */
  squadCounts?: SquadCounts | null;
  maxSquadSize?: number | null;
  penaltySlots?: number;
  bonusSlots?: number;
  emptyMessage?: string;
}

const MIN_BID = 500_000;

/** FPL prices are tenths of a million. */
function priceOf(el: WishlistElement | undefined): number | null {
  return el?.now_cost == null ? null : el.now_cost * 100_000;
}

export function WishlistList({
  wishlist,
  elementById,
  plTeams,
  ownedElementIds,
  onReorder,
  onMoveToTop,
  onMoveToPosition,
  onNudge,
  onRemove,
  maxRows,
  compact = false,
  purse = null,
  squadCounts = null,
  maxSquadSize = null,
  penaltySlots = 0,
  bonusSlots = 0,
  emptyMessage = "No players shortlisted yet.",
}: WishlistListProps) {
  const [positionFilter, setPositionFilter] = useState<number | null>(null);
  const [clubFilter, setClubFilter] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [editingRank, setEditingRank] = useState<string | null>(null);
  const [rankDraft, setRankDraft] = useState("");

  // Same debounce the players page uses — the filter runs over the whole list on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const isPreview = maxRows != null;

  /** Active (still available) entries in priority order — the rank shown is the index here. */
  const activeList = useMemo(
    () => wishlist.filter((w) => !ownedElementIds.has(w.fplElementId)),
    [wishlist, ownedElementIds]
  );

  /** Global active rank per entry id, so filtering never renumbers the rows. */
  const rankById = useMemo(() => {
    const m = new Map<string, number>();
    activeList.forEach((w, i) => m.set(w.id, i + 1));
    return m;
  }, [activeList]);

  /** Clubs present in the wishlist, for the club dropdown. */
  const clubOptions = useMemo(() => {
    const ids = new Set<number>();
    for (const w of wishlist) {
      const el = elementById.get(w.fplElementId);
      if (el) ids.add(el.team);
    }
    return [...ids]
      .map((id) => plTeams.get(id))
      .filter((t): t is WishlistPlTeam => !!t)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [wishlist, elementById, plTeams]);

  const isFiltered = positionFilter !== null || clubFilter !== null || debouncedSearch.trim() !== "";

  const visible = useMemo(() => {
    const lc = debouncedSearch.trim().toLowerCase();
    const rows = wishlist.filter((w) => {
      const el = elementById.get(w.fplElementId);
      if (positionFilter !== null && el?.element_type !== positionFilter) return false;
      if (clubFilter !== null && el?.team !== clubFilter) return false;
      if (lc && !w.playerName.toLowerCase().includes(lc) && !(el?.web_name ?? "").toLowerCase().includes(lc)) {
        return false;
      }
      return true;
    });
    return isPreview ? rows.slice(0, maxRows) : rows;
  }, [wishlist, elementById, positionFilter, clubFilter, debouncedSearch, isPreview, maxRows]);

  const visibleIds = useMemo(() => visible.map((w) => w.id), [visible]);

  /**
   * Which entry should the moved row sit above, given where it landed in the FILTERED view?
   *
   * Dropping above a visible row is unambiguous — that row is the anchor, even if hidden rows sit
   * between them. Dropping at the end of the filtered view means "after the last visible row", which
   * in the full list is the row immediately following it, not the bottom of the wishlist.
   */
  const anchorForDrop = useCallback(
    (moveId: string, nextVisibleId: string | null): string | null => {
      if (nextVisibleId) return nextVisibleId;
      const lastVisible = [...visibleIds].reverse().find((id) => id !== moveId);
      if (!lastVisible) return null;
      const idx = activeList.findIndex((w) => w.id === lastVisible);
      if (idx < 0) return null;
      const after = activeList.slice(idx + 1).find((w) => w.id !== moveId);
      return after?.id ?? null;
    },
    [visibleIds, activeList]
  );

  const sensors = useSensors(
    // A small distance threshold keeps taps on the ✕/▲▼ buttons from starting a drag on touch.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = visibleIds.indexOf(String(active.id));
      const newIndex = visibleIds.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      const moved = arrayMove(visibleIds, oldIndex, newIndex);
      const pos = moved.indexOf(String(active.id));
      onReorder(String(active.id), anchorForDrop(String(active.id), moved[pos + 1] ?? null));
    },
    [visibleIds, onReorder, anchorForDrop]
  );

  const commitRank = useCallback(
    (id: string) => {
      const n = Number(rankDraft);
      setEditingRank(null);
      if (Number.isFinite(n) && n >= 1) onMoveToPosition(id, n);
    },
    [rankDraft, onMoveToPosition]
  );

  /**
   * Which positions can still be added, and can the wishlist actually satisfy any of them?
   *
   * Auto-nomination walks the wishlist and silently skips entries that are owned, unaffordable, or
   * would break the squad's positional quota — and if it reaches the end, the team is penalised a
   * squad slot. A team can hold 300 wishlist entries and still be penalised, with nothing on screen
   * to explain why. This surfaces that before it costs them.
   */
  const coverage = useMemo(() => {
    if (!squadCounts || maxSquadSize == null) return null;
    const slotsLeft = maxSquadSize - squadCounts.total;
    if (slotsLeft <= 0) return { slotsLeft: 0, needed: [], playable: 0, affordable: true };

    const needed = POSITION_ORDER.filter((pos) => (squadCounts[pos as 1 | 2 | 3 | 4] ?? 0) < (MIN_QUOTA[pos] ?? 0));

    let playable = 0;
    let affordable = purse == null || purse >= MIN_BID;
    for (const w of activeList) {
      const el = elementById.get(w.fplElementId);
      if (!el) continue;
      if (!validateAddPlayer(squadCounts, penaltySlots, el.element_type, bonusSlots).ok) continue;
      playable++;
    }
    if (purse != null && purse < MIN_BID) affordable = false;
    return { slotsLeft, needed, playable, affordable };
  }, [squadCounts, maxSquadSize, activeList, elementById, penaltySlots, bonusSlots, purse]);

  const rows = visible.map((entry, i) => {
    const el = elementById.get(entry.fplElementId);
    const owned = ownedElementIds.has(entry.fplElementId);
    const rank = rankById.get(entry.id) ?? null;
    const price = priceOf(el);
    const unaffordable = !owned && price != null && purse != null && purse < MIN_BID;
    // The divider marks how far auto-nomination can realistically reach — everything below it is a
    // backup pool, which is the honest framing for a 300-entry list.
    const showReachDivider =
      !isPreview &&
      !isFiltered &&
      coverage != null &&
      coverage.slotsLeft > 0 &&
      rank === coverage.slotsLeft &&
      i < visible.length - 1;

    return (
      <WishlistRow
        key={entry.id}
        entry={entry}
        element={el}
        plTeam={el ? plTeams.get(el.team) : undefined}
        rank={rank}
        owned={owned}
        price={price}
        unaffordable={unaffordable}
        compact={compact}
        sortable={!isPreview && !owned}
        isFirst={rank === 1}
        isLast={rank === activeList.length}
        editingRank={editingRank === entry.id}
        rankDraft={rankDraft}
        showReachDivider={showReachDivider}
        onStartEditRank={() => {
          setEditingRank(entry.id);
          setRankDraft(String(rank ?? ""));
        }}
        onRankDraft={setRankDraft}
        onCommitRank={() => commitRank(entry.id)}
        onCancelRank={() => setEditingRank(null)}
        onMoveToTop={() => onMoveToTop(entry.id)}
        onNudge={(d) => onNudge(entry.id, d)}
        onRemove={() => onRemove(entry.id)}
      />
    );
  });

  return (
    <div className="space-y-2">
      {coverage && coverage.slotsLeft > 0 && (
        <div
          className={`rounded-lg px-3 py-2 text-xs ${
            coverage.playable === 0
              ? "border border-red-400/40 bg-red-500/10 text-red-200"
              : "border border-white/10 bg-white/5 text-gray-300"
          }`}
        >
          {coverage.playable === 0 ? (
            <>
              <strong>No wishlist entry can be auto-nominated.</strong> Every remaining entry is either
              owned or would break your squad quota — if your turn times out you will be penalised a
              squad slot. Add players in the positions you still need.
            </>
          ) : (
            <>
              {coverage.slotsLeft} slot{coverage.slotsLeft === 1 ? "" : "s"} left ·{" "}
              <span className="text-emerald-300">{coverage.playable}</span> wishlist entr
              {coverage.playable === 1 ? "y" : "ies"} currently playable
              {coverage.needed.length > 0 && (
                <>
                  {" "}
                  · still need{" "}
                  <span className="text-yellow-300">
                    {coverage.needed.map((p) => POSITION_LABELS[p]).join(", ")}
                  </span>
                </>
              )}
              {!coverage.affordable && <span className="text-red-300"> · purse below the minimum bid</span>}
            </>
          )}
        </div>
      )}

      {!isPreview && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setPositionFilter(null)}
            className={`text-[11px] px-2 py-0.5 rounded border ${
              positionFilter === null
                ? "border-white/40 bg-white/15 text-white"
                : "border-white/15 text-gray-400 hover:text-white"
            }`}
          >
            All
          </button>
          {POSITION_ORDER.map((pos) => (
            <button
              key={pos}
              onClick={() => setPositionFilter(positionFilter === pos ? null : pos)}
              className={`text-[11px] px-2 py-0.5 rounded border ${
                positionFilter === pos
                  ? "border-white/40 bg-white/15 text-white"
                  : "border-white/15 text-gray-400 hover:text-white"
              }`}
            >
              {POSITION_LABELS[pos]}
            </button>
          ))}

          <select
            value={clubFilter ?? ""}
            onChange={(e) => setClubFilter(e.target.value === "" ? null : Number(e.target.value))}
            className="text-[11px] rounded border border-white/15 bg-slate-800 px-2 py-1 text-gray-200"
          >
            <option value="">All clubs</option>
            {clubOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find in wishlist…"
            className="flex-1 min-w-[8rem] text-[11px] rounded border border-white/15 bg-slate-800 px-2 py-1 text-white placeholder:text-gray-500"
          />

          {isFiltered && (
            <button
              onClick={() => {
                setPositionFilter(null);
                setClubFilter(null);
                setSearch("");
              }}
              className="text-[11px] text-gray-400 hover:text-white underline"
            >
              clear
            </button>
          )}
        </div>
      )}

      {isFiltered && (
        <p className="text-[11px] text-gray-500">
          Showing {visible.length} of {wishlist.length}. Ranks are your real positions — dragging a row
          here moves it directly above the row you drop it on.
        </p>
      )}

      {visible.length === 0 ? (
        <div className="text-xs text-gray-500 py-3 text-center">
          {isFiltered ? "No entries match these filters." : emptyMessage}
        </div>
      ) : isPreview ? (
        <div className="space-y-0.5">{rows}</div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-0.5">{rows}</div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

interface WishlistRowProps {
  entry: WishlistEntry;
  element: WishlistElement | undefined;
  plTeam: WishlistPlTeam | undefined;
  rank: number | null;
  owned: boolean;
  price: number | null;
  unaffordable: boolean;
  compact: boolean;
  sortable: boolean;
  isFirst: boolean;
  isLast: boolean;
  editingRank: boolean;
  rankDraft: string;
  showReachDivider: boolean;
  onStartEditRank: () => void;
  onRankDraft: (v: string) => void;
  onCommitRank: () => void;
  onCancelRank: () => void;
  onMoveToTop: () => void;
  onNudge: (direction: -1 | 1) => void;
  onRemove: () => void;
}

function WishlistRow(props: WishlistRowProps) {
  const {
    entry,
    element,
    plTeam,
    rank,
    owned,
    price,
    unaffordable,
    compact,
    sortable,
    isFirst,
    isLast,
    editingRank,
    rankDraft,
    showReachDivider,
  } = props;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: !sortable,
  });

  const pos = element ? POSITION_LABELS[element.element_type] : null;
  const posColor = element ? POSITION_COLORS[element.element_type] : "";

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={`flex items-center gap-1.5 rounded px-1.5 py-1 ${
          isDragging ? "bg-white/15 shadow-lg z-10 relative" : "hover:bg-white/5"
        } ${owned ? "opacity-45" : ""}`}
      >
        {/* Drag handle doubles as the rank display; click it to type a new rank. */}
        {editingRank ? (
          <input
            autoFocus
            value={rankDraft}
            onChange={(e) => props.onRankDraft(e.target.value)}
            onBlur={props.onCommitRank}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onCommitRank();
              if (e.key === "Escape") props.onCancelRank();
            }}
            inputMode="numeric"
            className="w-9 shrink-0 rounded border border-yellow-400/60 bg-slate-900 px-1 py-0.5 text-[11px] text-center text-white"
          />
        ) : (
          <button
            {...(sortable ? { ...attributes, ...listeners } : {})}
            onClick={sortable ? props.onStartEditRank : undefined}
            disabled={!sortable}
            title={sortable ? "Drag to reorder, or click to type a rank" : undefined}
            className={`w-9 shrink-0 rounded px-1 py-0.5 text-[11px] font-mono text-center ${
              sortable
                ? "cursor-grab active:cursor-grabbing text-gray-400 hover:bg-white/10 hover:text-white touch-none"
                : "text-gray-600"
            }`}
          >
            {owned ? "—" : rank}
          </button>
        )}

        {pos && (
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${posColor}`}>{pos}</span>
        )}

        <div className="min-w-0 flex-1">
          <div className={`truncate text-xs font-semibold ${owned ? "line-through text-gray-500" : "text-white"}`}>
            {element?.web_name ?? entry.playerName}
          </div>
          {!compact && (
            <div className="truncate text-[10px] text-gray-500">
              {plTeam?.name ?? plTeam?.short_name ?? "—"}
              {price != null && (
                <span className={unaffordable ? "text-red-400" : ""}> · {formatCurrency(price)}</span>
              )}
              {owned && " · sold"}
            </div>
          )}
        </div>

        {compact && plTeam && <span className="shrink-0 text-[10px] text-gray-500">{plTeam.short_name}</span>}

        {sortable && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={props.onMoveToTop}
              disabled={isFirst}
              title="Move to top"
              className="px-1 text-[11px] text-gray-400 hover:text-yellow-300 disabled:opacity-25"
            >
              ⤒
            </button>
            <button
              onClick={() => props.onNudge(-1)}
              disabled={isFirst}
              title="Move up"
              className="px-1 text-[11px] text-gray-400 hover:text-white disabled:opacity-25"
            >
              ▲
            </button>
            <button
              onClick={() => props.onNudge(1)}
              disabled={isLast}
              title="Move down"
              className="px-1 text-[11px] text-gray-400 hover:text-white disabled:opacity-25"
            >
              ▼
            </button>
          </div>
        )}

        <button
          onClick={props.onRemove}
          title="Remove"
          className="shrink-0 px-1 text-[11px] text-gray-500 hover:text-red-400"
        >
          ✕
        </button>
      </div>

      {showReachDivider && (
        <div className="flex items-center gap-2 py-1" aria-hidden>
          <div className="h-px flex-1 bg-yellow-400/25" />
          <span className="text-[9px] uppercase tracking-widest text-yellow-400/60">
            auto-nomination reach
          </span>
          <div className="h-px flex-1 bg-yellow-400/25" />
        </div>
      )}
    </>
  );
}
