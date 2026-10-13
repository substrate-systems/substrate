import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  chooseCopy,
  failureCopy,
  otherAppCopy,
  sentCopy,
  startCopy,
} from "../../src/app/exomem/_journey/copy";
import { seedOwner, uniqueEmail } from "./seed";

async function expectJourneyCentered(page: Page) {
  const offset = await page.getByRole("main").locator('[class*="column"]').evaluate((column) => {
    const bounds = column.getBoundingClientRect();
    return bounds.top + bounds.height / 2 - window.innerHeight / 2;
  });
  expect(Math.abs(offset)).toBeLessThanOrEqual(1);
}

test("a failed email send keeps the form still and focused, then focuses the sent heading", async ({
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
  await page.evaluate(() => {
    const shifts: number[] = [];
    Object.assign(window, { journeyShifts: shifts });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries())
        shifts.push((entry as PerformanceEntry & { value: number }).value);
    }).observe({ type: "layout-shift" });
  });
  // A lost network connection is the failure this case exercises.
  await page.route("**/api/exomem/access/start", (route) => route.abort("failed"));
  await send.click();
  await expect(
    page
      .getByRole("main")
      .getByRole("alert")
      .getByText(failureCopy.generic, { exact: true })
      .filter({ visible: true })
  ).toBeVisible();
  await expect(send).toBeFocused();
  expect((await heading.boundingBox())!.y).toBe(beforeHeading.y);
  expect(await send.boundingBox()).toEqual(beforeButton);
  await send.click();
  await expect(
    page
      .getByRole("main")
      .getByRole("alert")
      .getByText(failureCopy.generic, { exact: true })
      .filter({ visible: true })
  ).toBeVisible();
  await expect(send).toBeFocused();
  expect(await send.boundingBox()).toEqual(beforeButton);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  expect(await page.evaluate(() => Reflect.get(window, "journeyShifts"))).toEqual([]);

  await page.unroute("**/api/exomem/access/start");
  await send.click();
  const sent = page.getByRole("heading", { name: sentCopy.title });
  await expect(sent).toBeFocused();
  await expect(page.getByRole("main").getByRole("alert")).not.toBeVisible();
  await expectJourneyCentered(page);
  await page.getByRole("button", { name: sentCopy.differentEmail }).click();
  await expect(heading).toBeFocused();
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
