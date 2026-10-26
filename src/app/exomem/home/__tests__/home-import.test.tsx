import assert from "node:assert/strict";
import { after, afterEach, before, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { generateIdentity, identityToRecipient } from "age-encryption";
import {
  browserStorageDouble,
  importApiDouble,
} from "../../../../lib/exomem-hosted/__tests__/browser-import-doubles";

// Home's import dialog runs for real against stand-ins for the browser's private storage, the
// import API and storage parts. Stylesheets are stood in for, since this runner loads no CSS.
before(() => {
  for (const path of [
    "../home.module.css",
    "../home-storage.module.css",
    "../../../../components/exomem/phone.module.css",
    "../../../../components/exomem/Button.module.css",
    "../../../../components/exomem/Modal.module.css",
    "../../../../components/exomem/Transitions.module.css",
    "../../../../components/exomem/Notice.module.css",
    "../../../../components/exomem/Switch.module.css",
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

function folder(name: string, notes: number) {
  return Array.from({ length: notes }, (_, index) => {
    const file = new File([`Synthetic note ${index}. `.repeat(30)], `note-${index}.md`);
    Object.defineProperty(file, "webkitRelativePath", {
      value: `${name}/notes/note-${index}.md`,
    });
    return file;
  });
}

async function home(options: {
  quota?: number;
  api: ReturnType<typeof importApiDouble>;
  context?: Record<string, unknown>;
}) {
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
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await options.api.receive(input, init);
      if (!String(input).startsWith("/api/exomem/cloud/imports") || !options.context)
        return response;
      return Response.json(
        { ...(await response.json()), ...options.context },
        { status: response.status }
      );
    },
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
  const choose = async (files: File[]) => {
    await until(
      () => dom.window.document.querySelector('input[aria-label="Folder to import"]'),
      "the folder input"
    );
    const input = dom.window.document.querySelector<HTMLInputElement>(
      'input[aria-label="Folder to import"]'
    )!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  };
  return { browser, text, button, until, click, choose };
}

it("closing the dialog keeps the import running, and a pause shows how to resume", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()), 1 << 20);
  const release = api.holdParts();
  const page = await home({ api });
  await page.click("Import…");
  await page.choose(folder("research", 12));
  await page.click("Encrypt and upload");
  await page.until(() => page.text().includes("Uploading the encrypted copy…"), "the upload");

  await page.click("Close");
  await page.until(() => page.text().includes("Uploading:"), "the row's upload state");
  assert.equal(page.button("Close"), undefined);

  await page.click("Import…");
  await page.click("Pause");
  await page.until(
    () =>
      page
        .text()
        .includes("Paused. Confirmed parts are kept in this browser, including after a reload."),
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

it("after a reload, an import without its report continues only from the same folder chosen again", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  const picked = folder("research", 3);
  const importId = crypto.randomUUID();
  api.rows.set(importId, {
    import_id: importId,
    kind: "adopt",
    declared_files: picked.length,
    declared_bytes: picked.reduce((total, file) => total + file.size, 0),
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
  await page.click("Import…");
  await page.until(() => page.button("Choose the folder again"), "the way to continue");

  await page.choose(folder("research", 4));
  await page.until(() => page.text().includes("The open import expects 3 files"), "the mismatch");
  assert.equal(page.button("Encrypt and continue"), undefined);

  await page.choose(picked);
  await page.click("Encrypt and continue");
  await page.until(() => page.text().includes("Checking and staging your files."), "acceptance");
  assert.equal(api.rows.size, 1);
  assert.equal(api.rows.get(importId)?.requested_state, "uploaded");
});

it("a folder whose encrypted copy cannot fit in this browser is refused before an import exists", async () => {
  const api = importApiDouble(await identityToRecipient(await generateIdentity()));
  const page = await home({ api, quota: 2_000 });
  await page.click("Import…");
  await page.choose(folder("research", 5));
  await page.until(() => page.text().includes("The encrypted copy needs"), "the refusal");
  assert.match(page.text(), /this browser can store 2 kB more for this site/);
  assert.equal(page.button("Encrypt and upload"), undefined);
  assert.ok(!api.requests.some(({ body }) => body?.kind === "adopt"));
});

const GiB = 1024 ** 3;
const published = {
  max_members: 500,
  reserve_bytes: GiB / 4,
  space_factor: 2,
  max_storage_gib: 20,
  import_growth_deadline_seconds: 3600,
};
const readings = {
  storage_gib: 2,
  grown_storage_gib: null,
  used_bytes: 2 * GiB,
  filesystem_bytes: 2 * GiB,
  observed_storage_capacity_bytes: 2 * GiB,
  usage_observed_at: "2026-01-01T00:00:00Z",
};

it("preflight admits a file at the member limit without counting its parent folder", async () => {
  const api = importApiDouble("unused");
  const page = await home({
    api,
    context: { limits: { ...published, max_members: 1 }, storage: readings },
  });
  await page.click("Import…");
  await page.choose(folder("research", 1));
  await page.until(() => page.text().includes("1 of 1"), "the archive's actual member count");
  assert.ok(page.button("Encrypt and upload"));
  assert.equal(api.rows.size, 0);
});

it("preflight shows growth, the reserve warning and the measured reading without refusing existing-content pressure", async () => {
  const page = await home({
    api: importApiDouble("unused"),
    context: { limits: published, storage: readings },
  });
  await page.click("Import…");
  await page.choose(folder("research", 1));
  await page.until(() => page.text().includes("grows to about"), "the storage growth estimate");
  assert.ok(page.text().includes("reserve"));
  assert.ok(page.button("Encrypt and upload"));
});

it("preflight refuses the unscaled lower bound above the cap and leaves no import", async () => {
  const api = importApiDouble("unused");
  const page = await home({
    api,
    context: { limits: { ...published, space_factor: GiB, max_storage_gib: 1 }, storage: readings },
  });
  await page.click("Import…");
  await page.choose(folder("research", 1));
  await page.until(() => page.text().includes("cannot fit within"), "the storage refusal");
  assert.equal(page.button("Encrypt and upload"), undefined);
  assert.equal(api.rows.size, 0);
});

it("unpublished limits stay visibly unknown while a selection remains available", async () => {
  const page = await home({ api: importApiDouble("unused") });
  await page.click("Import…");
  await page.choose(folder("research", 1));
  await page.until(
    () => page.text().includes("Limits not published"),
    "the unpublished limit notice"
  );
  assert.ok(page.button("Encrypt and upload"));
});

it("Home shows the published growth wait on its row and dialog, then a fixed growth failure", async () => {
  const api = importApiDouble("unused");
  const importId = crypto.randomUUID();
  const row = {
    import_id: importId,
    kind: "adopt",
    declared_files: 1,
    declared_bytes: 99,
    requested_state: "requested",
    observed_state: "pending",
    recipient: null,
    part_urls: null,
    urls_expire_at: null,
    error_code: null,
    ciphertext_sha256: null,
    ciphertext_bytes: null,
    required_storage_bytes: 3 * GiB,
    storage_ready: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  api.rows.set(importId, row);
  const page = await home({ api, context: { limits: published, storage: readings } });
  await page.until(() => page.text().includes("growing to about"), "the row's growth wait");
  await page.click("Import…");
  await page.until(() => page.text().includes("60 minutes"), "the published wait bound");
  assert.ok(page.text().includes("waiting for its encrypted copy"));
  assert.ok(!page.text().includes("stopped before"));
  Object.assign(row, { observed_state: "failed", error_code: "IMPORT_STORAGE_UNAVAILABLE" });
  await page.until(() => page.text().includes("did not grow in time"), "the fixed growth failure");
  assert.ok(page.text().includes(importId));
  await cleanup?.();
  cleanup = null;
  Object.assign(row, { error_code: "IMPORT_STORAGE_NO_ROOM" });
  const unavailable = await home({ api, context: { limits: published, storage: readings } });
  await unavailable.click("Import…");
  await unavailable.until(
    () => unavailable.text().includes("cannot grow its storage right now"),
    "the local growth refusal"
  );
  assert.ok(unavailable.text().includes("IMPORT_STORAGE_NO_ROOM"));
});

it("staged totals use the Job report and older imports say not recorded", async () => {
  const api = importApiDouble("unused");
  const id = crypto.randomUUID();
  const row = {
    import_id: id,
    kind: "adopt",
    declared_files: 99,
    declared_bytes: 9999,
    requested_state: "uploaded",
    observed_state: "done",
    recipient: null,
    part_urls: null,
    urls_expire_at: null,
    error_code: null,
    ciphertext_sha256: "a".repeat(64),
    ciphertext_bytes: 999,
    staged_files: 2,
    staged_bytes: 2048,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  api.rows.set(id, row);
  let page = await home({ api });
  await page.click("Import…");
  await page.until(() => page.text().includes("2 files · 2 kB"), "the staged report");
  await cleanup?.();
  cleanup = null;
  Object.assign(row, { staged_files: null, staged_bytes: null });
  page = await home({ api });
  await page.click("Import…");
  await page.until(() => page.text().includes("not recorded"), "the unknown staged count");
});

for (const [code, unit, reason] of [
  ["IMPORT_TOO_MANY_FILES", "files", "more members than this vault accepts"],
  ["IMPORT_STORAGE_LIMIT", "bytes", "cannot fit within this vault’s storage limit"],
  ["IMPORT_PARTS_LIMIT", "bytes", "exceeds this vault’s upload limit"],
] as const) {
  it(`Home shows the fixed ${code} reason and typed limit from a stale preflight refusal`, async () => {
    const api = importApiDouble("unused");
    const receive = api.receive;
    api.receive = async (input, init) =>
      String(input) === "/api/exomem/cloud/imports" && init?.method === "POST"
        ? Response.json(
            {
              error: {
                code,
                message: "untrusted wording",
                limit: { unit, value: 2, requested: 3 },
              },
            },
            { status: 422 }
          )
        : receive(input, init);
    const page = await home({ api });
    await page.click("Import…");
    await page.choose(folder("research", 1));
    await page.click("Encrypt and upload");
    await page.until(() => page.text().includes(reason), "the fixed refusal");
    assert.ok(page.text().includes("Requested:"));
    assert.ok(page.text().includes("Published limit:"));
    assert.ok(!page.text().includes("untrusted wording"));
    assert.ok(page.text().includes(code));
  });
}
