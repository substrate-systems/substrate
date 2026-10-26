import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { BrowserImportUpload, type ImportProgress } from "../cloud-import-browser-upload";
import { encryptImportToBrowserFile } from "../cloud-import-browser-file";
import { browserStorageDouble, importApiDouble } from "./browser-import-doubles";

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
    value: { storage: browser.storage },
  });
  return browser;
}

const folder = () => [
  { path: "notes/plan.md", file: new File(["A synthetic plan. ".repeat(40)], "plan.md") },
  { path: "notes/empty.md", file: new File([], "empty.md") },
];

test("an interrupted part upload resumes the same ciphertext and receipts, then reports importing", async () => {
  const browser = useBrowserStorage();
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const upload = new BrowserImportUpload(folder(), "synthetic");
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
  assert.equal(browser.files.size, 1);
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
  assert.equal(browser.files.size, 0);
  const encrypted = progress.filter((value) => value.phase === "encrypting").at(-1);
  assert.ok(encrypted?.phase === "encrypting");
  assert.equal(encrypted.files, encrypted.totalFiles);
  assert.equal(encrypted.plaintextBytes, encrypted.totalPlaintextBytes);
  assert.equal(encrypted.ciphertextBytes, encrypted.totalCiphertextBytes);
  const row = [...api.rows.values()][0];
  assert.equal(encrypted.totalCiphertextBytes, row.ciphertext_bytes);
});

test("a browser storage refusal leaves no ciphertext entry behind", async () => {
  const entries = new Set<string>();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            getFileHandle: async (name: string) => {
              entries.add(name);
              return {
                createWritable: async () => {
                  throw new DOMException("Storage full", "QuotaExceededError");
                },
              };
            },
            removeEntry: async (name: string) => {
              entries.delete(name);
            },
          }),
        }),
      },
    },
  });
  await assert.rejects(encryptImportToBrowserFile(crypto.randomUUID(), [], "unused"), {
    name: "QuotaExceededError",
  });
  assert.equal(entries.size, 0);
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
  const upload = new BrowserImportUpload(folder(), "synthetic");
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
  const first = new BrowserImportUpload(folder(), "synthetic");
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

  const again = new BrowserImportUpload(folder(), "synthetic", first.id);
  await again.resume(
    () => {},
    () => {}
  );

  assert.equal(api.rows.size, 1);
  assert.equal(api.rows.get(first.id)?.requested_state, "uploaded");
  assert.equal(browser.files.size, 0);
});

test("after its report, a reloaded page uploads the kept ciphertext only when it matches the report", async () => {
  const browser = useBrowserStorage();
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const first = new BrowserImportUpload(folder(), "synthetic");
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
  const [name] = browser.files.keys();
  const kept = browser.files.get(name)!;

  // A different file of the same size in the import's place is refused before any upload.
  const bytes = kept.reduce((total, chunk) => total + chunk.byteLength, 0);
  browser.files.set(name, [new Uint8Array(bytes)]);
  const before = { requests: api.requests.length, parts: api.parts.length };
  await assert.rejects(
    new BrowserImportUpload(null, "synthetic", first.id).resume(
      () => {},
      () => {}
    ),
    { code: "LOCAL_COPY_CHANGED" }
  );
  assert.equal(api.parts.length, before.parts);
  assert.ok(
    api.requests.slice(before.requests).every(({ path }) => !path.endsWith("/prepare-upload"))
  );

  browser.files.set(name, kept);
  const progress: ImportProgress[] = [];
  await new BrowserImportUpload(null, "synthetic", first.id).resume(
    () => {},
    (value) => progress.push(value)
  );
  assert.equal(api.rows.get(first.id)?.requested_state, "uploaded");
  const checked = progress.filter((value) => value.phase === "verifying").at(-1);
  assert.ok(checked?.phase === "verifying");
  assert.equal(checked.bytes, reported.ciphertext_bytes);
  assert.equal(browser.files.size, 0);
});

test("an encrypted copy larger than the browser's free space is refused before any ciphertext is written", async () => {
  const browser = useBrowserStorage(1_000);
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  mock.method(globalThis, "fetch", api.receive);
  const upload = new BrowserImportUpload(folder(), "synthetic");
  await assert.rejects(
    upload.resume(
      () => {},
      () => {}
    ),
    { code: "BROWSER_SPACE" }
  );
  assert.equal(browser.files.size, 0);
  assert.equal(api.rows.get(upload.id)?.ciphertext_sha256, null);
});
