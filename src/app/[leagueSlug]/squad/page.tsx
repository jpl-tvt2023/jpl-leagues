"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LeagueNav } from "@/components/LeagueNav";
import { SlotStatus, type SlotStatusData } from "@/components/SlotStatus";
import { HelpTip } from "@/components/HelpTip";
import { useEnforceFormat, useLeague } from "@/lib/league-context";
import { creditedRefund } from "@/lib/formats/auction/economy";
import {
  DEADWOOD_GAMES_WINDOW,
  breakdownFromSnapshot,
  describeDeadwoodReason,
  parseDeadwoodReason,
  type RefundBreakdown,
} from "@/lib/formats/auction/release-refund";
import {
  RELEASE_DEADLINE_HOURS,
  describeReleaseConfirmation,
  type ReleaseCountdown,
} from "@/lib/formats/auction/release-deadline";
import { Sheet } from "@/components/ui/Sheet";
import { ReleaseRefundBreakdown } from "@/components/ReleaseRefundBreakdown";
import { ReleaseDeadlineTimer } from "@/components/ReleaseDeadlineTimer";
import { MAX_SQUAD_SIZE, type SquadCounts } from "@/lib/formats/auction/squad-rules";
import { useWishlist } from "@/hooks/useWishlist";
import { WishlistList } from "@/components/WishlistList";

interface SquadPlayer {
  ownershipId: string;
  fplElementId: number;
  playerName: string;
  purchasePrice: number;
  acquiredGw: number;
  status: "active" | "deadwood" | "released" | "pending_release";
  totalPoints: number;
  fmv: number;
  releaseRefund?: number | null;
  releaseFmv?: number | null;
  deadwoodReason?: string | null;
}

/** GET /api/auction/release — what releasing this player would refund, and why. */
interface ReleasePreview {
  ownershipId: string;
  playerName: string;
  breakdown: RefundBreakdown;
  fplStatus: string | null;
  lastGames: { round: number; minutes: number }[];
}

/** "check" only shows the amount; "release" shows the same and asks to confirm. */
type ReleaseMode = "check" | "release";

interface SquadResponse {
  teamId: string;
  teamName: string;
  leagueId: string;
  /** When pending releases are confirmed: the release deadline, or a tentative GW deadline. */
  releaseCountdown: ReleaseCountdown | null;
  /** Past the release deadline and the auction not yet over — releases can't be marked or cancelled. */
  releasesClosed: boolean;
  squad: SquadPlayer[];
  activeCount: number;
  deadwoodCount: number;
  slotStatus?: SlotStatusData;
}

// Inline wrapper that wires <SlotStatus> into the squad page — handles unlock + redeem flows
// (confirm → POST → refresh parent) so the page-level callback stays small.
function SquadSlotStatusInline({
  slotStatus,
  teamId,
  auctionTier,
  onChanged,
}: { slotStatus: SlotStatusData; teamId: string; auctionTier?: "primary" | "complete" | null; onChanged: () => void | Promise<void> }) {
  return (
    <SlotStatus
      slotStatus={slotStatus}
      auctionTier={auctionTier}
      onUnlock={async () => {
        const cost = slotStatus.nextUnlockCost;
        if (!cost) return;
        if (!confirm(`Unlock slot ${MAX_SQUAD_SIZE + slotStatus.bonusSlots + 1} for £${(cost / 1_000_000).toFixed(1)}M? This is non-refundable.`)) return;
        const res = await fetch(`/api/auction/unlock-slot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d?.error ?? "Unlock failed"); return; }
        await onChanged();
      }}
      onRedeem={async () => {
        const cost = slotStatus.redeemableCost;
        if (cost == null) return;
        if (!confirm(`Redeem penalty slot for £${(cost / 1_000_000).toFixed(1)}M?`)) return;
        const res = await fetch(`/api/auction/redeem-slot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d?.error ?? "Redeem failed"); return; }
        await onChanged();
      }}
    />
  );
}

interface EconomyResponse {
  teamId: string;
  teamName: string;
  initialBudget: number;
  currentPurse: number;
  computedPurse: number;
  totalSpent: number;
  totalIncome: number;
  totalRefunds: number;
}

interface BootstrapElement {
  id: number;
  web_name: string;
  team: number;
  element_type: number;
  now_cost: number;
  total_points: number;
  status: string;
}

