/**
 * Signed upload routing and login origin for Cloud cells
 * (bridge-cloud-agent-uploads). Neither object carries a bearer: the cell's
 * single-use ticket stays the upload authority, and these name whose it is.
 */
import { createHash, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import type { ExomemCloudConfig } from "../lib/exomem-hosted/cloud-config";
import type { ActiveCloudOAuthLogin } from "../lib/exomem-hosted/cloud-oauth";

// Version 1 of the protocol; the Exomem cell verifies the same names and formats.
export const CLOUD_ORIGIN_AUDIENCE = "exomem-cloud-origin";
export const CLOUD_UPLOAD_ROUTE_AUDIENCE = "exomem-cloud-upload-route";
export const CLOUD_ORIGIN_HEADER = "x-exomem-cloud-origin";
export const CLOUD_UPLOAD_ROUTE_HEADER = "x-exomem-cloud-upload-route";
export const CLOUD_UPLOAD_TICKET_HEADER = "x-exomem-cloud-upload-ticket";
export const CLOUD_UPLOAD_PATH = "/upload";
const CLOUD_UPLOAD_PREFIX = "exomem-cloud-upload:v1:";
const CELL_TICKET_PREFIX = "exomem-upload:";
// The cell's portable handoff contract caps one handoff at 900 seconds.
const CLOUD_UPLOAD_TTL_SECONDS = 900;
// One forwarded request; the cell checks the proof when that request starts.
const ORIGIN_PROOF_TTL_SECONDS = 60;
// Leaves room in the CLI's 16 KiB handoff input and in an ordinary HTTP header.
const CLOUD_UPLOAD_MAX_TOKEN_CHARS = 8 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOWER_HEX = /^(?:[0-9a-f]{2})+$/;

const originFields = {
  tenant_id: z.uuid(),
  cell_id: z.string().regex(/^[a-z2-7]{16}$/),
  client_id: z.string().min(1),
  grant_id: z.uuid(),
  family_id: z.uuid(),
  resource: z.url(),
};
const originSchema = z.strictObject(originFields);
const routeSchema = z.strictObject({
  ...originFields,
  v: z.literal(1),
  upload_url: z.url(),
  iss: z.string(),
  aud: z.literal(CLOUD_UPLOAD_ROUTE_AUDIENCE),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.uuid(),
});

export type CloudOAuthOrigin = z.infer<typeof originSchema>;
export type CloudUploadRoute = z.infer<typeof routeSchema>;
export type CloudUploadHandoff = { capsule: string; ticket: string };

export class CloudUploadUnavailable extends Error {
  constructor() {
    super("Cloud upload authority is unavailable");
    this.name = "CloudUploadUnavailable";
  }
}

/** Whether the gateway issues and accepts upload handoffs for this cell. */
export function cloudUploadEnabled(config: ExomemCloudConfig, cellId: string): boolean {
  return Boolean(config.artifactSigningKey && config.uploadCells?.has(cellId));
}

export function cloudOAuthOrigin(login: ActiveCloudOAuthLogin): CloudOAuthOrigin {
  return originSchema.parse({
    tenant_id: login.tenantId,
    cell_id: login.cellId,
    client_id: login.clientId,
    grant_id: login.grantId,
    family_id: login.familyId,
    resource: login.resource,
  });
}

export function sameCloudOrigin(left: CloudOAuthOrigin, right: CloudOAuthOrigin): boolean {
  return (Object.keys(originFields) as Array<keyof CloudOAuthOrigin>).every(
    (field) => left[field] === right[field]
  );
}

/**
 * The fixed upload endpoint beside the resource. HTTPS, or HTTP on a literal
 * loopback address: the same rule the Exomem CLI applies before sending bytes.
 */
export function cloudUploadUrl(resource: string): string {
  const endpoint = new URL(CLOUD_UPLOAD_PATH, resource);
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    (isIP(host) === 4 && host.startsWith("127.")) || (isIP(host) === 6 && host === "::1");
  if (
    !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new CloudUploadUnavailable();
  }
  return endpoint.href;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sign(
  payload: JWTPayload,
  key: KeyObject,
  audience: string,
  login: ActiveCloudOAuthLogin,
  lifetime: number,
  now: number
): Promise<string> {
  return new SignJWT({ v: 1, ...cloudOAuthOrigin(login), ...payload })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(login.resource)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + lifetime)
    .setJti(randomUUID())
    .sign(key);
}

/** The routing capsule an upload handoff carries; the cell embeds it in its token. */
export async function signCloudUploadRoute(
  login: ActiveCloudOAuthLogin,
  key: KeyObject,
  now = nowSeconds()
): Promise<string> {
  const capsule = await sign(
    { upload_url: cloudUploadUrl(login.resource) },
    key,
    CLOUD_UPLOAD_ROUTE_AUDIENCE,
    login,
    CLOUD_UPLOAD_TTL_SECONDS,
    now
  );
  // The emitted token hexes the capsule; refuse an identity too long to fit, never truncate it.
  if (CLOUD_UPLOAD_PREFIX.length + capsule.length * 2 + 1 + 64 > CLOUD_UPLOAD_MAX_TOKEN_CHARS) {
    throw new CloudUploadUnavailable();
  }
  return capsule;
}

/**
 * Fresh origin for one forwarded request. An upload proof also names the
 * ticket it carries, so it cannot authorize a different one.
 */
export function signCloudOriginProof(
  login: ActiveCloudOAuthLogin,
  key: KeyObject,
  purpose: { purpose: "mcp" } | { purpose: "upload"; ticket: string },
  now = nowSeconds()
): Promise<string> {
  const payload: JWTPayload =
    purpose.purpose === "upload"
      ? {
          purpose: "upload",
          ticket_sha256: createHash("sha256").update(purpose.ticket, "ascii").digest("hex"),
        }
      : { purpose: "mcp" };
  return sign(payload, key, CLOUD_ORIGIN_AUDIENCE, login, ORIGIN_PROOF_TTL_SECONDS, now);
}

export async function verifyCloudUploadRoute(
  capsule: string,
  key: KeyObject,
  resource: string,
  now = nowSeconds()
): Promise<CloudUploadRoute> {
  try {
    const { payload } = await jwtVerify(capsule, createPublicKey(key), {
      algorithms: ["EdDSA"],
      typ: "JWT",
      issuer: resource,
      audience: CLOUD_UPLOAD_ROUTE_AUDIENCE,
      requiredClaims: ["iat", "exp", "jti"],
      currentDate: new Date(now * 1000),
    });
    const route = routeSchema.parse(payload);
    if (
      route.exp - route.iat > CLOUD_UPLOAD_TTL_SECONDS ||
      route.resource !== resource ||
      route.upload_url !== cloudUploadUrl(resource)
    ) {
      throw new CloudUploadUnavailable();
    }
    return route;
  } catch {
    throw new CloudUploadUnavailable();
  }
}

/** The handoff an upload's Authorization header carries; RFC 6750 schemes are case-insensitive. */
export function parseCloudUploadAuthorization(header: string | null): CloudUploadHandoff {
  const match = /^Bearer (\S+)$/i.exec(header ?? "");
  if (!match) throw new CloudUploadUnavailable();
  return parseCloudUploadEnvelope(match[1]);
}

/**
 * Splits `exomem-cloud-upload:v1:<capsule as lowercase hex>:<ticket nonce>`.
 * Hex keeps the compact JWT intact through output scrubbing; the bytes must
 * re-encode to the same hex, so a decoded capsule is exactly what was signed.
 */
function parseCloudUploadEnvelope(value: string): CloudUploadHandoff {
  if (value.length > CLOUD_UPLOAD_MAX_TOKEN_CHARS || !value.startsWith(CLOUD_UPLOAD_PREFIX)) {
    throw new CloudUploadUnavailable();
  }
  const parts = value.slice(CLOUD_UPLOAD_PREFIX.length).split(":");
  if (parts.length !== 2 || !LOWER_HEX.test(parts[0]) || !SHA256_HEX.test(parts[1])) {
    throw new CloudUploadUnavailable();
  }
  const capsule = Buffer.from(parts[0], "hex").toString("ascii");
  if (Buffer.from(capsule, "ascii").toString("hex") !== parts[0]) {
    throw new CloudUploadUnavailable();
  }
  return { capsule, ticket: CELL_TICKET_PREFIX + parts[1] };
}
