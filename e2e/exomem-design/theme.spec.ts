// The Exomem theme: one preference applied before first paint, kept across navigation,
// and scoped to /exomem. Unit tests cover the inline script's branches; what only a
// browser shows is whether the real pages get it at the right moment. Theme handling
// does not depend on the viewport, so this spec runs in the desktop project only.

import { expect, test, type Page } from "@playwright/test";
import { storeTheme } from "./accessibility";

const root = (page: Page) => page.locator("html");

test("is dark by default, on the Exomem ground", async ({ page }) => {
  await page.goto("/exomem/sign-in");

  await expect(root(page)).toHaveAttribute("data-exomem", "");
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  // The page itself, not just a panel, takes the Exomem ground.
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 9, 8)");
});

test("applies a stored light preference before any app code runs", async ({ page }) => {
  await storeTheme(page, "light");
  // Record the theme the moment <body> exists, before anything has painted.
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      (window as unknown as { themeAtBody: string | null }).themeAtBody =
        document.documentElement.getAttribute("data-theme");
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  // Without the app's scripts only the inline <head> script can set the theme.
  await page.route(
    (url) => url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".js"),
    (route) => route.abort()
  );

  await page.goto("/exomem/sign-in");

  expect(
    await page.evaluate(() => (window as unknown as { themeAtBody: string | null }).themeAtBody)
  ).toBe("light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 248, 244)");
});

test("follows the toggle across navigation and reload", async ({ page }) => {
  await page.goto("/exomem/design-system");
  await page.getByRole("button", { name: "Switch to light mode" }).first().click();
  await expect(root(page)).toHaveAttribute("data-theme", "light");

  await page.goto("/exomem");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(root(page)).toHaveAttribute("data-theme", "light");
});

test("leaves the rest of the site when a link leads off /exomem", async ({ page }) => {
  await storeTheme(page, "light");
  await page.goto("/exomem");
  await expect(root(page)).toHaveAttribute("data-exomem", "");

  // The landing's "Substrate" link is a client-side navigation: no reload clears <html>.
  await page.getByRole("link", { name: "Substrate", exact: true }).click();
  await page.waitForURL("/");

  await expect(root(page)).not.toHaveAttribute("data-exomem");
  await expect(root(page)).not.toHaveAttribute("data-theme");
});

test("leaves the rest of the site from an Exomem 404", async ({ page }) => {
  await storeTheme(page, "light");
  // The site-wide 404 renders here, outside the Exomem pages' own layout.
  await page.goto("/exomem/does-not-exist");
  await expect(root(page)).toHaveAttribute("data-exomem", "");

  await page.getByRole("main").getByRole("link", { name: "Home", exact: true }).click();
  await page.waitForURL("/");

  await expect(root(page)).not.toHaveAttribute("data-exomem");
  await expect(root(page)).not.toHaveAttribute("data-theme");
});
