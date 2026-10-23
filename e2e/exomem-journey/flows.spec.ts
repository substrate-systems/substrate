// The journey as people walk it, against the real server and its database: a new person
// from their email to checkout, a returning owner's emailed link, an app's consent
// answered both ways, and setup noticing the app that just connected. Only Cloudflare
// (its documented test keys) and the apps' own callback pages stand in for the outside
// world.

import type { BrowserContext, Page } from "@playwright/test";
import type { CloudHomeLiveLevels } from "../../src/lib/exomem-hosted/cloud-home-mcp";
import { AFTER_CONNECT_MS, expect, test } from "./fixtures";
import {
  breakCopy,
  chooseCopy,
  claimCopy,
  consentCopy,
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
  expireOwnerSession,
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

// Keep failed exchanges and their retries so transport failures remain diagnosable.
test.use({ trace: "retain-on-failure-and-retries" });

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
  // No provider serves example.test, so a phone offers its own mail app.
  if (test.info().project.use.isMobile)
    await expect(page.getByRole("link", { name: "Open your email app ↗" })).toHaveAttribute(
      "href",
      /^intent:/
    );

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
  await expect(page).toHaveURL(/\/exomem\/home$/);

  // The same link pasted into the first tab: spent, with one browser-bound resend.
  await page.goto(link);
  await page.getByRole("button", { name: CONTINUE_SIGN_IN }).click();
  // The page took the token out of the address bar before anything else.
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.getByRole("heading", { name: "This link was already used" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Email me a new link", exact: true })
  ).toBeVisible();
  await expect(page.getByLabel(startCopy.emailLabel)).toHaveCount(0);
});

test("an existing session opens Home without requesting another sign-in email", async ({
  page,
  context,
}) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  const starts: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/exomem/access/start") starts.push(request.url());
  });

  await page.goto("/exomem/sign-in");
  await expect(page).toHaveURL(/\/exomem\/home$/);
  expect(starts).toEqual([]);
  const account = await (await page.request.get("/api/exomem/account")).json();
  expect(account.account.email).toBe(owner.email);
});

test("an expired server session keeps the email sign-in form usable", async ({ page, context }) => {
  const owner = await seedOwner("ready");
  await expireOwnerSession(owner);
  await context.addCookies(owner.cookies);

  await page.goto("/exomem/sign-in");
  await expect(page.getByLabel(startCopy.emailLabel)).toBeVisible();
  await expect(page.getByRole("button", { name: startCopy.web.primary })).toBeEnabled();
  expect((await page.request.get("/api/exomem/account")).status()).toBe(401);
});

test("an existing session does not skip confirmation of another account's email link", async ({
  page,
  context,
}) => {
  const current = await seedOwner("ready");
  const next = await seedOwner("ready");
  await startWithEmail(page, next.email);
  const link = await signInLinkFor(next.email);
  await context.addCookies(current.cookies);

  await page.goto(link);
  await expect(page.getByRole("button", { name: CONTINUE_SIGN_IN })).toBeVisible();
  const before = await (await page.request.get("/api/exomem/account")).json();
  expect(before.account.email).toBe(current.email);

  await page.getByRole("button", { name: CONTINUE_SIGN_IN }).click();
  await expect(page).toHaveURL(/\/exomem\/home$/);
  const after = await (await page.request.get("/api/exomem/account")).json();
  expect(after.account.email).toBe(next.email);
});

test("Change returns to the submitted address and focuses its field", async ({ page }) => {
  const email = uniqueEmail("correct-address");
  await startWithEmail(page, email);
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(page.getByLabel(startCopy.emailLabel)).toHaveValue(email);
  await expect(page.getByLabel(startCopy.emailLabel)).toBeFocused();
});

test("a forged tab notification cannot advance a different signed-in account", async ({
  page,
  context,
}) => {
  const expected = await seedOwner("ready");
  const other = await seedOwner("ready");
  await startWithEmail(page, expected.email);
  await context.addCookies(other.cookies);
  // Observe a new request: the sent view's unauthenticated poll can still be in flight.
  const checked = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/exomem/access/session" &&
      request.method() === "POST"
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "exomem-access-session",
        newValue: JSON.stringify({ email: "invented@example.test", destination: "/exomem/home" }),
      })
    )
  );
  const response = await (await checked).response();
  expect(response?.status()).toBe(200);
  expect(await response!.json()).toEqual({ authenticated: false });
  await expect(page.getByRole("heading", { name: sentCopy.title })).toBeVisible();
});

