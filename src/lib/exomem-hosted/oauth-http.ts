import { exomemErrors } from "./errors";

const MAX_OAUTH_FORM_BYTES = 16 * 1024;

export async function readOAuthForm(
  request: Request,
  allowedFields?: readonly string[]
): Promise<Record<string, string>> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    throw exomemErrors.invalidRequest();
  }
  const declared = request.headers.get("content-length");
  if (declared) {
    if (!/^\d+$/.test(declared) || Number(declared) > MAX_OAUTH_FORM_BYTES) {
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
    if (size > MAX_OAUTH_FORM_BYTES) {
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
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw exomemErrors.invalidRequest();
  }
  const form: Record<string, string> = {};
  for (const [key, value] of params) {
    if (
      key in form ||
      key.length > 128 ||
      value.length > 4096 ||
      (allowedFields && !allowedFields.includes(key))
    ) {
      throw exomemErrors.invalidRequest();
    }
    form[key] = value;
  }
  return form;
}

export function oauthNoStoreHeaders(): HeadersInit {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
  };
}
