import {
  encryptImportFiles,
  type EncryptedImport,
  type EncryptionProgress,
  type ImportFile,
} from "./cloud-import-browser";
import { ImportStop } from "./cloud-import-stop";
import { z } from "zod";
import { MAX_IMPORT_PARTS } from "../exomem/cloud-import-contract";
import type { UploadedPart } from "./cloud-import-browser";

const ROOT = "exomem-import-uploads";
// Checks the shape of our own file names (an import UUID plus ".age"). Anything else, such as a
// browser's ".crswap" file for a write in progress, is not ours to count or remove.
const KEPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.age$/i;

/** The import ID names its ciphertext, so a reload or a new tab finds the same file. */
function ciphertextName(importId: string): string {
  return `${importId}.age`;
}

function receiptName(importId: string): string {
  return `${importId}.parts.json`;
}

// The receipt is our closed multipart wire shape; the digest expression checks SHA-256 format.
const receipt = z.object({
  import_id: z.uuid(),
  ciphertext_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parts: z
    .array(
      z.object({
        part_number: z.number().int().min(1).max(MAX_IMPORT_PARTS),
        etag: z.string().min(1).max(1024),
      })
    )
    .max(MAX_IMPORT_PARTS),
});

/** Origin-private storage exists only in secure contexts of browsers that implement it. */
function privateStorage(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

async function rootDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT, { create: true });
}

/** Each account keeps its copies in its own folder, so one account never sweeps another's. */
function accountFolderName(account: string): string {
  return `account-${account}`;
}

async function accountDirectory(account: string) {
  return (await rootDirectory()).getDirectoryHandle(accountFolderName(account), { create: true });
}

// TypeScript's DOM library types the directory iterator only with dom.asynciterable.
type Listing = { entries(): AsyncIterable<[string, FileSystemHandle]> };
function entries(directory: FileSystemDirectoryHandle) {
  return (directory as unknown as Listing).entries();
}

async function removeEntry(directory: FileSystemDirectoryHandle, name: string) {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    // The File System API's absent-entry result also means cleanup is complete.
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

async function removeCopy(directory: FileSystemDirectoryHandle, importId: string) {
  await removeEntry(directory, ciphertextName(importId));
  await removeEntry(directory, receiptName(importId));
}

/** Receipts belong only to this import and verified ciphertext; stale or malformed ones go. */
export async function readImportPartReceipts(
  account: string,
  importId: string,
  sha256: string
): Promise<Map<number, string>> {
  const directory = await accountDirectory(account);
  let value: unknown;
  try {
    const file = await (await directory.getFileHandle(receiptName(importId))).getFile();
    try {
      value = JSON.parse(await file.text());
    } catch {
      value = null;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return new Map();
    throw error;
  }
  const parsed = receipt.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.import_id !== importId ||
    parsed.data.ciphertext_sha256 !== sha256
  ) {
    await removeEntry(directory, receiptName(importId));
    return new Map();
  }
  return new Map(parsed.data.parts.map(({ part_number, etag }) => [part_number, etag]));
}

/** Commit a confirmed part beside its ciphertext before the upload continues to the next part. */
export async function writeImportPartReceipts(
  account: string,
  importId: string,
  sha256: string,
  parts: UploadedPart[]
): Promise<void> {
  const directory = await accountDirectory(account);
  const handle = await directory.getFileHandle(receiptName(importId), { create: true });
  const writer = (await handle.createWritable()).getWriter();
  try {
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({ import_id: importId, ciphertext_sha256: sha256, parts })
      )
    );
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    writer.releaseLock();
  }
}

function lockName(importId: string): string {
  return `exomem-import:${importId}`;
}

/** Runs the work while this tab alone holds the import, or refuses when another tab holds it. */
export async function holdImport<T>(importId: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function")
    return work();
  return navigator.locks.request(lockName(importId), { ifAvailable: true }, (lock) => {
    if (!lock) throw new ImportStop("OTHER_TAB");
    return work();
  });
}

/** Runs the work only while no tab holds the import; returns false when one does. */
async function whileImportFree(importId: string, work: () => Promise<boolean>): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function")
    return work();
  return navigator.locks.request(lockName(importId), { ifAvailable: true }, (lock) =>
    lock ? work() : false
  );
}

export type StoredCiphertext = {
  ciphertext: File;
  report: EncryptedImport;
  remove: () => Promise<void>;
};

/**
 * The browser stores only ciphertext; it does not buffer the whole vault in memory. The caller
 * holds the import, so no other tab writes or removes this file meanwhile.
 */
