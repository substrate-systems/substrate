// The Exomem accessibility check every Exomem spec shares: axe at WCAG 2.1 AA, with the
// one allowance for text pairs the locked palette keeps below AA.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { exomemTokens } from "../../src/lib/exomem/design-tokens";

const THEME_KEY = "exomem-theme";

/** The theme the page starts in, the way a returning visitor's browser stores it. */
export async function storeTheme(page: Page, theme: "light" | "dark") {
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
// Known gap the scan does not reach: muted and amber text over the light hover and pressed
// fill (--bg-hover, #EFEBE3) is about 4.2:1. Axe sees only the resting state.
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

/**
 * The serious and critical WCAG 2.1 AA violations on the page as it stands, minus the
 * allowed pairs (each one is noted on the running test instead).
 */
export async function blockingViolations(page: Page): Promise<string[]> {
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
          test.info().annotations.push({ type: "locked palette below AA", description: selector });
        } else {
          blocking.push(`color-contrast: ${selector} (${color} on ${ground})`);
        }
        continue;
      }
      blocking.push(`${violation.id}: ${selector}`);
    }
  }
  return blocking;
}

/** CSS and Web Animations still running on the page. */
export function runningAnimations(page: Page): Promise<number> {
  return page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === "running").length
  );
}

/**
 * The theme switch as the page's own does it: the attribute now, the preference kept.
 * It returns once the page's ground is painted in that theme, so a contrast check never
 * reads text in one theme against the ground of the other.
 */
export async function switchTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(
    ([key, next]) => {
      document.documentElement.setAttribute("data-theme", next);
      window.localStorage.setItem(key, next);
    },
    [THEME_KEY, theme] as const
  );
  const ground = computedColour(exomemTokens()[theme]["--bg-base"]);
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.querySelector("main") ?? document.body).backgroundColor
      )
    )
    .toBe(ground);
}
