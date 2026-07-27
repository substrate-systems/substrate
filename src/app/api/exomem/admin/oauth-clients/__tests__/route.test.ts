import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const ADMIN_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");
const SENTINEL = "operator-client-credential-sentinel";
let listed = [
  {
    id: "018f2d91-7c42-7000-8000-000000000001",
    enabled: true,
    admissionMode: "pinned",
    clientFingerprint: "a".repeat(64),
    redirectDigest: "b".repeat(64),
    redirectCount: 1,
    metadataExpiresAt: null,
  },
];
let updated: Record<string, unknown> | null = null;
let registered: Record<string, unknown> | null = null;

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
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
  mock.module("@/lib/exomem-hosted/operator-controls", {
    namedExports: {
      listOperatorOAuthClients: async () => listed,
      setOperatorOAuthClientEnabled: async (input: Record<string, unknown>) => {
        updated = input;
        return true;
      },
      registerOperatorOAuthClient: async (input: Record<string, unknown>) => {
        registered = input;
        return { id: "018f2d91-7c42-7000-8000-000000000002", enabled: false };
      },
      refreshOperatorCimdOAuthClient: async () => ({
        id: "018f2d91-7c42-7000-8000-000000000002",
        enabled: false,
      }),
    },
  });
});

after(() => {
  delete process.env.EXOMEM_ADMIN_TOKEN;
  mock.reset();
});

beforeEach(() => {
  listed = [
    {
      id: "018f2d91-7c42-7000-8000-000000000001",
      enabled: true,
      admissionMode: "pinned",
      clientFingerprint: "a".repeat(64),
      redirectDigest: "b".repeat(64),
      redirectCount: 1,
      metadataExpiresAt: null,
    },
  ];
  updated = null;
  registered = null;
});

function request(method: string, input: { authorization?: string; body?: unknown } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.authorization) headers.set("authorization", input.authorization);
  return new Request("https://substratesystems.io/api/exomem/admin/oauth-clients", {
    method,
    headers,
    ...(method === "PATCH" || method === "POST" ? { body: JSON.stringify(input.body) } : {}),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem operator OAuth client controls", () => {
  it("requires the operator bearer and returns no raw client identity", async () => {
    listed = [{ ...listed[0], clientId: SENTINEL, unexpected: SENTINEL } as never];
    const { GET } = await import("../route");
    assert.equal((await GET(request("GET"))).status, 401);
    const response = await GET(request("GET", { authorization: `Bearer ${ADMIN_TOKEN}` }));
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(SENTINEL), false);
  });

  it("accepts one bounded opaque client mutation", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      request("PATCH", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: { id: "018f2d91-7c42-7000-8000-000000000001", enabled: false },
      })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(updated, {
      clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
      enabled: false,
    });
  });

  it("registers a disabled client without returning its identity", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request("POST", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: {
          action: "register_pinned",
          platform: "claude",
          artifactId: "018f2d91-7c42-7000-8000-000000000001",
          clientId: "desktop-client-sentinel",
          redirectUris: ["https://app.example.test/callback"],
        },
      })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(registered, {
      admissionMode: "pinned",
      platform: "claude",
      artifactId: "018f2d91-7c42-7000-8000-000000000001",
      clientId: "desktop-client-sentinel",
      redirectUris: ["https://app.example.test/callback"],
      ttlSeconds: undefined,
    });
    assert.equal((await response.text()).includes("desktop-client-sentinel"), false);
  });

  it("rejects an oversized operator request before it reaches the control store", async () => {
    const { PATCH } = await import("../route");
    const response = await PATCH(
      request("PATCH", {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        body: {
          id: "018f2d91-7c42-7000-8000-000000000001",
          enabled: false,
          padding: "x".repeat(20_000),
        },
      })
    );
    assert.equal(response.status, 413);
    assert.equal(updated, null);
  });
});
