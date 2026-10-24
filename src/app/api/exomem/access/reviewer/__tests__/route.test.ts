import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createHash } from "node:crypto";
import { parseSetCookie } from "next/dist/compiled/@edge-runtime/cookies";

// One hour from now, in whole seconds as a cookie carries it: well inside the
// usual seven-day session, so the credential is what caps the session.
const CREDENTIAL_EXPIRES_AT = new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000);
const USERNAME = "reviewer-route-username-sentinel";
const PASSWORD = "reviewer-route-password-sentinel";
const NONCE = Buffer.alloc(32, 0x61).toString("base64url");
const continuationValue = {
  clientId: "client-openai",
  resource: "https://cloud.example.test/mcp/v1",
  formNonceDigest: createHash("sha256").update(NONCE).digest(),
};
let continuation: typeof continuationValue | null = continuationValue;
let authenticated = true;
let authenticateCalls = 0;
let bindCalls: Array<Record<string, unknown>> = [];
let webSessionCalls: Array<Record<string, unknown>> = [];
let webSessionExpiresAt: string | null = CREDENTIAL_EXPIRES_AT.toISOString();

before(() => {
  mock.module("@/lib/exomem-hosted/reviewer-access", {
    namedExports: {
      marketplaceReviewerAccessEnabled: () =>
        process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED === "true",
      authenticateMarketplaceReviewerCredential: async () => {
        authenticateCalls += 1;
        return authenticated
          ? {
              credentialId: "credential-1",
              provider: "openai",
              ownerUserId: "owner-sentinel",
              tenantId: "tenant-sentinel",
              fixtureVersion: "review-fixture-v1",
              expiresAt: CREDENTIAL_EXPIRES_AT.toISOString(),
            }
          : null;
      },
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-continuity", {
    namedExports: {
      resolveOAuthContinuation: async () => continuation,
      oauthContinuationDigest: () => Buffer.alloc(32, 0x41),
      oauthContinuationToken: () => "opaque-continuation",
      oauthConsentPath: () => "/exomem/authorize?confirmation=opaque-confirmation",
      oauthFormNonceFromRequest: () => NONCE,
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-reviewer-access-store", {
    namedExports: {
      findCloudReviewerCredentialForAuthentication: async () => null,
      createCloudReviewerOAuthSessionAtomic: async (input: Record<string, unknown>) => {
        bindCalls.push({ ...input, cloud: true });
        return { sessionId: "cloud-session-1" };
      },
      createCloudReviewerWebSessionAtomic: async (input: Record<string, unknown>) => {
        webSessionCalls.push(input);
        return webSessionExpiresAt
          ? { sessionId: "web-session-1", expiresAt: webSessionExpiresAt }
          : null;
      },
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: { clientAddressKey: () => "203.0.113.10" },
  });
});

after(() => mock.reset());

beforeEach(() => {
  process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "true";
  continuation = continuationValue;
  process.env.EXOMEM_CLOUD_MCP_URL = continuationValue.resource;
  process.env.EXOMEM_CLOUD_MCP_PATH = "/api/exomem/cloud/mcp/v1";
  authenticated = true;
  authenticateCalls = 0;
  bindCalls = [];
  webSessionCalls = [];
  webSessionExpiresAt = CREDENTIAL_EXPIRES_AT.toISOString();
});

// The session cookie as the browser receives it, read from the real Set-Cookie header.
function sessionCookie(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .map(parseSetCookie)
    .find((parsed) => parsed?.name === "exomem_session");
  assert.ok(cookie, "the response sets the session cookie");
  return cookie;
}

// Both Expires and Max-Age must end with the credential, not after it. Max-Age counts
// from when the route ran, which is no earlier than `sentAt`.
function assertCookieEndsWithCredential(response: Response, sentAt: number) {
  const cookie = sessionCookie(response);
  const credentialEndsMs = CREDENTIAL_EXPIRES_AT.getTime();
  const expiresMs = cookie.expires === undefined ? Infinity : new Date(cookie.expires).getTime();
  const maxAgeEndsMs = sentAt + (cookie.maxAge ?? Infinity) * 1000;
  for (const endsMs of [expiresMs, maxAgeEndsMs]) {
    assert.ok(endsMs <= credentialEndsMs && endsMs > credentialEndsMs - 60_000);
  }
}

function request(
  body: unknown = { username: USERNAME, password: PASSWORD, nonce: NONCE }
): Request {
  return new Request("https://hosted.example.test/api/exomem/access/reviewer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://hosted.example.test",
      host: "hosted.example.test",
      cookie: "exomem_oauth_tx=opaque-continuation",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/exomem/access/reviewer", () => {
  it("creates only a pre-bound reviewer session and returns the confirmation destination", async () => {
    const { POST } = await import("../route");
    const sentAt = Date.now();
    const response = await POST(request());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.status, "authenticated");
    assert.match(String(body.destination), /^\/exomem\/authorize\?confirmation=/);
    assert.equal(bindCalls.length, 1);
    assert.equal(bindCalls[0].cloud, true);
    assert.equal(bindCalls[0].credentialId, "credential-1");
    assert.equal(bindCalls[0].transactionDigest instanceof Buffer, true);
    assert.equal(JSON.stringify(bindCalls[0]).includes(USERNAME), false);
    assert.equal(JSON.stringify(bindCalls[0]).includes(PASSWORD), false);
    assertCookieEndsWithCredential(response, sentAt);
    assert.equal(JSON.stringify(body).includes("owner-sentinel"), false);
    assert.equal(JSON.stringify(body).includes("tenant-sentinel"), false);
    assert.equal(JSON.stringify(body).includes("review-fixture-v1"), false);
  });

  it("uses one generic no-store failure for disabled, missing continuation, invalid credentials, and malformed credentials", async () => {
    const { POST } = await import("../route");
    const failures: Response[] = [];
    process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "false";
    failures.push(await POST(request()));
    process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "true";
    continuation = null;
    failures.push(await POST(request()));
    continuation = continuationValue;
    authenticated = false;
    failures.push(await POST(request()));
    failures.push(await POST(request({ username: USERNAME })));

    for (const response of failures) {
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.deepEqual(await response.json(), { success: false, error: "authentication_failed" });
    }
    assert.equal(bindCalls.length, 0);
  });

  it("refuses mismatched nonce, foreign origin on either path and non-Cloud continuation before binding", async () => {
    const { POST } = await import("../route");
    const attempts = [request({ username: USERNAME, password: PASSWORD, nonce: "wrong" })];
    const foreign = request();
    foreign.headers.set("origin", "https://foreign.example.test");
    attempts.push(foreign);
    const foreignWeb = request({ username: USERNAME, password: PASSWORD });
    foreignWeb.headers.set("origin", "https://foreign.example.test");
    attempts.push(foreignWeb);
    for (const attempt of attempts) assert.equal((await POST(attempt)).status, 401);
    continuation = { ...continuationValue, resource: "https://hosted.example.test/mcp" };
    assert.equal((await POST(request())).status, 401);
    continuation = { ...continuationValue, formNonceDigest: Buffer.alloc(32) };
    assert.equal((await POST(request())).status, 401);
    assert.equal(bindCalls.length, 0);
    assert.equal(webSessionCalls.length, 0);
  });
  it("signs a reviewer in on the web without an OAuth request, for no longer than the credential", async () => {
    continuation = null;
    const { POST } = await import("../route");
    const sentAt = Date.now();
    const response = await POST(request({ username: USERNAME, password: PASSWORD }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      success: true,
      status: "authenticated",
      destination: "/exomem/home",
    });
    assert.equal(webSessionCalls.length, 1);
    assert.equal(webSessionCalls[0].credentialId, "credential-1");
    assert.equal(bindCalls.length, 0, "no OAuth request is bound");
    assertCookieEndsWithCredential(response, sentAt);
  });

  it("answers a failed web sign-in with the same 401, after the same throttled credential check", async () => {
    const { POST } = await import("../route");
    authenticated = false;
    const wrongPassword = await POST(request({ username: USERNAME, password: "wrong" }));
    authenticated = true;
    webSessionExpiresAt = null;
    const refusedSession = await POST(request({ username: USERNAME, password: PASSWORD }));

    for (const response of [wrongPassword, refusedSession]) {
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { success: false, error: "authentication_failed" });
      assert.equal(response.headers.get("set-cookie"), null);
    }
    // Every well-formed attempt reaches the rate-limited Argon2 check, as the app path does.
    assert.equal(authenticateCalls, 2);
  });
});
