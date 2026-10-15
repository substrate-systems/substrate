import { defineConfig, devices } from "@playwright/test";

// End-to-end coverage runs against a production build rather than `next dev`,
// because dev-mode compilation makes the first navigation of each worker slow
// enough to look like a flake. Outside the journey projects below, the build
// needs no database: those tests stub the API routes they touch.

// PLAYWRIGHT_PORT lets a second checkout run the suite beside a server already on 3000.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The journey specs drive the real start, sign-in, invitation, setup and consent flows
// against the server's own PostgreSQL, which they seed directly (e2e/exomem-journey/seed.ts).
// They exist only where that database is configured; elsewhere the projects are absent,
// so asking for one by name fails loudly instead of passing with nothing run. They use the
// server's own public address (EXOMEM_E2E_BASE_URL), the origin its links and cookies name.
// A production build accepts only an https public address, so locally and in CI they
// run against `next dev` on http://localhost, which accepts a loopback address.
const journeyBaseUrl = process.env.EXOMEM_E2E_BASE_URL;
const journeyEnabled = Boolean(process.env.EXOMEM_E2E_DATABASE_URL);
// `next dev` compiles each route on its first visit, which can take most of the default
// 30 s on a CI runner; a journey test gets twice that.
const JOURNEY_TEST_TIMEOUT_MS = 60_000;
// The journey pages animate their whole field, and these headless browsers draw it without a
// GPU: two workers' pages then starve the server and each other. The specs check flows, not
// motion, so they run with reduced motion; a test of motion asks for it (flows.spec.ts).
const journeyUse = { baseURL: journeyBaseUrl, reducedMotion: "reduce" as const };
const journeyProjects = journeyEnabled
  ? [
      {
        name: "exomem journey desktop 1440",
        timeout: JOURNEY_TEST_TIMEOUT_MS,
        testMatch: "exomem-journey/**/*.spec.ts",
        use: {
          ...devices["Desktop Chrome"],
          viewport: { width: 1440, height: 900 },
          ...journeyUse,
        },
      },
      {
        name: "exomem journey phone 390",
        timeout: JOURNEY_TEST_TIMEOUT_MS,
        testMatch: "exomem-journey/**/*.spec.ts",
        // One live reviewer credential at a time: the desktop project signs the reviewer in.
        testIgnore: "exomem-journey/reviewer.spec.ts",
        use: {
          ...devices["Pixel 7"],
          viewport: { width: 390, height: 844 },
          ...journeyUse,
        },
      },
      // The small phones: only the no-scroll check, on each side of the compact layout's
      // two cut-offs (journey.module.css). 360 × 640 is a common Android size and the
      // shortest one; 360 × 720 is compact below 390 px wide, and 390 × 740 is the shortest
      // phone that keeps the tiles.
      {
        name: "exomem journey phone 360x640",
        timeout: JOURNEY_TEST_TIMEOUT_MS,
        testMatch: "exomem-journey/layout.spec.ts",
        use: {
          ...devices["Pixel 7"],
          viewport: { width: 360, height: 640 },
          ...journeyUse,
        },
      },
      {
        name: "exomem journey phone 360x720",
        timeout: JOURNEY_TEST_TIMEOUT_MS,
        testMatch: "exomem-journey/layout.spec.ts",
        use: {
          ...devices["Pixel 7"],
          viewport: { width: 360, height: 720 },
          ...journeyUse,
        },
      },
      {
        name: "exomem journey phone 390x740",
        timeout: JOURNEY_TEST_TIMEOUT_MS,
        testMatch: "exomem-journey/layout.spec.ts",
        use: {
          ...devices["Pixel 7"],
          viewport: { width: 390, height: 740 },
          ...journeyUse,
        },
      },
    ]
  : [];

export default defineConfig({
  testDir: "./e2e",
  // The journey server compiles routes on first visit; warm them before the tests run.
  globalSetup: journeyEnabled ? "./e2e/exomem-journey/warm-up.ts" : undefined,
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
  // With the journey database configured, a run is the journey alone, on its own server;
  // without it, the other projects run against the production build.
  projects: journeyEnabled
    ? journeyProjects
    : [
        // Home's suite needs a database and has its own config (e2e/exomem-home/playwright.config.ts).
        {
          name: "chromium",
          use: { ...devices["Desktop Chrome"] },
          testIgnore: ["exomem-design/**", "exomem-journey/**", "exomem-home/**"],
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
  webServer:
    journeyEnabled && journeyBaseUrl
      ? {
          // `next dev` on the public address the journey uses.
          command: `npx next dev --hostname ${new URL(journeyBaseUrl).hostname} --port ${new URL(journeyBaseUrl).port}`,
          // Ready once a journey page compiles, not only the server's first route.
          url: new URL("/exomem/sign-in", journeyBaseUrl).toString(),
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          // Stop the server with SIGTERM so it exits cleanly; SIGKILL follows after 5 s.
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
        }
      : {
          command: `npm run start -- --port ${PORT}`,
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
        },
});
