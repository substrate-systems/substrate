import { randomUUID } from "node:crypto";
import { expect, test as base, type Page } from "@playwright/test";
import { homeE2eEnvironment } from "./environment";
import { connectApp, createOwner, emailsTo, grantRevoked, pool, signIn, type Owner } from "./seed";

const test = base.extend<object, { database: void }>({
  database: [
    async ({}, use) => {
      await use();
      await pool.end();
    },
    { scope: "worker", auto: true },
  ],
});

function accountPanel(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "Plan and account", exact: true }),
  });
}

async function canonicalEmail(owner: Owner): Promise<string> {
  const { rows } = await pool.query("SELECT email::text FROM exomem_users WHERE id = $1", [
    owner.userId,
  ]);
  return rows[0].email;
}

async function changeCounts(owner: Owner) {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM exomem_email_changes WHERE tenant_id = $1) AS pending,
            (SELECT count(*)::int FROM exomem_email_outbox WHERE tenant_id = $1
               AND kind IN ('email_change_confirmation', 'email_change_cancellation')) AS emails`,
    [owner.tenantId]
  );
  return rows[0] as { pending: number; emails: number };
}

/** These two kinds and action labels are fixed by the email-change contract. */
async function requestEmails(owner: Owner, requestId: string) {
  const { rows } = await pool.query(
    `SELECT kind, recipient, state FROM exomem_email_outbox
      WHERE tenant_id = $1 AND dedupe_key IN (
        'email_change_confirmation:' || $2, 'email_change_cancellation:' || $2
      ) ORDER BY kind`,
    [owner.tenantId, requestId]
  );
  return rows;
}

/** The renderer writes each action as "label: URL"; other lifecycle mail has no such action. */
async function deliveredActions(owner: Owner, label: string): Promise<string[]> {
  const prefix = `${label}: `;
  return (await emailsTo(owner)).flatMap((email) => {
    const line = email.textContent.split("\n").find((line) => line.startsWith(prefix));
    if (!line) return [];
    const link = new URL(line.slice(prefix.length));
    // Keep the actual delivered path and capability on the isolated server.
    return [
      new URL(`${link.pathname}${link.search}${link.hash}`, homeE2eEnvironment().baseUrl).href,
    ];
  });
}

test("email confirmation changes the canonical address only after an explicit action", async ({
  page,
}) => {
  const owner = await createOwner();
  const grant = await connectApp(owner, { platform: "claude" });
  const proposed = `confirmed-${randomUUID()}@example.test`;
  const sharedBefore = (await pool.query("SELECT * FROM users WHERE id = $1", [owner.userId])).rows;
  const sessionsBefore = (
    await pool.query(
      "SELECT id, user_id, tenant_id, expires_at, revoked_at FROM exomem_sessions WHERE tenant_id = $1 ORDER BY id",
      [owner.tenantId]
    )
  ).rows;
  await signIn(page.context(), owner);
  const levels = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/exomem/cloud/home/levels" &&
      response.request().method() === "GET"
  );
  const activity = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/exomem/cloud/home/live" &&
      response.request().method() === "GET"
  );
  await page.goto("/exomem/home");
  expect((await levels).ok()).toBe(true);
  expect((await activity).ok()).toBe(true);
  // Home creates its own grant during these reads; compare the settled authority before changing email.
  const grantsBefore = (
    await pool.query(
      "SELECT id, user_id, tenant_id, client_id, resource, scopes, revoked_at FROM exomem_oauth_grants WHERE tenant_id = $1 ORDER BY id",
      [owner.tenantId]
    )
  ).rows;
  const change = accountPanel(page).getByRole("button", { name: "Change", exact: true });
  await change.focus();
  await change.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(change).toBeFocused();
  await change.press("Enter");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(change).toBeFocused();
  expect(await changeCounts(owner)).toEqual({ pending: 0, emails: 0 });
  await change.press("Enter");
  await expect(accountPanel(page).getByText("Checking email status…", { exact: true })).toHaveCount(
    0
  );
  await page.getByRole("dialog").getByLabel("New email", { exact: true }).fill(proposed);
  const requested = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/exomem/account/email-change" &&
      response.request().method() === "POST"
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send the links", exact: true })
    .click();
  const response = await requested;
  expect(response.status()).toBe(202);
  const request = await response.json();
  expect(request).toMatchObject({ success: true, state: "pending", delivery: "queued" });
  const queued = page.getByRole("dialog", { name: "Check both inboxes" });
  // Another worker may already deliver the request; the POST above proves that it queued.
  await expect(queued.getByText(proposed, { exact: false })).toBeVisible();
  expect(
    (await requestEmails(owner, request.requestId)).map(({ kind, recipient }) => ({
      kind,
      recipient,
    }))
  ).toEqual([
    { kind: "email_change_cancellation", recipient: owner.email },
    { kind: "email_change_confirmation", recipient: proposed },
  ]);
  expect(await canonicalEmail(owner)).toBe(owner.email);

  const environment = homeE2eEnvironment();
  const delivered = await page.request.get("/api/cron/exomem-access-delivery", {
    headers: { authorization: `Bearer ${environment.schedulerSecret}` },
  });
  expect(delivered.ok()).toBe(true);
  await expect
    .poll(() => requestEmails(owner, request.requestId))
    .toEqual([
      { kind: "email_change_cancellation", recipient: owner.email, state: "sent" },
      { kind: "email_change_confirmation", recipient: proposed, state: "sent" },
    ]);
  await expect
    .poll(() => deliveredActions({ ...owner, email: proposed }, "Confirm this address"))
    .toHaveLength(1);
  await expect.poll(() => deliveredActions(owner, "Stop the change")).toHaveLength(1);
  await expect(
    queued.getByText(`Open the link we sent to ${proposed}`, { exact: false })
  ).toBeVisible({ timeout: 15_000 });
  const confirmation = (
    await deliveredActions({ ...owner, email: proposed }, "Confirm this address")
  )[0];
  expect(new URL(confirmation).pathname).toBe("/exomem/email-change/confirm");
  const preview = await page.request.get(confirmation);
  expect(preview.ok()).toBe(true);
  expect(await canonicalEmail(owner)).toBe(owner.email);
  await page.goto(confirmation);
  await expect(
    page.getByRole("heading", { name: "Confirm your new email", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(owner.email);
  await page.getByRole("button", { name: "Confirm this address", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your email has changed", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(proposed);
  expect((await pool.query("SELECT * FROM users WHERE id = $1", [owner.userId])).rows).toEqual(
    sharedBefore
  );
  expect(
    (
      await pool.query(
        "SELECT id, user_id, tenant_id, expires_at, revoked_at FROM exomem_sessions WHERE tenant_id = $1 ORDER BY id",
        [owner.tenantId]
      )
    ).rows
  ).toEqual(sessionsBefore);
  expect(
    (
      await pool.query(
        "SELECT id, user_id, tenant_id, client_id, resource, scopes, revoked_at FROM exomem_oauth_grants WHERE tenant_id = $1 ORDER BY id",
        [owner.tenantId]
      )
    ).rows
  ).toEqual(grantsBefore);
  expect(await grantRevoked(grant)).toBe(false);
  const account = await page.request.get("/api/exomem/account");
  expect(account.ok()).toBe(true);
  expect((await account.json()).account.email).toBe(proposed);
  await page.goto("/exomem/home");
  await expect(accountPanel(page).getByText(proposed, { exact: true })).toBeVisible();
  await page.goto(confirmation);
  const replay = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/exomem/account/email-change/confirm"
  );
  await page.getByRole("button", { name: "Confirm this address", exact: true }).click();
  expect((await replay).status()).toBe(401);
  await expect(
    page.getByRole("heading", { name: "This link no longer works", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(proposed);
});

test("the old inbox stops a pending change, closes its Home dialog and reveals no replay state", async ({
  page,
}) => {
  const owner = await createOwner();
  const proposed = `cancelled-${randomUUID()}@example.test`;
  await signIn(page.context(), owner);
  await page.goto("/exomem/home");
  await accountPanel(page).getByRole("button", { name: "Change", exact: true }).click();
  await expect(accountPanel(page).getByText("Checking email status…", { exact: true })).toHaveCount(
    0
  );
  await page.getByRole("dialog").getByLabel("New email", { exact: true }).fill(proposed);
  const requested = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/exomem/account/email-change" &&
      response.request().method() === "POST"
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send the links", exact: true })
    .click();
  const response = await requested;
  expect(response.status()).toBe(202);
  const request = await response.json();
  expect(request).toMatchObject({ success: true, state: "pending", delivery: "queued" });
  const queued = page.getByRole("dialog", { name: "Check both inboxes" });
  await expect(queued).toBeVisible();
  const environment = homeE2eEnvironment();
  const delivered = await page.request.get("/api/cron/exomem-access-delivery", {
    headers: { authorization: `Bearer ${environment.schedulerSecret}` },
  });
  expect(delivered.ok()).toBe(true);
  await expect
    .poll(() => requestEmails(owner, request.requestId))
    .toEqual([
      { kind: "email_change_cancellation", recipient: owner.email, state: "sent" },
      { kind: "email_change_confirmation", recipient: proposed, state: "sent" },
    ]);
  await expect.poll(() => deliveredActions(owner, "Stop the change")).toHaveLength(1);
  const cancellation = (await deliveredActions(owner, "Stop the change"))[0];
  expect(new URL(cancellation).pathname).toBe("/exomem/email-change/cancel");
  const cancellationPage = await page.context().newPage();
  await cancellationPage.goto(cancellation);
  await expect(
    cancellationPage.getByRole("heading", { name: "Stop this email change?", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(owner.email);
  expect((await changeCounts(owner)).pending).toBe(1);
  await cancellationPage.getByRole("button", { name: "Stop the change", exact: true }).click();
  await expect(
    cancellationPage.getByRole("heading", { name: "Email change stopped", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(owner.email);
  expect((await changeCounts(owner)).pending).toBe(0);
  await page.bringToFront();
  await expect(queued).toHaveCount(0, { timeout: 15_000 });
  await expect(accountPanel(page).getByText(owner.email, { exact: true })).toBeVisible();
  await cancellationPage.close();
  const account = await page.request.get("/api/exomem/account");
  expect(account.ok()).toBe(true);
  expect((await account.json()).account.email).toBe(owner.email);
  await page.goto(cancellation);
  const replay = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/exomem/account/email-change/cancel"
  );
  await page.getByRole("button", { name: "Stop the change", exact: true }).click();
  expect((await replay).status()).toBe(401);
  await expect(
    page.getByRole("heading", { name: "This link no longer works", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(owner.email);
});

test("a draft from account A cannot queue links for account B after a session switch", async ({
  page,
}) => {
  const original = await createOwner();
  const other = await createOwner();
  const before = await changeCounts(other);
  await page.clock.install();
  await signIn(page.context(), original);
  await page.goto("/exomem/home");
  await accountPanel(page).getByRole("button", { name: "Change", exact: true }).click();
  await expect(accountPanel(page).getByText("Checking email status…", { exact: true })).toHaveCount(
    0
  );
  const draft = page.getByRole("dialog").getByLabel("New email", { exact: true });
  await draft.fill(`wrong-account-${randomUUID()}@example.test`);
  // Keep the periodic cookie check from preempting the form's own stale-draft refusal.
  const frozenAt = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(frozenAt);
  await page.clock.pauseAt(frozenAt);
  await signIn(page.context(), other);
  await draft.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(accountPanel(page).getByText(other.email, { exact: true })).toBeVisible();
  expect(await changeCounts(other)).toEqual(before);
  expect(await changeCounts(original)).toEqual({ pending: 0, emails: 0 });
  expect(await canonicalEmail(other)).toBe(other.email);
});

test("a held account A response cannot replace an accepted account B view", async ({ page }) => {
  const original = await createOwner();
  const other = await createOwner();
  await page.clock.install();
  await signIn(page.context(), original);
  await page.goto("/exomem/home");
  await expect(accountPanel(page).getByText(original.email, { exact: true })).toBeVisible();
  await expect(accountPanel(page).getByText("Checking email status…", { exact: true })).toHaveCount(
    0
  );
  let held!: () => void;
  const reached = new Promise<void>((resolve) => {
    held = resolve;
  });
  await page.exposeBinding("__accountResponseHeld", () => {
    held();
  });
  await page.evaluate(() => {
    const browser = window as typeof window & {
      __accountResponseHeld: () => Promise<void>;
      __releaseAccountResponse?: () => void;
    };
    const nativeFetch = window.fetch.bind(window);
    let first = true;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        url.origin === location.origin &&
        url.pathname === "/api/exomem/account" &&
        method === "GET" &&
        first
      ) {
        first = false;
        const response = await nativeFetch(input, init);
        await new Promise<void>((resolve) => {
          browser.__releaseAccountResponse = resolve;
          void browser.__accountResponseHeld();
        });
        return response;
      }
      return nativeFetch(input, init);
    };
  });
  await page.clock.fastForward(31_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await reached;
  await signIn(page.context(), other);
  await page.clock.fastForward(31_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(accountPanel(page).getByText(other.email, { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    (window as typeof window & { __releaseAccountResponse: () => void }).__releaseAccountResponse();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  });
  await expect(accountPanel(page).getByText(other.email, { exact: true })).toBeVisible();
  await expect(accountPanel(page).getByText(original.email, { exact: true })).toHaveCount(0);
  const account = await page.request.get("/api/exomem/account");
  expect(account.ok()).toBe(true);
  expect((await account.json()).account.email).toBe(other.email);
  expect(await changeCounts(other)).toEqual({ pending: 0, emails: 0 });
});

test("the server rejects A's frozen nonce when B's cookies reach native fetch", async ({
  page,
}) => {
  const original = await createOwner();
  const other = await createOwner();
  const before = await changeCounts(other);
  await page.clock.install();
  await signIn(page.context(), original);
  await page.goto("/exomem/home");
  await accountPanel(page).getByRole("button", { name: "Change", exact: true }).click();
  await expect(accountPanel(page).getByText("Checking email status…", { exact: true })).toHaveCount(
    0
  );
  const draft = page.getByRole("dialog").getByLabel("New email", { exact: true });
  await draft.fill(`native-race-${randomUUID()}@example.test`);
  const frozenAt = await page.evaluate(() => Date.now());
  await page.clock.setFixedTime(frozenAt);
  await page.clock.pauseAt(frozenAt);
  let paused!: () => void;
  const reached = new Promise<void>((resolve) => {
    paused = resolve;
  });
  await page.exposeBinding("__emailChangePaused", () => {
    paused();
  });
  await page.evaluate(() => {
    const browser = window as typeof window & {
      __emailChangePaused: () => Promise<void>;
      __releaseEmailChange?: () => void;
      __emailChangeBoundary?: { originalHeader: boolean; changedCookie: boolean };
    };
    const nativeFetch = window.fetch.bind(window);
    const csrf = () =>
      document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("exomem_csrf="))
        ?.slice("exomem_csrf=".length);
    const originalCsrf = csrf();
    let first = true;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        url.origin === location.origin &&
        url.pathname === "/api/exomem/account/email-change" &&
        method === "POST" &&
        first
      ) {
        first = false;
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined)
        );
        const originalHeader =
          Boolean(originalCsrf) && headers.get("x-exomem-csrf") === originalCsrf;
        await new Promise<void>((resolve) => {
          browser.__releaseEmailChange = resolve;
          void browser.__emailChangePaused();
        });
        // Only booleans leave this closure; nonce values never enter logs, storage or the DOM.
        browser.__emailChangeBoundary = {
          originalHeader,
          changedCookie: Boolean(csrf()) && csrf() !== originalCsrf,
        };
      }
      return nativeFetch(input, init);
    };
  });
  await draft.press("Enter");
  await reached;
  await signIn(page.context(), other);
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/exomem/account/email-change" &&
      response.request().method() === "POST"
  );
  await page.evaluate(() =>
    (window as typeof window & { __releaseEmailChange: () => void }).__releaseEmailChange()
  );
  const response = await rejected;
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("CSRF_REJECTED");
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __emailChangeBoundary: { originalHeader: boolean; changedCookie: boolean };
          }
        ).__emailChangeBoundary
    )
  ).toEqual({ originalHeader: true, changedCookie: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(accountPanel(page).getByText(other.email, { exact: true })).toBeVisible();
  expect(await changeCounts(other)).toEqual(before);
  expect(await changeCounts(original)).toEqual({ pending: 0, emails: 0 });
  expect(await canonicalEmail(other)).toBe(other.email);
});
