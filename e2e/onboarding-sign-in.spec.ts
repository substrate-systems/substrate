// The sign-in screen is the first thing an invited person touches, and until
// recently it was where they got stuck: it sent a link and then said nothing a
// person could act on. `sign-in-copy.test.ts` covers the wording, but wording
// was never the failure. The failure was the *screen* — a terminal state with
// no way back to the form, a countdown that had to actually tick, and a stale
// link that had to land somewhere recoverable. None of that is observable
// without a browser, so it lives here.
//
// Every test stubs the two access endpoints. That is deliberate rather than a
// shortcut: the server's magic-link route is opaque by design (it returns
// `if_eligible_email_sent` whether or not it queued a mail), so driving it for
// real would prove nothing about the screen while dragging in a database and a
// mail path. What we assert here is the part the person sees.

import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

const MAGIC_LINK = "**/api/exomem/access/magic-link";
const REDEEM = "**/api/exomem/access/magic-link/redeem";
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * The canonical failure envelope from `safeErrorEnvelope`.
 *
 * The shape matters: `errorFrom` in `hosted-browser.ts` only reads a *nested*
 * `error` object, so a flat `{code, message}` stub silently degrades to
 * `REQUEST_FAILED` and every message assertion below would pass against the
 * wrong branch. Building it here once keeps these tests honest.
 */
function errorEnvelope(code: string, message: string, retryable = false) {
  return JSON.stringify({ success: false, error: { code, message, retryable } });
}

/** The opaque 202 the real route returns for every outcome. */
async function stubMagicLinkSent(page: Page) {
  const calls: string[] = [];
  await page.route(MAGIC_LINK, async (route) => {
    calls.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ success: true, status: "if_eligible_email_sent" }),
    });
  });
  return calls;
}

/**
 * The sign-in card's own status line.
 *
 * Next renders a route announcer with `role="alert"` on every page, so an
 * unscoped `getByRole("alert")` is ambiguous and fails strict mode.
 */
function statusAlert(page: Page) {
  return page.getByRole("region", { name: "Open your Exomem." }).getByRole("alert");
}

async function requestLink(page: Page, address: string) {
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
}

test.describe("requesting a sign-in link", () => {
  test("the sent screen states the expiry and always offers another link", async ({ page }) => {
    // The clock is installed before navigation so the countdown is ours to
    // advance; a real 60s wait would make this test worthless in CI.
    await page.clock.install();
    const calls = await stubMagicLinkSent(page);
    await page.goto("/exomem/sign-in");

    await requestLink(page, "invited@example.com");

    await expect(page.getByText(/Check your email/)).toBeVisible();
    // The dead end this replaced never said the link died, so someone opening
    // it late had no way to tell a stale link from a broken product.
    await expect(page.getByText(/expires 15 minutes after it is sent/)).toBeVisible();
    expect(calls).toHaveLength(1);

    // Held back at first, so nobody silently burns the hourly server allowance.
    const resend = page.getByRole("button", { name: /send another link/i });
    await expect(resend).toBeDisabled();
    await expect(resend).toHaveText(`You can send another link in ${RESEND_COOLDOWN_SECONDS}s`);
  });

  test("the countdown visibly ticks and then releases the resend", async ({ page }) => {
    await page.clock.install();
    const calls = await stubMagicLinkSent(page);
    await page.goto("/exomem/sign-in");
    await requestLink(page, "invited@example.com");

    const resend = page.getByRole("button", { name: /send another link/i });
    await expect(resend).toHaveText(`You can send another link in ${RESEND_COOLDOWN_SECONDS}s`);

    // Advanced one second at a time rather than in a single jump. The countdown
    // chains a fresh `setTimeout` from each render, so the next timer does not
    // exist until React has re-rendered; a single large `fastForward` finds only
    // the one pending timer and fires one tick. Asserting the label after every
    // second is what waits for that render, and it doubles as proof the number
    // actually moves — a frozen countdown reads as a hung page.
    for (let remaining = RESEND_COOLDOWN_SECONDS - 1; remaining > 0; remaining -= 1) {
      await page.clock.fastForward(1000);
      await expect(resend).toHaveText(`You can send another link in ${remaining}s`);
    }

    await page.clock.fastForward(1000);
    await expect(resend).toBeEnabled();
    await expect(resend).toHaveText("Send another link");

    // And it must actually resend, to the same address, without retyping it.
    await resend.click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toContain("invited@example.com");
  });

  test("a refused request returns to the form rather than stranding anyone", async ({ page }) => {
    await page.route(MAGIC_LINK, async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: errorEnvelope("RATE_LIMITED", "too many requests", true),
      });
    });
    await page.goto("/exomem/sign-in");
    await requestLink(page, "invited@example.com");

    await expect(statusAlert(page)).toBeVisible();
    // The form is the recovery, so it has to still be there.
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  });
});

test.describe("following a link from the email", () => {
  test("the token is taken out of the URL before anything else happens", async ({ page }) => {
    await page.goto("/exomem/sign-in#secret-token-value");

    await expect(page.getByRole("button", { name: "Continue sign-in" })).toBeVisible();
    // The fragment is stripped so the token does not survive in history, a
    // shared screen, or a copied URL.
    expect(page.url()).not.toContain("secret-token-value");
    expect(new URL(page.url()).hash).toBe("");
  });

  test("an expired link explains itself and leads back to the form", async ({ page }) => {
    await page.route(REDEEM, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: errorEnvelope("ACCESS_TOKEN_INVALID", "the access link is invalid or unavailable"),
      });
    });
    await page.goto("/exomem/sign-in#stale-token");
    await page.getByRole("button", { name: "Continue sign-in" }).click();

    // Links last 15 minutes and work once, so this is nearly always a stale
    // link rather than anything the person did wrong. Saying so is the
    // difference between a recoverable moment and a product that looks broken.
    await expect(statusAlert(page)).toHaveText(
      "That link has expired or was already used. Enter your email below for a new one."
    );
    await expect(page.getByLabel("Email address")).toBeVisible();
  });

  test("a good link hands off to the destination the server chose", async ({ page }) => {
    await page.route(REDEEM, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ destination: "/exomem/home" }),
      });
    });
    // The landing page itself needs a real session; this only asserts the
    // handoff, which is the part the sign-in screen owns.
    await page.route("**/exomem/home", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>home</body></html>" });
    });
    await page.goto("/exomem/sign-in#good-token");
    await page.getByRole("button", { name: "Continue sign-in" }).click();

    await page.waitForURL("**/exomem/home");
  });
});
