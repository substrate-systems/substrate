import { createHash, createHmac } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { exomemErrors } from "./errors";
import { controlPlaneKeyFromEnv } from "./security";

// The client population bound lives in exomem_oauth_client_partition_available,
// which is where it is actually enforced. A MAX_OAUTH_CLIENTS = 32 constant used
// to sit here, exported and consumed by nothing, restating a number the database
// owns -- so raising the database bound would have left a stale 32 in the code
// with no test to catch it. Read the bound from the predicate, not from here.
export const MAX_OAUTH_CLIENT_REDIRECTS = 8;
export const MAX_OAUTH_CLIENT_ID_LENGTH = 2048;
export const MAX_OAUTH_REDIRECT_URI_LENGTH = 1024;
export const CIMD_MAX_BODY_BYTES = 32 * 1024;
export const CIMD_MAX_HEADER_BYTES = 8 * 1024;
export const CIMD_TIMEOUT_MS = 3_000;
export const CIMD_MIN_TTL_SECONDS = 300;
export const CIMD_MAX_TTL_SECONDS = 604_800;
export const CIMD_DEFAULT_TTL_SECONDS = 86_400;
// Matches exomem_oauth_clients_client_name_valid (migration 0062), which is the
// authority: a longer value would fail the insert, not be stored.
const MAX_OAUTH_CLIENT_NAME_LENGTH = 64;

export type OAuthClientAdmissionMode = "pinned" | "cimd";

export type OperatorOAuthClientRegistration = {
  admissionMode: OAuthClientAdmissionMode;
  platform: "claude" | "openai";
  artifactId?: string;
  clientId: string;
  redirectUris: string[];
  registeredAppIdSha256?: string;
  ttlSeconds?: number;
};

type AdmissionOptions = {
  cimdHosts?: readonly string[];
  customRedirectHosts?: readonly string[];
};

export type CimdFetchedMetadata = {
  raw: string;
  document: {
    client_id: string;
    redirect_uris: string[];
    token_endpoint_auth_method: "none";
  };
  /** The document's `client_name`, sanitised; absent or unusable reads as null. */
  clientName?: string | null;
};

/**
 * A validated RFC 7591 registration for a generic MCP client. Nothing here is
 * trusted for admission: the client is a public client that proves possession
 * through PKCE S256 at every authorization, and tenancy still needs an invite.
 */
export type GenericClientRegistration = {
  redirectUris: string[];
  /** The declared name, sanitised; null when the client declared no readable one. */
  clientName: string | null;
};

function configuredHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[a-z0-9.-]+$/.test(entry));
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function safeRedirectUri(value: string, customHosts: readonly string[]): boolean {
  if (value.length === 0 || value.length > MAX_OAUTH_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (isLoopbackHost(url.hostname) || customHosts.includes(url.hostname.toLowerCase()))
  );
}

/**
 * Redirect rule for a self-registering CIMD client, deliberately stricter than
 * `safeRedirectUri`.
 *
 * An operator-registered client is vouched for by the operator, so its redirects
 * only have to be safe. A client that registers itself off a host allowlist is
 * vouched for by nothing but the host, so the host has to be the whole of the
 * claim: the redirect must be https and must live on the same host that served
 * the metadata document. Anything looser would let whoever can place a document
 * on an admitted host name an arbitrary delivery address for authorization
 * codes, which is precisely the trust the allowlist was not asked to extend.
 *
 * Both web connectors this path exists for already satisfy it — ChatGPT
 * redirects to `chatgpt.com` and Claude to `claude.ai`. A native client's
 * loopback redirects are admitted separately (`cimdRedirectsAdmissible`).
 */
