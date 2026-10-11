import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { LifecycleStatus } from "@/lib/exomem-hosted/cloud-status";

const TENANT = "018f2d91-7c42-7000-8000-000000000081";
const CLOUD_MCP_URL = "https://cloud.example.test/mcp/v1";
let cloudStatusCalls = 0;
let cloudResourceConfigured = true;
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
      loadExomemCloudResource: () => {
        if (!cloudResourceConfigured) throw new Error("Exomem Cloud configuration is incomplete");
        return { mcpUrl: CLOUD_MCP_URL, mcpPath: "/mcp" };
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  cloudStatusCalls = 0;
  cloudResourceConfigured = true;
  cloudStatus = { state: "ready", code: "CELL_READY", retryable: false };
});

async function getStatus(): Promise<Response> {
  const { GET } = await import("../route");
  return GET(
    new Request(
      "https://substratesystems.io/api/exomem/status"
    ) as unknown as import("next/server").NextRequest
  );
}

describe("GET /api/exomem/status", () => {
  it("returns the content-free Cloud cell status and the Cloud MCP connector URL", async () => {
    cloudStatus = { state: "degraded", code: "CELL_NOT_READY", retryable: true };
    const response = await getStatus();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const text = await response.text();
    assert.equal(text.includes(TENANT), false);
    const body = JSON.parse(text) as {
      status: { state: string; code: string };
      cloudConnectorUrl?: string;
    };
    assert.equal(body.status.state, "degraded");
    assert.equal(body.status.code, "CELL_NOT_READY");
    assert.equal(body.cloudConnectorUrl, CLOUD_MCP_URL);
    assert.equal(cloudStatusCalls, 1);
  });

  it("still answers with a status, and no connector URL, when the Cloud resource is unconfigured", async () => {
    cloudResourceConfigured = false;
    const response = await getStatus();
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: { state: string };
      cloudConnectorUrl?: string;
    };
    assert.equal(body.status.state, "ready");
    assert.equal("cloudConnectorUrl" in body, false);
  });
});
