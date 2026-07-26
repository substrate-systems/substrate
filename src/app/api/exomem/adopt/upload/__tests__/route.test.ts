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
        expiresAt: "2026-07-16T12:00:00.000Z",
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
            "X-Exomem-Transfer-Grant": "signed-staging-grant",
            "Content-Type": "application/zip",
          },
          expiresAt: "2026-07-16T12:05:00.000Z",
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

describe("POST /api/exomem/adopt/upload", () => {
  it("mints a run-bound staging ticket from signed metadata and returns no file bytes", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const metadata = {
      content_type: "application/zip",
      filename: "notes.zip",
      path: null,
      run_id: "run-1",
      sha256: "a".repeat(64),
      size: 10,
    };
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/adopt/upload", {
        method: "POST",
        headers: { "content-type": "application/json", "x-exomem-csrf": "csrf" },
        body: JSON.stringify({ metadata }),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(ticketCalls.length, 1);
    assert.deepEqual((ticketCalls[0] as { request: unknown }).request, {
      operation: "adoption-upload",
      metadata,
    });
    const text = await response.text();
    assert.equal(text.includes("signed-staging-grant"), true);
    assert.equal(text.includes("archive bytes"), false);
  });

  it("rejects bodies that are not exactly the metadata envelope", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    for (const body of [{ metadata: {}, extra: true }, { run_id: "run-1" }, [], "metadata"]) {
      const response = await POST(
        new NextRequest("https://substratesystems.io/api/exomem/adopt/upload", {
          method: "POST",
          headers: { "content-type": "application/json", "x-exomem-csrf": "csrf" },
          body: JSON.stringify(body),
        })
      );
      assert.equal(response.status, 400);
    }
    assert.equal(ticketCalls.length, 0);
  });

  it("rejects multipart file bodies before ticket issuance", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/adopt/upload", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=bad" },
        body: "archive bytes",
      })
    );
    assert.equal(response.status, 400);
    assert.equal(ticketCalls.length, 0);
  });

  it("stops an oversized streamed ticket body without issuing a grant", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/adopt/upload", {
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
