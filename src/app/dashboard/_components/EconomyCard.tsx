"use client";

// Economy card for the dashboard's top "Economy Grid" row: label / value / caption, and an optional
// breakdown tooltip opened by hovering or tapping the whole card.
//
// The tooltip is a HelpTip, which portals it to document.body (so sibling panels with
// backdrop-blur can't clip it) and keeps it on screen: the Squad Value breakdown lists every
// active player, which is taller than the room below the card on a phone, so the bubble flips to
// the roomier side and scrolls instead of running off the bottom.

import type { ReactNode } from "react";
import { HelpTip } from "@/components/HelpTip";

interface EconomyCardProps {
  label: string;
  value: ReactNode;
  valueClass?: string;
  caption?: ReactNode;
  tooltip?: ReactNode;
  tooltipWidth?: number; // pixels — default 288 matches the legacy w-72 popovers
}

const CARD_CLASS = "rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5 backdrop-blur";

export function EconomyCard({ label, value, valueClass, caption, tooltip, tooltipWidth = 288 }: EconomyCardProps) {
  const body = (
    <>
      <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl sm:text-2xl font-bold ${valueClass ?? "text-white"}`}>{value}</div>
      {caption && <div className="text-xs text-gray-500 mt-1">{caption}</div>}
    </>
  );

  if (!tooltip) return <div className={`${CARD_CLASS} cursor-default`}>{body}</div>;

  return (
    <HelpTip as="div" tip={tooltip} width={tooltipWidth} className={`${CARD_CLASS} block no-underline`}>
      {body}
    </HelpTip>
  );
}
