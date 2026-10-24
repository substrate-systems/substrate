// Every journey step the real server can reach, at each drawn size and in both themes:
// the step stays usable, clear of the wordmark and the footer, and it passes the
// Exomem accessibility check.
// Each step is reached the way a person reaches it, from seeded accounts and apps.
//
// With JOURNEY_SHOTS set to a folder, each test also saves its screenshot there, for the
// design review; nothing compares against them.

import type { BrowserContext, Page } from "@playwright/test";
import { AFTER_CONNECT_MS, expect, test } from "./fixtures";
import {
  blockingViolations,
  runningAnimations,
  storeTheme,
  switchTheme,
} from "../exomem-design/accessibility";
import {
  breakCopy,
  chooseCopy,
  consentCopy,
  handbackCopy,
  inviteCopy,
  joinedCopy,
  otherAppCopy,
  reviewerCopy,
  sentCopy,
  startCopy,
  signedInCopy,
  subscribeCopy,
  unknownAppCopy,
  waitingCopy,
} from "../../src/app/exomem/_journey/copy";
import { CLIENT_PLATFORM_LISTING_URLS } from "../../src/lib/exomem-hosted/client-platforms";
import {
  authorizeRequest,
  seedCapacity,
  seedClient,
  seedInvitation,
  seedOwner,
  startLinkFor,
  uniqueEmail,
  type OwnerState,
} from "./seed";

type Step = {
  name: string;
  /** Brings the page to the step; it ends once the step shows. */
  open: (page: Page, context: BrowserContext) => Promise<void>;
};

const heading = (page: Page, name: string) =>
  expect(page.getByRole("heading", { name })).toBeVisible();

async function signedIn(context: BrowserContext, state: OwnerState, email?: string) {
  const owner = await seedOwner(state, email);
  await context.addCookies(owner.cookies);
  return owner;
}

/** An app registered by the operator: one on the web, or one on this computer. */
async function app(where: "web" | "computer") {
  return seedClient(
    where === "web"
      ? {
          name: "Claude",
          redirectUri: "https://claude-app.example.test/callback",
          platform: "claude",
        }
      : { name: "Claude Code", redirectUri: "http://127.0.0.1:47124/callback", platform: null }
  );
}

/**
 * This server has no Paddle credentials, so its invitation answers carry no price. Here
 * the answer gets the prices Paddle previews when it answers, so a step can show the
 * friend price that the decision route then applies; the decision itself stays real.
 */
async function withPaddlePrices(context: BrowserContext) {
  await context.route("**/api/exomem/access/inspect", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.price?.reason === "price_unavailable") {
      body.price = {
        value: {
          usual: { amount: "1500", currencyCode: "EUR" },
          friend: { value: { amount: "1000", currencyCode: "EUR" }, reason: null },
        },
        reason: null,
      };
    }
    await route.fulfill({ response, json: body });
  });
}

/** The app's callback page, answered so a handback never leaves the test. */
async function answerApps(context: BrowserContext) {
  for (const origin of ["https://claude-app.example.test", "http://127.0.0.1:47124"]) {
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({ contentType: "text/plain", body: "the app" })
    );
  }
}

async function stubChatGPTListing(context: BrowserContext): Promise<string[]> {
  const requests: string[] = [];
  await context.route("https://chatgpt.com/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>ChatGPT listing fixture</title>",
    });
  });
  return requests;
}

async function consentFor(
  page: Page,
  context: BrowserContext,
  state: OwnerState | null,
  email?: string
) {
  if (state) await signedIn(context, state, email);
  const client = await app("web");
  await page.goto(authorizeRequest(client).url);
  return client;
}

async function connectFromApp(context: BrowserContext, where: "web" | "computer") {
  const client = await app(where);
  const consent = await context.newPage();
  // Like the step's own page, the app's page holds still: these checks are about layout.
  await consent.emulateMedia({ reducedMotion: "reduce" });
  await consent.goto(authorizeRequest(client).url);
  await consent.getByRole("button", { name: consentCopy.connect, exact: true }).click();
  await expect(consent.getByRole("heading", { name: handbackCopy.title })).toBeVisible({
    timeout: AFTER_CONNECT_MS,
  });
  await consent.close();
  return client;
}

