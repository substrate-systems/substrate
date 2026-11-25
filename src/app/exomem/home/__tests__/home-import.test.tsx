import assert from "node:assert/strict";
import { after, afterEach, before, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { createTarDecoder } from "modern-tar";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js/index-native.js";
import { importArchive, uploadOrigin } from "../../../../lib/exomem-hosted/cloud-import-envelope";
import {
  addToSelection,
  pickedFromFiles,
  selectImportFiles,
  selectionCollection,
} from "../../../../lib/exomem-hosted/cloud-import-selection";
import {
  browserStorageDouble,
  importApiDouble,
} from "../../../../lib/exomem-hosted/__tests__/browser-import-doubles";

// Home's import dialog runs for real against stand-ins for the browser's private storage, the
// import API with its storage parts, and the cell's filing view. Stylesheets are stood in for,
// since this runner loads no CSS.
before(() => {
  for (const path of [
    "../home.module.css",
    "../home-storage.module.css",
    "../home-import.module.css",
    "../../../../components/exomem/phone.module.css",
    "../../../../components/exomem/Button.module.css",
    "../../../../components/exomem/IconButton.module.css",
    "../../../../components/exomem/Modal.module.css",
    "../../../../components/exomem/Transitions.module.css",
    "../../../../components/exomem/Notice.module.css",
    "../../../../components/exomem/Switch.module.css",
    "../../../../components/exomem/TextField.module.css",
  ])
    mock.module(path, { defaultExport: {} });
  mock.module("next/link", {
    defaultExport: ({ children, href }: { children: ReactNode; href: string }) =>
      createElement("a", { href }, children),
  });
});
after(() => mock.reset());

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** Files as a folder picker gives them: each path starts with the folder's name. */
function folder(name: string, notes: number) {
  return Array.from({ length: notes }, (_, index) => {
    const file = new File([`Synthetic note ${index}. `.repeat(30)], `note-${index}.md`);
    Object.defineProperty(file, "webkitRelativePath", {
      value: `${name}/notes/note-${index}.md`,
    });
    return file;
  });
}

function photos(count: number) {
  return Array.from(
    { length: count },
    (_, index) =>
      new File([new Uint8Array(1000 + index)], `IMG_${String(index + 1).padStart(4, "0")}.HEIC`)
  );
}

const STAGED_ID = "0b8f5c1e-3f0a-4d55-9a57-6c0e2f8d1a42";

/** A C5 adopt import whose upload is staged, so Home reads the cell's filing view for it. */
function staged(api: ReturnType<typeof importApiDouble>) {
  api.rows.set(STAGED_ID, {
    import_id: STAGED_ID,
    kind: "adopt",
    declared_files: 41,
    declared_bytes: 4_200_000,
    requested_state: "uploaded",
    observed_state: "done",
    recipient: null,
    part_urls: null,
    urls_expire_at: null,
    error_code: null,
    ciphertext_sha256: "0".repeat(64),
    ciphertext_bytes: 4_300_000,
    created_at: "2026-11-25T09:00:00Z",
    updated_at: "2026-11-25T09:05:00Z",
  });
}

async function home(options: { quota?: number; api: ReturnType<typeof importApiDouble> }) {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', {
    url: "http://localhost/exomem/home",
  });
  // jsdom has no modal dialogs; the stand-in only opens and closes the element.
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  const browser = browserStorageDouble(options.quota);
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: { userAgent: "synthetic", storage: browser.storage },
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: options.api.receive,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.document.cookie = "exomem_csrf=synthetic";
  // React DOM reads the browser it runs in when it loads, so it loads after the globals.
  const { createRoot } = await import("react-dom/client");
  const { ImportDocuments } = await import("../home-import");
  const root: Root = createRoot(dom.window.document.getElementById("mount")!);
  await act(async () =>
    root.render(
      createElement(ImportDocuments, {
        csrfToken: "synthetic",
        account: "SYNTH1",
        canStart: true,
        storage: null,
        onAccountLost: () => assert.fail("the account stays signed in"),
      })
    )
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };

  const text = () => dom.window.document.body.textContent ?? "";
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll("button")].find(
      (element) => element.textContent === label
    );
  const until = async (ready: () => unknown, what: string) => {
    for (let waited = 0; waited < 5_000; waited += 20) {
      if (ready()) return;
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    assert.fail(`waited for ${what}; the page said: ${text()}`);
  };
  const click = async (label: string) => {
    await until(() => button(label), `the "${label}" button`);
    await act(async () => button(label)!.click());
  };
  /** Chooses through the "Files to add" or "Folder to add" picker, as the browser fills it. */
  const choose = async (files: File[], picker: "Files to add" | "Folder to add") => {
    const selector = `input[aria-label="${picker}"]`;
    await until(() => dom.window.document.querySelector(selector), `the ${picker} input`);
    const input = dom.window.document.querySelector<HTMLInputElement>(selector)!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  };
  const type = async (label: string, value: string) => {
    const field = [...dom.window.document.querySelectorAll("label")].find(
      (element) => element.textContent === label
    );
    const input = dom.window.document.getElementById(field!.htmlFor) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!;
    await act(async () => {
      setter.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const leftOut = () =>
    [...dom.window.document.querySelectorAll("details li")].map((item) => item.textContent);
  return { browser, text, button, until, click, choose, type, leftOut };
}

it("closing the dialog keeps the import running, and a pause shows how to resume", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()), 1 << 20);
  const release = api.holdParts();
  const page = await home({ api });
  await page.click("Add files…");
  await page.choose(folder("research", 12), "Folder to add");
  await page.click("Encrypt and upload");
  await page.until(() => page.text().includes("Uploading the encrypted copy…"), "the upload");

  await page.click("Close");
  await page.until(() => page.text().includes("Uploading:"), "the row's upload state");
  assert.equal(page.button("Close"), undefined);

  await page.click("Add files…");
  await page.click("Pause");
  await page.until(
    () => page.text().includes("Paused. Parts already uploaded from this page are kept."),
    "the paused state"
  );
  assert.ok(page.button("Resume upload"));

  release();
  await page.click("Resume upload");
  await page.until(() => page.text().includes("Checking and staging your files."), "acceptance");
  const [row] = api.rows.values();
  assert.equal(row.requested_state, "uploaded");
  assert.equal(page.browser.files("exomem-import-uploads", "account-SYNTH1").size, 0);
});