export function isSameHostHttpsRedirect(value: string, host: string): boolean {
  if (value.length === 0 || value.length > MAX_OAUTH_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  return url.protocol === "https:" && url.hostname.toLowerCase() === host.toLowerCase();
}

/**
 * The redirects a self-registering CIMD client may list: https on the host that
 * served its document (`isSameHostHttpsRedirect`), or a loopback address.
 *
 * Loopback is how a native client such as Claude Code receives its code (RFC
 * 8252 §7.3): the code only ever reaches the user's own machine, and PKCE S256,
 * which every authorization request must carry, binds it to the client that
 * started the flow. A cleartext redirect to anything but loopback still delivers
 * the code across a network, so it stays refused.
 */
export function cimdRedirectsAdmissible(redirectUris: readonly string[], host: string): boolean {
  return (
    redirectUris.length > 0 &&
    redirectUris.every(
      (uri) => isSameHostHttpsRedirect(uri, host) || isSafeLoopbackOAuthRedirect(uri)
    )
  );
}

/**
 * Whether `requested` is one of a client's approved redirects.
 *
 * Exact, except for one case RFC 8252 §7.3 requires: a loopback redirect
 * registered without a port matches the same scheme, host, path and query on
 * any port, because a native client binds whatever port is free at the time.
 * A loopback redirect registered with a port still has to match it exactly, and
 * `localhost`, `127.0.0.1` and `[::1]` stay distinct hosts.
 */
export function redirectUriApproved(approved: readonly string[], requested: string): boolean {
  if (approved.includes(requested)) return true;
  if (!isSafeLoopbackOAuthRedirect(requested)) return false;
  const wanted = new URL(requested);
  return approved.some((registered) => {
    if (!isSafeLoopbackOAuthRedirect(registered)) return false;
    const url = new URL(registered);
    // Only a registration already in canonical portless form matches any
    // port: `new URL` drops an explicit `:80`, which must stay pinned.
    if (url.port !== "" || url.href !== registered) return false;
    // Only the port may differ, and the request must be spelled exactly as
    // the registration with that port: parsing would accept `127.1`, `HTTP:`
    // or `/./callback` as the same address.
    url.port = wanted.port;
    return url.href === requested;
  });
}

/**
 * Whether a code sent to an already-admitted redirect reaches only the owner's
 * own machine: a loopback host over http or https. The admission rules decide
 * which of these a client may register; this reads only where one goes.
 */
export function isLoopbackRedirectDestination(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Bootstrap is intentionally narrower than ordinary client admission. */
export function isSafeLoopbackOAuthRedirect(value: string): boolean {
  if (value.length === 0 || value.length > MAX_OAUTH_REDIRECT_URI_LENGTH) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      isLoopbackHost(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Redirect rule for a generic (dynamically registered) client. Nobody vouches
 * for such a client, so it gets the self-registration rule rather than the
 * operator one: https without credentials or fragment, bounded, or loopback
 * http for a local agent that is served from no host (RFC 8252 section 7.3).
 * It is `safeRedirectUri` with no operator-configured cleartext hosts.
 *
 * The value must also already be its own canonical URL. `new URL` repairs what
 * it parses: it drops tabs and newlines, so "https://good.example\n.evil.example/cb"
 * delivers codes to good.example.evil.example, and it keeps an empty "#" that
 * the fragment check cannot see. The redirect is matched as a string and
 * delivered as a URL, so the two readings must agree. The cost is that a client
 * registering a non-canonical spelling, such as an upper-case host, is refused.
 */
function isGenericClientRedirect(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    // ASCII controls, space, DEL and "#": characters URL parsing drops or reads
    // as a fragment delimiter.
    if (code <= 0x20 || code === 0x7f || character === "#") return false;
  }
  try {
    if (new URL(value).href !== value) return false;
  } catch {
    return false;
  }
  return safeRedirectUri(value, []);
}

// Characters that let a declared name render as something other than the text
// it holds: Unicode "Other" (controls, bidi overrides, zero-width joiners,
// surrogates, private-use and unassigned code points), default-ignorable code
// points (such as the Hangul fillers), and U+2800 BRAILLE PATTERN BLANK, a
// symbol that renders as nothing and that no Unicode property marks as blank.
// This checks the shape of display text, not what the name means.
const UNDISPLAYABLE_NAME_CHARACTERS = /[\p{C}\p{Default_Ignorable_Code_Point}\u2800]/gu;
// A name must show at least one letter, number or symbol. Marks alone, such as
// a run of combining accents, render as nothing a person can read.
const VISIBLE_NAME_CHARACTER = /[\p{L}\p{N}\p{S}]/u;

/**
 * A client's self-declared `client_name` (RFC 7591 section 2, and the same field
 * in a Client ID Metadata Document), made safe to show. Returns null when the
 * value is not a string or holds nothing a person can read.
 */
export function sanitizeOAuthClientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFC")
    // A space, not nothing, so a hidden character cannot join two visible words.
    .replace(UNDISPLAYABLE_NAME_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(cleaned).slice(0, MAX_OAUTH_CLIENT_NAME_LENGTH).join("").trimEnd();
  return VISIBLE_NAME_CHARACTER.test(bounded) ? bounded : null;
}

// RFC 7591 section 2 grant types this server can serve. Fixed by the
// authorization server metadata (`grant_types_supported`), not by any client.
const GENERIC_CLIENT_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
// Token endpoint methods a registration may ask for. This server holds no client
// secrets, so it registers every one of these as `none` and says so in the
// response (RFC 7591 section 3.2.1 lets the server substitute a value). A
// method that authenticates with a key the client holds is refused instead.
const GENERIC_CLIENT_AUTH_METHODS = new Set([
  undefined,
  "none",
  "client_secret_post",
  "client_secret_basic",
]);

function optionalStringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value;
}

/**
 * Validate an RFC 7591 registration request from a generic MCP client.
 *
 * Returns null for every refusal; the caller answers all of them identically.
 * Every registered client is a public client that proves possession through
 * PKCE S256 (see `GENERIC_CLIENT_AUTH_METHODS`). A request that names its own
 * `client_id` or `client_secret` is refused, because both are server-assigned:
 * honouring a requested identifier is how a registration would reach an
 * existing client.
 */
export function validateGenericClientRegistration(body: unknown): GenericClientRegistration | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const request = body as Record<string, unknown>;
  if ("client_id" in request || "client_secret" in request) return null;
  if (!GENERIC_CLIENT_AUTH_METHODS.has(request.token_endpoint_auth_method as string | undefined)) {
    return null;
  }
  if (!exactStringList(request.redirect_uris)) return null;
  const redirectUris = request.redirect_uris;
  if (!redirectUris.every(isGenericClientRedirect)) return null;

  const responseTypes = optionalStringList(request.response_types);
  if (!responseTypes || responseTypes.some((type) => type !== "code")) return null;
  const requestedGrants = optionalStringList(request.grant_types);
  if (!requestedGrants || requestedGrants.some((type) => !GENERIC_CLIENT_GRANT_TYPES.has(type))) {
    return null;
  }
  // The server neither stores nor enforces grant types per client; a request
  // for a flow it cannot serve at all is still refused.
  if (requestedGrants.length > 0 && !requestedGrants.includes("authorization_code")) return null;

  return {
    redirectUris: [...redirectUris],
    clientName: sanitizeOAuthClientName(request.client_name),
  };
}

function exactStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_OAUTH_CLIENT_REDIRECTS &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length
  );
}

