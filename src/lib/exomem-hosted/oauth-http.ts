import { exomemErrors } from "./errors";

const MAX_OAUTH_FORM_BYTES = 16 * 1024;

const MAX_OAUTH_FORM_FIELDS = 64;

/**
 * `ignoreUnrecognized` drops unknown fields instead of rejecting the request,
 * as RFC 6749 section 3.2 requires of the token endpoint.
 *
 * The caller still decides what the surviving fields must look like, so this
 * cannot admit a request whose recognized fields are wrong. It exists because a
 * client that advertises `private_key_jwt` may send `client_assertion` even
 * after negotiating down to the `none` this server advertises. We do not verify
 * that assertion and must not be read as doing so — it is discarded. The proof
 * that authorizes the exchange is unchanged and unweakened: PKCE S256 binding,
 * a single-use code, and an exact redirect match. No client here can hold a
 * credential, so there is no stronger authentication being downgraded.
 */
export async function readOAuthForm(
  request: Request,
  allowedFields?: readonly string[],
  options?: { ignoreUnrecognized?: boolean }
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
  const seen = new Set<string>();
  for (const [key, value] of params) {
    // Duplicates stay fatal even for dropped fields: a repeated key is the
    // ambiguity used to smuggle a second value past whichever layer reads it.
    if (seen.has(key) || key.length > 128 || value.length > 4096) {
      throw exomemErrors.invalidRequest();
    }
    seen.add(key);
    if (seen.size > MAX_OAUTH_FORM_FIELDS) throw exomemErrors.invalidRequest();
    if (allowedFields && !allowedFields.includes(key)) {
      if (options?.ignoreUnrecognized) continue;
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
