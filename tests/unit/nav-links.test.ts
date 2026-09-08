/**
 * Navigation link model.
 *
 * `src/lib/nav-links.ts` replaced four hand-copied link lists (LeagueNav, both /dashboard
 * navs, both JPL-Cup navs, the admin nav). The property that makes that a refactor rather
 * than a redesign is that `flat` reproduces the OLD desktop link order exactly — so the
 * expected arrays below are transcribed verbatim from the pre-refactor `LeagueNav.tsx`.
 * If a future edit changes the desktop order, that is a deliberate act and this test is
 * where it gets acknowledged.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildNavModel, type NavContext } from "../../src/lib/nav-links";

const league = (over: Partial<Extract<NavContext, { surface: "league" }>> = {}): NavContext => ({
  surface: "league",
  leagueSlug: "demo",
  format: "tvt",
  auctionTier: null,
  isLoggedIn: true,
  dashboardHref: "/dashboard",
  ...over,
});

const labels = (ctx: NavContext, runtime = {}) => buildNavModel(ctx, runtime).flat.map((i) => i.label);

/* ── flat order matches the pre-refactor LeagueNav, format by format ────── */

test("tvt flat order matches the old LeagueNav", () => {
  assert.deepEqual(labels(league({ format: "tvt" })), [
    "Dashboard", "Standings", "Fixtures", "FPL League", "Playoffs", "Winners",
    "Rules", "Help", "Feedback", "Settings",
  ]);
});

test("continental-championship flat order matches the old LeagueNav", () => {
  assert.deepEqual(labels(league({ format: "continental-championship" })), [
    "Dashboard", "JPL Standings", "JPL Fixtures", "JPL Cup Standings", "JPL Cup Fixtures",
    "Playoffs", "Winners", "Rules", "Help", "Feedback", "Settings",
  ]);
});

test("auction flat order matches the old LeagueNav", () => {
  assert.deepEqual(labels(league({ format: "auction", auctionTier: "complete" })), [
    "Dashboard", "Standings", "GW Results", "Teams", "Auction", "Wishlist", "Squad",
    "Players", "Marketplace", "Finance", "Rules", "Help", "Feedback", "Settings",
  ]);
});

test("fpl-classic flat order matches the old LeagueNav", () => {
  assert.deepEqual(labels(league({ format: "fpl-classic", isLoggedIn: false })), [
    "All Leagues", "Standings", "Winners", "Rules",
  ]);
});

/* ── gating ─────────────────────────────────────────────────────────────── */

test("Marketplace is hidden during a live auction", () => {
  const shown = labels(league({ format: "auction", auctionTier: "complete" }), { auctionLive: true });
  assert.ok(!shown.includes("Marketplace"));
  assert.ok(shown.includes("Finance"), "only Marketplace should drop, not the rest of the group");
});

test("Marketplace is hidden in the Primary tier", () => {
  assert.ok(!labels(league({ format: "auction", auctionTier: "primary" })).includes("Marketplace"));
});

test("logged-out league nav hides Wishlist, Feedback and Settings and offers Sign In", () => {
  const ctx = league({ format: "auction", auctionTier: "complete", isLoggedIn: false });
  const shown = labels(ctx);
  for (const gated of ["Wishlist", "Feedback", "Settings"]) {
    assert.ok(!shown.includes(gated), `${gated} should be hidden when logged out`);
  }
  assert.equal(shown[0], "All Leagues", "the Dashboard link becomes All Leagues");
  const m = buildNavModel(ctx);
  assert.equal(m.showNotificationBell, false);
  assert.deepEqual(m.auth, { kind: "signIn", href: "/signin" });
});

test("fpl-classic offers no auth control and no bell, even if isLoggedIn is somehow true", () => {
  const m = buildNavModel(league({ format: "fpl-classic", isLoggedIn: true }));
  assert.deepEqual(m.auth, { kind: "none" });
  assert.equal(m.showNotificationBell, false);
});

test("logged-in league nav shows the bell and Sign Out", () => {
  const m = buildNavModel(league({ format: "tvt" }));
  assert.equal(m.showNotificationBell, true);
  assert.deepEqual(m.auth, { kind: "signOut" });
});

/* ── structural invariants ──────────────────────────────────────────────── */

test("flat is always exactly the flattening of groups, with no empty groups", () => {
  const contexts: NavContext[] = [
    league({ format: "tvt" }),
    league({ format: "auction", auctionTier: "primary", isLoggedIn: false }),
    league({ format: "continental-championship", isLoggedIn: false }),
    league({ format: "fpl-classic", isLoggedIn: false }),
    { surface: "admin-league", leagueId: "demo", format: "tvt", isSuperadminViewer: true, variant: "full" },
    { surface: "admin-league", leagueId: "demo", format: "auction", isSuperadminViewer: false, variant: "minimal" },
    { surface: "admin-leagues", isSuperadmin: false },
    { surface: "superadmin" },
    { surface: "account", backHref: "/dashboard" },
  ];
  for (const ctx of contexts) {
    const m = buildNavModel(ctx);
    assert.deepEqual(m.flat, m.groups.flatMap((g) => g.items), `${ctx.surface} flat drifted from groups`);
    assert.ok(m.groups.every((g) => g.items.length > 0), `${ctx.surface} kept an empty group`);
    assert.ok(m.groups.every((g) => g.heading.length > 0), `${ctx.surface} has an unlabelled group`);
  }
});

test("keys are unique within a model", () => {
  const m = buildNavModel(league({ format: "auction", auctionTier: "complete" }));
  const keys = m.flat.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate keys would light up two active rows");
});

/* ── admin / superadmin surfaces ────────────────────────────────────────── */

test("admin league nav shows Platform Admin only to a superadmin viewer", () => {
  const base = { surface: "admin-league", leagueId: "demo", format: "tvt", variant: "full" } as const;
  assert.ok(labels({ ...base, isSuperadminViewer: true }).includes("← Platform Admin"));
  assert.ok(!labels({ ...base, isSuperadminViewer: false }).includes("← Platform Admin"));
});

test("admin league nav branches its league-page links on format", () => {
  const base = { surface: "admin-league", leagueId: "demo", isSuperadminViewer: false, variant: "full" } as const;
  assert.ok(labels({ ...base, format: "continental-championship" }).includes("JPL Cup Fixtures"));
  assert.deepEqual(
    labels({ ...base, format: "auction" }),
    ["← Leagues", "Dashboard", "Standings", "Help"],
    "auction leagues have no admin-facing fixtures or playoffs pages",
  );
  assert.ok(labels({ ...base, format: "tvt" }).includes("Fixtures"));
});

test("the admin auction room offers only a way back out", () => {
  const m = buildNavModel({
    surface: "admin-league", leagueId: "demo", format: "auction",
    isSuperadminViewer: true, variant: "minimal",
  });
  assert.deepEqual(m.flat.map((i) => i.label), ["← Leagues", "← Back to demo"]);
  assert.deepEqual(m.auth, { kind: "none" });
});

test("the admin league index shows Superadmin only to a superadmin", () => {
  assert.ok(labels({ surface: "admin-leagues", isSuperadmin: true }).includes("← Superadmin"));
  assert.deepEqual(labels({ surface: "admin-leagues", isSuperadmin: false }), ["Your Leagues"]);
});
