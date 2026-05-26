import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.TEST_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
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

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // Use `npx` so `dotenv-cli` resolves through node_modules/.bin even when
    // Playwright spawns the server outside of an npm-script context (which is
    // what makes the local bins reachable on PATH).
    command: `npx dotenv -e .env.test -- next dev --webpack -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
