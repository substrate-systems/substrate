import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const ADMIN_TOKEN = Buffer.alloc(32, 0x72).toString("base64url");
const OWNER = "018f2d91-7c42-7000-8000-000000000010";
const TENANT = "018f2d91-7c42-7000-8000-000000000011";
let familyInput: Record<string, unknown> | null = null;

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
      revokeOperatorOAuthFamily: async (input: Record<string, unknown>) => {
        familyInput = input;
        return false;
      },
      revokeOperatorOAuthAccount: async () => 0,
    },
  });
});

after(() => {
  delete process.env.EXOMEM_ADMIN_TOKEN;
  mock.reset();
});
beforeEach(() => (familyInput = null));

function request(body: unknown) {
  return new Request("https://substratesystems.io/api/exomem/admin/oauth-revocations", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem operator OAuth revocation", () => {
  it("passes the owner and tenant fence through a family revocation", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      request({
        action: "family",
        ownerUserId: OWNER,
        tenantId: TENANT,
        familyId: "018f2d91-7c42-7000-8000-000000000012",
      })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(familyInput, {
      ownerUserId: OWNER,
      tenantId: TENANT,
      familyId: "018f2d91-7c42-7000-8000-000000000012",
    });
  });
});
