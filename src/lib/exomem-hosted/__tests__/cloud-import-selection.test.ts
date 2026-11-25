import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  ZipWriter,
} from "@zip.js/zip.js/index-native.js";
import {
  addToSelection,
  GITIGNORE_MAX_BYTES,
  pickedFromFiles,
  selectImportFiles,
  selectionCollection,
  type PickedItem,
} from "../cloud-import-selection";

function folder(name: string, files: [string, string][]): PickedItem {
  return {
    kind: "folder",
    name,
    files: files.map(([path, body]) => ({ path, file: new File([body], path.split("/").at(-1)!) })),
  };
}

async function zipFile(
  name: string,
  entries: { name: string; body: string; password?: string }[],
  options: { zip64?: boolean } = {}
): Promise<File> {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, ...options });
  for (const entry of entries)
    await writer.add(entry.name, new TextReader(entry.body), { password: entry.password });
  return new File([await writer.close()], name);
}

async function text(blob: { stream(): ReadableStream<Uint8Array> }): Promise<string> {
  return new Response(blob.stream()).text();
}

test("hidden items and the folder's own .gitignore rules stay out with their reasons", async () => {
  const parts = await addToSelection(
    [],
    [
      folder("Workspace", [
        [".gitignore", "build/\n*.log\n"],
        ["notes/plan.md", "plan"],
        ["notes/today.log", "log line"],
        ["build/out.js", "bundle"],
        // An excluded folder's own rules never apply, so this negation re-includes nothing.
        ["build/.gitignore", "!keep.js\n"],
        ["build/keep.js", "kept?"],
        // A deeper .gitignore overrides a shallower one, including by negation.
        ["drafts/.gitignore", "*\n!keep.md\n"],
        ["drafts/scratch.md", "scratch"],
        ["drafts/keep.md", "keep"],
        [".cache/index", "cache"],
        // Hidden and matched by .gitignore: left out once, as hidden.
        [".env.log", "secret-shaped"],
      ]),
    ]
  );

  const byDefault = selectImportFiles(parts, { gitignored: false });
  assert.deepEqual(
    byDefault.files.map(({ path }) => path),
    ["Workspace/notes/plan.md", "Workspace/drafts/keep.md"]
  );
  assert.deepEqual(byDefault.included, { files: 2, bytes: 8 });
  const reasons = Object.fromEntries(byDefault.leftOut.map(({ path, reason }) => [path, reason]));
  assert.deepEqual(reasons, {
    "Workspace/.gitignore": "hidden",
    "Workspace/notes/today.log": "gitignored",
    "Workspace/build/out.js": "gitignored",
    "Workspace/build/.gitignore": "hidden",
    "Workspace/build/keep.js": "gitignored",
    "Workspace/drafts/.gitignore": "hidden",
    "Workspace/drafts/scratch.md": "gitignored",
    "Workspace/.cache/index": "hidden",
    "Workspace/.env.log": "hidden",
  });
  assert.deepEqual(byDefault.gitignored, { files: 4, bytes: 26 });

  // Bringing .gitignore's items back never brings hidden ones.
  const everything = selectImportFiles(parts, { gitignored: true });
  assert.equal(everything.files.length, 6);
  assert.ok(everything.leftOut.every(({ reason }) => reason === "hidden"));
  assert.equal(selectionCollection(parts), "Workspace");
});

test("a .gitignore too large to read as rules is not applied, and the selection says so", async () => {
  const oversized = new File([new Uint8Array(GITIGNORE_MAX_BYTES + 1).fill(0x2a)], ".gitignore");
  const parts = await addToSelection(
    [],
    [
      {
        kind: "folder",
        name: "Workspace",
        files: [
          { path: ".gitignore", file: oversized },
          { path: "notes/plan.md", file: new File(["plan"], "plan.md") },
        ],
      },
    ]
  );
  const selection = selectImportFiles(parts, { gitignored: false });
  assert.deepEqual(
    selection.files.map(({ path }) => path),
    ["Workspace/notes/plan.md"]
  );
  assert.equal(selection.skippedRules, 1);
});

