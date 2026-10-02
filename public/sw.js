/*
 * JPL service worker.
 *
 * Deliberately small. It exists to make the app installable, to keep the immutable app shell
 * (hashed JS/CSS, fonts, icons) on the device so launches are fast, and to show a branded
 * offline screen instead of the browser's dinosaur. It does NOT cache data or HTML:
 *
 *  - /api/** is never intercepted. Scores, auction bids, the auction SSE stream
 *    (/api/auction/session/stream), notifications and auth must always hit the network; a stale
 *    standings table during a live gameweek is worse than no table.
 *  - Page HTML is never cached. The [leagueSlug] layout bakes the signed-in viewer into the page,
 *    so a cached page could show one account's view to another after a sign-out or account switch.
 *
 * Registered by src/components/pwa/PwaProvider.tsx as `/sw.js?v=<build id>`, so each deploy installs
 * a fresh worker. Because nothing it caches can disagree with a live page (hashed files and the
 * offline screen only), a new worker takes over immediately — no "waiting" phase. Telling the user
 * a new version is out is PwaProvider's job (it polls /app-version).
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";

/** Per-version: the offline page and the icon it shows. Old versions are deleted on activate. */
const SHELL_CACHE = `jpl-shell-${VERSION}`;
/**
 * Shared across versions on purpose: /_next/static files are content-hashed, so an entry can never
 * go stale — and a tab still running the previous deploy may lazy-load one of its chunks after the
 * new deploy has replaced them on the server.
 */
const STATIC_CACHE = "jpl-static-v1";
/** Icons, the crest and optimised images — refreshed in the background on every use. */
const IMAGE_CACHE = "jpl-images-v1";

const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [OFFLINE_URL, "/icons/icon-192.png"];

const STATIC_MAX_ENTRIES = 300;
const IMAGE_MAX_ENTRIES = 60;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE, IMAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("jpl-") && !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Oldest-first eviction; Cache.keys() returns entries in insertion order. */
async function trim(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    trim(STATIC_CACHE, STATIC_MAX_ENTRIES);
  }
  return response;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(event.request, response.clone());
        await trim(IMAGE_CACHE, IMAGE_MAX_ENTRIES);
      }
      return response;
    })
    .catch(() => hit);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return refresh;
}

async function networkWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch {
    const offline = await caches.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never touch data, auth, redirects to FPL, or React Server Component payloads.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/go/")) return;
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkWithOfflineFallback(request));
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (url.pathname.startsWith("/icons/") || url.pathname === "/logo.png" || url.pathname === "/_next/image") {
    event.respondWith(staleWhileRevalidate(event));
  }
  // Everything else (manifest, favicon, sw.js itself, …) goes to the network untouched.
});
