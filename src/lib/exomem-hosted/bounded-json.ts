import { exomemErrors } from "./errors";

// Takes a Response as well as a Request: the Home channel reads the cell's answer with the same bound.
export async function readBoundedJsonRequest(
  request: Pick<Request, "headers" | "body">,
  maxBytes: number
): Promise<unknown> {
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw) {
    if (!/^\d+$/.test(declaredRaw)) throw exomemErrors.invalidRequest();
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw exomemErrors.requestTooLarge();
    }
  }
  if (!request.body) throw exomemErrors.invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw exomemErrors.requestTooLarge();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw exomemErrors.invalidRequest();
  }
}
