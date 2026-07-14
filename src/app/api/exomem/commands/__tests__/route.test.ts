import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

let routeCalls = 0;

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({
        id: "session-1",
        userId: "018f2d91-7c42-7000-8000-000000000091",
        tenantId: "018f2d91-7c42-7000-8000-000000000092",
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-13T00:00:00.000Z",
      }),
      validateMutationRequest: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/gateway", {
    namedExports: {
      gatewayLimits: { commandBytes: 32 },
      hasForbiddenGatewayHeaders: () => false,
      hasReservedSelector: () => false,
      routeExomemCommand: async () => {
        routeCalls += 1;
        return { status: 200, body: { success: true } };
      },
    },
  });
});

after(() => mock.reset());

describe("POST /api/exomem/commands/[command]", () => {
  it("rejects an oversized chunked body before command routing", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../[command]/route");
    const request = new NextRequest("https://substratesystems.io/api/exomem/commands/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "sensitive-value-that-is-over-the-test-limit" }),
    });
    assert.equal(request.headers.get("content-length"), null);

    const response = await POST(request, { params: Promise.resolve({ command: "remember" }) });

    assert.equal(response.status, 413);
    assert.equal(routeCalls, 0);
    assert.equal((await response.json()).error.code, "TOO_LARGE");
  });
});