it("twelve photos from a phone's picker show twelve files and their total, and all twelve are sent", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  const page = await home({ api });
  await page.click("Add files…");
  const chosen = photos(12);
  await page.choose(chosen, "Files to add");
  const bytes = chosen.reduce((total, file) => total + file.size, 0);
  await page.until(() => page.text().includes(`12 files · ${(bytes / 1000).toFixed(1)} kB`), "totals");
  await page.click("Encrypt and upload");
  await page.until(() => page.text().includes("Checking and staging your files."), "acceptance");
  const [row] = api.rows.values();
  // The archive also carries the series file, which asks the cell to file the import.
  assert.equal(row.declared_files, 13);
});

it("a labelled folder upload states the label and the device in the series file, and the folder names the collection", async () => {
  const identity = await generateIdentity();
  const api = importApiDouble(await identityToRecipient(identity), 1 << 20);
  const page = await home({ api });
  await page.click("Add files…");
  await page.choose(folder("Workspace", 3), "Folder to add");
  await page.until(() => page.button("Encrypt and upload"), "the preflight");
  await page.type("Where is this from?", "Notion export");
  // The label settles into the series file, and the preflight measures that archive again.
  await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
  await page.click("Encrypt and upload");
  await page.until(() => page.text().includes("Checking and staging your files."), "acceptance");

  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const plaintext = await decrypter.decrypt(Buffer.concat(api.parts.map(({ bytes }) => bytes)));
  const reader = new Blob([Uint8Array.from(plaintext)])
    .stream()
    .pipeThrough(createTarDecoder())
    .getReader();
  const { value: first } = await reader.read();
  assert.equal(first!.header.name, ".exomem-series.json");
  assert.deepEqual(JSON.parse(await new Response(first!.body).text()), {
    label: "Workspace",
    paths: [0, 1, 2].map((index) => `Workspace/notes/note-${index}.md`),
    filing: "cell",
    origin: { label: "Notion export", device_family: "other", browser_family: "other" },
  });
  await reader.cancel();
  // The label travels only inside the encrypted archive, never in a request to Evermatter.
  assert.ok(!JSON.stringify(api.requests).includes("Notion export"));
});