const STEPS: Step[] = [
  {
    name: "start",
    open: async (page) => {
      await page.goto("/exomem/sign-in");
      await heading(page, startCopy.web.title);
    },
  },
  {
    name: "sent",
    open: async (page) => {
      await page.goto("/exomem/sign-in");
      await page.getByLabel(startCopy.emailLabel).fill(uniqueEmail("sent"));
      await page.getByRole("button", { name: startCopy.web.primary }).click();
      await heading(page, sentCopy.title);
    },
  },
  {
    // The page a link from the email opens, before the person continues.
    name: "sign-in-continue",
    open: async (page) => {
      await page.goto("/exomem/sign-in#a-link-from-the-email");
      await expect(page.getByRole("button", { name: "Continue sign-in" })).toBeVisible();
    },
  },
  {
    name: "reviewer-failed",
    open: async (page) => {
      await page.goto("/exomem/sign-in");
      await page.getByRole("button", { name: startCopy.reviewerLink }).click();
      await page.getByLabel(reviewerCopy.username).fill("not-a-reviewer");
      await page.getByLabel(reviewerCopy.password).fill("not-a-password");
      await page.getByRole("button", { name: reviewerCopy.primary }).click();
      await expect(page.getByText(reviewerCopy.failedOnWeb, { exact: true })).toBeVisible();
    },
  },
  {
    name: "invite",
    open: async (page) => {
      await seedCapacity();
      const email = uniqueEmail("invite");
      await page.goto("/exomem/sign-in");
      await page.getByLabel(startCopy.emailLabel).fill(email);
      await page.getByRole("button", { name: startCopy.web.primary }).click();
      await heading(page, sentCopy.title);
      await page.goto(await startLinkFor(email));
      await heading(page, inviteCopy.standardTitle);
    },
  },
  {
    name: "invite-unusable",
    open: async (page) => {
      await page.goto("/exomem/invite#not-an-invitation");
      await heading(page, inviteCopy.unusable.title);
    },
  },
  {
    // A friend's invitation with their note. Paddle has no credentials here, so the
    // amount says it shows at checkout.
    name: "invite-friend",
    open: async (page) => {
      const { link } = await seedInvitation({
        email: uniqueEmail("friend"),
        kind: "friend",
        inviterName: "Alex",
        note: "This is what I’ve been building. I’d love to know what you think.",
      });
      await page.goto(link);
      await heading(page, inviteCopy.friendTitle("Alex"));
      await expect(page.getByText(inviteCopy.price.atCheckout)).toBeVisible();
    },
  },
  {
    name: "invite-covered",
    open: async (page) => {
      const { link } = await seedInvitation({
        email: uniqueEmail("covered"),
        kind: "covered",
        inviterName: "Alex",
      });
      await page.goto(link);
      await heading(page, inviteCopy.friendTitle("Alex"));
      await expect(page.getByText(inviteCopy.price.nothingToPay)).toBeVisible();
    },
  },
  {
    // The invited address already has an Exomem, and this browser is signed in as it.
    name: "invite-existing",
    open: async (page, context) => {
      const owner = await signedIn(context, "ready");
      await withPaddlePrices(context);
      const { link } = await seedInvitation({
        email: owner.email,
        kind: "friend",
        inviterName: "Alex",
      });
      await page.goto(link);
      await heading(page, inviteCopy.existing.title);
      await expect(
        page.getByRole("button", { name: inviteCopy.existing.useFriendPrice("Alex") })
      ).toBeVisible();
      await expect(page.getByText(inviteCopy.price.perMonth("€10"))).toBeVisible();
    },
  },
  {
    // Paddle did not answer: neither the friend price nor a refusal, and a way to ask again.
    name: "invite-existing-unchecked",
    open: async (page, context) => {
      const owner = await signedIn(context, "ready");
      const { link } = await seedInvitation({
        email: owner.email,
        kind: "friend",
        inviterName: "Alex",
      });
      await page.goto(link);
      await heading(page, inviteCopy.existing.title);
      await expect(page.getByText(inviteCopy.existing.unchecked("Alex"))).toBeVisible();
    },
  },
  {
    name: "invite-existing-signed-out",
    open: async (page) => {
      const owner = await seedOwner("ready");
      const { link } = await seedInvitation({
        email: owner.email,
        kind: "friend",
        inviterName: "Alex",
      });
      await page.goto(link);
      await heading(page, inviteCopy.existing.title);
      await expect(page.getByText(inviteCopy.existing.signIn("Alex"))).toBeVisible();
    },
  },
  {
    // An owner who has not paid yet takes the friend price to their first checkout.
    name: "invite-applied-at-checkout",
    open: async (page, context) => {
      const owner = await signedIn(context, "unpaid");
      await withPaddlePrices(context);
      const { link } = await seedInvitation({
        email: owner.email,
        kind: "friend",
        inviterName: "Alex",
      });
      await page.goto(link);
      await page.getByRole("button", { name: inviteCopy.existing.useFriendPrice("Alex") }).click();
      await heading(page, inviteCopy.appliedOnResubscribe.title);
      await expect(page.getByText(inviteCopy.appliedOnResubscribe.done)).toBeVisible();
    },
  },
  {
    name: "invite-kept",
    open: async (page, context) => {
      const owner = await signedIn(context, "ready");
      const { link } = await seedInvitation({ email: owner.email, kind: "standard" });
      await page.goto(link);
      await page.getByRole("button", { name: inviteCopy.existing.keep }).click();
      await heading(page, inviteCopy.kept.title);
    },
  },
  {
    // The inline checkout retains the account's friend offer without inventing a price.
    name: "setup-subscribe-friend",
    open: async (page) => {
      await seedCapacity();
      const { link } = await seedInvitation({
        email: uniqueEmail("friend"),
        kind: "friend",
        inviterName: "Alex",
      });
      await page.goto(link);
      await page.getByRole("button", { name: inviteCopy.accept }).click();
      await heading(page, subscribeCopy.title);
      await expect(page.getByText("Alex’s friend price", { exact: true })).toBeVisible();
    },
  },
  {
    name: "setup-subscribe",
    open: async (page, context) => {
      await signedIn(context, "unpaid");
      await page.goto("/exomem/setup");
      await heading(page, subscribeCopy.title);
    },
  },
  {
    // Paid, while the Exomem starts: the page waits for it to be ready.
    name: "setup-preparing",
    open: async (page, context) => {
      await signedIn(context, "preparing");
      await page.goto("/exomem/setup");
      await heading(page, "You’re subscribed");
      await expect(page.getByRole("button", { name: "Add it to your assistant →" })).toBeDisabled();
    },
  },
  {
    name: "setup-choose",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await page.goto("/exomem/setup");
      await heading(page, chooseCopy.title);
    },
  },
  {
    name: "setup-waiting",
    open: async (page, context) => {
      await signedIn(context, "ready");
      const listingRequests = await stubChatGPTListing(context);
      await page.goto("/exomem/setup");
      const listing = page.waitForEvent("popup");
      await page.getByRole("button", { name: /^ChatGPT/ }).click();
      const popup = await listing;
      await expect(popup).toHaveURL(CLIENT_PLATFORM_LISTING_URLS.openai);
      expect(listingRequests).toContain(CLIENT_PLATFORM_LISTING_URLS.openai);
      await popup.close();
      await heading(page, waitingCopy.title("ChatGPT"));
      // The listing opens at Exomem itself, so the step asks for no search.
      await expect(
        page.getByText(waitingCopy.atListing("openai")!, { exact: false })
      ).toBeVisible();
    },
  },
  {
    name: "setup-other",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await page.goto("/exomem/setup");
      await page.getByRole("button", { name: new RegExp(`^${chooseCopy.other.name}`) }).click();
      await heading(page, otherAppCopy.title);
    },
  },
  {
    // The tallest step: an app without the plugin gets the instructions to paste, and a
    // picked level that this server cannot save says so.
    name: "setup-joined-without-plugin",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await answerApps(context);
      await page.goto("/exomem/setup");
      await page.getByRole("button", { name: new RegExp(`^${chooseCopy.other.name}`) }).click();
      await heading(page, otherAppCopy.title);
      await connectFromApp(context, "computer");
      await expect(
        page.getByRole("heading", { name: joinedCopy.title("Claude Code") })
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(joinedCopy.ledeWithoutPlugin)).toBeVisible();
      await page.getByRole("button", { name: "Light", exact: true }).click();
      await expect(page.getByText(joinedCopy.notSaved, { exact: true })).toBeVisible();
    },
  },
  {
    // Signed out from setup: the sign-in step keeps the reviewer's entry.
    name: "setup-switched",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await page.goto("/exomem/setup");
      await page.getByRole("button", { name: signedInCopy.switchAccount }).click();
      await heading(page, startCopy.web.title);
      await expect(page.getByRole("button", { name: startCopy.reviewerLink })).toBeVisible();
    },
  },
  {
    name: "setup-ended",
    open: async (page, context) => {
      await signedIn(context, "ended");
      await page.goto("/exomem/setup");
      await heading(page, breakCopy.ended.title);
    },
  },
  {
    name: "setup-paused",
    open: async (page, context) => {
      await signedIn(context, "paused");
      await page.goto("/exomem/setup");
      await heading(page, breakCopy.paused.title);
    },
  },
  {
    name: "setup-suspended",
    open: async (page, context) => {
      await signedIn(context, "suspended");
      await page.goto("/exomem/setup");
      await heading(page, breakCopy.suspended.title);
    },
  },
  {
    name: "consent-signed-out",
    open: async (page, context) => {
      await consentFor(page, context, null);
      await heading(page, startCopy.app("Claude").title);
    },
  },
  {
    name: "consent-reviewer",
    open: async (page, context) => {
      await consentFor(page, context, null);
      await page.getByRole("button", { name: startCopy.reviewerLink }).click();
      await heading(page, reviewerCopy.title);
    },
  },
  {
    name: "consent-subscribe",
    open: async (page, context) => {
      await consentFor(page, context, "unpaid");
      await heading(page, subscribeCopy.title);
    },
  },
  {
    // The app's inline checkout retains the same friend offer.
    name: "consent-subscribe-friend",
    open: async (page, context) => {
      await seedCapacity();
      const { link } = await seedInvitation({
        email: uniqueEmail("friend"),
        kind: "friend",
        inviterName: "Alex",
      });
      await page.goto(link);
      await page.getByRole("button", { name: inviteCopy.accept }).click();
      await heading(page, subscribeCopy.title);
      await consentFor(page, context, null);
      await heading(page, subscribeCopy.title);
      await expect(page.getByText("Alex’s friend price", { exact: true })).toBeVisible();
    },
  },
  {
    name: "consent-connect",
    open: async (page, context) => {
      await consentFor(page, context, "ready");
      await heading(page, consentCopy.title("Claude"));
    },
  },
  {
    name: "consent-preparing",
    open: async (page, context) => {
      await consentFor(page, context, "preparing");
      await expect(page.getByText(consentCopy.preparing)).toBeVisible();
    },
  },
  {
    name: "consent-read-only",
    open: async (page, context) => {
      await consentFor(page, context, "readonly");
      await expect(page.getByText(consentCopy.readOnly.lede)).toBeVisible();
    },
  },
  {
    // The tallest step with the longest address an email can have (254 characters): the
    // signed-in line takes at most two lines, so the step still fits.
    name: "consent-read-only-longest-email",
    open: async (page, context) => {
      const local = uniqueEmail("readonly").split("@")[0]!.padEnd(64, "x");
      const domain = `${"d".repeat(63)}.${"e".repeat(63)}.${"f".repeat(56)}.test`;
      await consentFor(page, context, "readonly", `${local}@${domain}`);
      await expect(page.getByText(consentCopy.readOnly.lede)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const main = page.getByRole("main");
      const theme = main.getByRole("button", { name: /^Theme:/ });
      await expect(theme).toBeVisible();
      const control = (await theme.boundingBox())!;
      const wordmark = (await main.getByRole("img", { name: "Exomem" }).first().boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(control.x).toBeGreaterThanOrEqual(wordmark.x + wordmark.width);
      expect(control.x + control.width).toBeLessThanOrEqual(viewport.width);
      expect(control.y).toBeGreaterThanOrEqual(0);
      expect(control.y + control.height).toBeLessThanOrEqual(viewport.height);
    },
  },
  {
    name: "consent-ended",
    open: async (page, context) => {
      await consentFor(page, context, "ended");
      await heading(page, breakCopy.ended.title);
    },
  },
  {
    name: "consent-paused",
    open: async (page, context) => {
      await consentFor(page, context, "paused");
      await heading(page, breakCopy.paused.title);
    },
  },
  {
    name: "consent-suspended",
    open: async (page, context) => {
      await consentFor(page, context, "suspended");
      await heading(page, breakCopy.suspended.title);
    },
  },
  {
    // The longest name an app may give itself, as one word: it wraps, whole, on a phone.
    name: "consent-long-name",
    open: async (page, context) => {
      await signedIn(context, "ready");
      const client = await seedClient({
        name: "W".repeat(64),
        redirectUri: "https://claude-app.example.test/callback",
        platform: null,
        namedBy: "itself",
      });
      await page.goto(authorizeRequest(client).url);
      await heading(page, consentCopy.title(client.name));
    },
  },
  {
    // An app Exomem does not know, or no longer admits: a plain page, not an error body.
    name: "unknown-app",
    open: async (page) => {
      await page.goto(
        authorizeRequest({
          clientId: "retired-app",
          redirectUri: "https://claude-app.example.test/callback",
          name: "",
        }).url
      );
      await heading(page, unknownAppCopy.title);
    },
  },
  {
    name: "consent-expired",
    open: async (page) => {
      await page.goto("/exomem/authorize");
      await heading(page, breakCopy.expired.title);
    },
  },
  {
    name: "consent-again-then-kept",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await answerApps(context);
      const client = await connectFromApp(context, "computer");
      await page.goto(authorizeRequest(client).url);
      await heading(page, consentCopy.again.title(client.name));
      await page.getByRole("button", { name: consentCopy.again.keep }).click();
      await heading(page, handbackCopy.kept.title);
      await expect(
        page.getByText(handbackCopy.kept.done(client.name), { exact: true })
      ).toBeVisible();
    },
  },
  {
    name: "handback-on-this-computer",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await answerApps(context);
      const client = await seedClient({
        name: "W".repeat(64),
        redirectUri: "http://127.0.0.1:47124/callback",
        platform: null,
      });
      await page.goto(authorizeRequest(client).url);
      await page.getByRole("button", { name: consentCopy.connect, exact: true }).click();
      await expect(page.getByText(handbackCopy.loopback.lede(client.name))).toBeVisible({
        timeout: AFTER_CONNECT_MS,
      });
      const status = page.getByText(handbackCopy.loopback.done(client.name), { exact: true });
      await expect(status).toBeVisible();
      await expect(status.locator('[aria-hidden="true"]')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const visible = await status.evaluate((line) => {
        const column = line.closest('[class*="column"]')!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(line);
        return {
          left: Math.max(0, column.left),
          right: Math.min(innerWidth, column.right),
          top: Math.max(0, column.top),
          bottom: Math.min(innerHeight, column.bottom),
          rects: Array.from(range.getClientRects(), ({ left, right, top, bottom }) => ({
            left,
            right,
            top,
            bottom,
          })),
        };
      });
      expect(visible.rects.length).toBeGreaterThan(0);
      for (const rect of visible.rects) {
        expect(rect.left).toBeGreaterThanOrEqual(visible.left);
        expect(rect.right).toBeLessThanOrEqual(visible.right);
        expect(rect.top).toBeGreaterThanOrEqual(visible.top);
        expect(rect.bottom).toBeLessThanOrEqual(visible.bottom);
      }
    },
  },
  {
    name: "declined-on-this-computer",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await answerApps(context);
      const client = await app("computer");
      await page.goto(authorizeRequest(client).url);
      await page.getByRole("button", { name: consentCopy.notNow }).click();
      await expect(page.getByText(handbackCopy.declined.ledeLoopback(client.name))).toBeVisible();
    },
  },
];

