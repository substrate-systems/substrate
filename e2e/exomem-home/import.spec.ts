import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base } from "@playwright/test";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { createTarDecoder } from "modern-tar";
import { createOwner, pool, setCell, signIn } from "./seed";
import { homeE2eEnvironment } from "./environment";

const test = base.extend<object, { database: void }>({
  database: [
    async ({}, use) => {
      await use();
      await pool.end();
    },
    { scope: "worker", auto: true },
  ],
});

test("Home shows the cell's complete filing count and keeps an incomplete count unknown after reload", async ({
  page,
  context,
}) => {
  const owner = await createOwner();
  const result = await pool.query(
    `INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files,
       requested_state, observed_state, staged_files, staged_bytes, part_etags,
       ciphertext_sha256, ciphertext_bytes)
     VALUES ($1, 'adopt', 99, 9, 'uploaded', 'done', 4, 44,
       '[{"part_number":1,"etag":"synthetic"}]', repeat('a',64), 77)
     RETURNING import_id`,
    [owner.cellId]
  );
  const path = `_Imports/${result.rows[0].import_id}`;
  await setCell(owner, { adoptionStatus: { [path]: { complete: true, adopted_files: 3 } } });
  await signIn(context, owner);
  await page.goto("/exomem/home");
  await page.getByRole("button", { name: "Import…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("3 files", { exact: true })).toBeVisible();
  await setCell(owner, { adoptionStatus: { [path]: { complete: false, adopted_files: 2 } } });
  await page.reload();
  await page.getByRole("button", { name: "Import…", exact: true }).click();
  await expect(dialog.getByText("unknown", { exact: true })).toBeVisible();
  const fresh = await page.evaluate(async () => (await fetch("/api/exomem/cloud/imports")).json());
  expect(fresh.import.adopted_files).toBeNull();
  expect(fresh.import.staged_files).toBe(4);
});

test("Home offers imports only while the cell permits starting one", async ({ page, context }) => {
  const owner = await createOwner();
  await signIn(context, owner);
  await page.goto("/exomem/home");
  const start = page.getByRole("button", { name: "Import…", exact: true });
  await expect(start).toBeVisible();

  // These are C5's two retained cell states that refuse new imports.
  for (const state of ["read_only", "stopped"]) {
    await pool.query(
      "UPDATE exomem_cloud_cells SET desired_state=$2, observed_state=$2, ready=true WHERE cell_id=$1",
      [owner.cellId, state]
    );
    const status = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/exomem/status"
    );
    await page.reload();
    await status;
    await expect(page.getByRole("heading", { name: "Your data", exact: true })).toBeVisible();
    await expect(start).toHaveCount(0);
  }

  // A failed runtime still permits C5 to start the import's recovery work.
  await pool.query(
    "UPDATE exomem_cloud_cells SET desired_state='running', observed_state='failed', ready=false WHERE cell_id=$1",
    [owner.cellId]
  );
  await page.reload();
  await expect(start).toBeVisible();
});

test("an open import remains cancellable when billing stops new uploads", async ({
  page,
  context,
}) => {
  const folder = await mkdtemp(join(tmpdir(), "exomem-import-suspension-"));
  try {
    await writeFile(join(folder, "note.md"), "Keep this source.");
    const owner = await createOwner();
    await signIn(context, owner);
    await page.clock.install();
    await page.goto("/exomem/home");
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Folder to import").setInputFiles(folder);
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/exomem/cloud/imports" &&
        response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Encrypt and upload", exact: true }).click();
    const operation = (await (await created).json()).import;
    await pool.query(
      "UPDATE exomem_cloud_cells SET desired_state='read_only', observed_state='read_only', ready=true WHERE cell_id=$1",
      [owner.cellId]
    );
    await pool.query(
      "UPDATE exomem_entitlements SET source_state='past_due', effective_state='grace' WHERE tenant_id=$1",
      [owner.tenantId]
    );
    await page.clock.fastForward(31_000);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("Starting or resuming an upload is unavailable right now.")
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Choose a folder" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Resume upload" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Cancel import", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Import status…", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel import", exact: true }).click();
    await expect(dialog.getByText("Cancellation requested.", { exact: false })).toBeVisible();
    const stored = await pool.query(
      "SELECT requested_state FROM exomem_cloud_imports WHERE import_id=$1",
      [operation.import_id]
    );
    expect(stored.rows[0].requested_state).toBe("cancelled");
    await page.reload();
    await page.getByRole("button", { name: "Import status…", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByText("Cancellation requested.", { exact: false })
    ).toBeVisible();
  } finally {
    await page.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Home encrypts the selected folder, stages it and preserves observed status after reload", async ({
  page,
  context,
}) => {
  const folder = await mkdtemp(join(tmpdir(), "exomem-browser-import-"));
  try {
    const body = "次の作業を確認する。";
    await mkdir(join(folder, "notes"));
    await writeFile(join(folder, "notes", "計画.md"), body);
    await writeFile(join(folder, "empty.md"), "");
    const owner = await createOwner();
    const identity = await generateIdentity();
    let ciphertext: Buffer | null = null;
    await context.route("https://storage.example.test/**", async (route) => {
      const headers = {
        "access-control-allow-origin": homeE2eEnvironment().baseUrl,
        "access-control-allow-methods": "PUT, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-expose-headers": "etag",
        etag: '"synthetic-import-part"',
      };
      if (route.request().method() === "PUT") {
        expect(route.request().headers().cookie).toBeUndefined();
        expect(route.request().headers()["x-exomem-csrf"]).toBeUndefined();
        ciphertext = route.request().postDataBuffer();
      }
      await route.fulfill({ status: 200, headers, body: "" });
    });
    await signIn(context, owner);
    await page.goto("/exomem/home");
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Choose a folder" })).toBeVisible();
    await dialog.getByLabel("Folder to import").setInputFiles(folder);
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/exomem/cloud/imports" &&
        response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Encrypt and upload", exact: true }).click();
    const operation = (await (await created).json()).import;
    const prepared = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/prepare-upload")
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET recipient=$2,observed_state='key_ready',updated_at=now() WHERE import_id=$1",
      [operation.import_id, await identityToRecipient(identity)]
    );
    const transport = (await (await prepared).json()).import;
    const completed = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/complete")
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET upload_id='synthetic-upload',part_urls=$2::jsonb,urls_expire_at=now()+interval '1 hour',updated_at=now() WHERE import_id=$1",
      [
        operation.import_id,
        JSON.stringify([
          {
            part_number: 1,
            url: "https://storage.example.test/upload",
            part_size_bytes: transport.ciphertext_bytes,
          },
        ]),
      ]
    );
    expect((await completed).ok()).toBe(true);
    await expect(dialog.getByText("Encrypted upload accepted.", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy review instructions" })).toHaveCount(0);
    assert.ok(ciphertext);
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const plaintext = await decrypter.decrypt(ciphertext);
    const reader = new Blob([Uint8Array.from(plaintext)])
      .stream()
      .pipeThrough(createTarDecoder({ strict: true }))
      .getReader();
    const files = new Map<string, string>();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        files.set(value.header.name, await new Response(value.body).text());
      }
    } finally {
      reader.releaseLock();
    }
    expect(files.get("notes/計画.md")).toBe(body);
    expect(files.get("empty.md")).toBe("");
    expect(files.size).toBe(2);
    const stored = await pool.query(
      "SELECT requested_state,declared_files,declared_bytes FROM exomem_cloud_imports WHERE import_id=$1",
      [operation.import_id]
    );
    expect(stored.rows[0].requested_state).toBe("uploaded");
    expect(Number(stored.rows[0].declared_files)).toBe(2);
    expect(Number(stored.rows[0].declared_bytes)).toBe(Buffer.byteLength(body));
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state='done',updated_at=now() WHERE import_id=$1",
      [operation.import_id]
    );
    await page.reload();
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByText("Files staged.", { exact: false })
    ).toBeVisible();
    const review = page.getByRole("dialog");
    const copyInstructions = review.getByRole("button", { name: "Copy review instructions" });
    await expect(copyInstructions).toBeVisible();
    // The clipboard is an external boundary; keep synthetic text out of the system clipboard.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException("Denied", "NotAllowedError");
          },
        },
      });
    });
    await copyInstructions.click();
    await expect(review.getByRole("alert")).toContainText("Copying did not work");
    await review.getByText("Review instructions", { exact: true }).click();
    await expect(
      review.getByText(`Help me bring the staged folder _Imports/${operation.import_id}`, {
        exact: false,
      })
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.setAttribute("data-fixture-copied-instructions", text);
          },
        },
      });
    });
    await copyInstructions.click();
    await expect(
      review.getByRole("status").filter({ hasText: "Instructions copied." })
    ).toBeVisible();
    const copied = await page.locator("html").getAttribute("data-fixture-copied-instructions");
    expect(copied).toContain(`_Imports/${operation.import_id}`);
    await review.getByRole("button", { name: "Remove staged files…", exact: true }).click();
    await review.getByRole("button", { name: "Remove staged files", exact: true }).click();
    await expect(review.getByText("Removal requested.", { exact: false })).toBeVisible();
    await expect(review.getByText("Keep this page open to retry", { exact: false })).toHaveCount(0);
    await expect(copyInstructions).toHaveCount(0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("local ciphertext cleanup failure does not block cancellation or reuse a terminal import ID", async ({
  page,
  context,
}) => {
  const folder = await mkdtemp(join(tmpdir(), "exomem-browser-cancel-"));
  try {
    await writeFile(join(folder, "note.md"), "A synthetic note.");
    const owner = await createOwner();
    const recipient = await identityToRecipient(await generateIdentity());
    await context.route("https://storage.example.test/**", (route) =>
      route.fulfill({
        status: route.request().method() === "OPTIONS" ? 200 : 503,
        headers: {
          "access-control-allow-origin": homeE2eEnvironment().baseUrl,
          "access-control-allow-methods": "PUT, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      })
    );
    await page.addInitScript(() => {
      const remove = FileSystemDirectoryHandle.prototype.removeEntry;
      FileSystemDirectoryHandle.prototype.removeEntry = function (name, options) {
        if (name.endsWith(".age"))
          return Promise.reject(
            new DOMException("Synthetic local cleanup failure", "UnknownError")
          );
        return remove.call(this, name, options);
      };
    });
    await signIn(context, owner);
    await page.goto("/exomem/home");
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Choose a folder" })).toBeVisible();
    await dialog.getByLabel("Folder to import").setInputFiles(folder);
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/exomem/cloud/imports" &&
        response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Encrypt and upload", exact: true }).click();
    const operation = (await (await created).json()).import;
    const prepared = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/prepare-upload")
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET recipient=$2,observed_state='key_ready',updated_at=now() WHERE import_id=$1",
      [operation.import_id, recipient]
    );
    const transport = (await (await prepared).json()).import;
    await pool.query(
      "UPDATE exomem_cloud_imports SET upload_id='synthetic-unavailable-upload',part_urls=$2::jsonb,urls_expire_at=now()+interval '1 hour',updated_at=now() WHERE import_id=$1",
      [
        operation.import_id,
        JSON.stringify([
          {
            part_number: 1,
            url: "https://storage.example.test/unavailable",
            part_size_bytes: transport.ciphertext_bytes,
          },
        ]),
      ]
    );
    await expect(dialog.getByRole("button", { name: "Resume upload" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel import", exact: true }).click();
    await expect(dialog.getByText("Cancellation requested.", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("Browser cleanup failed.");
    await expect(dialog.getByRole("alert")).toContainText("temporary encrypted file");
    await expect(dialog.getByText("Synthetic local cleanup failure", { exact: false })).toHaveCount(
      0
    );
    await expect(dialog.getByText("Keep this page open to retry", { exact: false })).toHaveCount(0);
    const cancelled = await pool.query(
      "SELECT requested_state FROM exomem_cloud_imports WHERE import_id=$1",
      [operation.import_id]
    );
    expect(cancelled.rows[0].requested_state).toBe("cancelled");
    await pool.query(
      "UPDATE exomem_cloud_imports SET observed_state='discarded',updated_at=now() WHERE import_id=$1",
      [operation.import_id]
    );
    await expect(dialog.getByText("Staged files removed.", { exact: false })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Encrypt and upload", exact: true })
    ).toHaveCount(0);
    await dialog.getByLabel("Folder to import").setInputFiles(folder);
    await expect(dialog.getByRole("alert")).toContainText("Browser cleanup failed.");
    const fresh = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/exomem/cloud/imports" &&
        response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Encrypt and upload", exact: true }).click();
    expect((await (await fresh).json()).import.import_id).not.toBe(operation.import_id);
  } finally {
    await page.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("admission grows before encryption and a reloaded upload sends only unrecorded parts", async ({
  page,
  context,
}) => {
  const folder = await mkdtemp(join(tmpdir(), "exomem-import-growth-resume-"));
  try {
    const content = "A synthetic source. ".repeat(800);
    await writeFile(join(folder, "source.md"), content);
    const owner = await createOwner({
      storage: {
        usedBytes: 2 * 1024 ** 3,
        filesystemBytes: 2 * 1024 ** 3,
        observedAt: new Date().toISOString(),
      },
    });
    const GiB = 1024 ** 3;
    const limits = {
      max_members: 500,
      reserve_bytes: GiB / 4,
      space_factor: 2,
      max_storage_gib: 20,
      part_bytes: 8192,
      max_parts: 10000,
      upload_window_seconds: 86400,
      import_deadline_seconds: 7200,
      import_growth_deadline_seconds: 3600,
    };
    await pool.query(
      "UPDATE exomem_cloud_cells SET storage_gib=2, import_limits=$2::jsonb WHERE cell_id=$1",
      [owner.cellId, JSON.stringify(limits)]
    );
    const sent: number[] = [];
    let refuseSecond = true;
    await context.route("https://storage.example.test/**", async (route) => {
      const number = Number(new URL(route.request().url()).pathname.split("/").at(-1));
      const headers = {
        "access-control-allow-origin": homeE2eEnvironment().baseUrl,
        "access-control-allow-methods": "PUT, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-expose-headers": "etag",
        etag: `"part-${number}"`,
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 200, headers });
        return;
      }
      sent.push(number);
      if (number === 2 && refuseSecond) {
        refuseSecond = false;
        await route.fulfill({ status: 503, headers });
        return;
      }
      await route.fulfill({ status: 200, headers });
    });
    await signIn(context, owner);
    await page.goto("/exomem/home");
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Folder to import").setInputFiles(folder);
    await expect(dialog.getByText("grows to about", { exact: false })).toBeVisible();
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/exomem/cloud/imports" &&
        response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Encrypt and upload", exact: true }).click();
    const admitted = await (await created).json();
    expect(admitted.import.required_storage_bytes).toBe(3 * GiB);
    expect(admitted.import.storage_ready).toBe(false);
    await expect(dialog.getByText("growing to about", { exact: false }).first()).toBeVisible();
    const importId = admitted.import.import_id;
    const saved = await pool.query(
      "SELECT cell.storage_gib, request.required_storage_gib, request.ciphertext_sha256 FROM exomem_cloud_cells cell JOIN exomem_cloud_imports request USING(cell_id) WHERE import_id=$1",
      [importId]
    );
    expect(saved.rows[0]).toEqual({
      storage_gib: 3,
      required_storage_gib: 3,
      ciphertext_sha256: null,
    });
    const prepared = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/prepare-upload")
    );
    // The controller and object store are the external boundaries; the browser/API/DB run unchanged.
    await pool.query(
      "UPDATE exomem_cloud_cells SET observed_storage_capacity_bytes=$2, observed_storage_generation=generation, observed_storage_pvc_uid='synthetic-claim', observed_storage_pvc_version='2', observed_storage_at=now() WHERE cell_id=$1",
      [owner.cellId, 3 * GiB]
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET recipient=$2, observed_state='key_ready' WHERE import_id=$1",
      [importId, await identityToRecipient(await generateIdentity())]
    );
    const transport = (await (await prepared).json()).import;
    const parts = [];
    for (
      let offset = 0, n = 1;
      offset < transport.ciphertext_bytes;
      offset += limits.part_bytes, n++
    )
      parts.push({
        part_number: n,
        url: `https://storage.example.test/resume/${n}`,
        part_size_bytes: Math.min(limits.part_bytes, transport.ciphertext_bytes - offset),
      });
    await pool.query(
      "UPDATE exomem_cloud_imports SET upload_id='synthetic-resume', part_urls=$2::jsonb, urls_expire_at=now()+interval '1 hour' WHERE import_id=$1",
      [importId, JSON.stringify(parts)]
    );
    await expect(dialog.getByRole("button", { name: "Resume upload" })).toBeVisible();
    expect(sent).toEqual([1, 2]);
    const receipt = await page.evaluate(async (id) => {
      const root = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle("exomem-import-uploads");
      for await (const [, directory] of (
        root as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle]> }
      ).entries()) {
        try {
          return JSON.parse(
            await (await (await directory.getFileHandle(`${id}.parts.json`)).getFile()).text()
          );
        } catch {}
      }
      return null;
    }, importId);
    expect(receipt.import_id).toBe(importId);
    expect(receipt.ciphertext_sha256).toBe(transport.ciphertext_sha256);
    expect(receipt.parts).toEqual([{ part_number: 1, etag: '"part-1"' }]);
    await page.reload();
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    dialog = page.getByRole("dialog");
    const completed = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/complete")
    );
    await dialog.getByRole("button", { name: "Continue upload", exact: true }).click();
    expect((await completed).ok()).toBe(true);
    expect(sent.filter((number) => number === 1)).toHaveLength(1);
    expect(sent).toEqual([1, 2, ...parts.slice(1).map((part) => part.part_number)]);
    const fresh = await pool.query(
      "SELECT requested_state, part_etags FROM exomem_cloud_imports WHERE import_id=$1",
      [importId]
    );
    expect(fresh.rows[0].requested_state).toBe("uploaded");
    expect(fresh.rows[0].part_etags).toEqual(
      parts.map(({ part_number }) => ({ part_number, etag: `"part-${part_number}"` }))
    );
    await pool.query(
      "UPDATE exomem_cloud_imports SET staged_files=1, staged_bytes=$2, observed_state='done' WHERE import_id=$1",
      [importId, Buffer.byteLength(content)]
    );
    await page.reload();
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByText("Staged originals", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("dialog").getByText("1 file · 16 kB", { exact: true })
    ).toBeVisible();
  } finally {
    await page.close();
    await rm(folder, { recursive: true, force: true });
  }
});
