import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";
import {
  BrowserImportUpload,
  keptCopyRetired,
  type ImportProgress,
} from "../cloud-import-browser-upload";
import { encryptImportToBrowserFile, writeImportPartReceipts } from "../cloud-import-browser-file";
import { browserStorageDouble, importApiDouble, webLocksDouble } from "./browser-import-doubles";

const ACCOUNT = "SYNTH1";
// Where this account's kept copies live in the browser's private storage.
const KEPT = ["exomem-import-uploads", `account-${ACCOUNT}`] as const;

const globals = ["navigator", "document"] as const;
let saved: (PropertyDescriptor | undefined)[] = [];
beforeEach(() => {
  saved = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=synthetic" },
  });
});
afterEach(() => {
  mock.restoreAll();
  globals.forEach((key, index) => {
    if (saved[index]) Object.defineProperty(globalThis, key, saved[index]);
    else Reflect.deleteProperty(globalThis, key);
  });
});

function useBrowserStorage(quota?: number) {
  const browser = browserStorageDouble(quota);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: browser.storage, locks: webLocksDouble().locks },
  });
  return { ...browser, kept: () => browser.files(...KEPT) };
}

function browserUpload(files: ReturnType<typeof folder> | null, importId?: string) {
  return new BrowserImportUpload({ files, csrfToken: "synthetic", account: ACCOUNT, importId });
}

const folder = () => [
  { path: "notes/plan.md", file: new File(["A synthetic plan. ".repeat(40)], "plan.md") },
  { path: "notes/empty.md", file: new File([], "empty.md") },
];

test("an interrupted part upload resumes the same ciphertext and receipts, then reports importing", async () => {
  const browser = useBrowserStorage();
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const upload = browserUpload(folder());
  const observations: string[] = [];
  const progress: ImportProgress[] = [];
  api.refusePartOnce(2);

  await assert.rejects(
    upload.resume(
      (value) => observations.push(value.observed_state),
      (value) => progress.push(value)
    ),
    { code: "STORAGE_REFUSED" }
  );
  assert.equal([...browser.kept().keys()].filter((name) => name.endsWith(".age")).length, 1);
  await upload.resume(
    (value) => observations.push(value.observed_state),
    (value) => progress.push(value)
  );

  const creates = api.requests.filter(({ path }) => path === "/api/exomem/cloud/imports");
  assert.equal(creates.length, 2);
  assert.equal(creates[0].body?.import_id, creates[1].body?.import_id);
  const firstPart = api.parts.filter(({ url }) => url.endsWith("/1"));
  assert.equal(firstPart.length, 1);
  const secondPart = api.parts.filter(({ url }) => url.endsWith("/2"));
  assert.deepEqual(secondPart[0].bytes, secondPart[1].bytes);
  assert.equal(observations.at(-1), "importing");
  assert.equal(browser.kept().size, 0);
  const encrypted = progress.filter((value) => value.phase === "encrypting").at(-1);
  assert.ok(encrypted?.phase === "encrypting");
  assert.equal(encrypted.files, encrypted.totalFiles);
  assert.equal(encrypted.plaintextBytes, encrypted.totalPlaintextBytes);
  assert.equal(encrypted.ciphertextBytes, encrypted.totalCiphertextBytes);
  const row = [...api.rows.values()][0];
  assert.equal(encrypted.totalCiphertextBytes, row.ciphertext_bytes);
});

test("a reload resumes at the next unrecorded part and removes the durable receipt with the copy", async () => {
  const browser = useBrowserStorage();
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const first = browserUpload(folder());
  api.refusePartOnce(2);
  await assert.rejects(
    first.resume(
      () => {},
      () => {}
    ),
    { code: "STORAGE_REFUSED" }
  );
  const receipt = browser.kept().get(`${first.id}.parts.json`)!;
  assert.ok(receipt);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(receipt[0])).parts, [
    { part_number: 1, etag: '"1"' },
  ]);
  const prior = api.parts.length;
  await browserUpload(null, first.id).resume(
    () => {},
    () => {}
  );
  assert.ok(api.parts.slice(prior).every(({ url }) => !url.endsWith("/1")));
  assert.equal(api.parts.filter(({ url }) => url.endsWith("/1")).length, 1);
  assert.equal(browser.kept().size, 0);
});

test("a receipt for different ciphertext never skips a part of the verified copy", async () => {
  const browser = useBrowserStorage();
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const first = browserUpload(folder());
  api.refusePartOnce(2);
  await assert.rejects(
    first.resume(
      () => {},
      () => {}
    ),
    { code: "STORAGE_REFUSED" }
  );
  await writeImportPartReceipts(ACCOUNT, first.id, "f".repeat(64), [
    { part_number: 1, etag: "unrelated" },
  ]);
  await browserUpload(null, first.id).resume(
    () => {},
    () => {}
  );
  assert.equal(api.parts.filter(({ url }) => url.endsWith("/1")).length, 2);
  assert.equal(browser.kept().size, 0);
});

