// SlotStatus — consolidated display of squad-slot state.
//
// Surfaces three distinct concepts side-by-side:
//   - Open slots: `effectiveMax - active` — green. The team can still bid on these.
//   - Penalty slots: lost to missed nominations — red. Redeemable for £2.5M/£5M.
//   - Locked slots: bonus slots 15/16 awaiting purse-unlock — grey lock pill.
//
// Penalty and locked slots are visually distinct (red vs grey) per spec — different mechanics,
// different fix paths.
//
// Mounted on:
//   - Auction live page (with onUnlock + onRedeem callbacks)
//   - Squad page (same as auction)
//   - Teams page per-team card (compact=true, no callbacks → read-only)
//   - Admin Squad Overview (compact, no callbacks)

"use client";

export interface SlotStatusData {
  active: number;
  effectiveMax: number;
  baseCap: number;
  bonusSlots: number;
  penaltySlots: number;
  open: number;
  lockedCount: number;
  nextUnlockCost: number | null;
  canUnlock: boolean;
  unlockBlockedReason: string | null;
  redeemableCost: number | null;
  canRedeem: boolean;
  initialAuctionCompleted?: boolean;
}

interface SlotStatusProps {
  slotStatus: SlotStatusData;
  onUnlock?: () => void | Promise<void>;
  onRedeem?: () => void | Promise<void>;
  /** Compact mode: tighter spacing, no action buttons (read-only views on Teams page / Admin). */
  compact?: boolean;
  /** Auction-tier gating: when "primary", slot expansion (15/16 unlock) is hidden entirely. */
  auctionTier?: "primary" | "complete" | null;
}

function formatM(value: number): string {
  return `£${(value / 1_000_000).toFixed(1)}M`;
}

export function SlotStatus({ slotStatus, onUnlock, onRedeem, compact, auctionTier }: SlotStatusProps) {
  const {
    active,
    effectiveMax,
    bonusSlots,
    penaltySlots,
    open,
    lockedCount,
    nextUnlockCost,
    canUnlock,
    unlockBlockedReason,
    redeemableCost,
    canRedeem,
  } = slotStatus;
  const isPrimaryTier = auctionTier === "primary";

  const isFull = open === 0;
  const sizing = compact
    ? "text-[11px] gap-1.5 px-2 py-1"
    : "text-xs gap-2 px-3 py-1.5";

  return (
    <div className={`inline-flex flex-wrap items-center rounded-lg border border-white/10 bg-white/[0.03] ${sizing}`}>
      <span className="font-mono font-semibold text-white">
        {active} / {effectiveMax}
      </span>
      <span className="text-gray-500">squad</span>

      {/* Open / full segment */}
      <span className="text-gray-600">·</span>
      {isFull ? (
        <span className="text-yellow-300 font-medium">squad full</span>
      ) : (
        <span className="text-green-300 font-medium">
          {open} open {open === 1 ? "slot" : "slots"} to fill
        </span>
      )}

      {/* Penalty segment — red. Only shown when penaltySlots > 0. */}
      {penaltySlots > 0 && (
        <>
          <span className="text-gray-600">·</span>
          <span className="text-red-300 font-medium inline-flex items-center gap-1">
            <span className="text-red-400">✕</span>
            {penaltySlots} lost {penaltySlots === 1 ? "slot" : "slots"}
            {redeemableCost != null && (
              <span className="text-cyan-300">
                {" "}redeemable for {formatM(redeemableCost)}
                {penaltySlots > 1 ? " each" : ""}
              </span>
            )}
          </span>
          {!compact && onRedeem && canRedeem && redeemableCost != null && (
            <button
              type="button"
              onClick={onRedeem}
              className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30 border border-cyan-500/40 font-semibold transition"
            >
              Redeem
            </button>
          )}
          {!compact && !canRedeem && redeemableCost != null && (
            <span className="text-[10px] text-gray-500">(insufficient purse)</span>
          )}
        </>
      )}

      {/* Locked segment — grey/blue. Only shown when there are still bonus slots to unlock.
          In Primary tier the entire segment is hidden (slot expansion is disabled). */}
      {lockedCount > 0 && !isPrimaryTier && (
        <>
          <span className="text-gray-600">·</span>
          <span className="text-slate-400 font-medium inline-flex items-center gap-1" title={`Slot ${slotStatus.baseCap + bonusSlots + 1}${lockedCount === 2 ? `, slot ${slotStatus.baseCap + bonusSlots + 2}` : ""} locked — unlock with purse money`}>
            <span aria-hidden>🔒</span>
            {lockedCount} locked
            {nextUnlockCost != null && (
              <span className="text-slate-300">{" "}({formatM(nextUnlockCost)})</span>
            )}
          </span>
          {!compact && onUnlock && canUnlock && nextUnlockCost != null && (
            <button
              type="button"
              onClick={onUnlock}
              className="text-[10px] px-2 py-0.5 rounded bg-purple-500/20 text-purple-200 hover:bg-purple-500/30 border border-purple-500/40 font-semibold transition"
            >
              Unlock {formatM(nextUnlockCost)}
            </button>
          )}
          {!compact && !canUnlock && unlockBlockedReason && (
            <span className="text-[10px] text-gray-500">({unlockBlockedReason})</span>
          )}
        </>
      )}
    </div>
  );
}
