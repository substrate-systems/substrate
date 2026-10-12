// Every journey step the real server can reach, at each drawn size and in both themes:
// the step fits without scrolling, clear of the wordmark and the footer, and it passes the
// Exomem accessibility check.
// Each step is reached the way a person reaches it, from seeded accounts and apps.
//
// With JOURNEY_SHOTS set to a folder, each test also saves its screenshot there, for the
// design review; nothing compares against them.

import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
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
  subscribeCopy,
  waitingCopy,
} from "../../src/app/exomem/_journey/copy";
import {
  authorizeRequest,
  seedCapacity,
  seedClient,
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

async function signedIn(context: BrowserContext, state: OwnerState) {
  const owner = await seedOwner(state);
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

/** The app's callback page, answered so a handback never leaves the test. */
async function answerApps(context: BrowserContext) {
  for (const origin of ["https://claude-app.example.test", "http://127.0.0.1:47124"]) {
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({ contentType: "text/plain", body: "the app" })
    );
  }
}

async function consentFor(page: Page, context: BrowserContext, state: OwnerState | null) {
  if (state) await signedIn(context, state);
  const client = await app("web");
  await page.goto(authorizeRequest(client).url);
  return client;
}

async function connectFromApp(context: BrowserContext, where: "web" | "computer") {
  const client = await app(where);
  const consent = await context.newPage();
  await consent.goto(authorizeRequest(client).url);
  await consent.getByRole("button", { name: consentCopy.connect, exact: true }).click();
  await expect(consent.getByRole("heading", { name: handbackCopy.title })).toBeVisible();
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
      await expect(page.getByText(reviewerCopy.failedOnWeb)).toBeVisible();
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
    name: "setup-subscribe",
    open: async (page, context) => {
      await signedIn(context, "unpaid");
      await page.goto("/exomem/setup");
      await heading(page, subscribeCopy.title);
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
      await page.goto("/exomem/setup");
      await page.getByRole("button", { name: /^ChatGPT/ }).click();
      await heading(page, waitingCopy.title("ChatGPT"));
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
    // The tallest step: an app without the plugin gets the instructions to paste.
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
    },
  },
  {
    name: "handback-on-this-computer",
    open: async (page, context) => {
      await signedIn(context, "ready");
      await answerApps(context);
      const client = await app("computer");
      await page.goto(authorizeRequest(client).url);
      await page.getByRole("button", { name: consentCopy.connect, exact: true }).click();
      await expect(page.getByText(handbackCopy.loopback.lede(client.name))).toBeVisible();
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
    expect(overflow).toEqual({ down: 0, across: 0 });
    // Nothing of the step runs under the wordmark or over the request's origin at the foot.
    const main = page.getByRole("main");
    const wordmark = (await main.getByRole("img", { name: "Exomem" }).first().boundingBox())!;
    const title = (await main.getByRole("heading", { level: 1 }).boundingBox())!;
    expect(title.y).toBeGreaterThanOrEqual(wordmark.y + wordmark.height);
    const footer = main.getByText(/^exomem · request from /);
    if (await footer.isVisible()) {
      const foot = (await footer.boundingBox())!;
      for (const control of await main.getByRole("button").all()) {
        const box = await control.boundingBox();
        if (box) expect(box.y + box.height).toBeLessThanOrEqual(foot.y);
      }
    }
    // The short phone is there for the fit; the theme checks run at the other sizes.
    if (size === "phone-375") return;

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
  await page.goto("/exomem/setup");
  await page.getByRole("button", { name: /^ChatGPT/ }).click();
  await heading(page, waitingCopy.title("ChatGPT"));
  await expect.poll(() => runningAnimations(page)).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => runningAnimations(page)).toBe(0);
});
