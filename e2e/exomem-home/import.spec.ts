import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base } from "@playwright/test";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { createTarDecoder } from "modern-tar";
import { createOwner, pool, signIn } from "./seed";
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
    await expect(dialog.getByRole("button", { name: "Retry this upload" })).toBeVisible();
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
