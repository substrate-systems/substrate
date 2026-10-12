// The Exomem design foundation at every drawn size: the pages are accessible in both
// themes, and motion stops under reduced motion. The theme itself is in theme.spec.ts.

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

// The locked palette puts these text-on-ground pairs below WCAG AA (4.5:1). Changing a
// locked value is the product owner's decision (raised with this foundation). Until then
// a contrast failure whose exact text colour and ground form one of these pairs is listed
// on the test instead of failing it; every other failure fails. Each pair takes both
// values from its own theme's tokens, so it matches wherever that theme is drawn: the
// showcase pins panels of each theme on a page of the other. Remove a pair when a value
// changes.
type Theme = "dark" | "light";
const BELOW_AA: { theme: Theme; text: string; alpha?: number; ground: string }[] = [
  { theme: "dark", text: "--fg-tertiary", ground: "--bg-base" },
  { theme: "dark", text: "--fg-tertiary", ground: "--bg-panel" },
  { theme: "dark", text: "--fg-tertiary", ground: "--bg-raised" },
  { theme: "light", text: "--fg-tertiary", ground: "--bg-base" },
  { theme: "light", text: "--fg-tertiary", ground: "--bg-panel" },
  { theme: "light", text: "--fg-muted", ground: "--bg-base" },
  { theme: "light", text: "--fg-muted", ground: "--bg-frame" },
  { theme: "light", text: "--exo-amber", ground: "--bg-base" },
  { theme: "light", text: "--exo-amber", ground: "--bg-panel" },
  // The landing's wikilink draws amber at 80% opacity.
  { theme: "light", text: "--exo-amber", alpha: 0.8, ground: "--bg-panel" },
  // Paper-coloured text on an amber fill.
  { theme: "light", text: "--bg-base", ground: "--exo-amber" },
];

/** A #rrggbb token as the browser reports a computed colour: "rgb(r, g, b)" or "rgba(r, g, b, a)". */
function computedColour(hex: string, alpha?: number): string {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ");
  return alpha === undefined ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`;
}

/** Keys "<computed text colour> on <ground hex as axe reports it>". */
const KNOWN_BELOW_AA = new Set(
  BELOW_AA.map(({ theme, text, alpha, ground }) => {
    const tokens = exomemTokens()[theme];
    return `${computedColour(tokens[text], alpha)} on ${tokens[ground].toLowerCase()}`;
  })
);

test.describe("accessibility in both themes", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const path of PAGES) {
      test(`${path} in ${theme} has no serious or critical violations`, async ({ page }) => {
        await storeTheme(page, theme);
        // Contrast is checked on settled colours, not mid-animation.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const blocking: string[] = [];
        for (const violation of results.violations) {
          if (violation.impact !== "serious" && violation.impact !== "critical") continue;
          for (const node of violation.nodes) {
            const selector = node.target.join(" ");
            if (violation.id === "color-contrast") {
              const color = await page.evaluate(
                (target) => getComputedStyle(document.querySelector(target)!).color,
                selector
              );
              const ground = (node.any[0]?.data as { bgColor?: string } | null)?.bgColor;
              if (KNOWN_BELOW_AA.has(`${color} on ${ground}`)) {
                test
                  .info()
                  .annotations.push({ type: "locked palette below AA", description: selector });
              } else {
                blocking.push(`color-contrast: ${selector} (${color} on ${ground})`);
              }
              continue;
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
