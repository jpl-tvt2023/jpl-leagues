/**
 * The single source of truth for every navigation link in the app.
 *
 * Before this module the link lists were duplicated four times — `LeagueNav`, both
 * `/dashboard` navs, both JPL-Cup page navs, and the admin nav — which is exactly how
 * the FPL League link ended up reachable from every league page but not from the
 * dashboard (see `tests/league-types/tvt-8.spec.ts`). One model, one place to edit.
 *
 * The model is *grouped* because the mobile drawer renders section headings; the
 * desktop bar renders `flat`, which is derived from `groups` and therefore can never
 * drift from it. `bottom` — the phone's bottom navigation bar — is picked out of `flat` by
 * key, so it can't drift either.
 *
 * This file deliberately imports nothing from `react` or `next` so it stays unit-testable
 * under `tsx --test` and usable from a server component if the nav is ever hoisted into
 * `src/app/[leagueSlug]/layout.tsx`.
 */

import { CONTINENTAL_FORMAT, FPL_CLASSIC_FORMAT } from "./format-palette";

export type LeagueFormat = "auction" | "continental-championship" | "tvt" | "fpl-classic";

/** `accent` = the orange "← Platform Admin" treatment; `back` = the yellow "← Leagues" treatment. */
export type NavTone = "default" | "accent" | "back";

/** Glyph ids drawn by `src/components/icons/NavIcon.tsx`. */
export type NavIconName =
  | "home"
  | "leagues"
  | "standings"
  | "fixtures"
  | "results"
  | "teams"
  | "auction"
  | "wishlist"
  | "squad"
  | "players"
  | "marketplace"
  | "finance"
  | "playoffs"
  | "winners"
  | "cup"
  | "fpl"
  | "rules"
  | "help"
  | "feedback"
  | "settings"
  | "notifications"
  | "admin"
  | "dashboard"
  | "back";

/** Default glyph per key, so the group tables below don't each have to name one. */
const ICON_BY_KEY: Record<string, NavIconName> = {
  dashboard: "home",
  standings: "standings",
  fixtures: "fixtures",
  "fpl-league": "fpl",
  playoffs: "playoffs",
  winners: "winners",
  rules: "rules",
  help: "help",
  feedback: "feedback",
  settings: "settings",
  notifications: "notifications",
  "gw-results": "results",
  teams: "teams",
  auction: "auction",
  wishlist: "wishlist",
  squad: "squad",
  players: "players",
  marketplace: "marketplace",
  finance: "finance",
  "jpl-cup-standings": "cup",
  "jpl-cup-fixtures": "fixtures",
  "admin-dashboard": "dashboard",
  "admin-leagues": "leagues",
  "admin-help": "help",
  superadmin: "admin",
  "superadmin-help": "help",
  "platform-admin": "admin",
  leagues: "leagues",
};

export type NavItem = {
  /**
   * Stable identity for active-state matching. League keys are byte-identical to the
   * strings pages already pass as `LeagueNav`'s `currentPage` prop, so no mapping table
   * is needed anywhere.
   */
  key: string;
  label: string;
  href: string;
  tone?: NavTone;
  /** Drawer / bottom-bar glyph. Filled in from `ICON_BY_KEY` when omitted. */
  icon?: NavIconName;
  /** Bottom-bar label when `label` is too long for a ~72px slot ("JPL Cup Standings" → "JPL Cup"). */
  shortLabel?: string;
};

export type NavGroup = {
  id: string;
  /** Small uppercase heading in the drawer. The desktop bar ignores it. */
  heading: string;
  items: NavItem[];
};

export type NavAuth =
  | { kind: "signOut" }
  | { kind: "signIn"; href: "/signin" }
  | { kind: "none" };

export type NavModel = {
  groups: NavGroup[];
  /** `groups.flatMap(g => g.items)` — the desktop bar renders exactly this, in order. */
  flat: NavItem[];
  /**
   * The phone/tablet bottom navigation bar: at most `MAX_BOTTOM_ITEMS` of the most-used pages,
   * each one an item from `flat`. Empty on surfaces that get no bottom bar (admin, account).
   */
  bottom: NavItem[];
  showNotificationBell: boolean;
  auth: NavAuth;
};

