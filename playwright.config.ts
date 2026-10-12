import { defineConfig, devices } from "@playwright/test";

// End-to-end coverage runs against a production build rather than `next dev`,
// because dev-mode compilation makes the first navigation of each worker slow
// enough to look like a flake. The build needs no database: every test here
// stubs the API routes it touches, so this job stays independent of the
// PostgreSQL services the unit and integration jobs require.

// PLAYWRIGHT_PORT lets a second checkout run the suite beside a server already on 3000.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
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
  projects: [
    // Home's suite needs a database and has its own config (e2e/exomem-home/playwright.config.ts).
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: ["exomem-design/**", "exomem-home/**"],
    },
    // The Exomem design checks run at the sizes the design is drawn for: desktop, and the
    // two phones its QA list names. Only the specs under e2e/exomem-design run here; the
    // theme spec does not depend on the viewport, so it runs on desktop only.
    {
      name: "exomem desktop 1440",
      testMatch: "exomem-design/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "exomem phone 390",
      testMatch: "exomem-design/**/*.spec.ts",
      testIgnore: "exomem-design/theme.spec.ts",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "exomem phone 375",
      testMatch: "exomem-design/**/*.spec.ts",
      testIgnore: "exomem-design/theme.spec.ts",
      use: { ...devices["Pixel 7"], viewport: { width: 375, height: 667 } },
    },
  ],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Stop the server with SIGTERM so it exits cleanly; SIGKILL follows after 5 s.
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
