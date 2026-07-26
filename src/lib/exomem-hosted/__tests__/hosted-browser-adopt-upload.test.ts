import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HostedBrowserError, postAdoptionFile } from "../hosted-browser";

const TICKET_URL = "https://transfer.example.test/cells/cell-a/public/exomem/v2/transfers/upload";

type RecordedCall = { url: string; init: RequestInit };

function withUploadFetch(
  context: { after: (callback: () => void) => void },
  calls: RecordedCall[],
  commitProof: (metadata: Record<string, unknown>) => Record<string, unknown>
): void {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=csrf-token" },
  });
  context.after(() => {
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, "document");
  });
  let metadata: Record<string, unknown> = {};
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "/api/exomem/adopt/upload") {
      metadata = (JSON.parse(String(init.body)) as { metadata: Record<string, unknown> }).metadata;
      return Response.json({
        success: true,
        data: {
          url: TICKET_URL,
          method: "PUT",
          headers: {
            "X-Exomem-Transfer-Grant": "signed-staging-grant",
            "Content-Type": metadata.content_type,
          },
          expiresAt: "2026-07-16T12:05:00.000Z",
          maxBytes: 94371840,
          requestId: "request-1",
        },
      });
    }
    return new Response(JSON.stringify({ success: true, data: commitProof(metadata) }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
}

test("postAdoptionFile mints a run-bound ticket, PUTs directly, and verifies the commit proof", async (context) => {
  const bytes = new TextEncoder().encode("adoption staging bytes");
  const file = new File([bytes], "notes.zip", { type: "application/zip" });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const calls: RecordedCall[] = [];
  withUploadFetch(context, calls, (metadata) => ({
    bytes: metadata.size,
    committed: true,
    operation: "upload",
    sha256: metadata.sha256,
  }));

  const proof = await postAdoptionFile(file, "run-1", "Notes/inbox");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/exomem/adopt/upload");
  assert.equal(new Headers(calls[0].init.headers).get("x-exomem-csrf"), "csrf-token");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    metadata: {
      content_type: "application/zip",
      filename: "notes.zip",
      path: "Notes/inbox",
      run_id: "run-1",
      sha256,
      size: file.size,
    },
  });

  assert.equal(calls[1].url, TICKET_URL);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.credentials, "omit");
  assert.equal(calls[1].init.redirect, "error");
  const putHeaders = new Headers(calls[1].init.headers);
  assert.equal(putHeaders.get("X-Exomem-Transfer-Grant"), "signed-staging-grant");
  assert.equal(putHeaders.get("Content-Type"), "application/zip");
  assert.equal(calls[1].init.body, file);

  const data = proof.data as Record<string, unknown>;
  assert.equal(data.committed, true);
  assert.equal(data.sha256, sha256);
});

test("postAdoptionFile sends a null staging path when no subdirectory is given", async (context) => {
  const file = new File([new TextEncoder().encode("plain")], "note.md", { type: "text/markdown" });
  const calls: RecordedCall[] = [];
  withUploadFetch(context, calls, (metadata) => ({
    bytes: metadata.size,
    committed: true,
    operation: "upload",
    sha256: metadata.sha256,
  }));

  await postAdoptionFile(file, "run-2");

  const body = JSON.parse(String(calls[0].init.body)) as { metadata: Record<string, unknown> };
  assert.equal(body.metadata.path, null);
  assert.equal(body.metadata.run_id, "run-2");
  assert.equal(body.metadata.content_type, "text/markdown");
});

test("postAdoptionFile rejects a commit proof that does not match the staged bytes", async (context) => {
  const file = new File([new TextEncoder().encode("mismatch")], "note.md", {
    type: "text/markdown",
  });
  const calls: RecordedCall[] = [];
  withUploadFetch(context, calls, (metadata) => ({
    bytes: metadata.size,
    committed: true,
    operation: "upload",
    sha256: "f".repeat(64),
  }));

  await assert.rejects(postAdoptionFile(file, "run-3"), (error: unknown) => {
    assert.equal(error instanceof HostedBrowserError, true);
    assert.equal((error as HostedBrowserError).status, 502);
    return true;
  });
});

test("postAdoptionFile refuses oversized files before any network call", async (context) => {
  const file = new File([new Uint8Array(1)], "big.bin", { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: 90 * 1024 * 1024 + 1 });
  const calls: RecordedCall[] = [];
  withUploadFetch(context, calls, () => ({}));

  await assert.rejects(postAdoptionFile(file, "run-4"), (error: unknown) => {
    assert.equal((error as HostedBrowserError).code, "TRANSFER_TOO_LARGE");
    return true;
  });
  assert.equal(calls.length, 0);
});
