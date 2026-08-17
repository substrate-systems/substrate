import { defineConfig, devices } from "@playwright/test";

// End-to-end coverage runs against a production build rather than `next dev`,
// because dev-mode compilation makes the first navigation of each worker slow
// enough to look like a flake. The build needs no database: every test here
// stubs the API routes it touches, so this job stays independent of the
// PostgreSQL services the unit and integration jobs require.

const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // `npm test` globs `src/**`, so these never collide with the node runner.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry in CI only. These tests drive a real browser, and a single retry
  // absorbs machine noise without hiding a test that is genuinely unstable.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
