// Home's workflows, driven through the real routes against a real database. Each test
// makes its own owner, so the tests share nothing but the server. The cell and Brevo
// answer through the stand-ins in fake-cell.ts and fake-brevo.ts.

import { reviewerCopy, startCopy } from "../../src/app/exomem/_journey/copy";
import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";
import { digestSecret, generateExternalToken } from "../../src/lib/exomem-hosted/security";
import { EXOMEM_THEME_COOKIE_PREFIX } from "../../src/lib/exomem/theme-binding";
import {
  connectApp,
  createDeletionLink,
  createOwner,
  createReviewer,
  grantRevoked,
  issueExportLink,
  markExportReady,
  newestExport,
  type Owner,
  pool,
  setCell,
  signIn,
  tenantStatus,
  cellState,
  emailsTo,
  refuseEmailTo,
} from "./seed";
import { homeE2eEnvironment } from "./environment";
import { PENDING_TRANSACTION_KEY } from "@/components/PaddleTransactionOpener";

const DAY = 86_400_000;

async function openHome(page: Page, owner: Owner) {
  await signIn(page.context(), owner);
  await page.goto("/exomem/home");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`
    );
}

function panel(page: Page, title: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title }) });
}

// A worker runs tests from this file in any order, so the seed's pool closes once, when
// the worker stops, not after a group of tests.
const test = base.extend<object, { database: void }>({
  database: [
    async ({}, use) => {
      await use();
      await pool.end();
    },
    { scope: "worker", auto: true },
  ],
});

test("late HTML from the old account cannot replace the new account's first theme", async ({
  page,
  context,
}) => {
  const oldOwner = await createOwner();
  const newOwner = await createOwner();
  await pool.query("UPDATE exomem_tenants SET theme_choice = $2, email_scheme = $2 WHERE id = $1", [
    oldOwner.tenantId,
    "dark",
  ]);
  await pool.query("UPDATE exomem_tenants SET theme_choice = $2, email_scheme = $2 WHERE id = $1", [
    newOwner.tenantId,
    "light",
  ]);
  const token = generateExternalToken();
  await pool.query(
    `INSERT INTO exomem_access_tokens (
       purpose, token_digest, browser_challenge_digest, magic_link_generation,
       user_id, tenant_id, expires_at, delivery_state, delivered_at
     ) SELECT 'magic_link', $1, $2, magic_link_generation,
              owner_user_id, id, now() + interval '15 minutes', 'sent', now()
       FROM exomem_tenants WHERE id = $3`,
    [digestSecret(token), digestSecret(generateExternalToken()), newOwner.tenantId]
  );
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      (window as unknown as { themeAtBody: string | null }).themeAtBody =
        document.documentElement.getAttribute("data-theme");
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await signIn(context, oldOwner);
  await page.goto("/exomem/privacy");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const authPage = await context.newPage();
  await authPage.goto("/exomem/privacy");
  let releaseOld!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let readOld!: () => void;
  let readFailed!: (error: unknown) => void;
  const oldResponseReady = new Promise<void>((resolve, reject) => {
    readOld = resolve;
    readFailed = reject;
  });
  const heldUrl = (url: URL) =>
    url.pathname === "/exomem/privacy" && url.searchParams.get("held-theme") === oldOwner.tenantId;
  await page.route(heldUrl, async (route) => {
    try {
      // Node fetch has no browser cookie jar: only fulfillment delivers these real headers.
      const response = await fetch(route.request().url(), {
        headers: await route.request().allHeaders(),
        redirect: "manual",
      });
      const headers = Object.fromEntries(response.headers);
      headers["set-cookie"] = response.headers.getSetCookie().join("\n");
      delete headers["content-encoding"];
      delete headers["content-length"];
      const body = Buffer.from(await response.arrayBuffer());
      readOld();
      await released;
      await route.fulfill({ status: response.status, headers, body });
    } catch (error) {
      readFailed(error);
      await route.abort();
    }
  });
  const navigation = page.goto(`/exomem/privacy?held-theme=${oldOwner.tenantId}`);
  try {
    await oldResponseReady;
    const redeemed = await authPage.evaluate(
      async (input) => {
        const response = await fetch("/api/exomem/access/magic-link/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        return response.status;
      },
      { token, expectedEmail: newOwner.email }
    );
    expect(redeemed).toBe(200);
    await authPage.reload();
    await expect(authPage.locator("html")).toHaveAttribute("data-theme", "light");
    const newScope = await authPage.locator("html").getAttribute("data-theme-scope");
    expect(newScope).toBeTruthy();
    releaseOld();
    await navigation;
    await page.unroute(heldUrl);
    expect(
      await page.evaluate(() => (window as unknown as { themeAtBody: string | null }).themeAtBody)
    ).toBe("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme-scope", newScope!);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const account = await page.evaluate(async () => {
      const response = await fetch("/api/exomem/account");
      return response.json();
    });
    expect(account.account.email).toBe(newOwner.email);
    const loggedOut = await page.evaluate(async () => {
      const csrf = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("exomem_csrf="))!
        .slice("exomem_csrf=".length);
      const response = await fetch("/api/exomem/access/logout", {
        method: "POST",
        headers: { "x-exomem-csrf": csrf },
      });
      return response.status;
    });
    expect(loggedOut).toBe(200);
    expect(
      (await context.cookies()).filter((cookie) =>
        cookie.name.startsWith(EXOMEM_THEME_COOKIE_PREFIX)
      )
    ).toEqual([]);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme-scope", "");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  } finally {
    releaseOld();
    await navigation.catch(() => {});
    await page.unroute(heldUrl);
    await authPage.close();
  }
});

test("Home shows the account's own values and calls only routes a Cloud account has", async ({
  page,
}) => {
  const owner = await createOwner({
    nextBilledAt: new Date(Date.now() + 19 * DAY).toISOString(),
    storage: {
      usedBytes: 1_234_000_000,
      filesystemBytes: 10_000_000_000,
      observedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  });
  await connectApp(owner, { platform: "claude" });
  await connectApp(owner, { platform: "openai" });
  await setCell(owner, {
    noteCount: 11402,
    events: [{ client: "claude-code", action: "recalled", items: 4, at: new Date().toISOString() }],
  });
  const routes: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) routes.push(url.pathname);
  });

  await openHome(page, owner);

  await expect(page.getByRole("heading", { name: "Your memory is on" })).toBeVisible();
  await expect(page.getByText("11,402 notes", { exact: false })).toBeVisible();
  await expect(page.getByText(/Claude Code recalled 4 notes · \d+ s ago/)).toBeVisible();
  const nextPayment = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(
    new Date(Date.now() + 19 * DAY)
  );
  // The test server has no Paddle to preview the amount: the row shows the date alone,
  // with no number and no zero.
  await expect(page.getByText(`next payment ${nextPayment}`, { exact: true })).toBeVisible();
  await expect(page.getByText("1.2 of 10 GB")).toBeVisible();
  // Every route Home called reaches the account through Cloud, never a retired Hosted path.
  expect([...new Set(routes)].sort()).toEqual([
    "/api/exomem/account",
    "/api/exomem/account/preferences",
    "/api/exomem/apps",
    "/api/exomem/cloud/home/levels",
    "/api/exomem/cloud/home/live",
    "/api/exomem/status",
  ]);

  // Connecting both providers must not hide the packages needed on another device.
  await panel(page, "Connected apps").getByRole("button", { name: "Set up" }).click();
  await expect(page.getByRole("link", { name: "Download Claude ZIP" })).toHaveAttribute(
    "href",
    "https://github.com/Artexis10/exomem/releases/latest/download/exomem-cloud-claude.zip"
  );
  await expect(page.getByRole("link", { name: "Download ChatGPT ZIP" })).toHaveAttribute(
    "href",
    "https://github.com/Artexis10/exomem/releases/latest/download/exomem-cloud-openai.zip"
  );
});

test("new activity highlights only its authenticated app for three seconds", async ({ page }) => {
  const owner = await createOwner();
  const first = await connectApp(owner, { platform: "claude", name: "First connection" });
  const second = await connectApp(owner, { platform: "claude", name: "Second connection" });
  await setCell(owner, {
    noteCount: 2,
    events: [
      {
        app_id: first,
        client: "claude-ai",
        action: "recalled",
        items: 2,
        at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  });
  await page.clock.install();
  await openHome(page, owner);
  await expect(page.getByText(/First connection recalled 2 notes/)).toBeVisible();
  const firstRow = page.locator(`[data-app-id="${first}"]`);
  const secondRow = page.locator(`[data-app-id="${second}"]`);
  const firstGlyph = firstRow.locator('[aria-hidden="true"]');
  const secondGlyph = secondRow.locator('[aria-hidden="true"]');
  const restingBorder = await secondGlyph.evaluate(
    (element) => getComputedStyle(element).borderBottomColor
  );
  await expect(firstGlyph).toHaveCSS("border-bottom-color", restingBorder);
  await setCell(owner, {
    events: [
      {
        app_id: second,
        client: "claude-ai",
        action: "saved",
        items: 1,
        at: new Date().toISOString(),
      },
    ],
  });
  await page.clock.fastForward(30_000);
  await expect(page.getByText(/Second connection saved a note/)).toBeVisible();
  await expect(secondGlyph).not.toHaveCSS("border-bottom-color", restingBorder);
  await expect(secondGlyph).toHaveCSS("color", "rgb(255, 176, 0)");
  await expect(firstGlyph).toHaveCSS("border-bottom-color", restingBorder);
  await page.clock.fastForward(3_001);
  await expect(secondGlyph).toHaveCSS("border-bottom-color", restingBorder);
  await setCell(owner, {
    events: [
      {
        app_id: null,
        client: "claude-ai",
        action: "saved",
        items: 1,
        at: new Date(Date.now() + 1).toISOString(),
      },
    ],
  });
  await page.clock.fastForward(30_000);
  await expect(page.getByText(/Claude saved a note/)).toBeVisible();
  await expect(firstGlyph).toHaveCSS("border-bottom-color", restingBorder);
  await expect(secondGlyph).toHaveCSS("border-bottom-color", restingBorder);
});

test("disconnecting an app revokes its grant, and the app stays gone after a reload", async ({
  page,
}) => {
  const owner = await createOwner();
  const claude = await connectApp(owner, { platform: "claude" });
  const other = await connectApp(owner, { platform: "openai" });
  await openHome(page, owner);
  const apps = panel(page, "Connected apps");

  await apps.getByRole("button", { name: "Disconnect Claude", exact: true }).click();
  await expect(
    apps.getByText("It loses access until you connect it again.").filter({ visible: true })
  ).toBeVisible();
  await apps.getByRole("button", { name: "Disconnect Claude now" }).click();

  await expect(apps.getByText("disconnected · to use it again, connect from Claude")).toBeVisible();
  expect(await grantRevoked(claude)).toBe(true);
  expect(await grantRevoked(other)).toBe(false);
  await page.reload();
  await expect(apps.getByText("ChatGPT", { exact: true })).toBeVisible();
  await expect(apps.getByText("Claude", { exact: true })).toHaveCount(0);
});

test("a level set on Home reaches the cell and is still set after a reload", async ({ page }) => {
  const owner = await createOwner();
  await openHome(page, owner);
  const chat = page.getByRole("group", { name: "How much Exomem joins in for chat apps" });

  await chat.getByRole("button", { name: "Light" }).click();

  await expect(chat.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  expect((await cellState(owner)).levels.conversation.level).toBe("light");
  await page.reload();
  await expect(chat.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
});

test("a level changed elsewhere meets a conflict, and Home shows the level in use", async ({
  page,
}) => {
  const owner = await createOwner();
  await openHome(page, owner);
  const coding = page.getByRole("group", { name: "How much Exomem joins in for coding agents" });
  await expect(coding.getByRole("button", { name: "Balanced" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  // The assistant sets coding agents to Off while this page still shows the old revision.
  await setCell(owner, {
    revision: 5,
    levels: {
      coding: { level: "off", source: "preference:context" },
      conversation: { level: "maximal", source: "default" },
    },
  });

  await coding.getByRole("button", { name: "Maximal" }).click();

  await expect(coding.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("This changed elsewhere a moment ago.")).toBeVisible();
  expect((await cellState(owner)).levels.coding.level).toBe("off");
});

test("an export packs, becomes ready, and Download follows a fresh link", async ({ page }) => {
  const owner = await createOwner();
  await openHome(page, owner);
  const data = panel(page, "Your data");
  // A running account is told before it starts that its assistants pause.
  await expect(
    data.getByText("Your assistants pause for a few minutes while we pack it.", { exact: false })
  ).toBeVisible();

  await data.getByRole("button", { name: "Export", exact: true }).click();

  await expect(
    data.getByText("Your assistants are back in a few minutes.", { exact: false })
  ).toBeVisible();
  const requested = await newestExport(owner);
  expect(requested?.observed_state).toBeNull();

  // cellctl packs it; the page shows the time limit from the row's own times.
  await markExportReady(requested!.export_id, 24);
  await page.reload();
  await expect(data.getByText(/^kept 24 h, until /)).toBeVisible();

  // The server hands out only an https link, as the object store's is; the browser's
  // route answers it here.
  const downloadUrl = `https://exports.example.test/${requested!.export_id}.zip`;
  await page.route(downloadUrl, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-disposition": 'attachment; filename="exomem.zip"' },
      body: "PK",
    })
  );
  const download = page.waitForEvent("download");
  await data.getByRole("button", { name: "Download" }).click();
  // cellctl answers the link request that the click made, as it does in production.
  await expect.poll(async () => (await newestExport(owner))?.link_requested_at).not.toBeNull();
  await issueExportLink(requested!.export_id, downloadUrl);
  expect((await download).url()).toBe(downloadUrl);
});

