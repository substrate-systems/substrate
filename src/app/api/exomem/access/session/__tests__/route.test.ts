import assert from "node:assert/strict";
import { after, before, beforeEach, test, mock } from "node:test";
import { exomemErrors } from "@/lib/exomem-hosted/errors";

let sessionValid = true;
let continuationValid = true;
let sessionFailure: Error | null = null;

before(async () => {
  const sessions = await import("@/lib/exomem-hosted/sessions");
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      ...sessions,
      resolveExomemSession: async () => {
        if (sessionFailure) throw sessionFailure;
        if (!sessionValid) throw exomemErrors.sessionInvalid();
        return { userId: "test-owner" };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/db", {
    namedExports: {
      executeExomemSql: async () => ({ rows: [{ email: "Owner@example.test" }], rowCount: 1 }),
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-continuity", {
    namedExports: {
      oauthContinuationToken: () => "current-transaction",
      resolveOAuthContinuation: async () => (continuationValid ? {} : null),
      validateOAuthContinuationNonce: ({ formNonce }: { formNonce: string }) =>
        formNonce === "original-form-nonce",
      oauthConsentPath: () => "/exomem/authorize?confirmation=current-request",
    },
  });
});
after(() => mock.reset());
beforeEach(() => {
  sessionValid = true;
  continuationValid = true;
  sessionFailure = null;
});

async function readNavigationSession() {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../route");
  return GET(new NextRequest("https://example.test/api/exomem/access/session"));
}

test("navigation receives only a private session boolean", async () => {
  const response = await readNavigationSession();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { authenticated: true });
});

test("an invalid session gives navigation an anonymous state", async () => {
  sessionValid = false;
  const response = await readNavigationSession();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { authenticated: false });
});

test("a failed session lookup is not reported as signed out", async () => {
  sessionFailure = new Error("synthetic storage failure");
  const response = await readNavigationSession();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(Object.hasOwn(await response.json(), "authenticated"), false);
});

async function readSession(body: Record<string, unknown>) {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../route");
  return POST(
    new NextRequest("https://example.test/api/exomem/access/session", {
      method: "POST",
      headers: {
        host: "example.test",
        origin: "https://example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
}

test("a tab notification cannot authenticate without a current session", async () => {
  sessionValid = false;
  const response = await readSession({ expectedEmail: "owner@example.test" });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("cache-control")!, /no-store/);
});

test("signing into another account does not advance the waiting email tab", async () => {
  const response = await readSession({ expectedEmail: "another@example.test" });
  assert.deepEqual(await response.json(), { authenticated: false });
});

test("the matching session resumes Home", async () => {
  const web = await readSession({ expectedEmail: "OWNER@example.test" });
  assert.deepEqual(await web.json(), { authenticated: true, destination: "/exomem/home" });
});

test("the matching session resumes its live original app request", async () => {
  const app = await readSession({
    expectedEmail: "owner@example.test",
    formNonce: "original-form-nonce",
  });
  assert.deepEqual(await app.json(), {
    authenticated: true,
    destination: "/exomem/authorize?confirmation=current-request",
  });
});

test("a replaced app request supplies no destination", async () => {
  const replaced = await readSession({
    expectedEmail: "owner@example.test",
    formNonce: "other-form-nonce",
  });
  assert.deepEqual(await replaced.json(), { authenticated: true, destination: null });
});

test("an expired app request supplies no destination", async () => {
  continuationValid = false;
  const expired = await readSession({
    expectedEmail: "owner@example.test",
    formNonce: "original-form-nonce",
  });
  assert.deepEqual(await expired.json(), { authenticated: true, destination: null });
});