/**
 * A CIMD document qualifies when the client can authenticate the way this server
 * actually works: PKCE with no client credential.
 *
 * `token_endpoint_auth_method` is the client's *preference*, not a demand. Our
 * authorization-server metadata advertises `token_endpoint_auth_methods_supported:
 * ["none"]`, and RFC 8414 negotiation says a client picks a method the server
 * supports — so a document declaring `private_key_jwt` while also listing `none`
 * among its supported methods is admissible and will use `none` here. ChatGPT's
 * connector documents are exactly that shape, and requiring the declared method to
 * be literally `none` locked every OpenAI-side client out of the product.
 *
 * A document that cannot do `none` at all is still refused: this server has no
 * client-credential verification path, so admitting one would produce an
 * authorization that can never complete a token exchange.
 */
function advertisesUnauthenticatedToken(candidate: Record<string, unknown>): boolean {
  if (candidate.token_endpoint_auth_method === "none") return true;
  const supported = candidate.token_endpoint_auth_methods_supported;
  return Array.isArray(supported) && supported.includes("none");
}

export function normalizeOperatorOAuthClientRegistration(
  input: OperatorOAuthClientRegistration,
  options: AdmissionOptions = {}
): OperatorOAuthClientRegistration & { ttlSeconds: number } {
  const cimdHosts = options.cimdHosts ?? configuredHosts(process.env.EXOMEM_CIMD_ALLOWED_HOSTS);
  const customRedirectHosts =
    options.customRedirectHosts ?? configuredHosts(process.env.EXOMEM_OAUTH_REDIRECT_ALLOWED_HOSTS);
  if (
    (input.admissionMode !== "pinned" && input.admissionMode !== "cimd") ||
    (input.platform !== "claude" && input.platform !== "openai") ||
    (input.artifactId !== undefined &&
      (typeof input.artifactId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.artifactId
        ))) ||
    typeof input.clientId !== "string" ||
    input.clientId.length === 0 ||
    input.clientId.length > MAX_OAUTH_CLIENT_ID_LENGTH ||
    !exactStringList(input.redirectUris) ||
    (input.registeredAppIdSha256 !== undefined &&
      (typeof input.registeredAppIdSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.registeredAppIdSha256))) ||
    input.redirectUris.some((uri) => !safeRedirectUri(uri, customRedirectHosts))
  ) {
    throw exomemErrors.invalidRequest();
  }
  if (input.admissionMode === "cimd") {
    let url: URL;
    try {
      url = new URL(input.clientId);
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.port !== "" && url.port !== "443") ||
      !cimdHosts.includes(url.hostname.toLowerCase())
    ) {
      throw exomemErrors.invalidRequest();
    }
  }
  const ttlSeconds = input.ttlSeconds ?? CIMD_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < CIMD_MIN_TTL_SECONDS ||
    ttlSeconds > CIMD_MAX_TTL_SECONDS
  ) {
    throw exomemErrors.invalidExpiry();
  }
  return {
    admissionMode: input.admissionMode,
    platform: input.platform,
    artifactId: input.artifactId,
    clientId: input.clientId,
    redirectUris: [...input.redirectUris],
    ...(input.registeredAppIdSha256 ? { registeredAppIdSha256: input.registeredAppIdSha256 } : {}),
    ttlSeconds,
  };
}

