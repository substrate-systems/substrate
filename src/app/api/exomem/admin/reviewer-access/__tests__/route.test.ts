import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const ADMIN_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");
const USERNAME = "exr_operator-reviewer-username-sentinel";
const PASSWORD = "operator-reviewer-password-sentinel";
const FIXTURE_PAYLOAD_DIGEST = "a".repeat(64);
const OWNER_ID = "018f2d91-7c42-7000-8000-000000000011";
const TENANT_ID = "018f2d91-7c42-7000-8000-000000000012";
let created: Record<string, unknown> | null = null;
let revoked: Record<string, unknown> | null = null;
let createdInternal: Record<string, unknown> | null = null;

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
  mock.module("@/lib/exomem-hosted/reviewer-access", {
    namedExports: {
      generateMarketplaceReviewerCredential: () => ({
        username: USERNAME,
        password: PASSWORD,
        usernameDigest: Buffer.alloc(32, 0x61),
      }),
      hashMarketplaceReviewerPassword: async () => "$argon2id$operator-test",
    },
  });
  mock.module("@/lib/exomem-hosted/reviewer-access-store", {
    namedExports: {
      createOrRotateMarketplaceReviewerCredentialAtomic: async (input: Record<string, unknown>) => {
        created = input;
        return { credentialId: "credential-1", ownerUserId: "owner-1", tenantId: "tenant-1" };
      },
      createInternalCanaryReviewerCredentialAtomic: async (input: Record<string, unknown>) => {
        createdInternal = input;
        return {
          credentialId: "credential-2",
          ownerUserId: "owner-1",
          tenantId: "tenant-1",
          expiresAt: "2026-07-31T00:00:00.000Z",
        };
      },
      getMarketplaceReviewerCredentialStatus: async () => ({
        provider: "openai",
        fixtureVersion: "review-fixture-v1",
        fixturePayloadDigest: FIXTURE_PAYLOAD_DIGEST,
        expiresAt: "2026-08-01T00:00:00.000Z",
        revokedAt: null,
      }),
      revokeMarketplaceReviewerCredentialAtomic: async (input: Record<string, unknown>) => {
        revoked = input;
        return 1;
      },
      revokeInternalCanaryReviewerCredentialAtomic: async () => {
        return 1;
      },
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: {
        adminPreAuthReadIp: { scope: "read-ip", limit: 1, windowSeconds: 60 },
        adminPreAuthMutationIp: { scope: "mutation-ip", limit: 1, windowSeconds: 60 },
        adminAuthenticatedRead: { scope: "read", limit: 1, windowSeconds: 60 },
        adminAuthenticatedMutation: { scope: "mutation", limit: 1, windowSeconds: 60 },
      },
      clientAddressKey: () => "test-ip",
      takeExomemRateLimit: async () => true,
    },
  });
});

after(() => {
  delete process.env.EXOMEM_ADMIN_TOKEN;
  mock.reset();
});

beforeEach(() => {
  created = null;
  revoked = null;
  createdInternal = null;
});

function request(
  method: string,
  input: { authorization?: string; body?: unknown; provider?: string } = {}
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.authorization) headers.set("authorization", input.authorization);
  const query = input.provider ? `?provider=${encodeURIComponent(input.provider)}` : "";
  return new Request(`https://substratesystems.io/api/exomem/admin/reviewer-access${query}`, {
    method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem operator reviewer access", () => {
  it("requires the operator bearer for reviewer controls", async () => {
    const { GET } = await import("../route");
    assert.equal((await GET(request("GET", { provider: "openai" }))).status, 401);
  });

  it("creates a generated credential and returns plaintext only in that response", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request("POST", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: {
          provider: "openai",
          ownerUserId: OWNER_ID,
          tenantId: TENANT_ID,
          fixtureVersion: "review-fixture-v1",
          fixturePayloadDigest: FIXTURE_PAYLOAD_DIGEST,
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      })
    );

    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body.credentials, { username: USERNAME, password: PASSWORD });
    assert.equal(created?.passwordHash, "$argon2id$operator-test");
    assert.equal(created?.usernameDigest instanceof Buffer, true);
    assert.equal(created?.fixturePayloadDigest, FIXTURE_PAYLOAD_DIGEST);
    assert.equal(JSON.stringify(body).includes("owner-1"), false);
    assert.equal(JSON.stringify(body).includes("tenant-1"), false);
    assert.equal(JSON.stringify(body).includes(OWNER_ID), false);
    assert.equal(JSON.stringify(body).includes(TENANT_ID), false);
  });

  it("rejects missing or malformed fixture payload digests before credential persistence", async () => {
    const { POST } = await import("../route");
    for (const fixturePayloadDigest of [undefined, "A".repeat(64), "a".repeat(63)]) {
      const response = await POST(
        request("POST", {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          body: {
            provider: "openai",
            ownerUserId: "018f2d91-7c42-7000-8000-000000000011",
            tenantId: "018f2d91-7c42-7000-8000-000000000012",
            fixtureVersion: "review-fixture-v1",
            ...(fixturePayloadDigest === undefined ? {} : { fixturePayloadDigest }),
            expiresAt: "2026-08-01T00:00:00.000Z",
          },
        })
      );
      assert.equal(response.status, 400);
      assert.equal(created, null);
    }
  });

  it("issues an exact internal-canary credential without exposing its stored selectors", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request("POST", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: {
          credentialKind: "internal_canary",
          platform: "claude",
          tenantId: TENANT_ID,
          candidateId: "018f2d91-7c42-7000-8000-000000000021",
          assignmentId: "018f2d91-7c42-7000-8000-000000000022",
          assignmentGeneration: 2,
          stagedClientReleaseId: "018f2d91-7c42-7000-8000-000000000023",
          oauthClientId: "018f2d91-7c42-7000-8000-000000000024",
          fixtureVersion: "internal-canary-v1",
          fixturePayloadDigest: FIXTURE_PAYLOAD_DIGEST,
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      })
    );

    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body.credentials, { username: USERNAME, password: PASSWORD });
    assert.equal(createdInternal?.platform, "claude");
    assert.equal(createdInternal?.tenantId, TENANT_ID);
    assert.equal(createdInternal?.assignmentGeneration, 2);
    assert.equal(created, null);
    assert.equal(body.expiresAt, "2026-07-31T00:00:00.000Z");
    assert.equal(JSON.stringify(body).includes("000000000021"), false);
    assert.equal(JSON.stringify(body).includes("passwordHash"), false);
  });

  it("returns only sanitized status and revokes idempotently", async () => {
    const { DELETE, GET } = await import("../route");
    const status = await GET(
      request("GET", { authorization: `Bearer ${ADMIN_TOKEN}`, provider: "openai" })
    );
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json()).status, {
      provider: "openai",
      fixtureVersion: "review-fixture-v1",
      fixturePayloadDigest: FIXTURE_PAYLOAD_DIGEST,
      expiresAt: "2026-08-01T00:00:00.000Z",
      revokedAt: null,
    });

    const response = await DELETE(
      request("DELETE", { authorization: `Bearer ${ADMIN_TOKEN}`, body: { provider: "openai" } })
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.revoked, true);
    assert.equal(typeof body.requestId, "string");
    assert.equal(revoked?.provider, "openai");
    assert.equal(revoked?.operatorPrincipalDigest instanceof Buffer, true);
  });
});