test("an unowned checkout return offers sign-in recovery and a return to Home", async ({
  page,
}) => {
  // An owner who already pays returns from an old checkout link; the server refuses it.
  const owner = await createOwner();
  await signIn(page.context(), owner);
  await page.goto("/exomem/home");
  await expect(page.getByRole("heading", { name: "Your memory is on" })).toBeVisible();
  const transactionId = `txn_${"a".repeat(26)}`;
  await page.evaluate(
    ({ key, transactionId }) => {
      window.sessionStorage.setItem(key, transactionId);
      window.sessionStorage.setItem("checkout-test-sentinel", "keep");
    },
    { key: PENDING_TRANSACTION_KEY, transactionId }
  );
  await page.reload();

  const failure = page.getByRole("heading", { name: "Sign in again to continue", exact: true });
  await expect(failure).toBeVisible();
  await expect(
    page.getByText("This does not change any payment Paddle received.", { exact: false })
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("_ptxn")).toBe(true);
  await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home", exact: true }).click();
  await expect(failure).toBeHidden();
  expect(new URL(page.url()).searchParams.has("_ptxn")).toBe(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your memory is on" })).toBeVisible();
  await expect(failure).toBeHidden();
  expect(
    await page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_TRANSACTION_KEY)
  ).toBeNull();
  expect(await page.evaluate(() => window.sessionStorage.getItem("checkout-test-sentinel"))).toBe(
    "keep"
  );
});

