import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { LifecycleStatus } from "@/lib/exomem-hosted/reconciler";

const TENANT = "018f2d91-7c42-7000-8000-000000000081";
const SENTINEL = "status-email-credential-path-query-provider-sentinel";
let reconcileCalls = 0;
let status: LifecycleStatus = {
  state: "preparing",
  code: "CELL_PREPARING",
  requestId: "018f2d91-7c42-7000-8000-000000000082",
  retryable: true,
};

const CLOUD_MCP_URL = "https://cloud.example.test/mcp/v1";
let cloudStatusCalls = 0;
let cloudStatus: LifecycleStatus = {
  state: "ready",
  code: "CELL_READY",
  retryable: false,
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
  // Item 6 / task 3.7: a distinct fake from getOwnerLifecycleStatus above --
  // if the route's Cloud branch fell through to the hosted function instead,
  // cloudStatusCalls would stay 0 and the flag-on test would fail on that
  // assertion rather than merely returning the wrong body.
  mock.module("@/lib/exomem-hosted/cloud-status", {
    namedExports: {
      getOwnerCloudStatus: async (tenantId: string) => {
        assert.equal(tenantId, TENANT);
        cloudStatusCalls += 1;
        return cloudStatus;
      },
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-config", {
    namedExports: {
      exomemCloudEnabled: () => process.env.EXOMEM_CLOUD_ENABLED === "true",
      loadExomemCloudConfig: () => ({
        mcpUrl: CLOUD_MCP_URL,
        mcpPath: "/api/exomem/cloud/mcp/v1",
        cellTokenKey: Buffer.alloc(32, 9),
      }),
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  reconcileCalls = 0;
  cloudStatusCalls = 0;
  status = {
    state: "preparing",
    code: "CELL_PREPARING",
    requestId: "018f2d91-7c42-7000-8000-000000000082",
    retryable: true,
  };
  cloudStatus = { state: "ready", code: "CELL_READY", retryable: false };
  delete process.env.EXOMEM_CLOUD_ENABLED;
});

describe("GET /api/exomem/status", () => {
  it("is a pure product-session read and returns content-free status", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/status"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 200);
    assert.equal(reconcileCalls, 0);
    const text = await response.text();
    assert.equal(text.includes(TENANT), false);
    assert.equal(text.includes(SENTINEL), false);
    const body = JSON.parse(text) as { status: { state: string; code: string } };
    assert.equal(body.status.state, "preparing");
    assert.equal(body.status.code, "CELL_PREPARING");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    assert.equal(cloudStatusCalls, 0);
  });

  // Item 6 / task 3.7: the Cloud branch, reading exomem_cloud_cells state
  // through cloud-status.ts and returning the Cloud MCP connector URL from
  // cloud-config.ts, in place of the hosted lifecycle store.
  it("flag on: reads Cloud cell status and returns the Cloud MCP connector URL, never the hosted status function", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    cloudStatus = { state: "degraded", code: "CELL_NOT_READY", retryable: true };
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/status"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: { state: string; code: string };
      cloudConnectorUrl?: string;
    };
    assert.equal(body.status.state, "degraded");
    assert.equal(body.status.code, "CELL_NOT_READY");
    assert.equal(body.cloudConnectorUrl, CLOUD_MCP_URL);
    assert.equal(cloudStatusCalls, 1);
  });

  it("flag off: status keeps calling only the hosted lifecycle store, and the response carries no connector URL", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/status"
      ) as unknown as import("next/server").NextRequest
    );
    const body = (await response.json()) as { cloudConnectorUrl?: string };
    assert.equal(cloudStatusCalls, 0);
    assert.equal("cloudConnectorUrl" in body, false);
  });
});
