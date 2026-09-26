import { exomemErrors } from "./errors";

const MAX_OAUTH_FORM_BYTES = 16 * 1024;

const MAX_OAUTH_FORM_FIELDS = 64;

const PLATFORM_REQUEST_URL = Object.getOwnPropertyDescriptor(Request.prototype, "url")?.get;

/**
 * The request URL exactly as the client sent it.
 *
 * Next.js's NextRequest overrides `url` (and `nextUrl`) with a copy that
 * rewrites the first loopback literal anywhere in the URL to "localhost" --
 * `REGEX_LOCALHOST_HOSTNAME` in next/dist/server/web/next-url.js is not
 * anchored to the host, so it reaches into the query and rewrites an encoded
 * `redirect_uri=http%3A%2F%2F127.0.0.1...`. RFC 8252 section 7.3 loopback
 * redirects are compared exactly, so they could never match. The platform
 * Request NextRequest extends still holds the URL it was constructed with.
 *
 * The platform getter needs the real Request, not a Proxy of it (Next.js
 * proxies the request for routes that are not force-dynamic). Should that ever
 * apply, fall back to the normalised URL: loopback clients break as they did
 * before, and nothing else does.
 */
export function unnormalizedRequestUrl(request: Request): URL {
  try {
    if (PLATFORM_REQUEST_URL) return new URL(PLATFORM_REQUEST_URL.call(request) as string);
  } catch {
    // Not a platform Request; see above.
  }
  return new URL(request.url);
}

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