for (const step of STEPS) {
  test(`${step.name} fits and is accessible in both themes`, async ({ page, context }) => {
    const size = test.info().project.name.replace("exomem journey ", "").replace(" ", "-");
    await storeTheme(page, "dark");
    // Settled colours for the contrast check; motion has its own test below.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await step.open(page, context);

    const overflow = await page.evaluate(() => ({
      down: document.documentElement.scrollHeight - window.innerHeight,
      across: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(overflow.across).toBe(0);
    const viewport = page.viewportSize()!;
    const checkout = (await page.locator("[data-checkout-panel]").count()) > 0;
    if (viewport.height >= 844 && !checkout) expect(overflow.down).toBe(0);
    else {
      const lastControl = page.getByRole("main").getByRole("button").last();
      // Informational states, such as an expired request, have no action to scroll to.
      if (await lastControl.count()) await lastControl.scrollIntoViewIfNeeded();
    }
    // Nothing of the step runs under the wordmark or over the request's origin at the foot,
    // and the title and the origin, which name the app, are whole on the screen: the page
    // hides what overflows its column, so the document's size alone would not show it.
    const main = page.getByRole("main");
    const width = page.viewportSize()!.width;
    const wordmark = (await main.getByRole("img", { name: "Exomem" }).first().boundingBox())!;
    const title = (await main.getByRole("heading", { level: 1 }).boundingBox())!;
    expect(title.y).toBeGreaterThanOrEqual(wordmark.y + wordmark.height);
    expect(title.x).toBeGreaterThanOrEqual(0);
    expect(title.x + title.width).toBeLessThanOrEqual(width);
    const footer = main.getByText(/^exomem · request from /);
    if (await footer.isVisible()) {
      const foot = (await footer.boundingBox())!;
      expect(foot.x).toBeGreaterThanOrEqual(0);
      expect(foot.x + foot.width).toBeLessThanOrEqual(width);
      for (const control of await main.getByRole("button").all()) {
        const box = await control.boundingBox();
        if (box) expect(box.y + box.height).toBeLessThanOrEqual(foot.y);
      }
    }
    // Small phones check the fit. Theme checks also run on shorter desktops,
    // including the canonical 1280 × 820 viewport, and phones at 390 × 844.
    if (width < 390 || (test.info().project.use.isMobile && viewport.height < 844)) return;

    for (const theme of ["dark", "light"] as const) {
      // The page's own switch does the same: the step stays where it is.
      await switchTheme(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await blockingViolations(page), theme).toEqual([]);
      const shots = process.env.JOURNEY_SHOTS;
      // Without the development server's own badge, which is not part of the page.
      if (shots) {
        await page.screenshot({
          path: `${shots}/${step.name}-${size}-${theme}.png`,
          style: "nextjs-portal { display: none !important; }",
        });
      }
    }
  });
}

test("reduced motion stops the journey's motion", async ({ page, context }) => {
  // The waiting step blinks its live dot; the content fades in on every step.
  await signedIn(context, "ready");
  await stubChatGPTListing(context);
  await page.goto("/exomem/setup");
  await page.getByRole("button", { name: /^ChatGPT/ }).click();
  await heading(page, waitingCopy.title("ChatGPT"));
  await expect.poll(() => runningAnimations(page)).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => runningAnimations(page)).toBe(0);
});
