"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWishlist } from "@/hooks/useWishlist";

interface BootstrapElement {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  total_points: number;
}

interface BootstrapTeam {
  id: number;
  name: string;
  short_name: string;
}

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

/**
 * Self-contained wishlist widget — not tied to any specific auction session, so it works any time
 * (before an auction starts, between sessions, etc.), unlike the wishlist panel embedded in the
 * live auction room (which only renders while a player-auction session is active/paused).
 */
export function WishlistManager({ leagueSlug, teamId }: { leagueSlug: string; teamId: string }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [elements, setElements] = useState<BootstrapElement[]>([]);
  const [plTeams, setPlTeams] = useState<Map<number, BootstrapTeam>>(new Map());
  const [ownedElementIds, setOwnedElementIds] = useState<Set<number>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [positionFilter, setPositionFilter] = useState<number | null>(null);

  const { wishlist, add, remove, reorder } = useWishlist(teamId, leagueId, ownedElementIds);

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
          const tMap = new Map<number, BootstrapTeam>();
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

  const wishlistElementIds = useMemo(() => new Set(wishlist.map((w) => w.fplElementId)), [wishlist]);

  const searchResults = useMemo(() => {
    const lc = searchTerm.trim().toLowerCase();
    if (!lc) return [];
    return elements
      .filter((el) => !ownedElementIds.has(el.id) && el.web_name.toLowerCase().includes(lc))
      .filter((el) => positionFilter === null || el.element_type === positionFilter)
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, 20);
  }, [elements, ownedElementIds, searchTerm, positionFilter]);

  const elementById = useMemo(() => {
    const m = new Map<number, BootstrapElement>();
    for (const el of elements) m.set(el.id, el);
    return m;
  }, [elements]);

  const activeWishlist = useMemo(() => wishlist.filter((w) => !ownedElementIds.has(w.fplElementId)), [wishlist, ownedElementIds]);

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
          {([
            [null, "ALL"],
            [1, "GKP"],
            [2, "DEF"],
            [3, "MID"],
            [4, "FWD"],
          ] as [number | null, string][]).map(([pos, label]) => (
            <button
              key={label}
              onClick={() => setPositionFilter(pos)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase border transition ${
                positionFilter === pos
                  ? "bg-yellow-400 text-slate-900 border-yellow-400"
                  : "bg-white/5 text-gray-300 border-white/20 hover:bg-white/10"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {searchTerm.trim() && (
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
                      <div className="text-[10px] text-gray-500">{POSITION_LABELS[el.element_type]} · {plTeams.get(el.team)?.short_name ?? "—"} · {el.total_points} pts</div>
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

      {wishlist.length === 0 ? (
        <div className="text-xs text-gray-500 py-4 text-center">
          Empty — search above to add players you want auto-nominated when it&apos;s your turn.
        </div>
      ) : (
        <div className="space-y-1">
          {wishlist.slice(0, 5).map((entry) => {
            const owned = ownedElementIds.has(entry.fplElementId);
            const activeIdx = activeWishlist.findIndex((w) => w.id === entry.id);
            const el = elementById.get(entry.fplElementId);
            return (
              <div key={entry.id} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm bg-white/5 ${owned ? "opacity-50" : ""}`}>
                <span className="w-5 text-right text-[11px] text-gray-500">{entry.priority}.</span>
                {el && <span className="text-[10px] text-gray-500 w-8">{POSITION_LABELS[el.element_type] ?? ""}</span>}
                <span className={`flex-1 truncate ${owned ? "text-gray-400 line-through" : "text-white"}`}>{entry.playerName}</span>
                {el && <span className="text-[10px] text-gray-500">{plTeams.get(el.team)?.short_name ?? ""}</span>}
                {owned ? (
                  <span className="text-[9px] text-gray-500 uppercase tracking-wide px-1">Owned</span>
                ) : (
                  <>
                    <button onClick={() => reorder(activeIdx, activeIdx - 1)} disabled={activeIdx === 0} className="text-gray-400 hover:text-white disabled:opacity-30 text-[11px]" title="Move up">▲</button>
                    <button onClick={() => reorder(activeIdx, activeIdx + 1)} disabled={activeIdx === activeWishlist.length - 1} className="text-gray-400 hover:text-white disabled:opacity-30 text-[11px]" title="Move down">▼</button>
                  </>
                )}
                <button onClick={() => remove(entry.id)} className="text-red-400 hover:text-red-300 text-[11px]" title="Remove">✕</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 text-right">
        <Link href={`/${leagueSlug}/squad?tab=wishlist`} className="text-xs text-yellow-400 hover:text-yellow-300 hover:underline">
          Manage full wishlist →
        </Link>
      </div>
    </div>
  );
}
