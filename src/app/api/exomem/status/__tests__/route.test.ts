import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const TENANT = "018f2d91-7c42-7000-8000-000000000081";
const SENTINEL = "status-email-credential-path-query-provider-sentinel";
let reconcileCalls = 0;
let status = {
  state: "preparing" as const,
  code: "CELL_PREPARING",
  requestId: "018f2d91-7c42-7000-8000-000000000082",
  retryable: true,
};

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({
        id: "session-1",
        userId: "user-1",
        tenantId: TENANT,
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-13T00:00:00.000Z",
      }),
    },
  });
  mock.module("@/lib/exomem-hosted/reconcile-runtime", {
    namedExports: {
      immediateBestEffortReconcile: async (tenantId: string) => {
        assert.equal(tenantId, TENANT);
        reconcileCalls += 1;
        return { attempted: true, code: SENTINEL };
      },
      getOwnerLifecycleStatus: async (tenantId: string) => {
        assert.equal(tenantId, TENANT);
        return status;
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  reconcileCalls = 0;
  status = {
    state: "preparing",
    code: "CELL_PREPARING",
    requestId: "018f2d91-7c42-7000-8000-000000000082",
    retryable: true,
  };
});

describe("GET /api/exomem/status", () => {
  it("uses the product session, kicks one reconcile step, and returns content-free status", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/status"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 200);
    assert.equal(reconcileCalls, 1);
    const text = await response.text();
    assert.equal(text.includes(TENANT), false);
    assert.equal(text.includes(SENTINEL), false);
    const body = JSON.parse(text) as { status: { state: string; code: string } };
    assert.equal(body.status.state, "preparing");
    assert.equal(body.status.code, "CELL_PREPARING");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  });
});
