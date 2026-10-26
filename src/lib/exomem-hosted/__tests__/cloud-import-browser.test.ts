import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { createTarDecoder } from "modern-tar";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  encryptImportFiles,
  folderImportFiles,
  forecastImport,
  uploadImportParts,
  type EncryptionProgress,
} from "../cloud-import-browser";

test("browser encryption preserves selected Unicode paths, binary bytes and empty files", async () => {
  const identity = await generateIdentity();
  const selected = [
    { path: "計画/ノート.md", file: new File(["次の作業を確認する。"], "ノート.md") },
    { path: "assets/image.bin", file: new File([new Uint8Array([0, 255, 1, 128])], "image.bin") },
    { path: "empty.md", file: new File([], "empty.md") },
  ];
  const chunks: Buffer[] = [];
  const report = await encryptImportFiles(
    selected,
    await identityToRecipient(identity),
    new WritableStream({
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
    })
  );
  const ciphertext = Buffer.concat(chunks);
  assert.equal(report.ciphertext_bytes, ciphertext.length);
  assert.equal(report.ciphertext_sha256, Buffer.from(sha256(ciphertext)).toString("hex"));
  assert.equal(ciphertext.includes(Buffer.from("次の作業")), false);
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const plaintext = await decrypter.decrypt(ciphertext);
  const decoded = new Blob([Uint8Array.from(plaintext)])
    .stream()
    .pipeThrough(createTarDecoder({ strict: true }));
  const actual = new Map<string, Buffer>();
  const reader = decoded.getReader();
  try {
    for (;;) {
      const { value: entry, done } = await reader.read();
      if (done) break;
      actual.set(entry.header.name, Buffer.from(await new Response(entry.body).arrayBuffer()));
    }
  } finally {
    reader.releaseLock();
  }
  assert.deepEqual(
    [...actual.keys()],
    selected.map(({ path }) => path)
  );
  for (const { path, file } of selected) {
    assert.deepEqual(actual.get(path), Buffer.from(await file.arrayBuffer()));
  }
});

test("the forecast before the key exists is the exact ciphertext size, and progress ends at every total", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  // Long and non-ASCII names take extra TAR header blocks; sizes straddle 512-byte blocks.
  const selected = [
    { path: `${"長い名前/".repeat(30)}note.md`, file: new File([new Uint8Array(513)], "note.md") },
    { path: `deep/${"x".repeat(150)}.bin`, file: new File([new Uint8Array(70_000)], "x.bin") },
    { path: "empty.md", file: new File([], "empty.md") },
  ];
  const before = await forecastImport(selected);
  const progress: EncryptionProgress[] = [];
  const report = await encryptImportFiles(
    selected,
    recipient,
    new WritableStream(),
    undefined,
    (value) => progress.push(value)
  );
  assert.equal(before.ciphertextBytes, report.ciphertext_bytes);
  assert.deepEqual(await forecastImport(selected, recipient), before);
  assert.deepEqual(progress.at(-1), {
    files: 3,
    plaintextBytes: 513 + 70_000,
    ciphertextBytes: report.ciphertext_bytes,
  });
});

test("failed storage parts retry the same bytes without forwarding session credentials", async () => {
  const ciphertext = new Blob([new Uint8Array([11, 22, 33, 44])]);
  const parts = [
    { part_number: 1, url: "https://storage.example.test/part1", part_size_bytes: 2 },
    { part_number: 2, url: "https://storage.example.test/part2", part_size_bytes: 2 },
  ];
  const requests: { url: string; body: number[] }[] = [];
  let failed = false;
  const receive: typeof fetch = async (input, init) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.headers, undefined);
    assert.ok(init?.body instanceof Blob);
    requests.push({ url: String(input), body: [...new Uint8Array(await init.body.arrayBuffer())] });
    if (String(input).endsWith("part2") && !failed) {
      failed = true;
      return new Response(null, { status: 503 });
    }
    return new Response(null, {
      headers: { etag: String(input).endsWith("part1") ? '"one"' : '"two"' },
    });
  };
  const storage = mock.method(globalThis, "fetch", receive);
  try {
    const completed = new Map<number, string>();
    await assert.rejects(
      uploadImportParts(ciphertext, parts, completed, () => {}),
      {
        code: "STORAGE_REFUSED",
      }
    );
    assert.deepEqual([...completed], [[1, '"one"']]);
    const progress: number[] = [];
    assert.deepEqual(
      await uploadImportParts(ciphertext, parts, completed, (bytes) => progress.push(bytes)),
      [
        { part_number: 1, etag: '"one"' },
        { part_number: 2, etag: '"two"' },
      ]
    );
    assert.deepEqual(
      requests.map(({ body }) => body),
      [
        [11, 22],
        [33, 44],
        [33, 44],
      ]
    );
    assert.equal(progress.at(-1), ciphertext.size);
  } finally {
    storage.mock.restore();
  }
});

test("a substituted part layout is refused before uploading any bytes", async () => {
  const storage = mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected upload");
  });
  try {
    await assert.rejects(
      uploadImportParts(
        new Blob(["ciphertext"]),
        [{ part_number: 2, url: "https://storage.example.test/wrong-part", part_size_bytes: 10 }],
        new Map(),
        () => {}
      ),
      { code: "DESTINATION" }
    );
    assert.equal(storage.mock.callCount(), 0);
  } finally {
    storage.mock.restore();
  }
});

test("folder selection retains nested paths without importing its enclosing folder", () => {
  const file = new File(["content"], "note.md");
  Object.defineProperty(file, "webkitRelativePath", { value: "selected/notes/note.md" });
  assert.deepEqual(folderImportFiles([file]), [{ path: "notes/note.md", file }]);
});

test(
  "a failed ciphertext sink does not leave the TAR producer waiting",
  { timeout: 5_000 },
  async () => {
    const identity = await generateIdentity();
    await assert.rejects(
      encryptImportFiles(
        [{ path: "note.md", file: new File([new Uint8Array(1024 * 1024)], "note.md") }],
        await identityToRecipient(identity),
        new WritableStream({
          write() {
            throw new Error("ciphertext storage is full");
          },
        })
      ),
      /ciphertext storage is full/
    );
  }
);
