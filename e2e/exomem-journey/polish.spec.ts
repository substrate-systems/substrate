import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { chooseCopy, otherAppCopy, sentCopy, startCopy } from "../../src/app/exomem/_journey/copy";
import { seedOwner, uniqueEmail } from "./seed";

async function expectJourneyCentered(page: Page) {
  const offset = await page
    .getByRole("main")
    .locator('[class*="column"]')
    .evaluate((column) => {
      const bounds = column.getBoundingClientRect();
      const headerClearance = 84;
      const phone = matchMedia("(max-width: 640px), (max-height: 480px)").matches;
      const bottomBand = phone ? 150 : headerClearance;
      const bandCenter = (window.innerHeight + headerClearance - bottomBand) / 2;
      const expectedCenter = Math.max(headerClearance + bounds.height / 2, bandCenter);
      return bounds.top + bounds.height / 2 - expectedCenter;
    });
  expect(Math.abs(offset)).toBeLessThanOrEqual(1);
}

test("email sign-in stays centered through an unreachable service and recovery", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/exomem/sign-in");
  const heading = page.getByRole("heading", { name: startCopy.web.title });
  await expect(heading).toBeVisible();
  await expect(heading).not.toBeFocused();
  await page.getByLabel(startCopy.emailLabel).fill(uniqueEmail("send-retry"));
  const send = page.getByRole("button", { name: startCopy.web.primary });
  await page.evaluate(() => document.fonts.ready);
  await expectJourneyCentered(page);
  const beforeHeading = (await heading.boundingBox())!;
  const beforeButton = (await send.boundingBox())!;
  const inputBounds = (await page.getByLabel(startCopy.emailLabel).boundingBox())!;
  const formGap = await page
    .locator("form")
    .evaluate((form) => parseFloat(getComputedStyle(form).rowGap));
  expect(beforeButton.y - inputBounds.y - inputBounds.height).toBe(formGap);
  // A lost network connection is the failure this case exercises.
  await page.route("**/api/exomem/access/start", (route) => route.abort("failed"));
  await send.click();
  const unreachable = page.getByRole("heading", { name: "We can’t reach Exomem" });
  await expect(unreachable).toBeFocused();
  await expect(page.getByRole("status")).toContainText("We can’t reach Exomem");
  await expectJourneyCentered(page);
  const retry = page.getByRole("button", { name: "Try now", exact: true });
  const failedButton = await retry.boundingBox();
  await retry.click();
  await expect(retry).toBeFocused();
  await expect(retry).toBeEnabled();
  expect(await retry.boundingBox()).toEqual(failedButton);
  await expectJourneyCentered(page);

  await page.unroute("**/api/exomem/access/start");
  await retry.click();
  const sent = page.getByRole("heading", { name: sentCopy.title });
  await expect(sent).toBeFocused();
  await expect(unreachable).toHaveCount(0);
  await expectJourneyCentered(page);
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.getByLabel(startCopy.emailLabel)).toBeFocused();
  await expectJourneyCentered(page);
  expect((await heading.boundingBox())!.y).toBe(beforeHeading.y);
});

test("copying the setup address keeps the control width and surrounding content still", async ({
  page,
  context,
}) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/exomem/setup");
  const choose = page.getByRole("heading", { name: chooseCopy.title });
  await expect(choose).toBeVisible();
  await expectJourneyCentered(page);
  await page.getByRole("button", { name: chooseCopy.other.name }).click();
  const other = page.getByRole("heading", { name: otherAppCopy.title });
  await expect(other).toBeFocused();
  await expectJourneyCentered(page);
  const copy = page.getByRole("button", { name: "Copy", exact: true });
  await page.evaluate(() => document.fonts.ready);
  const before = await copy.boundingBox();
  await page.evaluate(() => {
    const shifts: number[] = [];
    Object.assign(window, { journeyShifts: shifts });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries())
        shifts.push((entry as PerformanceEntry & { value: number }).value);
    }).observe({ type: "layout-shift" });
  });
  await copy.click();
  const copied = page.getByRole("button", { name: "Copied ✓", exact: true });
  await expect(copied).toBeFocused();
  expect(await copied.boundingBox()).toEqual(before);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  expect(await page.evaluate(() => Reflect.get(window, "journeyShifts"))).toEqual([]);
});
