/** Private, exact-handle download authority; never changes public tool arguments. */
import { createHash, randomUUID, sign, type KeyObject } from "node:crypto";

const MAX_BODY_BYTES = 1024 * 1024;
const BODY_READ_MS = 5000;
const OPERATIONS = new Set(["capture_source", "preserve_artifacts"]);

export class CloudArtifactBodyError extends Error {
  constructor(readonly status: number) {
    super("Cloud request body unavailable");
  }
}

/** Inspect bounded bytes for authority, preserving the existing stream on an inspection miss. */
export async function readCloudArtifactBody(request: Request): Promise<{
  body: BodyInit | null;
  inspected?: Uint8Array;
}> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    return { body: request.body };
  }
  if (!request.body) return { body: null, inspected: new Uint8Array() };
  const reader = request.body.getReader();
  let expired = false;
  let waiting:
    | {
        resolve: (value: ReadableStreamReadResult<Uint8Array> | null) => void;
        reject: (reason: unknown) => void;
      }
    | undefined;
  // One replaceable waiter: racing each chunk against shared unresolved promises
  // would retain two promise handlers per chunk until inspection ends.
  const timer = setTimeout(() => {
    expired = true;
    waiting?.resolve(null);
  }, BODY_READ_MS);
  const abort = () => waiting?.reject(new CloudArtifactBodyError(408));
  request.signal.addEventListener("abort", abort, { once: true });
  // A fixed buffer bounds allocation even when a sender emits millions of tiny chunks.
  const buffer = Buffer.allocUnsafe(MAX_BODY_BYTES);
  let bytes = 0;
  function replay(
    pending: Promise<ReadableStreamReadResult<Uint8Array>>
  ): ReadableStream<Uint8Array> {
    let prefix = bytes ? buffer.subarray(0, bytes) : undefined;
    let next: Promise<ReadableStreamReadResult<Uint8Array>> | undefined = pending;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (prefix) {
          controller.enqueue(prefix);
          prefix = undefined;
          return;
        }
        try {
          const result = await (next ?? reader.read());
          next = undefined;
          if (result.done) {
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
  try {
    while (true) {
      const pending = reader.read();
      const result = await new Promise<ReadableStreamReadResult<Uint8Array> | null>(
        (resolve, reject) => {
          waiting = { resolve, reject };
          pending.then(resolve, reject);
          if (request.signal.aborted) abort();
          else if (expired) resolve(null);
        }
      );
      waiting = undefined;
      if (result === null) return { body: replay(pending) };
      const { done, value } = result;
      if (done) break;
      if (bytes + value.byteLength > MAX_BODY_BYTES)
        return { body: replay(Promise.resolve(result)) };
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
    reader.releaseLock();
    const inspected = buffer.subarray(0, bytes);
    return { body: inspected as BodyInit, inspected };
  } catch {
    // A disconnected/hostile sender cannot keep the authenticated slot occupied.
    void reader.cancel().catch(() => undefined);
    throw new CloudArtifactBodyError(408);
  } finally {
    clearTimeout(timer);
    waiting = undefined;
    request.signal.removeEventListener("abort", abort);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" && [...value].length <= maxChars && !/[\uD800-\uDFFF]/u.test(value)
  );
}

function descriptorDigest(file: unknown): string | null {
  if (!object(file)) return null;
  // Existing cell schema/custody strips Python Unicode whitespace from file IDs.
  // Unknown descriptor keys are discarded by that schema; authorize only consumed fields.
  const fileId =
    typeof file.file_id === "string"
      ? file.file_id.replace(
          /^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu,
          ""
        )
      : null;
  if (!validString(fileId, 256) || !fileId) return null;
  if (!validString(file.download_url, 8192) || !file.download_url) return null;
  if (file.mime_type != null && !validString(file.mime_type, 255)) return null;
  if (
    file.file_name != null &&
    (!validString(file.file_name, 1024) || Buffer.byteLength(file.file_name, "utf8") > 1024)
  )
    return null;
  const descriptor = [fileId, file.download_url, file.mime_type ?? null, file.file_name ?? null];
  return createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex");
}

/** OAuth cell identity, not MCP headers or caller-selected routing, owns this grant. */
export function cloudArtifactGrant(body: Uint8Array, cell: string, key: KeyObject): string | null {
  let call: unknown;
  try {
    call = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!object(call) || call.method !== "tools/call" || !object(call.params)) return null;
  const operation = call.params.name;
  const args = call.params.arguments;
  if (typeof operation !== "string" || !OPERATIONS.has(operation) || !object(args)) return null;
  if (!Array.isArray(args.files) || args.files.length < 1 || args.files.length > 8) return null;
  const handles = args.files.map(descriptorDigest);
  if (handles.some((handle) => handle === null)) return null;
  const issued = Date.now();
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      aud: "exomem-artifact-broker",
      sub: cell,
      op: operation,
      jti: randomUUID(),
      issued_ms: issued,
      exp: Math.floor(issued / 1000) + 60,
      handles,
      max_files: 8,
      max_bytes: 100 * 1024 * 1024,
    })
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(null, Buffer.from(unsigned), key).toString("base64url")}`;
}