test("a zip and two loose files: the zip's entries under its stem, its unreadable entries left out with reasons", async () => {
  const zip = await zipFile("notes.zip", [
    { name: "plan.md", body: "plan" },
    { name: "journal/day.md", body: "day" },
    { name: ".DS_Store", body: "finder" },
    { name: "private.txt", body: "secret", password: "synthetic" },
  ]);
  const parts = await addToSelection(
    [],
    [
      { kind: "file", file: zip },
      { kind: "file", file: new File(["%PDF-1"], "contract.pdf") },
      { kind: "file", file: new File(["%PDF-2"], "invoice.pdf") },
    ]
  );
  const selection = selectImportFiles(parts, { gitignored: false });
  assert.deepEqual(
    selection.files.map(({ path }) => path),
    ["notes/plan.md", "notes/journal/day.md", "contract.pdf", "invoice.pdf"]
  );
  assert.equal(await text(selection.files[0].file), "plan");
  assert.deepEqual(
    selection.leftOut.map(({ path, reason }) => [path, reason]),
    [
      ["notes/private.txt", "zip-encrypted"],
      ["notes/.DS_Store", "hidden"],
    ]
  );
  assert.deepEqual(
    selection.parts.map(({ name, kind, source, included }) => [name, kind, source, included.files]),
    [
      ["notes", "zip", "notes.zip", 2],
      ["contract.pdf", "file", "contract.pdf", 1],
      ["invoice.pdf", "file", "invoice.pdf", 1],
    ]
  );
  // Loose files and mixed picks give no collection name of their own.
  assert.equal(selectionCollection(parts), null);
});

test("a ZIP64 zip expands, and an entry with a compression method the reader lacks is left out", async () => {
  const zip64 = await zipFile("big.zip", [{ name: "a.md", body: "alpha" }], { zip64: true });
  // A stored entry, its method then set to 12 (bzip2) in the local and central headers.
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add("b.md", new Uint8ArrayReader(new TextEncoder().encode("bravo")), { level: 0 });
  const bytes = new Uint8Array(await (await writer.close()).arrayBuffer());
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) view.setUint16(offset + 8, 12, true);
    if (signature === 0x02014b50) view.setUint16(offset + 10, 12, true);
  }
  const parts = await addToSelection(
    [],
    [
      { kind: "file", file: zip64 },
      { kind: "file", file: new File([bytes], "packed.zip") },
    ]
  );
  const selection = selectImportFiles(parts, { gitignored: false });
  assert.deepEqual(
    selection.files.map(({ path }) => path),
    ["big/a.md"]
  );
  assert.equal(await text(selection.files[0].file), "alpha");
  assert.deepEqual(selection.leftOut, [{ path: "packed/b.md", bytes: 5, reason: "zip-unsupported" }]);
});

test("a .docx is sent whole, a damaged zip is left out, and a zip in a folder expands in place", async () => {
  const container = await zipFile("ignored.zip", [{ name: "word/document.xml", body: "<w/>" }]);
  const parts = await addToSelection(
    [],
    [
      { kind: "file", file: new File([container], "report.docx") },
      { kind: "file", file: new File(["not a zip"], "broken.zip") },
      {
        kind: "folder",
        name: "Takeout",
        files: [
          { path: "Drive/export.zip", file: await zipFile("export.zip", [{ name: "x.md", body: "x" }]) },
          // A real folder already holds the zip's stem, so the zip takes a numbered one.
          { path: "Drive/export/kept.md", file: new File(["kept"], "kept.md") },
        ],
      },
    ]
  );
  const selection = selectImportFiles(parts, { gitignored: false });
  assert.deepEqual(
    selection.files.map(({ path }) => path),
    ["report.docx", "Takeout/Drive/export/kept.md", "Takeout/Drive/export (2)/x.md"]
  );
  assert.deepEqual(selection.leftOut, [{ path: "broken.zip", bytes: 9, reason: "zip-unreadable" }]);
});

test("the same photo chosen twice is kept once; another file of the same name is numbered", async () => {
  const photo = new File(["pixels"], "IMG_0001.HEIC", { lastModified: 1_700_000_000_000 });
  const first = await addToSelection([], pickedFromFiles([photo]));
  const again = await addToSelection(first, [
    { kind: "file", file: photo },
    { kind: "file", file: new File(["other"], "IMG_0001.HEIC", { lastModified: 1 }) },
  ]);
  assert.deepEqual(
    selectImportFiles(again, { gitignored: false }).files.map(({ path }) => path),
    ["IMG_0001.HEIC", "IMG_0001 (2).HEIC"]
  );
});

test("a folder picker's files group under their folder; loose picks stay loose", () => {
  const nested = new File(["n"], "note.md");
  Object.defineProperty(nested, "webkitRelativePath", { value: "Workspace/notes/note.md" });
  const loose = new File(["l"], "loose.md");
  const items = pickedFromFiles([nested, loose]);
  assert.deepEqual(items, [
    { kind: "folder", name: "Workspace", files: [{ path: "notes/note.md", file: nested }] },
    { kind: "file", file: loose },
  ]);
});
