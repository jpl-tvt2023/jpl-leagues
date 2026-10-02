"use client";

import Link from "next/link";
import { NavIcon } from "./icons/NavIcon";
import type { NavItem } from "@/lib/nav-links";

export interface BottomNavProps {
  /** `NavModel.bottom` — at most four, already gated for this viewer. */
  items: NavItem[];
  activeKey: string;
  /** Palette classes for the active slot's indicator pill. */
  activeBgClass: string;
  activeTextClass: string;
  /** Opens the navigation drawer. Omitted when the bar already holds every page. */
  onMore?: () => void;
  moreExpanded?: boolean;
}

const SLOT =
  "flex h-full w-full flex-col items-center justify-center gap-1 text-xs font-medium transition active:opacity-70";

function Indicator({ active, activeBgClass, children }: { active: boolean; activeBgClass: string; children: React.ReactNode }) {
  // Material 3 navigation bar: the active destination gets a pill behind its icon.
  return (
    <span
      className={`flex h-8 w-16 items-center justify-center rounded-full transition-colors duration-200 ${
        active ? activeBgClass : ""
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Android-style bottom navigation bar for phones and tablets (hidden from `lg`, where the
 * desktop bar shows every link).
 *
 * `id="app-bottom-nav"` is load-bearing: `globals.css` reserves the bar's height on `<body>`
 * via `body:has(#app-bottom-nav)`, so no page needs its own bottom padding. Labelled "Primary"
 * to keep it distinguishable from the top bar ("Main") for assistive tech and tests.
 */
export function BottomNav({ items, activeKey, activeBgClass, activeTextClass, onMore, moreExpanded }: BottomNavProps) {
  return (
    <nav
      id="app-bottom-nav"
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-slate-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto flex h-20 max-w-xl items-stretch">
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <li key={item.key} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`${SLOT} ${active ? `${activeTextClass} font-semibold` : "text-gray-400 hover:text-gray-200"}`}
              >
                <Indicator active={active} activeBgClass={activeBgClass}>
                  {item.icon && <NavIcon name={item.icon} className="h-6 w-6" />}
                </Indicator>
                <span className="max-w-full truncate px-1">{item.shortLabel ?? item.label}</span>
              </Link>
            </li>
          );
        })}
        {onMore && (
          <li className="min-w-0 flex-1">
            <button
              type="button"
              onClick={onMore}
              aria-expanded={moreExpanded}
              aria-controls="app-nav-drawer"
              className={`${SLOT} text-gray-400 hover:text-gray-200`}
            >
              <Indicator active={false} activeBgClass={activeBgClass}>
                <NavIcon name="menu" className="h-6 w-6" />
              </Indicator>
              <span>More</span>
            </button>
          </li>
        )}
      </ul>
    </nav>
  );
}
