"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWishlist } from "@/hooks/useWishlist";
import { WishlistList, type WishlistElement, type WishlistPlTeam } from "@/components/WishlistList";
import { POSITION_LABELS, POSITION_ORDER } from "@/lib/fpl/positions";
import { formatCurrency } from "@/lib/format/currency";

type BootstrapElement = WishlistElement & { total_points: number };

/**
 * Self-contained wishlist widget — not tied to any specific auction session, so it works any time
 * (before an auction starts, between sessions, etc.), unlike the wishlist panel embedded in the
 * live auction room (which only renders while a player-auction session is active/paused).
 *
 * The list itself is `WishlistList`, shared with the squad page and the auction room. This widget
 * used to render its own copy capped at five rows, with reorder buttons whose indices pointed into
 * the *full* list — so anything past #5 was simply unreachable here.
 */
export function WishlistManager({ leagueSlug, teamId }: { leagueSlug: string; teamId: string }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [elements, setElements] = useState<BootstrapElement[]>([]);
  const [plTeams, setPlTeams] = useState<Map<number, WishlistPlTeam>>(new Map());
  const [ownedElementIds, setOwnedElementIds] = useState<Set<number>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [positionFilter, setPositionFilter] = useState<number | null>(null);
  const [clubFilter, setClubFilter] = useState<number | null>(null);

  const { wishlist, add, remove, reorder, moveToTop, moveToPosition, nudge } = useWishlist(
    teamId,
    leagueId,
    ownedElementIds
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const leaguesRes = await fetch("/api/leagues");
        const leaguesJson = await leaguesRes.json();
        const league = (leaguesJson.leagues || []).find((l: { slug: string; id: string }) => l.slug === leagueSlug);
        if (!league) throw new Error("League not found");
        if (cancelled) return;
        setLeagueId(league.id);

        const [bootRes, ownedRes] = await Promise.all([
          fetch("/api/fpl/bootstrap"),
          fetch(`/api/auction/league-owned?leagueId=${league.id}`),
        ]);
        if (cancelled) return;
        if (bootRes.ok) {
          const boot = await bootRes.json();
          setElements(boot.elements ?? []);
          const tMap = new Map<number, WishlistPlTeam>();
          for (const t of boot.teams ?? []) tMap.set(t.id, t);
          setPlTeams(tMap);
        }
        if (ownedRes.ok) {
          const owned = await ownedRes.json();
          setOwnedElementIds(new Set(owned.ownedElementIds ?? []));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load wishlist");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [leagueSlug, teamId]);

  // Debounced so the ~700-element scan below doesn't run on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 250);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const wishlistElementIds = useMemo(() => new Set(wishlist.map((w) => w.fplElementId)), [wishlist]);

  const clubOptions = useMemo(
    () => [...plTeams.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [plTeams]
  );

  const searchResults = useMemo(() => {
    const lc = debouncedSearch.trim().toLowerCase();
    if (!lc && positionFilter === null && clubFilter === null) return [];
    return elements
      .filter((el) => !ownedElementIds.has(el.id))
      .filter((el) => (lc ? el.web_name.toLowerCase().includes(lc) : true))
      .filter((el) => positionFilter === null || el.element_type === positionFilter)
      .filter((el) => clubFilter === null || el.team === clubFilter)
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, 25);
  }, [elements, ownedElementIds, debouncedSearch, positionFilter, clubFilter]);

  const elementById = useMemo(() => {
    const m = new Map<number, WishlistElement>();
    for (const el of elements) m.set(el.id, el);
    return m;
  }, [elements]);

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-6 text-center text-gray-400 text-sm">
        Loading wishlist…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-6 text-center text-red-400 text-sm">
        {error}
      </div>
    );
  }

  const showSearchPanel = debouncedSearch.trim() !== "" || positionFilter !== null || clubFilter !== null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-bold text-white">Wishlist</h2>
        <span className="text-xs text-gray-400">{wishlist.length} player{wishlist.length === 1 ? "" : "s"}</span>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        Shortlist players now — the top unowned one auto-nominates for you if your turn&apos;s timer ever runs out during a live auction.
      </p>

      <div className="mb-3">
        <input
          type="text"
          placeholder="Search any unowned player to shortlist…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full rounded-lg bg-white/10 border border-white/20 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none"
        />
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {[null, ...POSITION_ORDER].map((pos) => (
            <button
              key={pos ?? "all"}
              onClick={() => setPositionFilter(pos)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase border transition ${
                positionFilter === pos
                  ? "bg-yellow-400 text-slate-900 border-yellow-400"
                  : "bg-white/5 text-gray-300 border-white/20 hover:bg-white/10"
              }`}
            >
              {pos === null ? "ALL" : POSITION_LABELS[pos]}
            </button>
          ))}
          <select
            value={clubFilter ?? ""}
            onChange={(e) => setClubFilter(e.target.value === "" ? null : Number(e.target.value))}
            className="text-[10px] rounded-full border border-white/20 bg-slate-800 px-2 py-1 text-gray-200"
          >
            <option value="">All clubs</option>
            {clubOptions.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        {showSearchPanel && (
          <div className="mt-2 max-h-52 overflow-y-auto space-y-1 rounded-lg border border-white/10 bg-black/20 p-1">
            {searchResults.length === 0 ? (
              <div className="text-[11px] text-gray-500 py-2 text-center">No unowned players match</div>
            ) : (
              searchResults.map((el) => {
                const inWl = wishlistElementIds.has(el.id);
                return (
                  <div key={el.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-white/5">
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">{el.web_name}</div>
                      <div className="text-[10px] text-gray-500">
                        {POSITION_LABELS[el.element_type]} · {plTeams.get(el.team)?.short_name ?? "—"}
                        {el.now_cost != null && ` · ${formatCurrency(el.now_cost * 100_000)}`}
                        {" · "}{el.total_points} pts
                      </div>
                    </div>
                    <button
                      onClick={() => (inWl ? undefined : add(el.id, el.web_name))}
                      disabled={inWl}
                      className={`h-7 w-7 shrink-0 flex items-center justify-center rounded-full text-xs transition ${
                        inWl ? "bg-yellow-400/20 text-yellow-400 cursor-default" : "bg-white/10 text-gray-300 hover:bg-purple-500/30 hover:text-purple-300"
                      }`}
                      title={inWl ? "Already in wishlist" : "Add to shortlist"}
                    >
                      {inWl ? "★" : "+"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      <div className="max-h-[28rem] overflow-y-auto pr-1">
        <WishlistList
          wishlist={wishlist}
          elementById={elementById}
          plTeams={plTeams}
          ownedElementIds={ownedElementIds}
          onReorder={reorder}
          onMoveToTop={moveToTop}
          onMoveToPosition={moveToPosition}
          onNudge={nudge}
          onRemove={remove}
          emptyMessage="Empty — search above to add players you want auto-nominated when it's your turn."
        />
      </div>

      <div className="mt-3 text-right">
        <Link href={`/${leagueSlug}/squad?tab=wishlist`} className="text-xs text-yellow-400 hover:text-yellow-300 hover:underline">
          Open in squad view →
        </Link>
      </div>
    </div>
  );
}
