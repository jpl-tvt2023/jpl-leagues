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
 * drift from it.
 *
 * This file deliberately imports nothing from `react` or `next` so it stays unit-testable
 * under `tsx --test` and usable from a server component if the nav is ever hoisted into
 * `src/app/[leagueSlug]/layout.tsx`.
 */

import { CONTINENTAL_FORMAT, FPL_CLASSIC_FORMAT } from "./format-palette";

export type LeagueFormat = "auction" | "continental-championship" | "tvt" | "fpl-classic";

/** `accent` = the orange "← Platform Admin" treatment; `back` = the yellow "← Leagues" treatment. */
export type NavTone = "default" | "accent" | "back";

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
  | { surface: "account"; backHref: string };

/**
 * Live-auction state is a *runtime* input, not part of the context identity — keeping it
 * out of `NavContext` means the builder stays pure and the unit test doesn't have to fake
 * a poll result inside a context object.
 */
export type NavRuntime = { auctionLive?: boolean };

/** Drops empty groups so the drawer never renders an orphan heading. */
function compact(groups: NavGroup[]): NavGroup[] {
  return groups.filter((g) => g.items.length > 0);
}

function model(groups: NavGroup[], showNotificationBell: boolean, auth: NavAuth): NavModel {
  const kept = compact(groups);
  return { groups: kept, flat: kept.flatMap((g) => g.items), showNotificationBell, auth };
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
            { key: "standings", label: "JPL Standings", href: p("standings") },
            { key: "fixtures", label: "JPL Fixtures", href: p("fixtures") },
          ],
        },
        {
          id: "cup",
          heading: "JPL Cup",
          items: [
            { key: "jpl-cup-standings", label: "JPL Cup Standings", href: p("jpl-cup-standings") },
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
            { key: "dashboard", label: "All Leagues", href: "/" },
            { key: "standings", label: "Standings", href: p("standings") },
            { key: "winners", label: "Winners", href: p("winners") },
          ],
        },
        { id: "help", heading: "Help", items: [{ key: "rules", label: "Rules", href: p("rules") }] },
      ],
      false,
      { kind: "none" },
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
