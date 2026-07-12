import assert from "node:assert/strict";
import test from "node:test";
import { inferMemoryTitle, postPrivateFile } from "../hosted-browser";

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

test("file uploads carry a caller-stable idempotency key", async (context) => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=csrf-token" },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "document");
  });
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("idempotency-key"), "upload-retry-1");
    assert.equal(headers.get("x-exomem-csrf"), "csrf-token");
    return Response.json({ success: true, data: { path: "Evidence/inbox/uploads/proof.txt" } });
  };

  const result = await postPrivateFile(
    new File(["same bytes"], "proof.txt", { type: "text/plain" }),
    { idempotencyKey: "upload-retry-1" }
  );
  assert.equal((result.data as { path: string }).path, "Evidence/inbox/uploads/proof.txt");
});
