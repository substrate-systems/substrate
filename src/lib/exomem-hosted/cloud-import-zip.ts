import type { Entry, FileEntry } from "@zip.js/zip.js/index-native.js";
import type { ImportBlob } from "./cloud-import-browser";

/** Why an entry of a zip is not sent; each reason is shown beside the entry in the preflight. */
export type ZipLeftOutReason =
  | "zip-encrypted"
  | "zip-unsupported"
  | "zip-unsafe-name"
  | "zip-repeated-name"
  | "zip-link";
export type ZipMember = { path: string; file: ImportBlob };
export type ZipLeftOut = { path: string; bytes: number; reason: ZipLeftOutReason };
export type ExpandedZip =
  | { readable: true; members: ZipMember[]; leftOut: ZipLeftOut[] }
  | { readable: false };

// The compression methods zip.js decodes (`ZipEntry.getData`): store, deflate and deflate64.
// These are APPNOTE 4.4.5 method numbers, a closed set the ZIP specification fixes.
const DECODED_METHODS = new Set([0, 8, 9]);

/** A zip's name without its `.zip` ending; the folder its members are placed in. */
export function zipStem(name: string): string {
  return name.replace(/\.zip$/i, "") || name;
}

/** Whether a picked file is a zip to expand. Other archive-like formats (.docx, .epub) stay whole. */
export function isZipName(name: string): boolean {
  // The `.zip` file extension alone decides; a .docx is a zip container that is sent as a file.
  return /\.zip$/i.test(name) && name.length > 4;
}

/** A zip entry's name as relative archive components, or null when it could escape its folder. */
function safeComponents(filename: string): string[] | null {
  if (filename.startsWith("/") || filename.includes("\\") || filename.includes("\0")) return null;
  const parts = filename.split("/");
  // A directory entry's trailing slash is the only empty component allowed.
  if (parts.at(-1) === "") parts.pop();
  return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..")
    ? parts
    : null;
}

function memberBlob(entry: FileEntry): ImportBlob {
  return {
    size: entry.uncompressedSize,
    lastModified: entry.lastModDate.getTime(),
    stream() {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      // Decoding runs on this thread with the browser's own DecompressionStream; a Worker would
      // need a script source that Home's content security policy does not grant.
      entry
        .getData(writable, { useWebWorkers: false, checkCrc32: true })
        .catch((error: unknown) => writable.abort(error).catch(() => {}));
      return readable;
    },
  };
}

/**
 * Lists a zip's entries from its central directory, which sits at the end of the file, so the
 * zip is read in slices and never held whole. Members are decoded only when the archive reads
 * them. Folders come from the members' paths, so directory entries are skipped.
 */
export async function expandZip(zip: Blob, folder: string): Promise<ExpandedZip> {
  // The reader loads with the first zip, so Home carries no zip code until a zip is chosen. Its
  // native build decodes with the browser's DecompressionStream and a script fallback, no
  // WebAssembly.
  const { BlobReader, ZipReader } = await import("@zip.js/zip.js/index-native.js");
  let entries: Entry[];
  try {
    entries = await new ZipReader(new BlobReader(zip), { useWebWorkers: false }).getEntries();
  } catch {
    // Not a zip, a split or damaged zip, or an encrypted central directory.
    return { readable: false };
  }
  const members: ZipMember[] = [];
  const leftOut: ZipLeftOut[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.directory) continue;
    const parts = safeComponents(entry.filename);
    const path = `${folder}/${parts ? parts.join("/") : entry.filename}`;
    const bytes = entry.uncompressedSize;
    if (!parts) leftOut.push({ path, bytes, reason: "zip-unsafe-name" });
    else if (seen.has(path)) leftOut.push({ path, bytes, reason: "zip-repeated-name" });
    else if (entry.symlink) leftOut.push({ path, bytes, reason: "zip-link" });
    else if (entry.encrypted) leftOut.push({ path, bytes, reason: "zip-encrypted" });
    else if (!DECODED_METHODS.has(entry.compressionMethod))
      leftOut.push({ path, bytes, reason: "zip-unsupported" });
    else members.push({ path, file: memberBlob(entry) });
    seen.add(path);
  }
  return { readable: true, members, leftOut };
}
