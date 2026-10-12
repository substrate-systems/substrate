// The journey as people walk it, against the real server and its database: a new person
// from their email to checkout, a returning owner's emailed link, an app's consent
// answered both ways, and setup noticing the app that just connected. Only Cloudflare
// (its documented test keys) and the apps' own callback pages stand in for the outside
// world.

import type { BrowserContext, Page } from "@playwright/test";
import type { CloudHomeLiveLevels } from "../../src/lib/exomem-hosted/cloud-home-mcp";
import { expect, test } from "./fixtures";
import {
  breakCopy,
  chooseCopy,
  claimCopy,
  consentCopy,
  failureCopy,
  handbackCopy,
  inviteCopy,
  joinedCopy,
  otherAppCopy,
  sentCopy,
  startCopy,
  subscribeCopy,
  waitingCopy,
} from "../../src/app/exomem/_journey/copy";
import {
  authorizeRequest,
  grantCount,
  invitationConsumed,
  seedCapacity,
  seedClient,
  seedInvitation,
  seedOwner,
  seedSubscription,
  signInLinkFor,
  startLinkFor,
  uniqueEmail,
} from "./seed";

/** The sign-in page's own step before a link redeems (not board copy; see sign-in-client). */
const CONTINUE_SIGN_IN = "Continue sign-in";

async function startWithEmail(page: Page, email: string) {
  await page.goto("/exomem/sign-in");
  await page.getByLabel(startCopy.emailLabel).fill(email);
  await page.getByRole("button", { name: startCopy.web.primary }).click();
  await expect(page.getByRole("heading", { name: sentCopy.title })).toBeVisible();
}

/** Stands in for an app's callback page and records each request that reaches it. */
async function appCallback(page: Page, origin: string): Promise<URL[]> {
  const reached: URL[] = [];
  await page.context().route(`${origin}/**`, async (route) => {
    reached.push(new URL(route.request().url()));
    await route.fulfill({ contentType: "text/plain", body: "the app" });
  });
  return reached;
}

test("a new person goes from their email to checkout", async ({ page }) => {
  await seedCapacity();
  const email = uniqueEmail("new");

  await startWithEmail(page, email);
  await expect(page.getByText(email)).toBeVisible();

  await page.goto(await startLinkFor(email));
  await expect(page.getByRole("heading", { name: inviteCopy.standardTitle })).toBeVisible();
  await page.getByRole("button", { name: inviteCopy.accept }).click();

  await expect(page).toHaveURL(/\/exomem\/setup$/);
  await expect(page.getByRole("heading", { name: subscribeCopy.title })).toBeVisible();
});

test("a returning owner's emailed link signs them in once, after they continue", async ({
  page,
}) => {
  const owner = await seedOwner("ready");

  await startWithEmail(page, owner.email);
  const link = await signInLinkFor(owner.email);
  // The email's link opens in a new tab of the same browser, and waits for the person.
  const opened = await page.context().newPage();
  await opened.goto(link);
  await opened.getByRole("button", { name: CONTINUE_SIGN_IN }).click();
  await expect(opened).toHaveURL(/\/exomem\/home$/);

  // The same link pasted into the first tab: spent, and the page says so and offers the form.
  await page.goto(link);
  await page.getByRole("button", { name: CONTINUE_SIGN_IN }).click();
  // The page took the token out of the address bar before anything else.
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByText(failureCopy.linkUnusable)).toBeVisible();
  await expect(page.getByLabel(startCopy.emailLabel)).toBeVisible();
});

test("Not now tells a web app no, and nothing is shared", async ({ page, context }) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Journey Web App",
    redirectUri: "https://web-app.example.test/callback",
    platform: null,
  });
  const reached = await appCallback(page, "https://web-app.example.test");
  const request = authorizeRequest(client);

  await page.goto(request.url);
  await expect(page.getByRole("heading", { name: consentCopy.title(client.name) })).toBeVisible();
  await page.getByRole("button", { name: consentCopy.notNow }).click();

  await expect(
    page.getByRole("heading", { name: handbackCopy.declined.title(client.name) })
  ).toBeVisible();
  await page.waitForURL("https://web-app.example.test/**");
  expect(reached).toHaveLength(1);
  expect(reached[0]!.searchParams.get("error")).toBe("access_denied");
  expect(reached[0]!.searchParams.get("state")).toBe(request.state);
  expect(await grantCount(client)).toBe(0);
});

test("Connect hands a web app its code", async ({ page, context }) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Journey Web App",
    redirectUri: "https://web-app.example.test/callback",
    platform: null,
  });
  const reached = await appCallback(page, "https://web-app.example.test");
  const request = authorizeRequest(client);

  await page.goto(request.url);
  await page.getByRole("button", { name: consentCopy.connect, exact: true }).click();

  await expect(page.getByRole("heading", { name: handbackCopy.title })).toBeVisible();
  await page.waitForURL("https://web-app.example.test/**");
  expect(reached[0]!.searchParams.get("code")).toBeTruthy();
  expect(reached[0]!.searchParams.get("state")).toBe(request.state);
  expect(await grantCount(client)).toBe(1);
});

