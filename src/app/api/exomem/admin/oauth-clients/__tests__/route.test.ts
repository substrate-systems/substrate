import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const ADMIN_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");
const SENTINEL = "operator-client-credential-sentinel";
let listed = [
  {
    id: "018f2d91-7c42-7000-8000-000000000001",
    enabled: true,
    admissionMode: "pinned",
    redirectCount: 1,
  },
];
let updated: Record<string, unknown> | null = null;

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: { adminInvites: { scope: "operator", limit: 1, windowSeconds: 60 } },
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
      redirectCount: 1,
    },
  ];
  updated = null;
});

function request(method: string, input: { authorization?: string; body?: unknown } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.authorization) headers.set("authorization", input.authorization);
  return new Request("https://substratesystems.io/api/exomem/admin/oauth-clients", {
    method,
    headers,
    ...(method === "PATCH" ? { body: JSON.stringify(input.body) } : {}),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem operator OAuth client controls", () => {
  it("requires the operator bearer and returns no raw client identity", async () => {
    listed = [{ ...listed[0], clientId: SENTINEL } as never];
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
