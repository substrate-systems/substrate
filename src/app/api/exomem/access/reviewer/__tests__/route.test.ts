import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const SESSION_TOKEN = Buffer.alloc(32, 0x31).toString("base64url");
const CSRF_TOKEN = Buffer.alloc(32, 0x32).toString("base64url");
const USERNAME = "reviewer-route-username-sentinel";
const PASSWORD = "reviewer-route-password-sentinel";
let continuation: { clientId: string } | null = { clientId: "client-openai" };
let authenticated = true;
let bindCalls: Array<Record<string, unknown>> = [];

before(() => {
  mock.module("@/lib/exomem-hosted/reviewer-access", {
    namedExports: {
      marketplaceReviewerAccessEnabled: () =>
        process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED === "true",
      authenticateMarketplaceReviewerCredential: async () =>
        authenticated
          ? {
              credentialId: "credential-1",
              provider: "openai",
              ownerUserId: "owner-sentinel",
              tenantId: "tenant-sentinel",
              fixtureVersion: "review-fixture-v1",
            }
          : null,
    },
  });
  mock.module("@/lib/exomem-hosted/reviewer-access-store", {
    namedExports: {
      findMarketplaceReviewerCredentialForAuthentication: async () => null,
      createMarketplaceReviewerOAuthSessionAtomic: async (input: Record<string, unknown>) => {
        bindCalls.push(input);
        return { sessionId: "session-1" };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-continuity", {
    namedExports: {
      resolveOAuthContinuation: async () => continuation,
      oauthContinuationDigest: () => Buffer.alloc(32, 0x41),
      oauthContinuationToken: () => "opaque-continuation",
      oauthConfirmationHandle: () => "opaque-confirmation",
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: { clientAddressKey: () => "203.0.113.10" },
  });
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      validatePublicAccessRequest: () => undefined,
      mintSessionMaterial: () => ({
        sessionToken: SESSION_TOKEN,
        sessionDigest: Buffer.alloc(32, 0x51),
        csrfToken: CSRF_TOKEN,
        csrfDigest: Buffer.alloc(32, 0x52),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
      applySessionCookies: (response: import("next/server").NextResponse) => {
        response.cookies.set("exomem_session", SESSION_TOKEN, { httpOnly: true, path: "/" });
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "true";
  continuation = { clientId: "client-openai" };
  authenticated = true;
  bindCalls = [];
});

function request(body: unknown = { username: USERNAME, password: PASSWORD }): Request {
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
    const response = await POST(request());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.status, "authenticated");
    assert.match(String(body.destination), /^\/exomem\/authorize\?confirmation=/);
    assert.equal(bindCalls.length, 1);
    assert.equal(bindCalls[0].credentialId, "credential-1");
    assert.equal(bindCalls[0].transactionDigest instanceof Buffer, true);
    assert.equal(JSON.stringify(bindCalls[0]).includes(USERNAME), false);
    assert.equal(JSON.stringify(bindCalls[0]).includes(PASSWORD), false);
  });

  it("uses one generic no-store failure for disabled, missing continuation, invalid credentials, and malformed credentials", async () => {
    const { POST } = await import("../route");
    const failures: Response[] = [];
    process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "false";
    failures.push(await POST(request()));
    process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "true";
    continuation = null;
    failures.push(await POST(request()));
    continuation = { clientId: "client-openai" };
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
});