// The answer to Connect can be lost after the server has already connected the app.
// The page must then say it could not confirm, never that nothing changed.
test("a lost answer to Connect is not reported as nothing changed", async ({ page, context }) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Journey Web App",
    redirectUri: "https://web-app.example.test/callback",
    platform: null,
  });
  const served: number[] = [];
  await page.route("**/api/exomem/oauth/authorize/complete", async (route) => {
    served.push((await route.fetch()).status());
    await route.abort("connectionreset");
  });

  await page.goto(authorizeRequest(client).url);
  await page.getByRole("button", { name: consentCopy.connect, exact: true }).click();

  await expect(
    page.getByRole("heading", { name: breakCopy.unconfirmed.title(client.name) })
  ).toBeVisible();
  await expect(page.getByText(breakCopy.unconfirmed.lede(client.name))).toBeVisible();
  await expect(page.getByText(/Nothing changed/)).toHaveCount(0);
  // The server answered 200 and connected the app; only the answer was lost.
  expect(served).toEqual([200]);
  expect(await grantCount(client)).toBe(1);
});

// The route answers 500 when its store throws, and a store throws also when only the
// COMMIT acknowledgement is lost: the app is then connected. Here the attach really
// commits, and the page gets the 500 that such a lost acknowledgement produces.
test("a 500 from Connect is not reported as nothing changed", async ({ page, context }) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Journey Web App",
    redirectUri: "https://web-app.example.test/callback",
    platform: null,
  });
  const served: number[] = [];
  await page.route("**/api/exomem/oauth/authorize/complete", async (route) => {
    served.push((await route.fetch()).status());
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "server_error" }),
    });
  });

  await page.goto(authorizeRequest(client).url);
  await page.getByRole("button", { name: consentCopy.connect, exact: true }).click();

  await expect(
    page.getByRole("heading", { name: breakCopy.unconfirmed.title(client.name) })
  ).toBeVisible();
  await expect(page.getByText(breakCopy.unconfirmed.lede(client.name))).toBeVisible();
  await expect(page.getByText(/Nothing changed/)).toHaveCount(0);
  expect(served).toEqual([200]);
  expect(await grantCount(client)).toBe(1);
});

// Any app can register itself under any name, "Claude" included. The page names where
// the answer goes, so a lookalike cannot pass as Claude while collecting codes elsewhere.
test("an app that names itself is shown with where its answer goes", async ({ page, context }) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Claude",
    redirectUri: "https://lookalike.example.test/callback",
    platform: null,
    namedBy: "itself",
  });

  await page.goto(authorizeRequest(client).url);

  await expect(page.getByRole("heading", { name: consentCopy.title("Claude") })).toBeVisible();
  await expect(
    page.getByText(`${consentCopy.footer("lookalike.example.test")} · ${claimCopy("Claude")}`)
  ).toBeVisible();
});

test("Not now tells an app on this computer in the background, and the page stays", async ({
  page,
  context,
}) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Journey Terminal",
    redirectUri: "http://127.0.0.1:47123/callback",
    platform: null,
  });
  const reached = await appCallback(page, "http://127.0.0.1:47123");
  const request = authorizeRequest(client);

  await page.goto(request.url);
  await page.getByRole("button", { name: consentCopy.notNow }).click();

  await expect(page.getByText(handbackCopy.declined.ledeLoopback(client.name))).toBeVisible();
  await expect.poll(() => reached.length).toBe(1);
  expect(reached[0]!.searchParams.get("error")).toBe("access_denied");
  expect(reached[0]!.searchParams.get("state")).toBe(request.state);
  expect(new URL(page.url()).pathname).toBe("/exomem/authorize");
});

test("setup notices the app that just connected", async ({ page, context }) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Claude",
    redirectUri: "https://claude-app.example.test/callback",
    platform: "claude",
  });
  await appCallback(page, "https://claude-app.example.test");

  await page.goto("/exomem/setup");
  await page.getByRole("button", { name: /^Claude/ }).click();
  await expect(page.getByRole("heading", { name: waitingCopy.title("Claude") })).toBeVisible();

  // Claude opens the consent page in its own tab, and the person presses Connect there.
  const consent = await context.newPage();
  await consent.goto(authorizeRequest(client).url);
  await consent.getByRole("button", { name: consentCopy.connect, exact: true }).click();
  await consent.waitForURL("https://claude-app.example.test/**");

  await expect(page.getByRole("heading", { name: joinedCopy.title("Claude") })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(joinedCopy.done("Claude"))).toBeVisible();
});

