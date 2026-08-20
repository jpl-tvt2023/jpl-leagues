"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface WishlistEntry {
  id: string;
  fplElementId: number;
  playerName: string;
  priority: number;
}

const EMPTY_OWNED_IDS = new Set<number>();

/** How long after a local mutation a background refresh is ignored, so polls can't clobber it. */
const SETTLE_MS = 2500;

/**
 * Single source of truth for a team's auction wishlist — fetch, add (single + bulk), remove,
 * reorder, and toggle. Shared by the standalone Dashboard widget (WishlistManager), the "manage
 * full wishlist" squad page, and the live auction room, which previously each reimplemented this
 * against the same /api/auction/wishlist route.
 *
 * `ownedElementIds` (league-wide, from /api/auction/league-owned) is optional but should be passed
 * whenever the caller already has it: a wishlisted player who's since been bought by anyone (via
 * auction sale, admin manual transfer, trade — any path, since this is derived from live ownership
 * rather than a stored flag) is sorted after all still-available entries rather than removed. We
 * used to hard-delete the row on sale; that had no way to un-sell a manually-corrected ownership.
 */
export function useWishlist(
  teamId: string | null,
  leagueId: string | null,
  ownedElementIds: Set<number> = EMPTY_OWNED_IDS
) {
  const [rawWishlist, setWishlist] = useState<WishlistEntry[]>([]);

  // Guards against a background poll overwriting a local edit. The auction room fully resyncs every
  // 3s; without this, an optimistic reorder visibly snapped back mid-edit whenever the in-flight
  // PATCH hadn't landed yet. `pendingRef` covers the request itself, `settleUntilRef` covers the
  // window just after it, where a poll already in flight can still return pre-move data.
  const pendingRef = useRef(0);
  const settleUntilRef = useRef(0);
  const isDirty = useCallback(
    () => pendingRef.current > 0 || Date.now() < settleUntilRef.current,
    []
  );

  // Active entries first (priority order), sold/owned entries appended after (also priority
  // order among themselves) — a pure display-time derivation, never persisted.
  const wishlist = useMemo(() => {
    const active = rawWishlist.filter((w) => !ownedElementIds.has(w.fplElementId));
    const sold = rawWishlist.filter((w) => ownedElementIds.has(w.fplElementId));
    return [...active, ...sold];
  }, [rawWishlist, ownedElementIds]);

  const fetchList = useCallback(async (): Promise<WishlistEntry[] | null> => {
    if (!teamId) return null;
    try {
      const res = await fetch(`/api/auction/wishlist?teamId=${teamId}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data.wishlist ?? []) as WishlistEntry[];
    } catch {
      return null;
    }
  }, [teamId]);

  /**
   * Re-sync from the server. Callers on a timer (the auction room's 3s resync) must pass
   * `{ background: true }` so an in-flight or just-completed local edit wins.
   */
  const refresh = useCallback(
    async (opts: { background?: boolean } = {}) => {
      if (opts.background && isDirty()) return;
      const list = await fetchList();
      if (list && !(opts.background && isDirty())) setWishlist(list);
    },
    [fetchList, isDirty]
  );

  // Fetch on mount / teamId change.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    fetch(`/api/auction/wishlist?teamId=${teamId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setWishlist(data.wishlist ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  /** Run a mutation while holding the dirty guard, so background polls can't race it. */
  const withGuard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    pendingRef.current += 1;
    try {
      return await fn();
    } finally {
      pendingRef.current -= 1;
      settleUntilRef.current = Date.now() + SETTLE_MS;
    }
  }, []);

  // Optimistic: the row appears immediately with a provisional id, then the authoritative list
  // replaces it. Previously this was POST-then-GET, so the star didn't light up for two round trips.
  const add = useCallback(
    async (fplElementId: number, playerName: string) => {
      if (!teamId || !leagueId) return;
      setWishlist((cur) =>
        cur.some((w) => w.fplElementId === fplElementId)
          ? cur
          : [...cur, { id: `pending-${fplElementId}`, fplElementId, playerName, priority: cur.length + 1 }]
      );
      await withGuard(async () => {
        try {
          const res = await fetch("/api/auction/wishlist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ leagueId, teamId, fplElementId, playerName }),
          });
          const list = res.ok ? await fetchList() : null;
          if (list) setWishlist(list);
        } catch {
          /* leave the optimistic row; the next refresh reconciles */
        }
      });
    },
    [teamId, leagueId, fetchList, withGuard]
  );

  const addMany = useCallback(
    async (players: { fplElementId: number; playerName: string }[]): Promise<boolean> => {
      if (!teamId || !leagueId || players.length === 0) return false;
      return withGuard(async () => {
        const res = await fetch("/api/auction/wishlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leagueId, teamId, players }),
        });
        if (res.ok) {
          const list = await fetchList();
          if (list) setWishlist(list);
        }
        return res.ok;
      });
    },
    [teamId, leagueId, fetchList, withGuard]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!teamId) return;
      const snapshot = rawWishlist;
      setWishlist((cur) => cur.filter((w) => w.id !== id));
      await withGuard(async () => {
        try {
          const res = await fetch("/api/auction/wishlist", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, teamId }),
          });
          if (!res.ok) setWishlist(snapshot); // roll back
        } catch {
          setWishlist(snapshot);
        }
      });
    },
    [teamId, rawWishlist, withGuard]
  );

  /**
   * Move `moveId` to sit immediately above `beforeId` (`null` = send to the bottom).
   *
   * Expressed as a target, not an index, which is what lets reordering keep working while the list
   * is filtered: "put A before B" is unambiguous even when the rows between them are hidden. It
   * also means the request body is two ids rather than the entire re-indexed list — the old handler
   * shipped all 327 entries on every arrow click and the server wrote them back one round trip at a
   * time, ~2s per click.
   *
   * Optimistic locally; the server recomputes authoritative priorities and only writes rows that
   * actually shift.
   */
  const reorder = useCallback(
    (moveId: string, beforeId: string | null) => {
      if (!teamId || moveId === beforeId) return;

      setWishlist((current) => {
        const active = current.filter((w) => !ownedElementIds.has(w.fplElementId));
        const sold = current.filter((w) => ownedElementIds.has(w.fplElementId));
        const from = active.findIndex((w) => w.id === moveId);
        if (from < 0) return current;

        const next = [...active];
        const [moved] = next.splice(from, 1);
        const insertAt = beforeId == null ? next.length : next.findIndex((w) => w.id === beforeId);
        next.splice(insertAt < 0 ? next.length : insertAt, 0, moved);

        return [...next.map((e, i) => ({ ...e, priority: i + 1 })), ...sold];
      });

      void withGuard(async () => {
        try {
          await fetch("/api/auction/wishlist", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, moveId, beforeId }),
          });
        } catch {
          /* the next non-background refresh reconciles */
        }
      });
    },
    [teamId, ownedElementIds, withGuard]
  );

  /** Move an entry to a 1-based rank within the ACTIVE list — backs the rank-number input. */
  const moveToPosition = useCallback(
    (moveId: string, position: number) => {
      const active = wishlist.filter((w) => !ownedElementIds.has(w.fplElementId));
      const without = active.filter((w) => w.id !== moveId);
      const target = Math.max(1, Math.min(Math.trunc(position), without.length + 1));
      // The row currently occupying that rank becomes our anchor; past the end means "bottom".
      reorder(moveId, target > without.length ? null : without[target - 1].id);
    },
    [wishlist, ownedElementIds, reorder]
  );

  /** Move an entry to the top of the active list. */
  const moveToTop = useCallback(
    (moveId: string) => {
      const active = wishlist.filter((w) => !ownedElementIds.has(w.fplElementId));
      const first = active.find((w) => w.id !== moveId);
      reorder(moveId, first ? first.id : null);
    },
    [wishlist, ownedElementIds, reorder]
  );

  /** Nudge one place up/down within the active list. */
  const nudge = useCallback(
    (moveId: string, direction: -1 | 1) => {
      const active = wishlist.filter((w) => !ownedElementIds.has(w.fplElementId));
      const idx = active.findIndex((w) => w.id === moveId);
      if (idx < 0) return;
      const target = idx + direction;
      if (target < 0 || target >= active.length) return;
      // Moving down means landing *after* the neighbour, i.e. before whatever follows it.
      if (direction === -1) reorder(moveId, active[target].id);
      else reorder(moveId, active[target + 1]?.id ?? null);
    },
    [wishlist, ownedElementIds, reorder]
  );

  const toggle = useCallback(
    async (fplElementId: number, playerName: string) => {
      const existing = wishlist.find((w) => w.fplElementId === fplElementId);
      if (existing) await remove(existing.id);
      else await add(fplElementId, playerName);
    },
    [wishlist, add, remove]
  );

  return {
    wishlist,
    setWishlist,
    refresh,
    add,
    addMany,
    remove,
    reorder,
    moveToPosition,
    moveToTop,
    nudge,
    toggle,
  };
}

export type WishlistController = ReturnType<typeof useWishlist>;
