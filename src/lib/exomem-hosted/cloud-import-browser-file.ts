import { encryptImportFiles, type ImportFile } from "./cloud-import-browser";

/** The browser stores only ciphertext; it does not buffer the whole vault in memory. */
export async function encryptImportToBrowserFile(
  files: ImportFile[],
  recipient: string,
  signal?: AbortSignal
) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("exomem-import-uploads", { create: true });
  const name = `${crypto.randomUUID()}.age`;
  const handle = await directory.getFileHandle(name, { create: true });
  const remove = async () => {
    try {
      await directory.removeEntry(name);
    } catch (error) {
      // The File System API's absent-entry result also means cleanup is complete.
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
  };
  try {
    const destination = await handle.createWritable();
    const report = await encryptImportFiles(files, recipient, destination, signal);
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