export async function encryptImportToBrowserFile(
  account: string,
  importId: string,
  files: ImportFile[],
  recipient: string,
  signal?: AbortSignal,
  onProgress?: (value: EncryptionProgress) => void
): Promise<StoredCiphertext> {
  if (!privateStorage()) throw new ImportStop("BROWSER_UNSUPPORTED");
  const directory = await accountDirectory(account);
  const name = ciphertextName(importId);
  const remove = () => removeCopy(directory, importId);
  const handle = await directory.getFileHandle(name, { create: true });
  try {
    if (typeof handle.createWritable !== "function") throw new ImportStop("BROWSER_UNSUPPORTED");
    const destination = await handle.createWritable();
    const report = await encryptImportFiles(files, recipient, destination, signal, onProgress);
    return { ciphertext: await handle.getFile(), report, remove };
  } catch (error) {
    try {
      await remove();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The encrypted temporary file needs cleanup."
      );
    }
    throw error;
  }
}

/** This import's ciphertext from an earlier page, or null when this browser has none. */
export async function storedImportCiphertext(
  account: string,
  importId: string
): Promise<Omit<StoredCiphertext, "report"> | null> {
  if (!privateStorage()) return null;
  const directory = await accountDirectory(account);
  const name = ciphertextName(importId);
  try {
    const handle = await directory.getFileHandle(name);
    return { ciphertext: await handle.getFile(), remove: () => removeCopy(directory, importId) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

/** Removes this import's copy; the caller holds the import or has checked that no tab does. */
export async function removeImportCiphertext(account: string, importId: string): Promise<void> {
  if (!privateStorage()) return;
  await removeCopy(await accountDirectory(account), importId);
}

/** Removes this import's copy unless another tab holds the import; false when one does. */
export async function removeFreeImportCiphertext(
  account: string,
  importId: string
): Promise<boolean> {
  return whileImportFree(importId, async () => {
    await removeImportCiphertext(account, importId);
    return true;
  });
}

/**
 * Removes this account's copies that no import can use any more. A copy goes only while no
 * tab holds its import and a fresh status read says that import no longer waits for this
 * browser's upload, because a page's own view of the open import can be stale.
 */
export async function sweepKeptCiphertext(
  account: string,
  keep: string | null,
  retired: (importId: string) => Promise<boolean>
): Promise<void> {
  if (!privateStorage()) return;
  const directory = await accountDirectory(account);
  const candidates: string[] = [];
  for await (const [name, handle] of entries(directory)) {
    const importId = KEPT_NAME.exec(name)?.[1];
    if (handle.kind === "file" && importId && importId !== keep) candidates.push(importId);
  }
  for (const importId of candidates) {
    // One copy that cannot be removed now stays counted as used; the next sweep tries again.
    // An import that stops waiting never waits again, so the read stays valid until removal.
    if (await retired(importId).catch(() => false))
      await whileImportFree(importId, async () => {
        await removeImportCiphertext(account, importId);
        return true;
      }).catch(() => false);
  }
}

type KeptCopy = { directory: FileSystemDirectoryHandle; name: string; importId: string };

/** Copies outside this account's folder: other accounts' and those from before folders. */
async function otherCopies(account: string): Promise<KeptCopy[]> {
  const root = await rootDirectory();
  const copies: KeptCopy[] = [];
  const collect = async (directory: FileSystemDirectoryHandle) => {
    for await (const [name, handle] of entries(directory)) {
      const importId = KEPT_NAME.exec(name)?.[1];
      if (handle.kind === "file" && importId) copies.push({ directory, name, importId });
    }
  };
  await collect(root);
  for await (const [name, handle] of entries(root)) {
    if (handle.kind === "directory" && name !== accountFolderName(account))
      await collect(handle as FileSystemDirectoryHandle);
  }
  return copies;
}

/** The files and bytes other accounts' kept copies use in this browser. */
export async function otherKeptCiphertext(
  account: string
): Promise<{ files: number; bytes: number }> {
  const total = { files: 0, bytes: 0 };
  if (!privateStorage()) return total;
  for (const { directory, name } of await otherCopies(account)) {
    try {
      total.bytes += (await (await directory.getFileHandle(name)).getFile()).size;
      total.files += 1;
    } catch (error) {
      // A copy removed since the listing no longer uses space.
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
  }
  return total;
}

/** Removes other accounts' kept copies on the owner's request, except those a tab holds. */
export async function discardOtherKeptCiphertext(account: string): Promise<{ kept: number }> {
  if (!privateStorage()) return { kept: 0 };
  let kept = 0;
  for (const { directory, importId } of await otherCopies(account)) {
    const removed = await whileImportFree(importId, async () => {
      await removeCopy(directory, importId);
      return true;
    }).catch(() => false);
    if (!removed) kept += 1;
  }
  return { kept };
}

/** What this origin may still store, as the browser estimates it; null when it cannot say. */
export async function browserStorageRoom(): Promise<{ quota: number; usage: number } | null> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function")
    return null;
  const { quota, usage } = await navigator.storage.estimate();
  if (typeof quota !== "number" || typeof usage !== "number") return null;
  return { quota, usage };
}

/** Asks the browser not to evict the encrypted copy under storage pressure. */
export async function keepImportCiphertext(): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.persist !== "function")
    return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