test("a browser storage refusal leaves no ciphertext entry behind", async () => {
  const browser = browserStorageDouble();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        ...browser.storage,
        getDirectory: async () => {
          const root = await browser.storage.getDirectory();
          const uploads = await root.getDirectoryHandle(KEPT[0], { create: true });
          const account = await uploads.getDirectoryHandle(KEPT[1], { create: true });
          // The account folder refuses every write, as a full browser does.
          const refusing = {
            ...account,
            getFileHandle: async (name: string, options?: { create?: boolean }) => ({
              ...(await account.getFileHandle(name, options)),
              createWritable: async () => {
                throw new DOMException("Storage full", "QuotaExceededError");
              },
            }),
          };
          return { getDirectoryHandle: async () => ({ getDirectoryHandle: async () => refusing }) };
        },
      },
    },
  });
  await assert.rejects(encryptImportToBrowserFile(ACCOUNT, crypto.randomUUID(), [], "unused"), {
    name: "QuotaExceededError",
  });
  assert.equal(browser.files(...KEPT).size, 0);
});

test("pausing an import aborts its pending account request before encryption starts", async () => {
  let reached: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const network = mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        reached();
      })
  );
  const upload = browserUpload(folder());
  const result = upload.resume(
    () => {},
    () => {}
  );
  const stopped = assert.rejects(result, { name: "AbortError" });
  await requested;
  upload.pause();
  await stopped;
  assert.equal(network.mock.callCount(), 1);
});

test("before its report, a reloaded page continues the same import from the folder chosen again", async () => {
  const browser = useBrowserStorage();
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const first = browserUpload(folder());
  // The first page goes away while it encrypts.
  await assert.rejects(
    first.resume(
      () => {},
      (value) => {
        if (value.phase === "encrypting") first.pause();
      }
    ),
    { name: "AbortError" }
  );
  assert.equal(api.rows.get(first.id)?.ciphertext_sha256, null);

  const again = browserUpload(folder(), first.id);
  await again.resume(
    () => {},
    () => {}
  );

  assert.equal(api.rows.size, 1);
  assert.equal(api.rows.get(first.id)?.requested_state, "uploaded");
  assert.equal(browser.kept().size, 0);
});

test("after its report, a reloaded page uploads the kept ciphertext only when it matches the report", async () => {
  const browser = useBrowserStorage();
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const first = browserUpload(folder());
  api.refusePartOnce(1);
  await assert.rejects(
    first.resume(
      () => {},
      () => {}
    ),
    { code: "STORAGE_REFUSED" }
  );
  const reported = api.rows.get(first.id)!;
  assert.notEqual(reported.ciphertext_sha256, null);
  const [name] = browser.kept().keys();
  const kept = browser.kept().get(name)!;

  // A different file of the same size in the import's place is refused before any upload.
  const bytes = kept.reduce((total, chunk) => total + chunk.byteLength, 0);
  browser.kept().set(name, [new Uint8Array(bytes)]);
  const before = { requests: api.requests.length, parts: api.parts.length };
  await assert.rejects(
    browserUpload(null, first.id).resume(
      () => {},
      () => {}
    ),
    { code: "LOCAL_COPY_CHANGED" }
  );
  assert.equal(api.parts.length, before.parts);
  assert.ok(
    api.requests.slice(before.requests).every(({ path }) => !path.endsWith("/prepare-upload"))
  );

  browser.kept().set(name, kept);
  const progress: ImportProgress[] = [];
  await browserUpload(null, first.id).resume(
    () => {},
    (value) => progress.push(value)
  );
  assert.equal(api.rows.get(first.id)?.requested_state, "uploaded");
  const checked = progress.filter((value) => value.phase === "verifying").at(-1);
  assert.ok(checked?.phase === "verifying");
  assert.equal(checked.bytes, reported.ciphertext_bytes);
  assert.equal(browser.kept().size, 0);
});

test("a kept copy counts as retired only when a fresh read shows its import ended or absent", async () => {
  const api = importApiDouble("age1unused");
  const row = (requested_state: string) => ({
    import_id: crypto.randomUUID(),
    kind: "adopt",
    declared_files: 1,
    declared_bytes: 1,
    requested_state,
    observed_state: "key_ready",
    recipient: null,
    part_urls: null,
    urls_expire_at: null,
    error_code: null,
    ciphertext_sha256: null,
    ciphertext_bytes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  const open = row("requested");
  const cancelled = row("cancelled");
  for (const value of [open, cancelled]) api.rows.set(value.import_id, value);
  mock.method(globalThis, "fetch", api.receive);
  assert.equal(await keptCopyRetired("synthetic", open.import_id), false);
  assert.equal(await keptCopyRetired("synthetic", cancelled.import_id), true);
  assert.equal(await keptCopyRetired("synthetic", crypto.randomUUID()), true);
  mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(await keptCopyRetired("synthetic", open.import_id), false);
});

test("an encrypted copy larger than the browser's free space is refused before any ciphertext is written", async () => {
  const browser = useBrowserStorage(1_000);
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const upload = browserUpload(folder());
  await assert.rejects(
    upload.resume(
      () => {},
      () => {}
    ),
    { code: "BROWSER_SPACE" }
  );
  assert.equal(browser.kept().size, 0);
  assert.equal(api.rows.get(upload.id)?.ciphertext_sha256, null);
});
