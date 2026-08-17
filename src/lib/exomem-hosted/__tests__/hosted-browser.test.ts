import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  HostedBrowserError,
  friendlyHostedError,
  getPrivateFile,
  inferMemoryTitle,
  postPrivateFile,
} from "../hosted-browser";

test("an expired sign-in link says which of the two happened and what to do", () => {
  // Links last 15 minutes and work once. The bare cell message, "the access
  // link is invalid or unavailable", named neither the cause nor the cure, so a
  // stale link read as a broken product.
  const message = friendlyHostedError(
    new HostedBrowserError({ code: "ACCESS_TOKEN_INVALID", message: "the access link is invalid" }, 401)
  );
  assert.match(message, /expired or was already used/);
  assert.match(message, /Enter your email/);
});

test("first-memory titles are inferred without asking a non-technical user for metadata", () => {
  assert.equal(
    inferMemoryTitle("\n# The locksmith arrives Tuesday\nBring the old key."),
    "The locksmith arrives Tuesday"
  );
  assert.equal(
    inferMemoryTitle("Call Mina tomorrow. Ask about the invoice."),
    "Call Mina tomorrow."
  );
  assert.equal(inferMemoryTitle("  \n"), "Untitled memory");
  assert.equal(inferMemoryTitle("x".repeat(100)), `${"x".repeat(77)}…`);
});

test("file uploads obtain a small ticket before sending bytes directly to the cell", async (context) => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=csrf-token" },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "document");
  });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const expectedSha256 = createHash("sha256").update("same bytes").digest("hex");
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-exomem-csrf"), "csrf-token");
      assert.equal(headers.get("content-type"), "application/json");
      const body = String(init.body);
      assert.equal(body.includes("same bytes"), false);
      assert.equal(body.includes("résumé.txt"), true);
      assert.equal(body.includes("résumé.txt"), false);
      assert.equal(
        (JSON.parse(body) as { metadata: { sha256: string } }).metadata.sha256,
        expectedSha256
      );
      return Response.json({
        success: true,
        data: {
          url: "https://transfer.example.test/cells/cell-alpha/public/exomem/v2/transfers/upload",
          method: "PUT",
          headers: {
            "X-Exomem-Transfer-Grant": "signed-grant",
            "Content-Type": "text/plain",
          },
          expiresAt: "2026-07-14T12:05:00.000Z",
          maxBytes: 94371840,
          requestId: "request-1",
        },
      });
    }
    assert.equal(String(input).startsWith("https://transfer.example.test/"), true);
    assert.equal(init.method, "PUT");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("x-exomem-transfer-grant"), "signed-grant");
    assert.ok(init.body instanceof File);
    assert.equal(await init.body.text(), "same bytes");
    return Response.json(
      {
        success: true,
        data: {
          operation: "upload",
          bytes: 10,
          sha256: expectedSha256,
          committed: true,
        },
      },
      { status: 201 }
    );
  };

  const result = await postPrivateFile(
    new File(["same bytes"], "résumé.txt", { type: "text/plain" })
  );
  assert.deepEqual(result, {
    success: true,
    data: { operation: "upload", bytes: 10, sha256: expectedSha256, committed: true },
  });
  assert.equal(calls.length, 2);
});

