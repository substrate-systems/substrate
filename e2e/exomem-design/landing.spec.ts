// The Exomem landing at each drawn size (desktop 1440, phones 390 and 375). Accessibility in
// both themes runs for /exomem in foundation.spec.ts; this spec covers what a visitor does
// on the landing itself.

import { expect, test } from "@playwright/test";
import recallBenchmarks from "../../src/app/exomem/landing/recall-benchmarks.json";
import { proofFigures } from "../../src/app/exomem/landing/proof";

test("every way in leads to the start page", async ({ page }) => {
  await page.goto("/exomem");

  const starts = page.getByRole("link", { name: "Start with your email →" });
  await expect(starts.first()).toBeVisible();
  for (const link of await starts.all()) {
    await expect(link).toHaveAttribute("href", "/exomem/sign-in");
  }
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/exomem/sign-in"
  );

  await starts.first().click();
  await expect(page).toHaveURL(/\/exomem\/sign-in$/);
});

test("an unavailable session read keeps a neutral entry link usable", async ({ page }) => {
  await page.route("**/api/exomem/access/session", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
  );
  await page.goto("/exomem");
  const entry = page.getByRole("link", { name: "Open Exomem", exact: true });
  await expect(entry).toHaveAttribute("href", "/exomem/sign-in");
  await expect(page.getByRole("link", { name: "Open Exomem →" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveCount(0);
  await entry.click();
  await expect(page).toHaveURL(/\/exomem\/sign-in$/);
});

test("in-page links reach their sections", async ({ page }) => {
  await page.goto("/exomem");

  const targets = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")!.slice(1)));
  expect(targets.length).toBeGreaterThan(0);
  for (const id of new Set(targets)) {
    await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
  }
});

test("the proof shows the measured recall", async ({ page }) => {
  const figures = proofFigures(recallBenchmarks);
  await page.goto("/exomem");

  await expect(page.getByText(figures.recall, { exact: true })).toBeVisible();
  await expect(page.getByText(figures.scaleNotes, { exact: true })).toBeVisible();
});

test("fits the screen without sideways scrolling", async ({ page }) => {
  await page.goto("/exomem");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBe(0);
});

test("holds still under reduced motion and still reads", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/exomem");

  const running = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === "running").length
  );
  expect(running).toBe(0);
  // The current-status suffix is fixed; the demo's example wording can change.
  await expect(page.getByText(/· current$/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Grows with you.Stays true.");
});
