"use client";

// Hoverable economy card for the dashboard's top "Economy Grid" row.
//
// The card itself renders inline (label / value / caption). The tooltip is portalled to
// document.body and positioned via getBoundingClientRect() — this escapes the parent grid's
// stacking context so siblings with backdrop-blur (Last Gameweek, Standings, etc.) can't clip it.
// Same pattern as ClubTooltipCell in AuctionStandings.tsx.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface EconomyCardProps {
  label: string;
  value: ReactNode;
  valueClass?: string;
  caption?: ReactNode;
  tooltip?: ReactNode;
  tooltipWidth?: number; // pixels — default 288 matches the legacy w-72 popovers
}

export function EconomyCard({ label, value, valueClass, caption, tooltip, tooltipWidth = 288 }: EconomyCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const show = () => {
    if (!ref.current || !tooltip) return;
    const r = ref.current.getBoundingClientRect();
    // Anchor below the card, right-aligned to the card's right edge; clamp to viewport on the left.
    setPos({ top: r.bottom + 6, left: Math.max(8, r.right - tooltipWidth) });
  };
  const hide = () => setPos(null);

  return (
    <div
      ref={ref}
      onMouseEnter={tooltip ? show : undefined}
      onMouseLeave={hide}
      className={`relative rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur ${tooltip ? "cursor-help" : "cursor-default"}`}
    >
      <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl sm:text-2xl font-bold ${valueClass ?? "text-white"}`}>{value}</div>
      {caption && <div className="text-xs text-gray-500 mt-1">{caption}</div>}
      {mounted && pos && tooltip && createPortal(
        <div
          className="fixed z-50 rounded-xl border border-white/10 bg-slate-800/95 backdrop-blur-xl shadow-xl p-3 pointer-events-none"
          style={{ top: pos.top, left: pos.left, width: tooltipWidth }}
        >
          {tooltip}
        </div>,
        document.body,
      )}
    </div>
  );
}