test("a replaced app request cannot advance the original waiting tab", async ({
  page,
  context,
}) => {
  const owner = await seedOwner("ready");
  const client = await seedClient({
    name: "Journey Waiting App",
    redirectUri: "https://waiting-app.example.test/callback",
    platform: null,
  });
  await page.goto(authorizeRequest(client).url);
  await page.getByLabel(startCopy.emailLabel).fill(owner.email);
  await page.getByRole("button", { name: startCopy.app(client.name).primary }).click();
  await expect(page.getByRole("heading", { name: sentCopy.title })).toBeVisible();
  const replacement = await context.newPage();
  await replacement.goto(authorizeRequest(client).url);
  await context.addCookies(owner.cookies);
  // Read the post-cookie exchange rather than an older unauthenticated poll.
  const checked = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/exomem/access/session" &&
      request.method() === "POST"
  );
  await page.evaluate(() =>
    window.dispatchEvent(new StorageEvent("storage", { key: "exomem-access-session" }))
  );
  const response = await (await checked).response();
  expect(response?.status()).toBe(200);
  expect(await response!.json()).toEqual({ authenticated: true, destination: null });
  await expect(page.getByRole("heading", { name: sentCopy.title })).toBeVisible();
  await replacement.close();
});

test("a denied theme save stays visible and does not claim an account preference", async ({
  page,
  context,
}) => {
  const owner = await seedOwner("ready");
  await context.addCookies(owner.cookies);
  await page.goto("/exomem/home", { waitUntil: "networkidle" });
  await page.route("**/api/exomem/account/preferences", (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "FORBIDDEN", message: "The theme was not saved." } },
    })
  );
  await page.getByRole("button", { name: "Theme: Auto", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page.getByRole("alert").filter({ hasText: "The theme was not saved." })
  ).toBeVisible();
  await page.unroute("**/api/exomem/account/preferences");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme-choice", "auto");
});

test("a session answer from before Change cannot advance the corrected form", async ({ page }) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/exomem/access/session", async (route) => {
    requested?.();
    await held;
    await route
      .fulfill({ json: { authenticated: true, destination: "/exomem/home" } })
      .catch(() => {});
  });
  const email = uniqueEmail("stale-answer");
  await startWithEmail(page, email);
  await reached;
  await page.getByRole("button", { name: "Change", exact: true }).click();
  release?.();
  await expect(page.getByLabel(startCopy.emailLabel)).toHaveValue(email);
  await expect(page.getByRole("heading", { name: startCopy.web.title })).toBeVisible();
});