it("a zip and two PDFs: the preflight counts the zip's entries under its folder and lists what it leaves out", async () => {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add("plan.md", new TextReader("plan"));
  await writer.add("ideas.md", new TextReader("ideas"));
  await writer.add("private.txt", new TextReader("secret"), { password: "synthetic" });
  const zip = new File([await writer.close()], "notes.zip");
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  const page = await home({ api });
  await page.click("Add files…");
  await page.choose(
    [zip, new File(["%PDF-1"], "contract.pdf"), new File(["%PDF-2"], "invoice.pdf")],
    "Files to add"
  );
  await page.until(() => page.button("Encrypt and upload"), "the preflight");
  assert.match(page.text(), /4 files · 21 bytes/);
  assert.match(page.text(), /notes\/notes\.zip2 files/);
  assert.match(page.text(), /Files2 files/);
  assert.match(page.text(), /Left out: 1/);
  assert.deepEqual(page.leftOut(), ["notes/private.txtEncrypted in the zip"]);
});

it("after a reload, an import without its report continues only from the same files chosen again", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  const picked = folder("research", 3);
  // The open import declared the archive this selection makes: its series file and files.
  const parts = await addToSelection([], pickedFromFiles(picked));
  const archive = importArchive(
    selectImportFiles(parts, { gitignored: false }),
    selectionCollection(parts),
    uploadOrigin({ userAgent: "synthetic" }, "")
  );
  const importId = crypto.randomUUID();
  api.rows.set(importId, {
    import_id: importId,
    kind: "adopt",
    declared_files: archive.length,
    declared_bytes: archive.reduce((total, { file }) => total + file.size, 0),
    requested_state: "requested",
    observed_state: "key_ready",
    recipient: await identityToRecipient(await generateIdentity()),
    part_urls: null,
    urls_expire_at: null,
    error_code: null,
    ciphertext_sha256: null,
    ciphertext_bytes: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  const page = await home({ api });
  await page.click("Add files…");
  await page.until(() => page.text().includes("Choose the same files again"), "the way to continue");

  await page.choose(folder("research", 4), "Folder to add");
  await page.until(
    () => page.text().includes("This selection differs from the open import’s."),
    "the mismatch"
  );
  assert.equal(page.button("Encrypt and continue"), undefined);

  // Removing the wrong pick and choosing the same folder again continues the import.
  await page.click("×");
  await page.choose(picked, "Folder to add");
  await page.click("Encrypt and continue");
  await page.until(() => page.text().includes("Checking and staging your files."), "acceptance");
  assert.equal(api.rows.size, 1);
  assert.equal(api.rows.get(importId)?.requested_state, "uploaded");
});

it("a selection whose encrypted copy cannot fit in this browser is refused before an import exists", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  const page = await home({ api, quota: 2_000 });
  await page.click("Add files…");
  await page.choose(folder("research", 5), "Folder to add");
  await page.until(() => page.text().includes("The encrypted copy needs"), "the refusal");
  assert.match(page.text(), /this browser can store 2 kB more for this site/);
  assert.equal(page.button("Encrypt and upload"), undefined);
  assert.ok(!api.requests.some(({ body }) => body?.kind === "adopt"));
});

// Records as Home's filing route passes them on, in the shape settled with the cell.
const working = {
  state: "working",
  as_of: "2026-11-25T10:00:00Z",
  progress: {
    total: 40,
    filed: 12,
    skipped_duplicates: 1,
    failed: 0,
    left_out: 1,
    remaining: 26,
  },
  left_out: null,
  stop: null,
  needs: [],
  rate: null,
};

const parked = (stop: string, needs: unknown[]) => ({
  ...working,
  state: "parked",
  stop: { code: stop, reason: "The cell's own words for agents." },
  needs,
  person: [{ need: "free_space", text: "The cell's own words for agents." }],
});

