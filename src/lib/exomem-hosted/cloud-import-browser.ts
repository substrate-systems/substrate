import { sha256 } from "@noble/hashes/sha2.js";
import { Encrypter } from "age-encryption";
import { createTarPacker } from "modern-tar";
import type { UploadPart } from "../exomem/cloud-import-contract";

export type { UploadPart } from "../exomem/cloud-import-contract";

export type ImportFile = { path: string; file: File };
export type EncryptedImport = { ciphertext_sha256: string; ciphertext_bytes: number };
export type UploadedPart = { part_number: number; etag: string };

/** The names belong to an archive, never to a server-side filesystem path. */
export function folderImportFiles(files: File[]): ImportFile[] {
  if (!files.length) throw new Error("Choose a folder that contains files.");
  const root = files[0].webkitRelativePath.split("/")[0];
  const selected = files.map((file) => {
    const components = file.webkitRelativePath.split("/");
    if (components.shift() !== root || !components.length) {
      throw new Error("Choose one folder to import.");
    }
    return { path: components.join("/"), file };
  });
  const names = new Set<string>();
  for (const { path } of selected) {
    // TAR uses slash-separated relative components; these are path-shape checks only.
    if (path.split("/").some((part) => !part || part === "." || part === "..") || names.has(path)) {
      throw new Error("The folder contains an invalid or repeated archive path.");
    }
    names.add(path);
  }
  return selected;
}

/** Stream plaintext through maintained TAR and age implementations into a ciphertext-only sink. */
export async function encryptImportFiles(
  files: ImportFile[],
  recipient: string,
  destination: WritableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<EncryptedImport> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const packer = createTarPacker();
  const encrypted = await encrypter.encrypt(packer.readable);
  const digest = sha256.create();
  let bytes = 0;
  const transfer = encrypted
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          digest.update(chunk);
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      })
    )
    .pipeTo(destination, { signal });
  const produce = (async () => {
    try {
      for (const { path, file } of files) {
        signal?.throwIfAborted();
        await file
          .stream()
          .pipeTo(packer.controller.add({ name: path, size: file.size }), { signal });
      }
      packer.controller.finalize();
    } catch (error) {
      packer.controller.error(error);
      throw error;
    }
  })();
  // Attach both handlers before either side can reject under stream backpressure.
  const results = await Promise.allSettled([produce, transfer]);
  if (results[1].status === "rejected") throw results[1].reason;
  if (results[0].status === "rejected") throw results[0].reason;
  return {
    ciphertext_sha256: Array.from(digest.digest(), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(""),
    ciphertext_bytes: bytes,
  };
}

/** Retry a part with the same ciphertext, without forwarding the signed-in session to storage. */
export async function uploadImportParts(
  ciphertext: Blob,
  parts: UploadPart[],
  completed: Map<number, string>,
  onProgress: (uploadedBytes: number) => void,
  signal?: AbortSignal
): Promise<UploadedPart[]> {
  let total = 0;
  for (const [index, part] of parts.entries()) {
    let target: URL;
    try {
      target = new URL(part.url);
    } catch {
      throw new Error("The upload destination is unavailable. Retry from your Exomem account.");
    }
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      part.part_number !== index + 1 ||
      !Number.isSafeInteger(part.part_size_bytes) ||
      part.part_size_bytes <= 0
    ) {
      throw new Error("The upload destination is unavailable. Retry from your Exomem account.");
    }
    total += part.part_size_bytes;
  }
  if (!parts.length || total !== ciphertext.size)
    throw new Error("The upload parts do not cover the encrypted file.");
  let offset = 0;
  for (const part of parts) {
    signal?.throwIfAborted();
    const end = offset + part.part_size_bytes;
    if (!completed.has(part.part_number)) {
      const response = await fetch(part.url, {
        method: "PUT",
        body: ciphertext.slice(offset, end),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal,
      });
      if (!response.ok)
        throw new Error("The encrypted upload paused. Retry to send the remaining parts.");
      const etag = response.headers.get("etag");
      if (!etag) throw new Error("Storage did not confirm the uploaded part. Retry the upload.");
      completed.set(part.part_number, etag);
    }
    offset = end;
    onProgress(offset);
  }
  return parts.map(({ part_number }) => ({ part_number, etag: completed.get(part_number)! }));
}