test("a confirmation email that cannot be sent deletes nothing, and Home says so", async ({
  page,
}) => {
  const owner = await createOwner();
  await refuseEmailTo(owner);
  await openHome(page, owner);

  await panel(page, "Your data").getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your Exomem?" });
  await dialog.getByRole("button", { name: "Email me a confirmation link" }).click();

  await expect(dialog.getByRole("alert")).toHaveText("That didn’t finish. Try again in a minute.");
  expect(await tenantStatus(owner)).toBe("active");
  expect(await emailsTo(owner)).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("Delete emails a link, and the link deletes only after the owner confirms", async ({
  page,
}) => {
  const owner = await createOwner({ plan: "complimentary" });
  await openHome(page, owner);

  await panel(page, "Your data").getByRole("button", { name: "Delete…" }).click();
  await page
    .getByRole("dialog", { name: "Delete your Exomem?" })
    .getByRole("button", { name: "Email me a confirmation link" })
    .click();

  // The minutes come from the link's expiry that the server returns.
  const sent = page.getByRole("dialog", { name: "Check your email" });
  await expect(sent.getByText("It works for 15 minutes.", { exact: false })).toBeVisible();
  const [email] = await emailsTo(owner);
  // The email links to the configured public origin; the test opens the same path here.
  const link = email.textContent.match(/https:\/\/app\.example\.test(\/exomem\/delete#[\w-]+)/);
  expect(link).not.toBeNull();
  await page.goto(link![1]);
  await expect(page.getByText("There is no undo after you confirm.")).toBeVisible();
  // Opening the link reads the token from the address and clears it; nothing is deleted yet.
  expect(new URL(page.url()).hash).toBe("");
  expect(await tenantStatus(owner)).toBe("active");

  await page.getByRole("button", { name: "Permanently delete my Exomem" }).click();

  await expect(page.getByRole("status")).toHaveText(
    "Your shared Substrate identity and any other product remain untouched."
  );
  // A complimentary account has no billing to cancel, so deletion may already be finished.
  expect(["deletion_pending", "deleted"]).toContain(await tenantStatus(owner));
});

test("a seeded reviewer signs in on the web and sees the sample account without billing or delete", async ({
  page,
}) => {
  // The two projects run at once, and each provider allows one active reviewer.
  const reviewer = await createReviewer(
    test.info().project.name.includes("phone") ? "openai" : "anthropic"
  );
  await connectApp(reviewer, { platform: "claude" });
  await setCell(reviewer, { noteCount: 40 });

  await page.goto("/exomem/sign-in");
  await page.getByRole("button", { name: startCopy.reviewerLink }).click();
  await page.getByLabel(reviewerCopy.username).fill(reviewer.username);
  await page.getByLabel(reviewerCopy.password).fill(reviewer.password);
  await page.getByRole("button", { name: reviewerCopy.primary }).click();
  await expect(page).toHaveURL(/\/exomem\/home$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const ends = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(
    new Date(Date.now() + 20 * DAY)
  );
  await expect(page.getByText(/^Sample account · 40 example notes/)).toBeVisible();
  await expect(
    page.getByText(`It holds sample notes only and ends on ${ends}.`, { exact: false })
  ).toBeVisible();
  await expect(page.getByText(`complimentary · ends ${ends}`)).toBeVisible();
  await expect(
    panel(page, "Connected apps").getByText(/^connected \d{1,2} \w+ · during review$/)
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /billing/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete…" })).toHaveCount(0);
  await expect(
    page.getByText("Not on a reviewer account. We delete it when the review ends.")
  ).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  test(`Home and the delete page in ${theme} have no serious accessibility violations, and Home holds still under reduced motion`, async ({
    page,
  }) => {
    const owner = await createOwner({
      storage: {
        usedBytes: 8_600_000_000,
        filesystemBytes: 10_000_000_000,
        observedAt: new Date().toISOString(),
      },
    });
    await connectApp(owner, { platform: "claude" });
    await setCell(owner, {
      noteCount: 12,
      events: [{ client: "claude-ai", action: "saved", items: 1, at: new Date().toISOString() }],
    });
    await page.addInitScript((value) => window.localStorage.setItem("exomem-theme", value), theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openHome(page, owner);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    // A disconnected app's row is drawn dimmed; it must still read at AA.
    const apps = panel(page, "Connected apps");
    await apps.getByRole("button", { name: "Disconnect Claude", exact: true }).click();
    await apps.getByRole("button", { name: "Disconnect Claude now" }).click();
    await expect(apps.getByText(/^disconnected · /)).toBeVisible();
    await apps.getByRole("button", { name: "Set up" }).click();
    await expect(page.getByText("Add this address")).toBeVisible();
    // The address is the one the server configures, never one Home builds.
    await expect(apps.getByRole("group", { name: /connector or MCP settings/ })).toContainText(
      homeE2eEnvironment().mcpUrl
    );

    expect(await seriousViolations(page)).toEqual([]);

    // Reduced motion means no motion: the lit web, the mark and the live dot stand still.
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .filter((element) => getComputedStyle(element).animationName !== "none")
        .map((element) => element.getAttribute("class") ?? element.tagName)
    );
    expect(moving).toEqual([]);

    await page.goto(`/exomem/delete#${await createDeletionLink(owner)}`);
    await expect(page.getByRole("button", { name: "Permanently delete my Exomem" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}
