import assert from "node:assert/strict";
import { after, before, beforeEach, test, mock } from "node:test";
import { exomemErrors } from "@/lib/exomem-hosted/errors";

let sessionValid = true;
let continuationValid = true;

before(async () => {
  const sessions = await import("@/lib/exomem-hosted/sessions");
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      ...sessions,
      resolveExomemSession: async () => {
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
