import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { BrowserImportUpload } from "../cloud-import-browser-upload";
import { encryptImportToBrowserFile } from "../cloud-import-browser-file";

test("an interrupted browser import resumes its ciphertext and receipts, then reports importing rather than done", async () => {
  const recipient = await identityToRecipient(await generateIdentity());
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let removed = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            getFileHandle: async () => ({
              createWritable: async () =>
                new WritableStream<Uint8Array>({
                  write: (chunk) => {
                    chunks.push(Uint8Array.from(chunk));
                  },
                }),
              getFile: async () => new File(chunks, "encrypted.age"),
            }),
            removeEntry: async () => {
              removed += 1;
            },
          }),
        }),
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=synthetic" },
  });
  let operation: Record<string, unknown> | undefined;
  let firstFailure = true;
  const uploads: { part: string; bytes: Uint8Array }[] = [];
  const createIds: string[] = [];
  const receive: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path.startsWith("https://storage.example.test/")) {
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.headers, undefined);
      assert.ok(init?.body instanceof Blob);
      uploads.push({ part: path, bytes: new Uint8Array(await init.body.arrayBuffer()) });
      if (path.endsWith("/2") && firstFailure) {
        firstFailure = false;
        return new Response(null, { status: 503 });
      }
      return new Response(null, {
        headers: { etag: path.endsWith("/1") ? '"first"' : '"second"' },
      });
    }
    assert.equal(init?.credentials, "same-origin");
    const body = JSON.parse(String(init?.body));
    if (path === "/api/exomem/cloud/imports") {
      createIds.push(body.import_id);
      operation ??= {
        ...body,
        requested_state: "requested",
        observed_state: "key_ready",
        recipient,
        part_urls: null,
        urls_expire_at: null,
        error_code: null,
        ciphertext_sha256: null,
        ciphertext_bytes: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
    } else if (operation && path.endsWith("/prepare-upload")) {
      if (operation.ciphertext_sha256)
        assert.equal(body.ciphertext_sha256, operation.ciphertext_sha256);
      Object.assign(operation, body, {
        urls_expire_at: new Date(Date.now() + 60_000).toISOString(),
        part_urls: [
          { part_number: 1, url: "https://storage.example.test/1", part_size_bytes: 128 },
          {
            part_number: 2,
            url: "https://storage.example.test/2",
            part_size_bytes: body.ciphertext_bytes - 128,
          },
        ],
      });
    } else if (operation && path.endsWith("/complete")) {
      assert.deepEqual(body.part_etags, [
        { part_number: 1, etag: '"first"' },
        { part_number: 2, etag: '"second"' },
      ]);
      Object.assign(operation, { requested_state: "uploaded", observed_state: "importing" });
    } else throw new Error(`Unexpected synthetic request: ${path}`);
    return Response.json({ import: operation });
  };
  const network = mock.method(globalThis, "fetch", receive);
  const upload = new BrowserImportUpload(
    [{ path: "notes/plan.md", file: new File(["A synthetic plan."], "plan.md") }],
    "synthetic"
  );
  const observations: string[] = [];
  try {
    await assert.rejects(
      upload.resume(
        (value) => observations.push(value.observed_state),
        () => {}
      ),
      /paused/
    );
    assert.equal(removed, 0);
    await upload.resume(
      (value) => observations.push(value.observed_state),
      () => {}
    );
    assert.equal(createIds.length, 2);
    assert.equal(createIds[0], createIds[1]);
    assert.equal(uploads.filter(({ part }) => part.endsWith("/1")).length, 1);
    assert.deepEqual(uploads[1].bytes, uploads[2].bytes);
    assert.equal(observations.at(-1), "importing");
    assert.equal(removed, 1);
  } finally {
    await upload.dispose();
    network.mock.restore();
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a browser storage refusal removes the new ciphertext entry before returning the failure", async () => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let removed = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            getFileHandle: async () => ({
              createWritable: async () => {
                throw new DOMException("Storage full", "QuotaExceededError");
              },
            }),
            removeEntry: async () => {
              removed += 1;
            },
          }),
        }),
      },
    },
  });
  try {
    await assert.rejects(encryptImportToBrowserFile([], "unused"), { name: "QuotaExceededError" });
    assert.equal(removed, 1);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("pausing an import aborts its pending account request before encryption starts", async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=synthetic" },
  });
  let reached: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const receive: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      reached();
    });
  const network = mock.method(globalThis, "fetch", receive);
  const upload = new BrowserImportUpload(
    [{ path: "note.md", file: new File(["Synthetic"], "note.md") }],
    "synthetic"
  );
  try {
    const result = upload.resume(
      () => {},
      () => {}
    );
    const stopped = assert.rejects(result, { name: "AbortError" });
    await requested;
    upload.pause();
    await stopped;
    assert.equal(network.mock.callCount(), 1);
  } finally {
    await upload.dispose();
    network.mock.restore();
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
