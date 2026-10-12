// The app reviewer's own sign-in, from the sign-in page, with the credential the
// operator issues. The directory allows one live reviewer credential, so this runs in
// one project only (playwright.config.ts).

import { expect, test } from "./fixtures";
import { reviewerCopy, startCopy } from "../../src/app/exomem/_journey/copy";
import { seedReviewer } from "./seed";

test("an app reviewer signs in with the username and password", async ({ page }) => {
  const reviewer = await seedReviewer();

  await page.goto("/exomem/sign-in");
  await page.getByRole("button", { name: startCopy.reviewerLink }).click();
  await page.getByLabel(reviewerCopy.username).fill(reviewer.username);
  await page.getByLabel(reviewerCopy.password).fill(`${reviewer.password}-wrong`);
  await page.getByRole("button", { name: reviewerCopy.primary }).click();
  await expect(page.getByText(reviewerCopy.failedOnWeb)).toBeVisible();

  await page.getByLabel(reviewerCopy.password).fill(reviewer.password);
  await page.getByRole("button", { name: reviewerCopy.primary }).click();
  await expect(page).toHaveURL(/\/exomem\/home$/);
});
