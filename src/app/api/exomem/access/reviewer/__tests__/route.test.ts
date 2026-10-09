import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createHash } from "node:crypto";

const SESSION_TOKEN = Buffer.alloc(32, 0x31).toString("base64url");
const CSRF_TOKEN = Buffer.alloc(32, 0x32).toString("base64url");
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
let bindCalls: Array<Record<string, unknown>> = [];
let cookieExpiresAt: Date | undefined;

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
              expiresAt: "2026-07-30T00:00:00.000Z",
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
      applySessionCookies: (
        response: import("next/server").NextResponse,
        material: { expiresAt: Date }
      ) => {
        cookieExpiresAt = material.expiresAt;
        response.cookies.set("exomem_session", SESSION_TOKEN, { httpOnly: true, path: "/" });
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "true";
  continuation = continuationValue;
  process.env.EXOMEM_CLOUD_MCP_URL = continuationValue.resource;
  process.env.EXOMEM_CLOUD_MCP_PATH = "/api/exomem/cloud/mcp/v1";
  authenticated = true;
  bindCalls = [];
  cookieExpiresAt = undefined;
});

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
    assert.equal(cookieExpiresAt?.toISOString(), "2026-07-30T00:00:00.000Z");
    assert.equal(JSON.stringify(body).includes("owner-sentinel"), false);
    assert.equal(JSON.stringify(body).includes("tenant-sentinel"), false);
    assert.equal(JSON.stringify(body).includes("review-fixture-v1"), false);
  });

  // Cloud design D2: the reviewer-credential branch does not apply under
  // Cloud, so a credential issued before the flag was turned on no longer
  // redeems either.
  it("uses independent reviewer redemption while Exomem Cloud is enabled", async () => {
    const { POST } = await import("../route");
    process.env.EXOMEM_CLOUD_ENABLED = "1";
    try {
      const response = await POST(request());
      assert.equal(response.status, 200);
      assert.equal(bindCalls.length, 1);
      assert.equal(bindCalls[0].cloud, true);
    } finally {
      delete process.env.EXOMEM_CLOUD_ENABLED;
    }
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

  it("refuses missing/mismatched nonce, foreign origin and non-Cloud continuation before binding", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    try {
      const { POST } = await import("../route");
      const attempts = [
        request({ username: USERNAME, password: PASSWORD }),
        request({ username: USERNAME, password: PASSWORD, nonce: "wrong" }),
      ];
      const foreign = request();
      foreign.headers.set("origin", "https://foreign.example.test");
      attempts.push(foreign);
      for (const attempt of attempts) assert.equal((await POST(attempt)).status, 401);
      continuation = { ...continuationValue, resource: "https://hosted.example.test/mcp" };
      assert.equal((await POST(request())).status, 401);
      continuation = { ...continuationValue, formNonceDigest: Buffer.alloc(32) };
      assert.equal((await POST(request())).status, 401);
      assert.equal(bindCalls.length, 0);
    } finally {
      delete process.env.EXOMEM_CLOUD_ENABLED;
    }
  });
});
