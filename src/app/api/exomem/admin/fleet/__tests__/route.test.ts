import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

const ADMIN_TOKEN = Buffer.alloc(32, 0x73).toString("base64url");
const observation = {
  artifact: "exomem-hosted-substrate-fleet-observation",
  schemaVersion: 1,
  observedAt: "2026-08-21T12:34:56Z",
  routableCells: [],
  tenantBindings: [],
  assignments: [],
  unfinishedOperations: [],
  capacityClaims: [],
  capacityActiveCellCount: 0,
  reviewerAuthorities: [],
  reviewerTenants: [],
};

before(() => {
  process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
  mock.module("@/lib/exomem-hosted/fleet-observation", {
    namedExports: { getExomemHostedFleetObservation: async () => observation },
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

function request(authorization?: string) {
  return new Request("https://substratesystems.io/api/exomem/admin/fleet", {
    headers: authorization ? { authorization } : {},
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem operator fleet observation", () => {
  it("returns the read-only observation under operator authority", async () => {
    const { GET } = await import("../route");
    const response = await GET(request(`Bearer ${ADMIN_TOKEN}`));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.observation, observation);
    assert.equal(typeof body.requestId, "string");
    assert.deepEqual(Object.keys(body).sort(), ["observation", "requestId", "success"]);
  });

  it("refuses an unauthenticated observation", async () => {
    const { GET } = await import("../route");
    assert.equal((await GET(request())).status, 401);
  });
});
