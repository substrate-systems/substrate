import { randomUUID } from "node:crypto";
import { expect, test as base, type Page } from "@playwright/test";
import { homeE2eEnvironment } from "./environment";
import type { SentEmail } from "./fake-brevo";
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
            (SELECT count(*)::int FROM exomem_email_outbox WHERE tenant_id = $1) AS emails`,
    [owner.tenantId]
  );
  return rows[0] as { pending: number; emails: number };
}

/** The email renderer writes each action as "label: URL"; URL parses the delivered link. */
function deliveredLink(email: SentEmail, label: string) {
  const prefix = `${label}: `;
  const line = email.textContent.split("\n").find((line) => line.startsWith(prefix));
  expect(line, `The delivered email needs its ${label} action`).toBeDefined();
  const link = new URL(line!.slice(prefix.length));
  // Keep the actual delivered path and capability on the isolated server.
  return new URL(`${link.pathname}${link.search}${link.hash}`, homeE2eEnvironment().baseUrl).href;
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
  const grantsBefore = (
    await pool.query(
      "SELECT id, user_id, tenant_id, client_id, resource, scopes, revoked_at FROM exomem_oauth_grants WHERE tenant_id = $1 ORDER BY id",
      [owner.tenantId]
    )
  ).rows;
  await signIn(page.context(), owner);
  await page.goto("/exomem/home");
  await accountPanel(page).getByRole("button", { name: "Change", exact: true }).click();
  await expect(accountPanel(page).getByText("Checking email status…", { exact: true })).toHaveCount(
    0
  );
  await page.getByRole("dialog").getByLabel("New email", { exact: true }).fill(proposed);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send the links", exact: true })
    .click();
  const queued = page.getByRole("dialog", { name: "Check both inboxes" });
  await expect(
    queued.getByText(`A confirmation link is queued for ${proposed}`, { exact: false })
  ).toBeVisible();
  await expect(queued.getByText("Open the link we sent", { exact: false })).toHaveCount(0);
  expect(
    (
      await pool.query(
        "SELECT kind, recipient, state FROM exomem_email_outbox WHERE tenant_id = $1 ORDER BY kind",
        [owner.tenantId]
      )
    ).rows
  ).toEqual([
    { kind: "email_change_cancellation", recipient: owner.email, state: "pending" },
    { kind: "email_change_confirmation", recipient: proposed, state: "pending" },
  ]);
  expect(await canonicalEmail(owner)).toBe(owner.email);

  const environment = homeE2eEnvironment();
  const delivered = await page.request.get("/api/cron/exomem-access-delivery", {
    headers: { authorization: `Bearer ${environment.schedulerSecret}` },
  });
  expect(delivered.ok()).toBe(true);
  await expect.poll(async () => (await emailsTo({ ...owner, email: proposed })).length).toBe(1);
  await expect.poll(async () => (await emailsTo(owner)).length).toBe(1);
  await expect(
    queued.getByText(`Open the link we sent to ${proposed}`, { exact: false })
  ).toBeVisible({ timeout: 15_000 });
  const confirmation = deliveredLink(
    (await emailsTo({ ...owner, email: proposed }))[0],
    "Confirm this address"
  );
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

test("the old inbox can stop a pending change and replay reveals no account state", async ({
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
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Send the links", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "Check both inboxes" })).toBeVisible();
  const environment = homeE2eEnvironment();
  const delivered = await page.request.get("/api/cron/exomem-access-delivery", {
    headers: { authorization: `Bearer ${environment.schedulerSecret}` },
  });
  expect(delivered.ok()).toBe(true);
  await expect.poll(async () => (await emailsTo(owner)).length).toBe(1);
  const cancellation = deliveredLink((await emailsTo(owner))[0], "Stop the change");
  expect(new URL(cancellation).pathname).toBe("/exomem/email-change/cancel");
  await page.goto(cancellation);
  await expect(
    page.getByRole("heading", { name: "Stop this email change?", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(owner.email);
  expect((await changeCounts(owner)).pending).toBe(1);
  await page.getByRole("button", { name: "Stop the change", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Email change stopped", exact: true })
  ).toBeVisible();
  expect(await canonicalEmail(owner)).toBe(owner.email);
  expect((await changeCounts(owner)).pending).toBe(0);
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
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
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
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
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
