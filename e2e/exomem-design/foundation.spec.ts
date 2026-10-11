// The Exomem design foundation: one theme preference applied before first paint, kept
// across navigation, scoped to /exomem, accessible in both themes, and still under
// reduced motion. Unit tests cover the inline script's branches; what only a browser
// shows is whether the real pages get it at the right moment.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { exomemTokens } from "../../src/lib/exomem/design-tokens";

const THEME_KEY = "exomem-theme";

// Existing Exomem pages that need no backend, and the component showcase.
const PAGES = ["/exomem", "/exomem/sign-in", "/exomem/setup", "/exomem/design-system"];

async function storeTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    THEME_KEY,
    theme,
  ] as const);
}

const root = (page: Page) => page.locator("html");

// The locked palette puts these text colours below WCAG AA (4.5:1) on some grounds:
// --fg-tertiary everywhere; in light, --fg-muted on paper, --exo-amber on paper and
// white, and paper-coloured text on an amber fill. Changing a locked value is the
// product owner's decision (raised with this foundation). Until then a contrast failure
// drawn in exactly one of these colours is listed on the test instead of failing it;
// every other failure fails. Remove a token here when its value changes.
const BELOW_AA_TEXT = {
  dark: ["--fg-tertiary"],
  light: ["--fg-tertiary", "--fg-muted", "--exo-amber", "--bg-base"],
} as const;

/** "r, g, b" of a #rrggbb token value, as the browser reports a computed colour. */
function channels(hex: string): string {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
}

const KNOWN_BELOW_AA = new Set(
  (["dark", "light"] as const).flatMap((theme) =>
    BELOW_AA_TEXT[theme].map((token) => channels(exomemTokens()[theme][token]))
  )
);

test.describe("the Exomem theme", () => {
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
});

test.describe("accessibility in both themes", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const path of PAGES) {
      test(`${path} in ${theme} has no serious or critical violations`, async ({ page }) => {
        await storeTheme(page, theme);
        // Contrast is checked on settled colours, not mid-animation.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(path);
        await expect(root(page)).toHaveAttribute("data-theme", theme);

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const blocking: string[] = [];
        for (const violation of results.violations) {
          if (violation.impact !== "serious" && violation.impact !== "critical") continue;
          for (const node of violation.nodes) {
            const selector = node.target.join(" ");
            if (violation.id === "color-contrast") {
              // The computed colour, alpha dropped: "rgb(r, g, b)" or "rgba(r, g, b, a)".
              const color = await page.evaluate(
                (target) => getComputedStyle(document.querySelector(target)!).color,
                selector
              );
              const rgb = color
                .slice(color.indexOf("(") + 1, -1)
                .split(",")
                .slice(0, 3);
              if (KNOWN_BELOW_AA.has(rgb.map((c) => c.trim()).join(", "))) {
                test
                  .info()
                  .annotations.push({ type: "locked palette below AA", description: selector });
                continue;
              }
            }
            blocking.push(`${violation.id}: ${selector}`);
          }
        }
        expect(blocking).toEqual([]);
      });
    }
  }
});

test.describe("reduced motion", () => {
  const running = (page: Page) =>
    page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);

  test("stops every animation and the page still reads", async ({ page }) => {
    // The showcase runs every component's motion at once (the live dot blinks forever).
    await page.goto("/exomem/design-system");
    await expect.poll(() => running(page)).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => running(page)).toBe(0);
    await expect(page.getByRole("heading", { name: "The Exomem design system" })).toBeVisible();
  });
});