// The filing panel branches on the cell's state; each case is one answer and what it must show.
const filingCases: { name: string; answer: unknown; shows: string[]; hides: string[] }[] = [
  {
    name: "working, with a time left only at the cell's measured rate",
    answer: {
      state: "live",
      filing: { ...working, rate: { files_per_minute: 24, over_calls: 3 } },
    },
    shows: [
      "Filing · 12 of 40 files filed · 1 left out",
      "Filed12 of 40 files",
      "Remaining26",
      "Left out1",
      "Time left at the measured rateabout 1 min",
    ],
    hides: ["Copy review instructions", "Failed"],
  },
  {
    name: "working before the cell knows the stage's size: no denominator, no remaining, no time",
    answer: {
      state: "live",
      filing: {
        ...working,
        progress: { ...working.progress, total: null, remaining: null, left_out: 0 },
        rate: { files_per_minute: 24, over_calls: 3 },
      },
    },
    shows: ["Filing · 12 files filed", "Filed12 files"],
    hides: [" of ", "Remaining", "Time left", "left out"],
  },
  {
    name: "working before the cell has reported counts",
    answer: { state: "live", filing: { ...working, progress: null } },
    shows: ["Filing · counts not reported yet", "Counts not reported yet"],
    hides: ["Filed", "Remaining", "Already in Evermatter"],
  },
  {
    name: "paused for free space, with the space it needs and the next step",
    answer: {
      state: "live",
      filing: parked("INSUFFICIENT_SPACE", [{ need: "free_space", bytes: 1_288_490_188 }]),
    },
    shows: ["Filing paused: vault full", "Needs 1.3 GB more free space. Add storage or remove"],
    hides: ["Import ID", "The cell's own words"],
  },
  {
    name: "paused for free space of a size the cell does not know",
    answer: {
      state: "live",
      filing: parked("INSUFFICIENT_SPACE", [{ need: "free_space", bytes: null }]),
    },
    shows: ["Filing paused: vault full", "Add storage or remove files to continue."],
    hides: ["Needs ", "0 bytes"],
  },
  {
    name: "paused for a reason only support can clear, with the reference",
    answer: {
      state: "live",
      filing: parked("IMPORT_RECOVERY_UNRESOLVED", [{ need: "support" }]),
    },
    shows: ["Filing paused: needs support", "Import ID", "IMPORT_RECOVERY_UNRESOLVED"],
    hides: ["The cell's own words"],
  },
  {
    name: "paused by a code Home does not know, which the reference names",
    answer: { state: "live", filing: parked("MUTATION_BUSY", []) },
    shows: ["Filing paused", "Contact support with the import ID.", "MUTATION_BUSY"],
    hides: ["Filing paused:"],
  },
  {
    name: "a cell that cannot answer now",
    answer: { state: "unavailable", reason: "CELL_NOT_READY" },
    shows: ["Filing status unavailable: Evermatter is starting"],
    hides: ["Filed", "Copy review instructions"],
  },
  {
    name: "an older cell without the filer, which keeps the assistant prompt",
    answer: { state: "not_offered" },
    shows: ["Files staged.", "Copy review instructions", "Staged originals4.2 MB"],
    hides: ["Filed", "Filing paused", "Filing not started"],
  },
];

for (const { name, answer, shows, hides } of filingCases) {
  it(`the cell's filing: ${name}`, async () => {
    const api = importApiDouble(await identityToRecipient(await generateIdentity()));
    staged(api);
    api.answerFiling(() => answer);
    const page = await home({ api });
    await page.click("Add files…");
    await page.until(() => shows.every((text) => page.text().includes(text)), shows.join(" · "));
    for (const text of hides) assert.ok(!page.text().includes(text), `shows "${text}"`);
  });
}

const wakes = (api: ReturnType<typeof importApiDouble>) =>
  api.requests.filter(({ body }) => body?.call === "wake").length;

