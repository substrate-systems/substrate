import { sha256 } from "@noble/hashes/sha2.js";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { createTarPacker } from "modern-tar";
import { MAX_IMPORT_PARTS, type UploadPart } from "../exomem/cloud-import-contract";
import { ImportStop } from "./cloud-import-stop";

export type { UploadPart } from "../exomem/cloud-import-contract";

export type ImportFile = { path: string; file: File };
export type EncryptedImport = { ciphertext_sha256: string; ciphertext_bytes: number };
export type UploadedPart = { part_number: number; etag: string };
/** How far encryption has got: files packed, plaintext read and ciphertext written. */
export type EncryptionProgress = { files: number; plaintextBytes: number; ciphertextBytes: number };
/** The exact sizes one selection produces, before anything is read or written. */
export type ImportForecast = {
  files: number;
  plaintextBytes: number;
  tarBytes: number;
  ciphertextBytes: number;
};

/** The names belong to an archive, never to a server-side filesystem path. */
export function folderImportFiles(files: File[]): ImportFile[] {
  if (!files.length) throw new ImportStop("FOLDER_EMPTY");
  const root = files[0].webkitRelativePath.split("/")[0];
  const selected = files.map((file) => {
    const components = file.webkitRelativePath.split("/");
    if (components.shift() !== root || !components.length) {
      throw new ImportStop("FOLDER_SHAPE");
    }
    return { path: components.join("/"), file };
  });
  const names = new Set<string>();
  for (const { path } of selected) {
    // TAR uses slash-separated relative components; these are path-shape checks only.
    if (path.split("/").some((part) => !part || part === "." || part === "..") || names.has(path)) {
      throw new ImportStop("FOLDER_PATH");
    }
    names.add(path);
  }
  return selected;
}

/** The one TAR header the archive and its size forecast both write for a file. */
function tarEntry({ path, file }: ImportFile) {
  return { name: path, size: file.size };
}

const ZERO_CHUNK = new Uint8Array(1 << 20);

/**
 * Packs the selection's real headers with zero bodies, so the forecast is the archive's exact
 * size without reading any file.
 */
async function tarBytes(files: ImportFile[], signal?: AbortSignal): Promise<number> {
  const packer = createTarPacker();
  let bytes = 0;
  const counted = packer.readable.pipeTo(
    new WritableStream({
      write(chunk) {
        bytes += chunk.byteLength;
      },
    })
  );
  try {
    for (const entry of files) {
      signal?.throwIfAborted();
      const body = packer.controller.add(tarEntry(entry)).getWriter();
      for (let left = entry.file.size; left > 0; left -= ZERO_CHUNK.byteLength) {
        await body.write(ZERO_CHUNK.subarray(0, Math.min(left, ZERO_CHUNK.byteLength)));
      }
      await body.close();
    }
    packer.controller.finalize();
  } catch (error) {
    packer.controller.error(error);
    await counted.catch(() => {});
    throw error;
  }
  await counted;
  return bytes;
}

/** age's own stream size for a given recipient; header length depends on the recipient type. */
async function ageBytes(plaintextBytes: number, recipient: string): Promise<number> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(new ReadableStream<Uint8Array>());
  const size = encrypted.size(plaintextBytes);
  await encrypted.cancel();
  return size;
}

/**
 * The exact archive and ciphertext sizes. Before the cell issues its recipient, a throwaway
 * X25519 recipient stands in: C5 imports use the X25519 envelope, whose header length is fixed.
 */
export async function forecastImport(
  files: ImportFile[],
  recipient?: string,
  signal?: AbortSignal
): Promise<ImportForecast> {
  const archive = await tarBytes(files, signal);
  const stand = recipient ?? (await identityToRecipient(await generateX25519Identity()));
  return {
    files: files.length,
    plaintextBytes: files.reduce((total, { file }) => total + file.size, 0),
    tarBytes: archive,
    ciphertextBytes: await ageBytes(archive, stand),
  };
}

/** Stream plaintext through maintained TAR and age implementations into a ciphertext-only sink. */
export async function encryptImportFiles(
  files: ImportFile[],
  recipient: string,
  destination: WritableStream<Uint8Array>,
  signal?: AbortSignal,
  onProgress: (value: EncryptionProgress) => void = () => {}
): Promise<EncryptedImport> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const packer = createTarPacker();
  const encrypted = await encrypter.encrypt(packer.readable);
  const digest = sha256.create();
  const measured: EncryptionProgress = { files: 0, plaintextBytes: 0, ciphertextBytes: 0 };
  const report = () => onProgress({ ...measured });
  const transfer = encrypted
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          digest.update(chunk);
          measured.ciphertextBytes += chunk.byteLength;
          controller.enqueue(chunk);
          report();
        },
      })
    )
    .pipeTo(destination, { signal });
  const produce = (async () => {
    try {
      for (const entry of files) {
        signal?.throwIfAborted();
        await entry.file
          .stream()
          .pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                measured.plaintextBytes += chunk.byteLength;
                controller.enqueue(chunk);
              },
            })
          )
          .pipeTo(packer.controller.add(tarEntry(entry)), { signal });
        measured.files += 1;
        report();
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
  return { ciphertext_sha256: hex(digest.digest()), ciphertext_bytes: measured.ciphertextBytes };
}

function hex(digest: Uint8Array): string {
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 of a stored ciphertext, read in chunks so a large file never sits in memory. */
export async function digestImportCiphertext(
  ciphertext: Blob,
  onProgress: (bytes: number) => void = () => {},
  signal?: AbortSignal
): Promise<EncryptedImport> {
  const digest = sha256.create();
  let bytes = 0;
  await ciphertext.stream().pipeTo(
    new WritableStream({
      write(chunk) {
        digest.update(chunk);
        bytes += chunk.byteLength;
        onProgress(bytes);
      },
    }),
    { signal }
  );
  return { ciphertext_sha256: hex(digest.digest()), ciphertext_bytes: bytes };
}

/** Retry a part with the same ciphertext, without forwarding the signed-in session to storage. */
async function readable(blob: Blob): Promise<boolean> {
  try {
    await blob.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

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
      throw new ImportStop("DESTINATION");
    }
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      part.part_number !== index + 1 ||
      !Number.isSafeInteger(part.part_size_bytes) ||
      part.part_size_bytes <= 0
    ) {
      throw new ImportStop("DESTINATION");
    }
    total += part.part_size_bytes;
  }
  if (!parts.length || parts.length > MAX_IMPORT_PARTS || total !== ciphertext.size)
    throw new ImportStop("PARTS");
  let offset = 0;
  for (const part of parts) {
    signal?.throwIfAborted();
    const end = offset + part.part_size_bytes;
    if (!completed.has(part.part_number)) {
      const body = ciphertext.slice(offset, end);
      let response: Response;
      try {
        response = await fetch(part.url, {
          method: "PUT",
          body,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          signal,
        });
      } catch (error) {
        // Fetch reports a body it cannot read as a network failure (a TypeError), so a read of
        // the part tells a lost encrypted copy from a dropped connection.
        if (error instanceof TypeError && !(await readable(body)))
          throw new ImportStop("LOCAL_COPY_MISSING");
        throw error;
      }
      if (!response.ok) throw new ImportStop("STORAGE_REFUSED");
      const etag = response.headers.get("etag");
      if (!etag) throw new ImportStop("STORAGE_UNCONFIRMED");
      completed.set(part.part_number, etag);
    }
    offset = end;
    onProgress(offset);
  }
  return parts.map(({ part_number }) => ({ part_number, etag: completed.get(part_number)! }));
}
