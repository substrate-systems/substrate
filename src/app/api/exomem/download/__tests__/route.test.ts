import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

let requestedPath = "";

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({
        id: "session-1",
        userId: "018f2d91-7c42-7000-8000-000000000091",
        tenantId: "018f2d91-7c42-7000-8000-000000000092",
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-14T12:00:00.000Z",
      }),
      validateMutationRequest: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/gateway", {
    namedExports: { hasForbiddenGatewayHeaders: () => false },
  });
  mock.module("@/lib/exomem-hosted/transfers", {
    namedExports: {
      createDirectTransferTicket: async (input: { request: { path: string } }) => {
        requestedPath = input.request.path;
        return {
          url: "https://transfer.example.test/cells/cell-a/public/exomem/v2/transfers/download",
          method: "GET",
          headers: { "X-Exomem-Transfer-Grant": "signed-grant" },
          expiresAt: "2026-07-14T12:05:00.000Z",
          maxBytes: 5368709120,
          requestId: "request-2",
        };
      },
    },
  });
});

after(() => mock.reset());
beforeEach(() => {
  requestedPath = "";
});

describe("POST /api/exomem/download", () => {
  it("returns a bodyless direct GET ticket bound to the requested path", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/download", {
        method: "POST",
        headers: { "content-type": "application/json", "x-exomem-csrf": "csrf" },
        body: JSON.stringify({ path: "Evidence/proof.txt" }),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(requestedPath, "Evidence/proof.txt");
    const body = (await response.json()) as { data: { method: string; headers: object } };
    assert.equal(body.data.method, "GET");
    assert.deepEqual(Object.keys(body.data.headers), ["X-Exomem-Transfer-Grant"]);
  });

  it("stops an oversized streamed ticket body without issuing a grant", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/download", {
        method: "POST",
        headers: { "content-type": "application/json", "x-exomem-csrf": "csrf" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            controller.enqueue(new Uint8Array(8 * 1024));
            controller.close();
          },
        }),
      })
    );
    assert.equal(response.status, 413);
    assert.equal(requestedPath, "");
  });
});