test("a link opened in another browser checks email and signs in only that browser", async ({
  page,
  browser,
}) => {
  const owner = await seedOwner("ready");
  await startWithEmail(page, owner.email);
  const link = await signInLinkFor(owner.email);
  const completing = await browser.newContext({ baseURL: process.env.EXOMEM_E2E_BASE_URL });
  try {
    const opened = await completing.newPage();
    await opened.goto(link);
    await expect.poll(() => new URL(opened.url()).hash).toBe("");
    expect((await completing.cookies()).some((cookie) => cookie.name === "exomem_session")).toBe(
      false
    );
    await expect(opened.getByLabel(startCopy.emailLabel)).toHaveCount(0);
    await opened.getByRole("button", { name: CONTINUE_SIGN_IN }).click();
    await opened.getByLabel(startCopy.emailLabel).fill("other@example.test");
    await opened.getByRole("button", { name: CONTINUE_SIGN_IN }).click();
    await expect(
      opened.getByText("We couldn’t sign you in. Check your email address or request a new link.", {
        exact: true,
      })
    ).toBeVisible();
    expect((await completing.cookies()).some((cookie) => cookie.name === "exomem_session")).toBe(
      false
    );
    await opened.getByLabel(startCopy.emailLabel).fill(owner.email);
    await opened.getByRole("button", { name: CONTINUE_SIGN_IN }).click();
    await expect(opened).toHaveURL(/\/exomem\/home$/);
    await opened.reload();
    await expect(opened).toHaveURL(/\/exomem\/home$/);
    expect((await completing.cookies()).some((cookie) => cookie.name === "exomem_session")).toBe(
      true
    );
    expect(
      (await page.context().cookies()).some((cookie) => cookie.name === "exomem_session")
    ).toBe(false);
  } finally {
    await completing.close();
  }
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

for (const reducedMotion of ["no-preference", "reduce"] as const)
  test(`Connect preserves its full completion before handing back (${reducedMotion})`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ reducedMotion });
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
    const completed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/exomem/oauth/authorize/complete"
    );
    await page.getByRole("button", { name: consentCopy.connect, exact: true }).click();
    expect((await completed).status()).toBe(200);
    expect(await grantCount(client)).toBe(1);
    if (reducedMotion === "no-preference") {
      await expect(
        page.getByRole("button", { name: consentCopy.connecting, exact: true })
      ).toBeVisible();
      // The answer came at once, yet the page says it connected only after the whole
      // field has lit: when its last note or link finishes, not when the tiles do.
      const { lighting, fieldLit, connectedAt } = await page.evaluate(async (title) => {
        const field = document.querySelector("main svg[data-alive-key]")!;
        const ends = field.getAnimations({ subtree: true }).map((animation) => {
          const timing = animation.effect!.getComputedTiming();
          return Number(timing.endTime) - Number(timing.localTime ?? 0);
        });
        const lit = performance.now() + Math.max(...ends);
        const at = await new Promise<number>((resolve) => {
          const look = () =>
            [...document.querySelectorAll("h1")].some((h) => h.textContent?.includes(title))
              ? resolve(performance.now())
              : requestAnimationFrame(look);
          look();
        });
        return { lighting: ends.length, fieldLit: lit, connectedAt: at };
      }, handbackCopy.title);
      expect(lighting).toBeGreaterThan(0);
      expect(connectedAt).toBeGreaterThanOrEqual(fieldLit - 50);
    }

    await expect(page.getByRole("heading", { name: handbackCopy.title })).toBeVisible({
      timeout: AFTER_CONNECT_MS,
    });
    // Wait for the visible mark's finite completion animations, not a guessed wall-clock delay.
    await page
      .getByRole("img", { name: "Exomem", exact: true })
      .last()
      .evaluate(async (element) => {
        const finite = element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
        await Promise.allSettled(finite.map((animation) => animation.finished));
      });
    expect(reached).toHaveLength(0);
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
  ).toBeVisible({ timeout: AFTER_CONNECT_MS });
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
  ).toBeVisible({ timeout: AFTER_CONNECT_MS });
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
    page.getByText(consentCopy.footer("lookalike.example.test"), { exact: true })
  ).toBeVisible();
  await expect(page.getByText(claimCopy("Claude"), { exact: true })).toBeVisible();
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
    timeout: AFTER_CONNECT_MS,
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

  await expect(page.getByRole("heading", { name: joinedCopy.title("Claude Code") })).toBeVisible({
    timeout: AFTER_CONNECT_MS,
  });
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

  await expect(page.getByText(joinedCopy.notSaved, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByText(/^Saved for/)).toHaveCount(0);
});

// The channel is off on this server, so the test answers its two calls in the browser.
// Every write loses its answer, as when the connection drops after the cell applied the
// level or before it did. The page reads the levels again and says what the cell holds.
test("a level save whose answer is lost reports what the cell holds", async ({ page, context }) => {
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
  await expect(page.getByText(joinedCopy.notSaved, { exact: true })).toBeVisible();
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
  await expect(page.getByText("Alex’s friend price", { exact: true })).toBeVisible();
  await expect(page.getByText("Due today", { exact: true })).toBeVisible();
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

  await expect(page.getByText(inviteCopy.existing.notFinished, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: inviteCopy.existing.keep })).toBeEnabled();
  expect(await invitationConsumed(invitation.id)).toBe(false);
});
