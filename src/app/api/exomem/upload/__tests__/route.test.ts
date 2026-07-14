import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

let ticketCalls: unknown[] = [];

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
      createDirectTransferTicket: async (input: unknown) => {
        ticketCalls.push(input);
        return {
          url: "https://transfer.example.test/cells/cell-a/public/exomem/v2/transfers/upload",
          method: "PUT",
          headers: {
            "X-Exomem-Transfer-Grant": "signed-grant",
            "Content-Type": "text/plain",
          },
          expiresAt: "2026-07-14T12:05:00.000Z",
          maxBytes: 94371840,
          requestId: "request-1",
        };
      },
    },
  });
});

after(() => mock.reset());
beforeEach(() => {
  ticketCalls = [];
});

describe("POST /api/exomem/upload", () => {
  it("accepts only small signed-metadata ticket requests and returns no file bytes", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const metadata = {
      category: "uploads",
      content_type: "text/plain",
      description: null,
      filename: "proof.txt",
      scope: "inbox",
      sha256: "a".repeat(64),
      size: 10,
    };
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/upload", {
        method: "POST",
        headers: { "content-type": "application/json", "x-exomem-csrf": "csrf" },
        body: JSON.stringify({ metadata }),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(ticketCalls.length, 1);
    assert.deepEqual((ticketCalls[0] as { request: unknown }).request, {
      operation: "upload",
      metadata,
    });
    const text = await response.text();
    assert.equal(text.includes("signed-grant"), true);
    assert.equal(text.includes("proof file bytes"), false);
  });

  it("rejects multipart file bodies before ticket issuance", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/upload", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=bad" },
        body: "proof file bytes",
      })
    );
    assert.equal(response.status, 400);
    assert.equal(ticketCalls.length, 0);
  });

  it("stops an oversized streamed ticket body without issuing a grant", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/upload", {
        method: "POST",
        headers: { "content-type": "application/json", "x-exomem-csrf": "csrf" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            controller.enqueue(new Uint8Array(16 * 1024));
            controller.close();
          },
        }),
      })
    );
    assert.equal(response.status, 413);
    assert.equal(ticketCalls.length, 0);
  });
});