/** Connects Claude Code, an app without the plugin, from the setup page to its joined step. */
async function joinWithoutPlugin(page: Page, context: BrowserContext) {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const client = await seedClient({
    name: "Claude Code",
    redirectUri: "http://127.0.0.1:47125/callback",
    platform: null,
  });
  await appCallback(page, "http://127.0.0.1:47125");

  await page.goto("/exomem/setup");
  await page.getByRole("button", { name: new RegExp(`^${chooseCopy.other.name}`) }).click();
  await expect(page.getByRole("heading", { name: otherAppCopy.title })).toBeVisible();
  const consent = await context.newPage();
  await consent.goto(authorizeRequest(client).url);
  await consent.getByRole("button", { name: consentCopy.connect, exact: true }).click();
  await consent.close();

  await expect(
    page.getByRole("heading", { name: joinedCopy.title("Claude Code") })
  ).toBeVisible({ timeout: 10_000 });
}

// Production keeps the Home channel off until a later cell release, and so does this
// server. A level picked on the joined step then stays on screen, and the page says it is
// not saved; it never promises or shows a save.
test("a level the cell cannot take yet stays picked and is not called saved", async ({
  page,
  context,
}) => {
  await joinWithoutPlugin(page, context);
  await expect(page.getByText(joinedCopy.ledeWithoutPlugin)).toBeVisible();
  await page.getByRole("button", { name: "Light", exact: true }).click();

  await expect(page.getByText(joinedCopy.notSaved)).toBeVisible();
  await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText(/^Saved for/)).toHaveCount(0);
});

// The channel is off on this server, so the test answers its two calls in the browser.
// Every write loses its answer, as when the connection drops after the cell applied the
// level or before it did. The page reads the levels again and says what the cell holds.
test("a level save whose answer is lost reports what the cell holds", async ({
  page,
  context,
}) => {
  const held: CloudHomeLiveLevels["levels"] = {
    coding: { level: "balanced", source: "default" },
    conversation: { level: "balanced", source: "default" },
  };
  let revision = 1;
  let writeLands = true;
  await page.route("**/api/exomem/cloud/home/levels", async (route) => {
    if (route.request().method() === "PUT") {
      const { context: levelContext, level } = route.request().postDataJSON();
      if (writeLands) {
        held[levelContext as keyof typeof held] = { level, source: "preference:context" };
        revision += 1;
      }
      return route.abort("connectionreset");
    }
    const view: CloudHomeLiveLevels = {
      state: "live",
      revision: `r${revision}`,
      writable: true,
      locked_by: null,
      levels: held,
    };
    return route.fulfill({ json: view });
  });
  await joinWithoutPlugin(page, context);
  await expect(page.getByText(joinedCopy.ledeSaving)).toBeVisible();

  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.getByText(/^Saved for/)).toBeVisible();

  writeLands = false;
  await page.getByRole("button", { name: "Maximal", exact: true }).click();
  await expect(page.getByText(joinedCopy.notSaved)).toBeVisible();
  await expect(page.getByRole("button", { name: "Maximal", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

// A friend invitation for a new person: accepting it signs them in, and setup asks them to
// subscribe with the friend's price, never the usual one.
test("a friend's invitation leads to checkout at the friend price", async ({ page }) => {
  await seedCapacity();
  const { link } = await seedInvitation({
    email: uniqueEmail("friend"),
    kind: "friend",
    inviterName: "Alex",
  });

  await page.goto(link);
  await page.getByRole("button", { name: inviteCopy.accept }).click();

  await expect(page).toHaveURL(/\/exomem\/setup$/);
  await expect(page.getByText(subscribeCopy.friendLede("Alex", null))).toBeVisible();
  await expect(page.getByText(inviteCopy.price.friend("Alex"))).toBeVisible();
  await expect(page.getByText(inviteCopy.price.atCheckout)).toBeVisible();
});

// An owner on a paid plan answers a friend's invitation. Paddle cannot confirm the plan
// here (no friend discount is configured), so the server answers 503
// FRIEND_PRICE_UNAVAILABLE: the page says it did not finish, the answer can be given
// again, and the invitation stays usable.
test("an owner's answer that Paddle cannot confirm stays open to try again", async ({
  page,
  context,
}) => {
  const owner = await seedOwner("ready");
  await seedSubscription(owner);
  await context.addCookies(owner.cookies);
  const invitation = await seedInvitation({
    email: owner.email,
    kind: "friend",
    inviterName: "Alex",
  });

  await page.goto(invitation.link);
  await page.getByRole("button", { name: inviteCopy.existing.keep }).click();

  await expect(page.getByText(inviteCopy.existing.notFinished)).toBeVisible();
  await expect(page.getByRole("button", { name: inviteCopy.existing.keep })).toBeEnabled();
  expect(await invitationConsumed(invitation.id)).toBe(false);
});
