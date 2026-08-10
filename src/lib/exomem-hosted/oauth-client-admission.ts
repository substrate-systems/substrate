import { createHash, createHmac } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { exomemErrors } from "./errors";
import { controlPlaneKeyFromEnv } from "./security";

export const MAX_OAUTH_CLIENTS = 32;
export const MAX_OAUTH_CLIENT_REDIRECTS = 8;
export const MAX_OAUTH_CLIENT_ID_LENGTH = 2048;
export const MAX_OAUTH_REDIRECT_URI_LENGTH = 1024;
export const CIMD_MAX_BODY_BYTES = 32 * 1024;
export const CIMD_MAX_HEADER_BYTES = 8 * 1024;
export const CIMD_TIMEOUT_MS = 3_000;
export const CIMD_MIN_TTL_SECONDS = 300;
export const CIMD_MAX_TTL_SECONDS = 604_800;
export const CIMD_DEFAULT_TTL_SECONDS = 86_400;

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

function exactStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_OAUTH_CLIENT_REDIRECTS &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length
  );
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

export function clientRedirectDigest(redirectUris: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...redirectUris]), "utf8")
    .digest("hex");
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
    candidate.token_endpoint_auth_method !== "none" ||
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
  };
}
