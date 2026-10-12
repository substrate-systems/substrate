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

// The text-on-ground pairs below stay under WCAG AA (4.5:1) after the AA palette change
// of 2026-10-12. A contrast failure whose exact text colour and ground form one of these
// pairs is listed on the test instead of failing it; every other failure fails. Each pair
// takes both values from its own theme's tokens, so it matches wherever that theme is
// drawn: the showcase pins panels of each theme on a page of the other. Remove a pair when
// its text moves to a token that passes.
//
// Known gap the scan does not reach: over the light hover and pressed fill (--bg-hover,
// #EFEBE3), muted text is about 4.3:1 and amber text about 4.0:1. Axe sees only the resting state.
type Theme = "dark" | "light";
const BELOW_AA: { theme: Theme; text: string; ground: string }[] = [
  // Page text still drawn in --fg-tertiary (landing captions and links, page footers, the
  // showcase's panel labels). The token is for disabled controls and non-text marks only.
  { theme: "dark", text: "--fg-tertiary", ground: "--bg-base" },
  { theme: "dark", text: "--fg-tertiary", ground: "--bg-panel" },
  { theme: "dark", text: "--fg-tertiary", ground: "--bg-raised" },
  { theme: "light", text: "--fg-tertiary", ground: "--bg-base" },
  { theme: "light", text: "--fg-tertiary", ground: "--bg-panel" },
  // Muted labels on the light frame ground (#EDEAE3), which is darker than paper: 4.2:1.
  { theme: "light", text: "--fg-muted", ground: "--bg-frame" },
  // The landing's "$ pip install exomem · Copy" box in the self-host door: muted text on the
  // light deep ground (#F3F0EA), 4.45:1. The board draws it so; the fix is the owner's call.
  { theme: "light", text: "--fg-muted", ground: "--bg-deep" },
  // Paper-coloured text on an amber fill: fills keep --exo-amber, 4.0:1 in light.
  { theme: "light", text: "--bg-base", ground: "--exo-amber" },
];

/** A #rrggbb token as the browser reports a computed colour: "rgb(r, g, b)". */
function computedColour(hex: string): string {
  return `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
}

/** Keys "<computed text colour> on <ground hex as axe reports it>". */
const KNOWN_BELOW_AA = new Set(
  BELOW_AA.map(({ theme, text, ground }) => {
    const tokens = exomemTokens()[theme];
    return `${computedColour(tokens[text])} on ${tokens[ground].toLowerCase()}`;
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