interface BootstrapTeam {
  id: number;
  name: string;
  short_name: string;
}

interface AuctionSession {
  id: string;
  type: "initial" | "mini-auction";
  status: "pending" | "active" | "paused" | "completed";
}

const POSITION_LABELS: Record<number, string> = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  2: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  3: "bg-green-500/20 text-green-300 border-green-500/30",
  4: "bg-red-500/20 text-red-300 border-red-500/30",
};

function formatCurrency(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}

export default function SquadPage() {
  useEnforceFormat(["auction"]);
  const { league } = useLeague();
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [squadData, setSquadData] = useState<SquadResponse | null>(null);
  const [economy, setEconomy] = useState<EconomyResponse | null>(null);
  const [elements, setElements] = useState<Map<number, BootstrapElement>>(new Map());
  const [elementsList, setElementsList] = useState<BootstrapElement[]>([]);
  const [teamsMap, setTeamsMap] = useState<Map<number, BootstrapTeam>>(new Map());
  const [session, setSession] = useState<AuctionSession | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releasePreview, setReleasePreview] = useState<(ReleasePreview & { mode: ReleaseMode }) | null>(null);
  // Which button is fetching a preview, so only that one reads "Checking…".
  const [checking, setChecking] = useState<{ ownershipId: string; mode: ReleaseMode } | null>(null);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"squad" | "wishlist">("squad");
  const [wlSearch, setWlSearch] = useState("");
  const [wlDebouncedSearch, setWlDebouncedSearch] = useState("");
  const [wlPositionFilter, setWlPositionFilter] = useState<number | null>(null);
  const [wlClubFilter, setWlClubFilter] = useState<number | null>(null);
  const [ownedElementIds, setOwnedElementIds] = useState<Set<number>>(new Set());
  const [wishlistSelections, setWishlistSelections] = useState<Set<number>>(new Set());

  const teamId = squadData?.teamId ?? null;
  const leagueId = squadData?.leagueId ?? null;
  const {
    wishlist,
    add: addWishlist,
    addMany: addManyToWishlist,
    remove: removeWishlist,
    reorder: reorderWishlist,
    moveToTop: wishlistMoveToTop,
    moveToPosition: wishlistMoveToPosition,
    nudge: wishlistNudge,
  } = useWishlist(teamId, leagueId, ownedElementIds);

  // Deep-link support for "?tab=wishlist" (e.g. the Dashboard wishlist card's "Manage full
  // wishlist" link) — read via window.location rather than useSearchParams() to avoid requiring
  // a <Suspense> boundary around this already-fully-client page just for this one link.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "wishlist") {
      setActiveTab("wishlist");
    }
  }, []);

  // Debounce the add-search — it scans and sorts the full ~700-element list.
  useEffect(() => {
    const t = setTimeout(() => setWlDebouncedSearch(wlSearch), 250);
    return () => clearTimeout(t);
  }, [wlSearch]);

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const meRes = await fetch("/api/auth/me");
      const me = await meRes.json();
      if (!me.authenticated) {
        router.push("/signin");
        return;
      }
      if (me.type !== "team") {
        setError("Squad view is only available to team accounts.");
        setIsLoading(false);
        return;
      }
      const teamId = me.team.id;

      const [squadRes, economyRes, bootstrapRes] = await Promise.all([
        fetch(`/api/auction/squad?teamId=${teamId}`),
        fetch(`/api/auction/economy?teamId=${teamId}`),
        fetch("/api/fpl/bootstrap"),
      ]);

      if (!squadRes.ok) throw new Error("Failed to load squad");
      if (!economyRes.ok) throw new Error("Failed to load economy");

      const squadJson: SquadResponse = await squadRes.json();
      const economyJson: EconomyResponse = await economyRes.json();
      setSquadData(squadJson);
      setEconomy(economyJson);

      if (bootstrapRes.ok) {
        const boot = await bootstrapRes.json();
        const elMap = new Map<number, BootstrapElement>();
        for (const el of boot.elements ?? []) elMap.set(el.id, el);
        setElements(elMap);
        setElementsList(boot.elements ?? []);
        const tMap = new Map<number, BootstrapTeam>();
        for (const t of boot.teams ?? []) tMap.set(t.id, t);
        setTeamsMap(tMap);
      }

      // Fetch active auction session to determine release window
      const sessRes = await fetch(`/api/auction/session?leagueId=${squadJson.leagueId}`);
      if (sessRes.ok) {
        const sessJson = await sessRes.json();
        const active = sessJson.sessions?.find(
          (s: AuctionSession) => s.status === "active" || s.status === "paused"
        );
        setSession(active ?? null);
      }

      // Load owned players in league to filter search
      const ownedRes = await fetch(`/api/auction/league-owned?leagueId=${squadJson.leagueId}`);
      if (ownedRes.ok) {
        const ownedJson = await ownedRes.json();
        setOwnedElementIds(new Set(ownedJson.ownedElementIds ?? []));
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load squad");
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  // Release is available until the release deadline, 24h before the next mini-auction; the refund is
  // credited at that deadline.
  const canRelease = true;
  const releasesClosed = squadData?.releasesClosed ?? false;

  // Step 1 (both buttons): price the release and open the dialog — read-only for "check", with a
  // confirm step for "release". Whether he's deadwood depends on live FPL data, so only the server
  // can say what the refund will be.
  const handleRelease = async (ownershipId: string, mode: ReleaseMode) => {
    setChecking({ ownershipId, mode });
    setReleaseError(null);
    try {
      const res = await fetch(`/api/auction/release?ownershipId=${encodeURIComponent(ownershipId)}`);
      // A crashed route answers 500 with an empty body — fall back to our own message, not a parse error.
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't work out the refund — please try again");
      setReleasePreview({ ...(data as ReleasePreview), mode });
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "Couldn't work out the refund");
    } finally {
      setChecking(null);
    }
  };

  // Step 2: the team confirmed in the dialog. The server re-prices and locks the amount.
  const confirmRelease = async () => {
    if (!releasePreview) return;
    const { ownershipId } = releasePreview;
    setReleasing(ownershipId);
    setReleaseError(null);
    try {
      const res = await fetch("/api/auction/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownershipId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Release failed — please try again");
      await loadAll();
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "Release failed");
    } finally {
      setReleasePreview(null);
      setReleasing(null);
    }
  };

  const handleCancelRelease = async (ownershipId: string, playerName: string) => {
    if (!confirm(`Cancel pending release for ${playerName}?`)) return;
    setReleasing(ownershipId);
    setReleaseError(null);
    try {
      const res = await fetch("/api/auction/release", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownershipId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Cancel release failed — please try again");
      await loadAll();
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "Cancel release failed");
    } finally {
      setReleasing(null);
    }
  };

  const fmvSquadValue = squadData?.squad.reduce((sum, p) => sum + p.fmv, 0) ?? 0;
  const oldSquadValue = squadData?.squad.reduce((sum, p) => sum + p.purchasePrice, 0) ?? 0;
  const pendingReleases = squadData?.squad.filter((p) => p.status === "pending_release") ?? [];
  const pendingRefundTotal = pendingReleases.reduce(
    (sum, p) => sum + creditedRefund({ purchasePrice: p.purchasePrice, releaseRefund: p.releaseRefund ?? null }),
    0
  );

  const wishlistElementIds = useMemo(() => new Set(wishlist.map((w) => w.fplElementId)), [wishlist]);

  // Memoised and debounced. This scans ~700 elements and sorts them; unmemoised it re-ran on every
  // render of the page, including every single reorder click.
  const searchResults = useMemo(
    () =>
      elementsList
        .filter((el) => {
          if (ownedElementIds.has(el.id)) return false;
          if (wishlistElementIds.has(el.id)) return false;
          if (wlPositionFilter !== null && el.element_type !== wlPositionFilter) return false;
          if (wlClubFilter !== null && el.team !== wlClubFilter) return false;
          const lc = wlDebouncedSearch.trim().toLowerCase();
          if (lc && !el.web_name.toLowerCase().includes(lc)) return false;
          return true;
        })
        .sort((a, b) => b.total_points - a.total_points)
        .slice(0, 30),
    [elementsList, ownedElementIds, wishlistElementIds, wlPositionFilter, wlClubFilter, wlDebouncedSearch]
  );

  const wlClubOptions = useMemo(
    () => [...teamsMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    [teamsMap]
  );

  /** Squad composition, for the wishlist's position-coverage banner. */
  const wlSquadCounts = useMemo<SquadCounts | null>(() => {
    if (!squadData) return null;
    const counts: SquadCounts = { 1: 0, 2: 0, 3: 0, 4: 0, total: 0 };
    for (const p of squadData.squad) {
      const el = elements.get(p.fplElementId);
      if (el && el.element_type >= 1 && el.element_type <= 4) counts[el.element_type as 1 | 2 | 3 | 4]++;
      counts.total++;
    }
    return counts;
  }, [squadData, elements]);

  const handleBulkAddToWishlist = async () => {
    if (wishlistSelections.size === 0) return;
    const players = [...wishlistSelections].map((elementId) => ({
      fplElementId: elementId,
      playerName: elementsList.find((e) => e.id === elementId)?.web_name ?? "",
    }));
    const ok = await addManyToWishlist(players);
    if (ok) setWishlistSelections(new Set());
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueSlug}
        currentPage="squad"
        format="auction"
        auctionTier={league.auctionTier ?? "complete"}
        isLoggedIn={true}
        dashboardHref="/dashboard"
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="default" fullScreen={false} label="Loading Squad" />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : !squadData || !economy ? (
          <div className="text-center text-gray-400 py-12">No squad data available.</div>
        ) : (
          <>
            <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
              <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">{squadData.teamName}</h1>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {squadData.slotStatus ? (
                      <SquadSlotStatusInline slotStatus={squadData.slotStatus} teamId={squadData.teamId} auctionTier={league.auctionTier ?? "complete"} onChanged={loadAll} />
                    ) : (
                      <span className="rounded-full bg-white/10 px-3 py-1 text-white">{squadData.activeCount}/15 active</span>
                    )}
                    {squadData.deadwoodCount > 0 && (
                      <span className="rounded-full bg-yellow-500/20 text-yellow-300 px-3 py-1 border border-yellow-500/30">
                        {squadData.deadwoodCount} deadwood
                      </span>
                    )}
                    <span className="rounded-full bg-blue-500/20 text-blue-300 px-3 py-1 border border-blue-500/30 text-xs">
                      {releasesClosed ? "Releases closed until the mini-auction is over" : `Releases confirmed ${RELEASE_DEADLINE_HOURS}h before the mini-auction`}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-400 uppercase">Purse</div>
                  <div className="text-2xl font-mono font-bold text-green-300">{formatCurrency(economy.computedPurse)}</div>
                </div>
              </div>
              {/* Economy summary — always visible */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-white/10 text-sm">
                <div title="Everything you've spent — player purchases, club, slot unlocks, trade payments and transfer fees"><div className="text-[10px] text-gray-400 uppercase mb-0.5">Total Spent</div><div className="font-mono text-red-300">{formatCurrency(economy.totalSpent)}</div></div>
                <div title="Everything credited to your purse — GW payouts, release refunds and trade income"><div className="text-[10px] text-gray-400 uppercase mb-0.5">Total Income</div><div className="font-mono text-green-300">{formatCurrency(economy.totalIncome)}</div></div>
                <div title="Sum of purchase prices — what you originally paid"><div className="text-[10px] text-gray-400 uppercase mb-0.5">Old Squad Value</div><div className="font-mono text-white">{formatCurrency(oldSquadValue)}</div></div>
                <div title="Sum of current fair-market values (purchase + point appreciation)"><div className="text-[10px] text-gray-400 uppercase mb-0.5">FMV Squad Value</div><div className="font-mono text-white">{formatCurrency(fmvSquadValue)}</div></div>
              </div>
            </div>

            {pendingReleases.length > 0 && (
              <div className="mb-6 rounded-2xl border border-orange-500/40 bg-orange-500/5 p-4 backdrop-blur">
                <div className="mb-3 text-sm text-white">
                  <span className="text-[10px] uppercase tracking-wider text-orange-400 font-bold mr-2">Pending releases</span>
                  {pendingReleases.length} player{pendingReleases.length === 1 ? "" : "s"} ·{" "}
                  <span className="font-mono text-green-300">+{formatCurrency(pendingRefundTotal)}</span> to be paid out
                </div>
                <ReleaseDeadlineTimer countdown={squadData.releaseCountdown} onDeadline={loadAll} />
              </div>
            )}

            {releaseError && (
              <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {releaseError}
              </div>
            )}

            <div className="mb-6 flex gap-2 border-b border-white/10">
              <button
                onClick={() => setActiveTab("squad")}
                title="View the players you currently own"
                className={`px-4 py-2 text-sm font-semibold uppercase tracking-wider transition border-b-2 ${
                  activeTab === "squad" ? "border-yellow-400 text-yellow-400" : "border-transparent text-gray-400 hover:text-white"
                }`}
              >
                Squad
              </button>
              <button
                onClick={() => setActiveTab("wishlist")}
                title="Your priority list for auto-nomination when your turn's timer runs out"
                className={`px-4 py-2 text-sm font-semibold uppercase tracking-wider transition border-b-2 ${
                  activeTab === "wishlist" ? "border-yellow-400 text-yellow-400" : "border-transparent text-gray-400 hover:text-white"
                }`}
              >
                Wishlist ({wishlist.length})
              </button>
            </div>

            {activeTab === "wishlist" ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
                {/* Current wishlist */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <h2 className="text-lg font-bold text-white mb-3">Your Priority List</h2>
                  <p className="text-xs text-gray-400 mb-4">
                    When your nomination turn comes and the 60s timer expires, the top unowned entry is auto-nominated. If the list is empty, you lose a squad slot.
                  </p>
                  <WishlistList
                    wishlist={wishlist}
                    elementById={elements}
                    plTeams={teamsMap}
                    ownedElementIds={ownedElementIds}
                    onReorder={reorderWishlist}
                    onMoveToTop={wishlistMoveToTop}
                    onMoveToPosition={wishlistMoveToPosition}
                    onNudge={wishlistNudge}
                    onRemove={removeWishlist}
                    purse={economy?.computedPurse ?? null}
                    squadCounts={wlSquadCounts}
                    maxSquadSize={squadData?.slotStatus?.effectiveMax ?? null}
                    penaltySlots={squadData?.slotStatus?.penaltySlots ?? 0}
                    bonusSlots={squadData?.slotStatus?.bonusSlots ?? 0}
                    emptyMessage="Empty — add players from the right."
                  />
                </div>

                {/* Add players */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <h2 className="text-lg font-bold text-white mb-3">Add Players</h2>
                  <input
                    type="text"
                    placeholder="Search player name..."
                    title="Type part of a player's name to find them, then add to your wishlist"
                    value={wlSearch}
                    onChange={(e) => setWlSearch(e.target.value)}
                    className="w-full rounded-lg bg-white/10 border border-white/20 px-3 py-2 text-white placeholder-gray-500 focus:border-yellow-400 focus:outline-none mb-3"
                  />
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    {([
                      [null, "ALL"],
                      [1, "GKP"],
                      [2, "DEF"],
                      [3, "MID"],
                      [4, "FWD"],
                    ] as [number | null, string][]).map(([pos, label]) => (
                      <button
                        key={label}
                        onClick={() => setWlPositionFilter(pos)}
                        className={`px-3 py-1 rounded-full text-xs font-bold uppercase border transition ${
                          wlPositionFilter === pos
                            ? "bg-yellow-400 text-slate-900 border-yellow-400"
                            : "bg-white/5 text-gray-300 border-white/20 hover:bg-white/10"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                    <select
                      value={wlClubFilter ?? ""}
                      onChange={(e) => setWlClubFilter(e.target.value === "" ? null : Number(e.target.value))}
                      title="Filter the search by real-life Premier League club"
                      className="rounded-full border border-white/20 bg-slate-800 px-3 py-1 text-xs text-gray-200"
                    >
                      <option value="">All clubs</option>
                      {wlClubOptions.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                  {searchResults.length > 0 && (
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-500">Showing top {searchResults.length} by points</span>
                      <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-400 hover:text-white select-none">
                        <input
                          type="checkbox"
                          className="accent-yellow-400"
                          checked={searchResults.every((e) => wishlistSelections.has(e.id)) && searchResults.length > 0}
                          onChange={(ev) => {
                            const ids = searchResults.map((e) => e.id);
                            if (ev.target.checked) {
                              setWishlistSelections((prev) => new Set([...prev, ...ids]));
                            } else {
                              setWishlistSelections((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
                            }
                          }}
                        />
                        Select all
                      </label>
                    </div>
                  )}
                  <div className="max-h-[32rem] overflow-y-auto space-y-1">
                    {searchResults.length === 0 ? (
                      <div className="text-sm text-gray-500 py-6 text-center">No matches</div>
                    ) : (
                      searchResults.map((el) => {
                        const team = teamsMap.get(el.team);
                        const selected = wishlistSelections.has(el.id);
                        return (
                          <div
                            key={el.id}
                            className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition text-left"
                          >
                            <div className="flex items-center gap-3">
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-yellow-400 cursor-pointer shrink-0"
                                checked={selected}
                                onChange={(ev) => {
                                  setWishlistSelections((prev) => {
                                    const next = new Set(prev);
                                    if (ev.target.checked) next.add(el.id);
                                    else next.delete(el.id);
                                    return next;
                                  });
                                }}
                              />
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${POSITION_COLORS[el.element_type]}`}>
                                {POSITION_LABELS[el.element_type]}
                              </span>
                              <div>
                                <div className="text-white font-semibold">{el.web_name}</div>
                                <div className="text-xs text-gray-400">{team?.short_name ?? "—"}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <div className="text-sm font-mono text-[#00ff85]">{el.total_points} pts</div>
                              <button
                                onClick={() => addWishlist(el.id, el.web_name)}
                                className="text-yellow-400 font-bold text-lg hover:text-yellow-300 transition"
                                title="Add to wishlist"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {wishlistSelections.size > 0 && (
                    <div className="mt-3 border-t border-white/10 pt-3">
                      <button
                        onClick={handleBulkAddToWishlist}
                        className="w-full rounded-lg bg-gradient-to-r from-purple-500 to-indigo-500 px-4 py-2.5 font-bold text-white hover:from-purple-400 hover:to-indigo-400 transition text-sm"
                      >
                        Add {wishlistSelections.size} player{wishlistSelections.size !== 1 ? "s" : ""} to Wishlist
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
            <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {([1, 2, 3, 4] as const).map((posType) => {
              const playersInPos = squadData.squad.filter((p) => {
                const el = elements.get(p.fplElementId);
                return el?.element_type === posType;
              });
              return (
                <div key={posType} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center justify-between gap-2 mb-3 px-1">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${POSITION_COLORS[posType]}`}>
                      {POSITION_LABELS[posType]}
                    </span>
                    <span className="text-xs text-gray-500">{playersInPos.length}</span>
                  </div>
                  {playersInPos.length === 0 ? (
                    <div className="text-center text-xs text-gray-600 py-6">No players</div>
                  ) : (
                  <div className="space-y-2">
                    {playersInPos.map((p) => {
                      const el = elements.get(p.fplElementId);
                      const position = el ? POSITION_LABELS[el.element_type] : "—";
                      const positionColor = el ? POSITION_COLORS[el.element_type] : "bg-white/10 text-gray-300 border-white/20";
                      const team = el ? teamsMap.get(el.team) : null;
                      const pnl = p.fmv - p.purchasePrice;
                      const isExpanded = expandedCard === p.ownershipId;
                      return (
                  <div
                    key={p.ownershipId}
                    className={`rounded-xl border ${
                      p.status === "pending_release"
                        ? "border-orange-500/50 bg-orange-500/5 border-dashed"
                        : p.status === "deadwood"
                        ? "border-yellow-500/40 bg-yellow-500/5"
                        : "border-white/10 bg-white/5"
                    } backdrop-blur transition`}
                  >
                    {/* Always-visible summary row — click to expand */}
                    <button
                      onClick={() => setExpandedCard(isExpanded ? null : p.ownershipId)}
                      className="w-full flex items-center gap-3 p-4 text-left hover:bg-white/5 transition rounded-xl"
                    >
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 ${positionColor}`}>{position}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-white truncate">{p.playerName}</div>
                        <div className="text-xs text-gray-400">{team?.short_name ?? "—"}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs text-gray-400">Purchase</div>
                        <div className="font-mono text-sm text-white">{formatCurrency(p.purchasePrice)}</div>
                      </div>
                      <span className={`text-gray-400 text-xs transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}>▼</span>
                    </button>

                    {/* Expanded details */}
                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-1 text-xs text-gray-300 border-t border-white/10 pt-3">
                        <div className="flex justify-between"><span><HelpTip tip="Fair Market Value — what this player is worth now (purchase price adjusted for points scored). Used for trade floors.">FMV</HelpTip></span><span className="font-mono text-white">{formatCurrency(p.fmv)}</span></div>
                        <div className="flex justify-between">
                          <span><HelpTip tip="Profit & Loss — current FMV minus what you paid.">P&amp;L</HelpTip></span>
                          <span className={`font-mono ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
                          </span>
                        </div>
                        <div className="flex justify-between"><span>Points</span><span className="font-mono text-[#00ff85]">{p.totalPoints}</span></div>
                        <div className="flex justify-between"><span>Acquired</span><span className="font-mono">GW{p.acquiredGw}</span></div>
                        {p.status === "deadwood" && (
                          <div className="pt-1 text-[10px] uppercase tracking-wider text-yellow-400 font-bold">Deadwood</div>
                        )}
                        {p.status === "pending_release" && (() => {
                          const snapshot = {
                            purchasePrice: p.purchasePrice,
                            releaseRefund: p.releaseRefund ?? null,
                            releaseFmv: p.releaseFmv ?? null,
                            deadwoodReason: p.deadwoodReason ?? null,
                          };
                          const breakdown = breakdownFromSnapshot(snapshot);
                          const deadwood = parseDeadwoodReason(p.deadwoodReason);
                          return (
                            <div className="pt-2 space-y-2">
                              <div className="text-[10px] uppercase tracking-wider text-orange-400 font-bold">
                                Pending Release{deadwood ? " · Deadwood" : ""} — refund {formatCurrency(creditedRefund(snapshot))}
                              </div>
                              {deadwood && (
                                <div className="text-[11px] text-yellow-300">Deadwood: {describeDeadwoodReason(deadwood)}</div>
                              )}
                              {breakdown && <ReleaseRefundBreakdown breakdown={breakdown} />}
                              <div className="text-[11px] text-gray-400">
                                Amount locked when you marked him. {describeReleaseConfirmation(squadData.releaseCountdown)} He keeps scoring for you until then, and you can cancel until it&apos;s confirmed.
                              </div>
                            </div>
                          );
                        })()}
                        {canRelease && (p.status === "active" || p.status === "deadwood") && (() => {
                          const busy = checking?.ownershipId === p.ownershipId;
                          return (
                            <div className="mt-2 flex gap-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRelease(p.ownershipId, "check"); }}
                                disabled={busy}
                                title="See exactly what you'd get back and how it's worked out. Nothing is released."
                                className="flex-1 rounded-lg bg-white/10 border border-white/20 text-white text-xs font-semibold py-1.5 hover:bg-white/20 transition disabled:opacity-50"
                              >
                                {busy && checking?.mode === "check" ? "Checking…" : "Check release amount"}
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRelease(p.ownershipId, "release"); }}
                                disabled={busy || releasesClosed}
                                title={
                                  releasesClosed
                                    ? `Releases closed ${RELEASE_DEADLINE_HOURS} hours before the mini-auction — they reopen once it's over.`
                                    : "Shows the refund breakdown, then asks you to confirm the release."
                                }
                                className="flex-1 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 text-xs font-semibold py-1.5 hover:bg-red-500/30 transition disabled:opacity-50"
                              >
                                {busy && checking?.mode === "release" ? "Checking…" : "Release player"}
                              </button>
                            </div>
                          );
                        })()}
                        {p.status === "pending_release" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCancelRelease(p.ownershipId, p.playerName); }}
                            disabled={releasing === p.ownershipId}
                            title="Cancel the pending release and keep this player — possible until the release is confirmed."
                            className="mt-2 w-full rounded-lg bg-white/10 border border-white/20 text-white text-xs font-semibold py-1.5 hover:bg-white/20 transition disabled:opacity-50"
                          >
                            {releasing === p.ownershipId ? "..." : "Cancel Release"}
                          </button>
                        )}
                      </div>
                    )}
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>
              );
            })}
            </div>

            {squadData.squad.length === 0 && (
              <div className="text-center py-12 rounded-2xl border border-white/10 bg-white/5">
                <p className="text-gray-400">No players in your squad yet. Head to the auction to bid on players.</p>
              </div>
            )}
            </>
            )}
          </>
        )}
      </div>

      <Sheet
        open={releasePreview !== null}
        onClose={() => { if (!releasing) setReleasePreview(null); }}
        title={
          !releasePreview
            ? ""
            : releasePreview.mode === "check"
              ? `Release amount: ${releasePreview.playerName}`
              : `Release ${releasePreview.playerName}?`
        }
        description={
          releasePreview?.mode === "check"
            ? "What you'd get back if you released him now, and how it's worked out. Nothing has been released."
            : "Here's exactly what you'd get back, and how it's worked out."
        }
        size="md"
        hideClose
        footer={releasePreview && (
          releasePreview.mode === "check" ? (
            <button
              type="button"
              onClick={() => setReleasePreview(null)}
              className="w-full rounded-lg border border-white/20 bg-white/10 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"
            >
              Close
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setReleasePreview(null)}
                disabled={releasing !== null}
                className="flex-1 rounded-lg border border-white/20 bg-white/10 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
              >
                Keep him
              </button>
              <button
                type="button"
                onClick={confirmRelease}
                disabled={releasing !== null}
                className="flex-1 rounded-lg border border-red-500/40 bg-red-500/20 py-2.5 text-sm font-semibold text-red-200 transition hover:bg-red-500/30 disabled:opacity-50"
              >
                {releasing ? "Releasing…" : `Confirm release (+${formatCurrency(releasePreview.breakdown.refund)})`}
              </button>
            </div>
          )
        )}
      >
        {releasePreview && <ReleaseVerdict preview={releasePreview} countdown={squadData?.releaseCountdown ?? null} />}
      </Sheet>
    </div>
  );
}

