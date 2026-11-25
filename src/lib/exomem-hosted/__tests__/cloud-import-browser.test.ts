import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { createTarDecoder } from "modern-tar";
import { sha256 } from "@noble/hashes/sha2.js";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js/index-native.js";
import {
  encryptImportFiles,
  forecastImport,
  uploadImportParts,
  type EncryptionProgress,
} from "../cloud-import-browser";
import { importArchive, uploadOrigin } from "../cloud-import-envelope";
import { addToSelection, selectImportFiles, selectionCollection } from "../cloud-import-selection";

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

test("a part whose encrypted copy can no longer be read stops as a lost copy, not as a dropped connection", async () => {
  const parts = [{ part_number: 1, url: "https://storage.example.test/part1", part_size_bytes: 4 }];
  // Fetch reports a body it cannot read, like a dropped connection, as a TypeError.
  const storage = mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  // The browser's file snapshot after its file was removed: reading any slice fails.
  const removed = (size: number): Blob =>
    ({
      size,
      slice: (start = 0, end = size) => removed(Math.min(end, size) - start),
      arrayBuffer: async () => {
        throw new DOMException("The file is gone.", "NotFoundError");
      },
    }) as unknown as Blob;
  try {
    await assert.rejects(
      uploadImportParts(removed(4), parts, new Map(), () => {}),
      {
        code: "LOCAL_COPY_MISSING",
      }
    );
    await assert.rejects(
      uploadImportParts(new Blob([new Uint8Array(4)]), parts, new Map(), () => {}),
      TypeError
    );
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

test("a built archive decrypts to the series file, each member's time and the folder's collection name", async () => {
  const identity = await generateIdentity();
  const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await zip.add("page.md", new TextReader("from the export"), {
    lastModDate: new Date("2024-03-05T10:20:30Z"),
  });
  const plan = new File(["plan"], "plan.md", { lastModified: Date.parse("2025-06-01T08:00:00Z") });
  const parts = await addToSelection(
    [],
    [
      {
        kind: "folder",
        name: "Workspace",
        files: [
          { path: "notes/plan.md", file: plan },
          {
            path: "export.zip",
            file: new File([await zip.close()], "export.zip", { lastModified: 0 }),
          },
          { path: ".obsidian/app.json", file: new File(["{}"], "app.json") },
        ],
      },
    ]
  );
  const selection = selectImportFiles(parts, { gitignored: false });
  const origin = uploadOrigin(
    {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
    "  Notion export  "
  );
  const archive = importArchive(selection, selectionCollection(parts), origin);

  const chunks: Buffer[] = [];
  await encryptImportFiles(
    archive,
    await identityToRecipient(identity),
    new WritableStream({ write: (chunk) => void chunks.push(Buffer.from(chunk)) })
  );
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const plaintext = await decrypter.decrypt(Buffer.concat(chunks));
  const members = new Map<string, { mtime: number; body: string }>();
  const reader = new Blob([Uint8Array.from(plaintext)])
    .stream()
    .pipeThrough(createTarDecoder({ strict: true }))
    .getReader();
  for (;;) {
    const { value: entry, done } = await reader.read();
    if (done) break;
    members.set(entry.header.name, {
      mtime: entry.header.mtime!.getTime(),
      body: await new Response(entry.body).text(),
    });
  }

  assert.deepEqual(
    [...members.keys()],
    [".exomem-series.json", "Workspace/notes/plan.md", "Workspace/export/page.md"]
  );
  assert.deepEqual(JSON.parse(members.get(".exomem-series.json")!.body), {
    label: "Workspace",
    paths: ["Workspace/notes/plan.md", "Workspace/export/page.md"],
    filing: "cell",
    origin: { label: "Notion export", device_family: "phone", browser_family: "safari" },
  });
  assert.equal(members.get("Workspace/notes/plan.md")!.mtime, Date.parse("2025-06-01T08:00:00Z"));
  // A zip member keeps the time the zip records for it.
  assert.equal(members.get("Workspace/export/page.md")!.mtime, Date.parse("2024-03-05T10:20:30Z"));
});

test("loose files name no collection: the person's label stays provenance alone", async () => {
  const parts = await addToSelection(
    [],
    [{ kind: "file", file: new File(["pixels"], "IMG_0001.HEIC") }]
  );
  const selection = selectImportFiles(parts, { gitignored: false });
  const series = await new Response(
    importArchive(
      selection,
      selectionCollection(parts),
      uploadOrigin({ userAgent: "synthetic" }, "My phone")
    )[0].file.stream()
  ).json();
  // A reused label as the collection name would join unrelated uploads as one collection's versions.
  assert.deepEqual(series, {
    paths: ["IMG_0001.HEIC"],
    filing: "cell",
    origin: { label: "My phone", device_family: "other", browser_family: "other" },
  });
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