export type NavContext =
  | {
      surface: "league";
      leagueSlug: string;
      format: LeagueFormat;
      auctionTier: "primary" | "complete" | null;
      isLoggedIn: boolean;
      dashboardHref: string;
    }
  | {
      surface: "admin-league";
      leagueId: string;
      format: string;
      isSuperadminViewer: boolean;
      /** `minimal` is the admin auction room — it only offers a way back out. */
      variant: "full" | "minimal";
    }
  | { surface: "admin-leagues"; isSuperadmin: boolean }
  | { surface: "superadmin" }
  | { surface: "account"; backHref: string }
  /**
   * Pages outside any league and outside the signed-in area. `home` is the league list itself;
   * `signin` links back to it; `flow` is a mid-flow screen (change password, team setup) that
   * offers no way out until it is finished.
   */
  | { surface: "public"; page: "home" | "signin" | "flow" };

/**
 * Live-auction state is a *runtime* input, not part of the context identity — keeping it
 * out of `NavContext` means the builder stays pure and the unit test doesn't have to fake
 * a poll result inside a context object.
 */
export type NavRuntime = { auctionLive?: boolean };

/** Bottom-bar slots for pages; the bar adds a "Menu" slot after these when the drawer has more. */
export const MAX_BOTTOM_ITEMS = 4;

/** Drops empty groups so the drawer never renders an orphan heading. */
function compact(groups: NavGroup[]): NavGroup[] {
  return groups.filter((g) => g.items.length > 0);
}

function withIcon(item: NavItem): NavItem {
  if (item.icon) return item;
  const icon = item.tone === "back" ? "back" : ICON_BY_KEY[item.key];
  return icon ? { ...item, icon } : item;
}

/**
 * @param bottomKeys keys of `flat` items for the bottom bar, in slot order. A key that the gating
 *   above removed (e.g. Squad when signed out) is simply skipped, so callers can list fallbacks.
 */
function model(
  groups: NavGroup[],
  showNotificationBell: boolean,
  auth: NavAuth,
  bottomKeys: string[] = [],
): NavModel {
  const kept = compact(groups).map((g) => ({ ...g, items: g.items.map(withIcon) }));
  const flat = kept.flatMap((g) => g.items);
  const byKey = new Map(flat.map((i) => [i.key, i]));
  const bottom = bottomKeys
    .map((k) => byKey.get(k))
    .filter((i): i is NavItem => i !== undefined)
    .slice(0, MAX_BOTTOM_ITEMS);
  return { groups: kept, flat, bottom, showNotificationBell, auth };
}

/** `cond ? [item] : []` spread helper — keeps the group tables readable. */
function when(cond: boolean, ...items: NavItem[]): NavItem[] {
  return cond ? items : [];
}

