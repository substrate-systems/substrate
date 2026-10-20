// Global setup for the journey projects: open every journey page and call every route
// the journey uses once, before any test runs. `next dev` compiles each route on its
// first visit, and a compile that changes shared chunks reloads the pages already
// open, which would interrupt tests running in parallel. The answers do not matter.

import { chromium, type FullConfig } from "@playwright/test";

const PAGES = [
  "/exomem/sign-in",
  "/exomem/invite",
  "/exomem/setup",
  "/exomem/authorize",
  "/exomem/home",
];

const ROUTES: { path: string; method: "GET" | "POST" }[] = [
  { path: "/api/exomem/oauth/authorize", method: "GET" },
  { path: "/api/exomem/oauth/authorize/complete", method: "POST" },
  { path: "/api/exomem/oauth/authorize/decline", method: "POST" },
  { path: "/api/exomem/access/start", method: "POST" },
  { path: "/api/exomem/access/inbox?domain=example.test", method: "GET" },
  { path: "/api/exomem/access/magic-link/redeem", method: "POST" },
  { path: "/api/exomem/access/inspect", method: "POST" },
  { path: "/api/exomem/access/redeem", method: "POST" },
  { path: "/api/exomem/access/reviewer", method: "POST" },
  { path: "/api/exomem/access/logout", method: "POST" },
  { path: "/api/exomem/apps", method: "GET" },
  { path: "/api/exomem/status", method: "GET" },
];

export default async function warmUp(config: FullConfig) {
  const baseURL = config.projects.find((project) => project.name.startsWith("exomem journey"))?.use
    .baseURL;
  if (!baseURL) return;
  for (const route of ROUTES) {
    await fetch(new URL(route.path, baseURL), {
      method: route.method,
      headers: { "content-type": "application/json", origin: new URL(baseURL).origin },
      body: route.method === "POST" ? "{}" : undefined,
    });
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const path of PAGES) {
    await page.goto(new URL(path, baseURL).toString(), { waitUntil: "networkidle" });
  }
  await browser.close();
}