test("file uploads require the exact committed 201 proof for the selected bytes", async (context) => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=csrf-token" },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "document");
  });
  const file = new File(["same bytes"], "proof.txt", { type: "text/plain" });
  const expectedSha256 = createHash("sha256").update("same bytes").digest("hex");
  const invalidResponses = [
    Response.json(
      {
        success: true,
        data: { operation: "upload", bytes: 10, sha256: expectedSha256, committed: true },
      },
      { status: 200 }
    ),
    Response.json(
      { success: false, error: { code: "NOT_COMMITTED", message: "not committed" } },
      { status: 201 }
    ),
    Response.json(
      {
        success: true,
        data: { operation: "upload", bytes: 9, sha256: expectedSha256, committed: true },
      },
      { status: 201 }
    ),
    Response.json(
      {
        success: true,
        data: { operation: "upload", bytes: 10, sha256: "a".repeat(64), committed: true },
      },
      { status: 201 }
    ),
    Response.json(
      {
        success: true,
        data: {
          operation: "upload",
          bytes: 10,
          sha256: expectedSha256,
          committed: true,
          path: "must-not-be-accepted",
        },
      },
      { status: 201 }
    ),
  ];

  for (const invalidResponse of invalidResponses) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          success: true,
          data: {
            url: "https://transfer.example.test/cells/cell-alpha/public/exomem/v2/transfers/upload",
            method: "PUT",
            headers: {
              "X-Exomem-Transfer-Grant": "signed-grant",
              "Content-Type": "text/plain",
            },
            maxBytes: 94371840,
          },
        });
      }
      return invalidResponse;
    };

    await assert.rejects(postPrivateFile(file), (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "HostedBrowserError");
      return true;
    });
    assert.equal(calls, 2);
  }
});

test("file downloads obtain a bodyless ticket then fetch directly without cookies", async (context) => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=csrf-token" },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "document");
  });
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(String(input), "/api/exomem/download");
      assert.deepEqual(JSON.parse(String(init.body)), { path: "Evidence/proof.txt" });
      return Response.json({
        success: true,
        data: {
          url: "https://transfer.example.test/cells/cell-alpha/public/exomem/v2/transfers/download",
          method: "GET",
          headers: { "X-Exomem-Transfer-Grant": "download-grant" },
          expiresAt: "2026-07-14T12:05:00.000Z",
          maxBytes: 5368709120,
          requestId: "request-2",
        },
      });
    }
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).get("x-exomem-transfer-grant"), "download-grant");
    return new Response("download bytes", {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "14",
        "content-disposition":
          "attachment; filename=\"exomem-download\"; filename*=UTF-8''proof.txt",
      },
    });
  };

  const response = await getPrivateFile("Evidence/proof.txt");
  assert.equal(await response.text(), "download bytes");
  assert.equal(calls, 2);
});

test("file downloads require the exact bounded runtime response contract", async (context) => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=csrf-token" },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "document");
  });
  const invalidResponses = [
    new Response("bytes", {
      status: 201,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "5",
        "content-disposition":
          "attachment; filename=\"exomem-download\"; filename*=UTF-8''proof.txt",
      },
    }),
    new Response("bytes", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": "5",
        "content-disposition":
          "attachment; filename=\"exomem-download\"; filename*=UTF-8''proof.txt",
      },
    }),
    new Response("bytes", {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "6",
        "content-disposition":
          "attachment; filename=\"exomem-download\"; filename*=UTF-8''proof.txt",
      },
    }),
    new Response("bytes", {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": "5" },
    }),
  ];

  for (const invalidResponse of invalidResponses) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          success: true,
          data: {
            url: "https://transfer.example.test/cells/cell-alpha/public/exomem/v2/transfers/download",
            method: "GET",
            headers: { "X-Exomem-Transfer-Grant": "download-grant" },
            maxBytes: 5,
          },
        });
      }
      return invalidResponse;
    };
    await assert.rejects(getPrivateFile("Evidence/proof.txt"), (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "HostedBrowserError");
      return true;
    });
    assert.equal(calls, 2);
  }
});

test("file uploads reject the hosted size cap before hashing or fetching", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetched = false;
  let hashed = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("must not fetch");
  };
  const file = new File(["small"], "oversize.bin", { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: 90 * 1024 * 1024 + 1 });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => {
      hashed = true;
      return new ArrayBuffer(0);
    },
  });

  await assert.rejects(postPrivateFile(file), (error: unknown) => {
    assert.equal(error instanceof Error && error.name, "HostedBrowserError");
    assert.equal(error instanceof Error && "code" in error && error.code, "TRANSFER_TOO_LARGE");
    return true;
  });
  assert.equal(hashed, false);
  assert.equal(fetched, false);
});