it("a stage the filer has not met is woken once, and the wake's record is shown", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  staged(api);
  // Once woken, the cell has a record for the stage.
  let woken = false;
  api.answerFiling((_id, call) => {
    woken ||= call === "wake";
    return woken
      ? { state: "live", filing: working }
      : { state: "live", filing: { state: "unknown", stop: null, needs: [] } };
  });
  const page = await home({ api });
  await page.click("Add files…");
  await page.until(() => page.text().includes("Filed12 of 40 files"), "the woken record");
  assert.equal(wakes(api), 1);
});

it("a wake that gets no record keeps the read's view: filing not started, with no counts", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  staged(api);
  api.answerFiling((_id, call) =>
    call === "wake"
      ? { state: "unavailable", reason: "CELL_UNREACHABLE" }
      : { state: "live", filing: { state: "unknown", stop: null, needs: [] } }
  );
  const page = await home({ api });
  await page.click("Add files…");
  await page.until(() => page.text().includes("Filing not started"), "the unknown state");
  assert.equal(wakes(api), 1);
  assert.ok(!page.text().includes("Filed"));
});

it("an ended login is registered again by Home, which then shows filing carry on", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  staged(api);
  let woken = false;
  api.answerFiling((_id, call) => {
    woken ||= call === "wake";
    return woken
      ? { state: "live", filing: working }
      : { state: "live", filing: parked("IMPORT_FILING_LOGIN_ENDED", [{ need: "login" }]) };
  });
  const page = await home({ api });
  await page.click("Add files…");
  await page.until(() => page.text().includes("Filed12 of 40 files"), "filing again");
  assert.equal(wakes(api), 1);
  assert.ok(!page.text().includes("Filing paused"));
});

it("filing finishes without an assistant: the row and the dialog show the filed count and each left-out file's reason", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  staged(api);
  api.answerFiling(() => ({
    state: "live",
    filing: {
      ...working,
      state: "done",
      as_of: "2026-11-25T10:05:00Z",
      progress: {
        total: 40,
        filed: 30,
        skipped_duplicates: 2,
        failed: 0,
        left_out: 8,
        remaining: 0,
      },
      left_out: {
        by_reason: { outside_run: 5, ineligible: 2, mystery_code: 1 },
        items: [
          { path: "Takeout/.DS_Store", code: "outside_run" },
          { path: "Takeout/setup.exe", code: "ineligible" },
          { path: "Takeout/odd.bin", code: "mystery_code" },
        ],
        truncated: true,
      },
    },
  }));
  const page = await home({ api });
  // The row says it before the dialog opens.
  await page.until(() => page.text().includes("Filed 30 of 40 files · 8 left out"), "the row");
  await page.click("Add files…");
  await page.until(() => page.text().includes("Left out: 8"), "the left-out count");
  assert.deepEqual(page.leftOut(), [
    "Takeout/.DS_StoreHidden, or added after the scan",
    "Takeout/setup.exeFile type not supported",
    "Takeout/odd.binNot filed (mystery_code)",
  ]);
  assert.match(page.text(), /Not listed: 5/);
  assert.match(page.text(), /Hidden, or added after the scan5/);
  assert.match(page.text(), /Already in Evermatter2/);
  assert.ok(!page.text().includes("Copy review instructions"));
  // Filing that has finished stops asking the cell, and a finished stage is not woken.
  const reads = api.requests.filter(({ path }) => path.startsWith("/api/exomem/cloud/home/filing/"));
  assert.ok(reads.length <= 2);
  assert.equal(wakes(api), 0);
});

it("a finished import whose size the cell does not know shows its filed count without a denominator", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  staged(api);
  api.answerFiling(() => ({
    state: "live",
    filing: {
      ...working,
      state: "done",
      progress: { ...working.progress, total: null, remaining: null, filed: 30, left_out: 0 },
    },
  }));
  const page = await home({ api });
  await page.until(() => page.text().includes("Filed 30 files"), "the row");
  assert.ok(!page.text().includes(" of "));
  assert.ok(!page.text().includes("left out"));
});

it("with Home's owner channel not released, the staged upload keeps the assistant prompt", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  staged(api);
  const page = await home({ api });
  await page.click("Add files…");
  await page.until(() => page.button("Copy review instructions"), "the assistant prompt");
});