function buildLeague(ctx: Extract<NavContext, { surface: "league" }>, runtime: NavRuntime): NavModel {
  const { leagueSlug, format, auctionTier, isLoggedIn, dashboardHref } = ctx;
  const auctionLive = runtime.auctionLive ?? false;
  const p = (path: string) => `/${leagueSlug}/${path}`;

  // Dashboard / All Leagues — the one link whose label and target depend on auth.
  const home: NavItem = {
    key: "dashboard",
    label: isLoggedIn ? "Dashboard" : "All Leagues",
    href: isLoggedIn ? dashboardHref : "/",
    icon: isLoggedIn ? "home" : "leagues",
    shortLabel: isLoggedIn ? "Home" : "Leagues",
  };
  const settings: NavItem[] = when(isLoggedIn, { key: "settings", label: "Settings", href: "/settings" });
  const feedback: NavItem[] = when(isLoggedIn, { key: "feedback", label: "Feedback", href: p("feedback") });

  if (format === "auction") {
    // Trades are gated by a live auction (mid-auction freeze) AND by tier (Primary disables them).
    const showMarketplace = !auctionLive && auctionTier !== "primary";
    return model(
      [
        {
          id: "league",
          heading: "League",
          items: [
            home,
            { key: "standings", label: "Standings", href: p("standings") },
            { key: "gw-results", label: "GW Results", href: p("gw-results") },
            { key: "teams", label: "Teams", href: p("teams") },
          ],
        },
        {
          id: "auction",
          heading: "Auction",
          items: [
            { key: "auction", label: "Auction", href: p("auction") },
            ...when(isLoggedIn, { key: "wishlist", label: "Wishlist", href: "/dashboard#wishlist" }),
          ],
        },
        { id: "my-team", heading: "My Team", items: [{ key: "squad", label: "Squad", href: p("squad") }] },
        {
          id: "trading",
          heading: "Trading & Finance",
          items: [
            { key: "players", label: "Players", href: p("players") },
            ...when(showMarketplace, { key: "marketplace", label: "Marketplace", href: p("marketplace") }),
            { key: "finance", label: "Finance", href: p("finance") },
          ],
        },
        {
          id: "help",
          heading: "Help",
          items: [
            { key: "rules", label: "Rules", href: p("rules") },
            { key: "help", label: "Help", href: p("help") },
            ...feedback,
          ],
        },
        { id: "account", heading: "Account", items: settings },
      ],
      isLoggedIn,
      isLoggedIn ? { kind: "signOut" } : { kind: "signIn", href: "/signin" },
      // Squad is signed-in only; Teams takes its slot for visitors.
      ["dashboard", "standings", "auction", isLoggedIn ? "squad" : "teams"],
    );
  }

  if (format === CONTINENTAL_FORMAT) {
    return model(
      [
        {
          id: "league",
          heading: "League",
          items: [
            home,
            { key: "standings", label: "JPL Standings", href: p("standings"), shortLabel: "Standings" },
            { key: "fixtures", label: "JPL Fixtures", href: p("fixtures"), shortLabel: "Fixtures" },
          ],
        },
        {
          id: "cup",
          heading: "JPL Cup",
          items: [
            { key: "jpl-cup-standings", label: "JPL Cup Standings", href: p("jpl-cup-standings"), shortLabel: "JPL Cup" },
            { key: "jpl-cup-fixtures", label: "JPL Cup Fixtures", href: p("jpl-cup-fixtures") },
          ],
        },
        {
          id: "knockouts",
          heading: "Knockouts",
          items: [
            { key: "playoffs", label: "Playoffs", href: p("playoffs") },
            { key: "winners", label: "Winners", href: p("winners") },
          ],
        },
        {
          id: "help",
          heading: "Help",
          items: [
            { key: "rules", label: "Rules", href: p("rules") },
            { key: "help", label: "Help", href: p("help") },
            ...feedback,
          ],
        },
        { id: "account", heading: "Account", items: settings },
      ],
      isLoggedIn,
      isLoggedIn ? { kind: "signOut" } : { kind: "signIn", href: "/signin" },
      ["dashboard", "standings", "fixtures", "jpl-cup-standings"],
    );
  }

  if (format === FPL_CLASSIC_FORMAT) {
    // Public, read-only format with no login accounts: no bell, and no Sign In invitation
    // either — there is nothing to sign in TO. `isLoggedIn` is ignored on purpose.
    return model(
      [
        {
          id: "league",
          heading: "League",
          items: [
            { key: "dashboard", label: "All Leagues", href: "/", icon: "leagues", shortLabel: "Leagues" },
            { key: "standings", label: "Standings", href: p("standings") },
            { key: "winners", label: "Winners", href: p("winners") },
          ],
        },
        { id: "help", heading: "Help", items: [{ key: "rules", label: "Rules", href: p("rules") }] },
      ],
      false,
      { kind: "none" },
      ["dashboard", "standings", "winners", "rules"],
    );
  }

  // tvt (and the default for any unrecognised format)
  return model(
    [
      {
        id: "league",
        heading: "League",
        items: [
          home,
          { key: "standings", label: "Standings", href: p("standings") },
          { key: "fixtures", label: "Fixtures", href: p("fixtures") },
          { key: "fpl-league", label: "FPL League", href: p("fpl-league") },
        ],
      },
      {
        id: "knockouts",
        heading: "Knockouts",
        items: [
          { key: "playoffs", label: "Playoffs", href: p("playoffs") },
          { key: "winners", label: "Winners", href: p("winners") },
        ],
      },
      {
        id: "help",
        heading: "Help",
        items: [
          { key: "rules", label: "Rules", href: p("rules") },
          { key: "help", label: "Help", href: p("help") },
          ...feedback,
        ],
      },
      { id: "account", heading: "Account", items: settings },
    ],
    isLoggedIn,
    isLoggedIn ? { kind: "signOut" } : { kind: "signIn", href: "/signin" },
    ["dashboard", "standings", "fixtures", "playoffs"],
  );
}