/** Body of the release dialog: deadwood verdict (with the evidence), refund breakdown, timing. */
function ReleaseVerdict({ preview, countdown }: { preview: ReleasePreview & { mode: ReleaseMode }; countdown: ReleaseCountdown | null }) {
  const { breakdown, lastGames } = preview;
  const deadwood = breakdown.deadwoodReason;
  const minutesPlayed = lastGames.reduce((s, g) => s + g.minutes, 0);

  let verdict: string;
  if (deadwood) {
    verdict = `Deadwood — ${describeDeadwoodReason(deadwood)}. You get the 80% rate.`;
  } else if (lastGames.length < DEADWOOD_GAMES_WINDOW) {
    verdict = `Standard release — only ${lastGames.length} finished game${lastGames.length === 1 ? "" : "s"} on record, and deadwood needs ${DEADWOOD_GAMES_WINDOW} in a row without minutes.`;
  } else {
    verdict = `Standard release — he played ${minutesPlayed} minute${minutesPlayed === 1 ? "" : "s"} in his last ${DEADWOOD_GAMES_WINDOW} games.`;
  }

  return (
    <div className="space-y-4 text-sm">
      <div className={`rounded-xl border p-3 ${deadwood ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-200" : "border-white/10 bg-white/5 text-gray-200"}`}>
        <p>{verdict}</p>
        {lastGames.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`Minutes in his last ${lastGames.length} games, newest first`}>
            {lastGames.map((g, i) => (
              <span key={i} className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${g.minutes === 0 ? "bg-white/5 text-gray-400" : "bg-green-500/15 text-green-300"}`}>
                GW{g.round}: {g.minutes}&apos;
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-gray-400">
          Deadwood (80% rate) = no minutes in his last {DEADWOOD_GAMES_WINDOW} games, or FPL lists him as unavailable (transferred or loaned out). Otherwise the standard 50% rate applies.
        </p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 p-3">
        <ReleaseRefundBreakdown breakdown={breakdown} />
      </div>

      <ul className="list-disc space-y-1 pl-5 text-xs text-gray-400">
        {preview.mode === "check" ? (
          <li>This is today&apos;s amount. If you release him later it&apos;s worked out again then — his FMV and deadwood status can change.</li>
        ) : (
          <li>The refund is locked the moment you confirm.</li>
        )}
        <li>{describeReleaseConfirmation(countdown)} The refund is credited then and he keeps scoring for you until then.</li>
        <li>You can mark and cancel releases until that deadline. From then until the auction is over, releases are closed so everyone sees the final player pool.</li>
      </ul>
    </div>
  );
}