export function operatorOAuthClientFingerprint(
  clientId: string,
  key: Buffer = controlPlaneKeyFromEnv()
): string {
  return createHmac("sha256", key)
    .update("exomem-oauth-client:v1\0", "utf8")
    .update(clientId)
    .digest("hex");
}

export function oauthClientConfigSha256(input: {
  platform: "claude" | "openai";
  admissionMode: OAuthClientAdmissionMode;
  clientId: string;
  redirectUris: readonly string[];
}): string {
  return createHash("sha256")
    .update("exomem-oauth-client-config:v1\0", "utf8")
    .update(
      JSON.stringify({
        admission_mode: input.admissionMode,
        client_id: input.clientId,
        platform: input.platform,
        redirect_uris: [...input.redirectUris].sort(),
        token_endpoint_auth_method: "none",
      }),
      "utf8"
    )
    .digest("hex");
}

export function documentDigest(document: string): Buffer {
  return createHash("sha256").update(document, "utf8").digest();
}

export function isCimdNetworkAddressAllowed(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      a >= 240 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      (a === 192 && b === 168)
    );
  }
  const normalized = address.toLowerCase();
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fec") ||
    normalized.startsWith("fed") ||
    normalized.startsWith("fee") ||
    normalized.startsWith("fef") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("::ffff:") ||
    normalized.startsWith("64:ff9b:") ||
    normalized.startsWith("64:ff9b:1:") ||
    normalized.startsWith("2002:") ||
    normalized.startsWith("2001:0000:") ||
    normalized.startsWith("2001:0:") ||
    normalized.startsWith("2001:db8:")
  );
}

/** Fetch only a pre-authorized CIMD document. DNS is resolved once and the request connects to that literal. */
export async function fetchCimdMetadata(clientId: string): Promise<CimdFetchedMetadata> {
  const url = new URL(clientId);
  const deadline = Date.now() + CIMD_TIMEOUT_MS;
  const remaining = () => Math.max(1, deadline - Date.now());
  const records = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(exomemErrors.invalidRequest()), remaining())
    ),
  ]);
  if (
    records.length === 0 ||
    records.length > 8 ||
    records.some((record) => !isCimdNetworkAddressAllowed(record.address))
  ) {
    throw exomemErrors.invalidRequest();
  }
  const address = records[0]!.address;
  const raw = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      result();
    };
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: address,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: url.host, accept: "application/json" },
        rejectUnauthorized: true,
        agent: false,
        maxHeaderSize: CIMD_MAX_HEADER_BYTES,
        timeout: remaining(),
      },
      (response) => {
        if (response.statusCode !== 200 || response.headers.location) {
          response.resume();
          settle(() => reject(exomemErrors.invalidRequest()));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > CIMD_MAX_BODY_BYTES) {
            request.destroy();
            settle(() => reject(exomemErrors.requestTooLarge()));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => settle(() => resolve(Buffer.concat(chunks).toString("utf8"))));
      }
    );
    const absoluteTimer = setTimeout(
      () => request.destroy(exomemErrors.invalidRequest()),
      remaining()
    );
    request.once("timeout", () => request.destroy(exomemErrors.invalidRequest()));
    request.once("error", () => settle(() => reject(exomemErrors.invalidRequest())));
    request.end();
  });
  return parseCimdDocument(raw, clientId);
}

/**
 * Validate a fetched CIMD body. Split out from the transport so the admission rules
 * are unit-testable without standing up a TLS server.
 */
export function parseCimdDocument(raw: string, clientId: string): CimdFetchedMetadata {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw exomemErrors.invalidRequest();
  }
  const candidate = document as Record<string, unknown>;
  if (
    !candidate ||
    candidate.client_id !== clientId ||
    !advertisesUnauthenticatedToken(candidate) ||
    !exactStringList(candidate.redirect_uris)
  ) {
    throw exomemErrors.invalidRequest();
  }
  return {
    raw,
    document: {
      client_id: candidate.client_id,
      redirect_uris: candidate.redirect_uris,
      token_endpoint_auth_method: "none",
    },
    // A display field only: an unusable name reads as none rather than refusing
    // a document that is otherwise admissible.
    clientName: sanitizeOAuthClientName(candidate.client_name),
  };
}
