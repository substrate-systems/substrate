// The Exomem design foundation at every drawn size: the pages are accessible in both
// themes, and motion stops under reduced motion. The theme itself is in theme.spec.ts.

import { expect, test } from "@playwright/test";
import { blockingViolations, runningAnimations, storeTheme } from "./accessibility";

// Existing Exomem pages that need no backend, and the component showcase.
const PAGES = ["/exomem", "/exomem/sign-in", "/exomem/design-system"];

test.describe("accessibility in both themes", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const path of PAGES) {
      test(`${path} in ${theme} has no serious or critical violations`, async ({ page }) => {
        await storeTheme(page, theme);
        // Contrast is checked on settled colours, not mid-animation.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

        expect(await blockingViolations(page)).toEqual([]);
      });
    }
  }
});

test.describe("reduced motion", () => {
  test("stops every animation and the page still reads", async ({ page }) => {
    // The showcase runs every component's motion at once (the live dot blinks forever).
    await page.goto("/exomem/design-system");
    await expect.poll(() => runningAnimations(page)).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => runningAnimations(page)).toBe(0);
    await expect(page.getByRole("heading", { name: "The Exomem design system" })).toBeVisible();
  });
});
