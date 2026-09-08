import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.TEST_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // 1 retry everywhere, not just CI: `next dev --webpack` compiles each route
  // on first hit, and a cold compile can drop the connection (ECONNRESET) on
  // an otherwise-passing request. Same reason the timeouts below are generous.
  retries: 1,
  reporter: process.env.CI ? [["html"], ["github"]] : [["html", { open: "never" }], ["list"]],
  // Generous per-test timeout — Next.js webpack dev compiles each API/UI route on
  // first hit (~5-10s each), so a spec touching many endpoints can easily need a minute.
  timeout: 180_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // First-hit compilation per API route can take 5-10s in dev mode — give
    // each API/UI action room to breathe so cold compiles don't fail tests.
    actionTimeout: 45_000,
    navigationTimeout: 45_000,
  },

  // The mobile project is scoped to one file on purpose. With `fullyParallel: false` and
  // `workers: 1`, an unscoped second project would re-run every spec at a phone viewport
  // and roughly double an already-slow suite — so `mobile` runs only the drawer spec, and
  // `chromium` skips it.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile-nav\.spec\.ts/,
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
      testMatch: /mobile-nav\.spec\.ts/,
    },
  ],

  webServer: {
    // Use `npx` so `dotenv-cli` resolves through node_modules/.bin even when
    // Playwright spawns the server outside of an npm-script context (which is
    // what makes the local bins reachable on PATH).
    command: `npx dotenv -e .env.test.local -e .env.test -- next dev --webpack -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
