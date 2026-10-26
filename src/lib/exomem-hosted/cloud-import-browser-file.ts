import {
  encryptImportFiles,
  type EncryptedImport,
  type EncryptionProgress,
  type ImportFile,
} from "./cloud-import-browser";
import { ImportStop } from "./cloud-import-stop";

const DIRECTORY = "exomem-import-uploads";

/** The import ID names its ciphertext, so a reload or a new tab finds the same file. */
function ciphertextName(importId: string): string {
  return `${importId}.age`;
}

/** Origin-private storage exists only in secure contexts of browsers that implement it. */
function privateStorage(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

async function importDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIRECTORY, { create: true });
}

async function removeEntry(directory: FileSystemDirectoryHandle, name: string) {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    // The File System API's absent-entry result also means cleanup is complete.
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

export type StoredCiphertext = {
  ciphertext: File;
  report: EncryptedImport;
  remove: () => Promise<void>;
};

/** The browser stores only ciphertext; it does not buffer the whole vault in memory. */
export async function encryptImportToBrowserFile(
  importId: string,
  files: ImportFile[],
  recipient: string,
  signal?: AbortSignal,
  onProgress?: (value: EncryptionProgress) => void
): Promise<StoredCiphertext> {
  if (!privateStorage()) throw new ImportStop("BROWSER_UNSUPPORTED");
  const directory = await importDirectory();
  const name = ciphertextName(importId);
  const remove = () => removeEntry(directory, name);
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
  importId: string
): Promise<Omit<StoredCiphertext, "report"> | null> {
  if (!privateStorage()) return null;
  const directory = await importDirectory();
  const name = ciphertextName(importId);
  try {
    const handle = await directory.getFileHandle(name);
    return { ciphertext: await handle.getFile(), remove: () => removeEntry(directory, name) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

/**
 * Removes ciphertext that no open import can use: finished, cancelled or abandoned attempts.
 * Only the open import's file is kept; there is at most one open import per cell.
 */
export async function removeStaleImportCiphertext(openImportId: string | null): Promise<void> {
  if (!privateStorage()) return;
  const directory = await importDirectory();
  const keep = openImportId === null ? null : ciphertextName(openImportId);
  // TypeScript's DOM library types the directory iterator only with dom.asynciterable.
  const names = (directory as unknown as { keys(): AsyncIterable<string> }).keys();
  const stale: string[] = [];
  for await (const name of names) if (name !== keep) stale.push(name);
  for (const name of stale) await removeEntry(directory, name);
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
