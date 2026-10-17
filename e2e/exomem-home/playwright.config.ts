import { defineConfig, devices } from "@playwright/test";
import { homeE2eAddress } from "./environment";

// Home's workflows against the production build, a real migrated PostgreSQL and the
// gateway-and-cell stand-in (serve.ts). Unlike e2e/playwright.config.ts, nothing here
// stubs an API route: the browser drives the real routes, and only the cell is
// substituted, at its HTTP boundary.
//
//   DATABASE_URL=postgresql://… npx playwright test -c e2e/exomem-home/playwright.config.ts

// Static tooling can load the configuration; serve.ts still requires the test database.
const environment = homeE2eAddress();

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: environment.baseUrl,
    trace: "on-first-retry",
    // Home follows the device's colour scheme until a person picks a theme. The specs
    // start on a dark device; a spec that checks a stored theme sets that itself.
    colorScheme: "dark",
  },
  projects: [
    {
      name: "home desktop 1440",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "home phone 390",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "npx tsx e2e/exomem-home/serve.ts",
    cwd: "../..",
    url: `${environment.baseUrl}/exomem/privacy`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // SIGTERM lets serve.ts stop Next and both stand-ins and delete its certificates;
    // SIGKILL follows after 5 s.
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
