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
const journeyProjects = process.env.EXOMEM_E2E_DATABASE_URL
  ? [
      {
        name: "exomem journey desktop 1440",
        testMatch: "exomem-journey/**/*.spec.ts",
        use: {
          ...devices["Desktop Chrome"],
          viewport: { width: 1440, height: 900 },
          baseURL: journeyBaseUrl,
        },
      },
      {
        name: "exomem journey phone 390",
        testMatch: "exomem-journey/**/*.spec.ts",
        // One live reviewer credential at a time: the desktop project signs the reviewer in.
        testIgnore: "exomem-journey/reviewer.spec.ts",
        use: {
          ...devices["Pixel 7"],
          viewport: { width: 390, height: 844 },
          baseURL: journeyBaseUrl,
        },
      },
      // The short phone: only the no-scroll check, the size where every step is tightest.
      {
        name: "exomem journey phone 375",
        testMatch: "exomem-journey/layout.spec.ts",
        use: {
          ...devices["Pixel 7"],
          viewport: { width: 375, height: 667 },
          baseURL: journeyBaseUrl,
        },
      },
    ]
  : [];

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
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: ["exomem-design/**", "exomem-journey/**"],
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
    ...journeyProjects,
  ],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
