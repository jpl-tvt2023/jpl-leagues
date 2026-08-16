"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export interface WishlistEntry {
  id: string;
  fplElementId: number;
  playerName: string;
  priority: number;
}

const EMPTY_OWNED_IDS = new Set<number>();

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

  // Active entries first (priority order), sold/owned entries appended after (also priority
  // order among themselves) — a pure display-time derivation, never persisted.
  const wishlist = useMemo(() => {
    const active = rawWishlist.filter((w) => !ownedElementIds.has(w.fplElementId));
    const sold = rawWishlist.filter((w) => ownedElementIds.has(w.fplElementId));
    return [...active, ...sold];
  }, [rawWishlist, ownedElementIds]);

  const refresh = useCallback(async () => {
    if (!teamId) return;
    const res = await fetch(`/api/auction/wishlist?teamId=${teamId}`);
    if (res.ok) {
      const data = await res.json();
      setWishlist(data.wishlist ?? []);
    }
  }, [teamId]);

  // Fetch on mount / teamId change. Inlined (rather than calling `refresh` here) so the effect
  // body's own setState call is trivially local — `refresh` remains separately callable for
  // explicit re-syncs (SSE reconnect, post-mutation refresh) elsewhere.
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

  const add = useCallback(
    async (fplElementId: number, playerName: string) => {
      if (!teamId || !leagueId) return;
      const res = await fetch("/api/auction/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId, teamId, fplElementId, playerName }),
      });
      if (res.ok) await refresh();
    },
    [teamId, leagueId, refresh]
  );

  const addMany = useCallback(
    async (players: { fplElementId: number; playerName: string }[]): Promise<boolean> => {
      if (!teamId || !leagueId || players.length === 0) return false;
      const res = await fetch("/api/auction/wishlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueId, teamId, players }),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [teamId, leagueId, refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!teamId) return;
      const res = await fetch("/api/auction/wishlist", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, teamId }),
      });
      if (res.ok) await refresh();
    },
    [teamId, refresh]
  );

  // Optimistic reorder — updates local state immediately, persists in the background. Operates
  // only on the active (non-owned) subset: fromIdx/toIdx are indices within that subset, matching
  // what callers compute for their reorder-button positions. Sold entries keep whatever priority
  // they last had — irrelevant now since display order always sorts them after active entries.
  const reorder = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (!teamId) return;
      setWishlist((current) => {
        const active = current.filter((w) => !ownedElementIds.has(w.fplElementId));
        const sold = current.filter((w) => ownedElementIds.has(w.fplElementId));
        if (toIdx < 0 || toIdx >= active.length) return current;
        const next = [...active];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        const reindexed = next.map((e, i) => ({ ...e, priority: i + 1 }));
        const items = reindexed.map((e) => ({ id: e.id, priority: e.priority }));
        fetch("/api/auction/wishlist", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId, items }),
        }).catch(() => {});
        return [...reindexed, ...sold];
      });
    },
    [teamId, ownedElementIds]
  );

  const toggle = useCallback(
    async (fplElementId: number, playerName: string) => {
      const existing = wishlist.find((w) => w.fplElementId === fplElementId);
      if (existing) await remove(existing.id);
      else await add(fplElementId, playerName);
    },
    [wishlist, add, remove]
  );

  return { wishlist, setWishlist, refresh, add, addMany, remove, reorder, toggle };
}

export type WishlistController = ReturnType<typeof useWishlist>;