function buildAdminLeague(ctx: Extract<NavContext, { surface: "admin-league" }>): NavModel {
  const { leagueId, format, isSuperadminViewer, variant } = ctx;

  if (variant === "minimal") {
    return model(
      [
        {
          id: "admin",
          heading: "Admin",
          items: [
            { key: "admin-leagues", label: "← Leagues", href: "/admin", tone: "back" },
            { key: "admin-dashboard", label: `← Back to ${leagueId}`, href: `/admin/${leagueId}`, tone: "back" },
          ],
        },
      ],
      false,
      { kind: "none" },
    );
  }

  const p = (path: string) => `/${leagueId}/${path}`;
  let leaguePages: NavItem[];
  if (format === CONTINENTAL_FORMAT) {
    leaguePages = [
      { key: "standings", label: "JPL Standings", href: p("standings") },
      { key: "fixtures", label: "JPL Fixtures", href: p("fixtures") },
      { key: "jpl-cup-standings", label: "JPL Cup Standings", href: p("jpl-cup-standings") },
      { key: "jpl-cup-fixtures", label: "JPL Cup Fixtures", href: p("jpl-cup-fixtures") },
      { key: "playoffs", label: "Playoffs", href: p("playoffs") },
    ];
  } else if (format === "auction") {
    leaguePages = [{ key: "standings", label: "Standings", href: p("standings") }];
  } else {
    leaguePages = [
      { key: "standings", label: "Standings", href: p("standings") },
      { key: "fixtures", label: "Fixtures", href: p("fixtures") },
      { key: "playoffs", label: "Playoffs", href: p("playoffs") },
    ];
  }

  return model(
    [
      {
        id: "admin",
        heading: "Admin",
        items: [
          ...when(isSuperadminViewer, {
            key: "platform-admin",
            label: "← Platform Admin",
            href: "/superadmin",
            tone: "accent" as const,
          }),
          { key: "admin-leagues", label: "← Leagues", href: "/admin", tone: "back" },
          { key: "admin-dashboard", label: "Dashboard", href: `/admin/${leagueId}` },
        ],
      },
      { id: "league-pages", heading: "League Pages", items: leaguePages },
      {
        id: "help",
        heading: "Help",
        items: [{ key: "admin-help", label: "Help", href: `/admin/${leagueId}/help` }],
      },
    ],
    false,
    { kind: "signOut" },
  );
}

export function buildNavModel(ctx: NavContext, runtime: NavRuntime = {}): NavModel {
  switch (ctx.surface) {
    case "league":
      return buildLeague(ctx, runtime);

    case "admin-league":
      return buildAdminLeague(ctx);

    case "admin-leagues":
      return model(
        [
          {
            id: "admin",
            heading: "Admin",
            items: [
              ...when(ctx.isSuperadmin, {
                key: "superadmin",
                label: "← Superadmin",
                href: "/superadmin",
                tone: "accent" as const,
              }),
              { key: "admin-leagues", label: "Your Leagues", href: "/admin" },
            ],
          },
        ],
        false,
        { kind: "signOut" },
      );

    case "superadmin":
      return model(
        [
          {
            id: "platform",
            heading: "Platform",
            items: [
              { key: "superadmin", label: "Dashboard", href: "/superadmin" },
              { key: "superadmin-help", label: "Help", href: "/superadmin/help" },
            ],
          },
        ],
        false,
        { kind: "signOut" },
      );

    case "public":
      if (ctx.page === "signin") {
        return model(
          [{ id: "public", heading: "JPL", items: [{ key: "leagues", label: "All Leagues", href: "/" }] }],
          false,
          { kind: "none" },
        );
      }
      return model([], false, ctx.page === "home" ? { kind: "signIn", href: "/signin" } : { kind: "none" });

    case "account":
      return model(
        [
          {
            id: "account",
            heading: "Account",
            items: [
              { key: "dashboard", label: "← Back to Dashboard", href: ctx.backHref, tone: "back" },
              { key: "settings", label: "Settings", href: "/settings" },
              { key: "notifications", label: "Notifications", href: "/notifications" },
            ],
          },
        ],
        false,
        { kind: "signOut" },
      );
  }
}
