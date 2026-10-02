import type { NextConfig } from "next";

/**
 * Identifies this deploy to the service worker: PwaProvider registers `/sw.js?v=<this>`, so every
 * deploy installs a fresh worker and offers the "Update available" snackbar. Vercel provides the
 * commit SHA; local production builds fall back to the build time.
 */
const APP_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? `local-${Date.now()}`).slice(0, 12);

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // The browser must always re-check the worker script, or a deploy's new worker would sit
        // behind an HTTP cache for up to a day. `nosniff` above makes the explicit type matter.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
