import type { ReactNode } from "react";
import type { NavIconName } from "@/lib/nav-links";

/** Nav glyphs plus the chrome's own controls (menu, account, install, …). */
export type IconName = NavIconName | "menu" | "logout" | "install" | "add" | "chevron-down" | "check" | "close";

/**
 * Outline glyphs on a 24px grid, stroked with `currentColor` so they pick up the surrounding text
 * colour (and the active-pill colour in the bottom bar). Hand-drawn inline SVG like every other
 * glyph in the repo — there is no icon dependency.
 */
const GLYPHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9v11h4.5v-6h4v6h4.5V9" />
    </>
  ),
  leagues: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  standings: <path d="M4 6h1.5M4 12h1.5M4 18h1.5M9 6h11M9 12h11M9 18h11" />,
  fixtures: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  results: <path d="M4 20h16M7 16.5V11M12 16.5V6.5M17 16.5V9" />,
  teams: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3a6.5 6.5 0 0 1 3.5 5.7" />
    </>
  ),
  auction: (
    <>
      <path d="m13.5 3.5 7 7-3 3-7-7z" />
      <path d="m12 10-8 8a1.4 1.4 0 0 0 2 2l8-8" />
    </>
  ),
  wishlist: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  squad: <path d="M8.5 3.5 3 6.5l2 4 2.5-1V20.5h9V9.5l2.5 1 2-4-5.5-3a3.5 3.5 0 0 1-7 0z" />,
  players: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  marketplace: <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />,
  finance: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10.5h18M15.5 15h2.5M6.5 6V5a2 2 0 0 1 2-2h9" />
    </>
  ),
  playoffs: <path d="M3 5h6v14H3M9 12h5M14 8h7v8h-7z" />,
  winners: (
    <>
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 6H4a3 3 0 0 0 3.5 5M17 6h3a3 3 0 0 1-3.5 5M12 14v4M8 21h8l-1-3H9z" />
    </>
  ),
  cup: (
    <>
      <path d="m8 3 4 7 4-7" />
      <circle cx="12" cy="15" r="5.5" />
    </>
  ),
  fpl: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m12 7.5 3.6 2.6-1.4 4.2H9.8l-1.4-4.2zM12 3v4.5M20.6 9.4l-5 .7M17.5 19.2l-3.3-4.9M6.5 19.2l3.3-4.9M3.4 9.4l5 .7" />
    </>
  ),
  rules: (
    <>
      <path d="M5 19.5V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12" />
      <path d="M9 7.5h6" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.2a2.6 2.6 0 0 1 5 .8c0 1.7-2.5 2.2-2.5 4M12 17.2h.01" />
    </>
  ),
  feedback: <path d="M4 5h16v11H9.5L4 20.5z" />,
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  notifications: <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5a2 2 0 0 0 4 0" />,
  admin: <path d="M12 3 20 6v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />,
  dashboard: <path d="M3.5 3.5h7v9h-7zM13.5 3.5h7v5h-7zM13.5 11.5h7v9h-7zM3.5 15.5h7v5h-7z" />,
  back: <path d="m15 5-7 7 7 7" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />,
  install: <path d="M12 3.5v11M7.5 10.5l4.5 4.5 4.5-4.5M5 20.5h14" />,
  add: <path d="M12 5v14M5 12h14" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export function NavIcon({ name, className = "h-6 w-6" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}
