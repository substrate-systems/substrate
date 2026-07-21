import { createHash, createHmac, randomUUID } from "node:crypto";
import { ADOPTION_RUN_ID } from "./adoption-staging";
import { createTransferGrantRecord } from "./db";
import { exomemErrors } from "./errors";
import { resolveGatewayPrivateTarget, type GatewayDependencies } from "./gateway";
import { exomemPublicBaseUrlFromEnv, parseExomemPublicBaseUrl } from "./public-origin";
import { digestSecret, type SensitiveSecret } from "./security";

export const TRANSFER_AUDIENCE = "exomem-hosted-transfer";
export const TRANSFER_GRANT_VERSION = 2;
export const TRANSFER_TTL_SECONDS = 5 * 60;
export const TRANSFER_MAX_TTL_SECONDS = 15 * 60;
export const TRANSFER_UPLOAD_MAX_BYTES = 90 * 1024 * 1024;
export const TRANSFER_GRANT_HEADER = "X-Exomem-Transfer-Grant";
export const TRANSFER_UPLOAD_PATH = "/public/exomem/v2/transfers/upload";
export const TRANSFER_DOWNLOAD_PATH = "/public/exomem/v2/transfers/download";

type TransferOperation = "upload" | "download";
const SHA256 = /^[0-9a-f]{64}$/;
const CELL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CREDENTIAL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MEDIA_TYPE =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:;[!#$%&'*+.^_`|~0-9A-Za-z=-]+)*$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TransferDependencies = GatewayDependencies & {
  createGrant?: typeof createTransferGrantRecord;
  randomUUID?: () => string;
  publicOrigin?: string;
  transferHost?: string;
};

export type UploadMetadataV2 = {
  category: string | null;
  content_type: string;
  description: string | null;
  filename: string;
  scope: string | null;
  sha256: string;
  size: number;
};

// Adoption staging intake rides the SAME locked upload-v1 grant target as a
// normal upload; the cell routes on the signed metadata fields (scope ==
// "adoption-staging", category == run id, description == optional relative
// subdirectory) because the upload-v1 schema has no room for new fields. The
// caller supplies only the adoption shape below — the staging binding is
// composed here, never caller-supplied.
export type AdoptionUploadMetadataV1 = {
  content_type: string;
  filename: string;
  path: string | null;
  run_id: string;
  sha256: string;
  size: number;
};

export type DirectTransferRequest =
  | { operation: "upload"; metadata: UploadMetadataV2 }
  | { operation: "adoption-upload"; metadata: AdoptionUploadMetadataV1 }
  | { operation: "download"; path: string };

export type DirectTransferTicket = {
  url: string;
  method: "PUT" | "GET";
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
  requestId: string;
};

type UploadGrantTarget = {
  kind: "upload-v1";
  metadata: UploadMetadataV2;
  metadata_sha256: string;
};

type DownloadGrantTarget = { kind: "download-v1"; path: string };
type TransferGrantTarget = UploadGrantTarget | DownloadGrantTarget;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function canonicalPrincipalScope(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && base64url(decoded) === value;
}

function validDnsName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value === value.toLowerCase() &&
    !value.endsWith(".") &&
    value.split(".").every((label) => DNS_LABEL.test(label))
  );
}

function canonicalTransferOrigin(value: string): string {
  if (!value || !/^[\x00-\x7f]+$/.test(value) || value.length > 255) {
    throw exomemErrors.invalidRequest();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw exomemErrors.invalidRequest();
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !validDnsName(url.hostname) ||
    (url.port !== "" &&
      (!/^[1-9][0-9]{0,4}$/.test(url.port) || Number(url.port) > 65_535 || url.port === "443"))
  ) {
    throw exomemErrors.invalidRequest();
  }
  return value;
}

export function mintCellTransferGrant(input: {
  credential: SensitiveSecret;
  credentialVersion: string;
  origin: string;
  cellId: string;
  principalScope: string;
  operation: TransferOperation;
  jti: string;
  maxBytes: number;
  issuedAt: number;
  ttlSeconds?: number;
  target: TransferGrantTarget;
}): { token: string; expiresAt: number } {
  const ttlSeconds = input.ttlSeconds ?? TRANSFER_TTL_SECONDS;
  const canonicalOrigin = parseExomemPublicBaseUrl(input.origin);
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    !Number.isSafeInteger(input.issuedAt) ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > TRANSFER_MAX_TTL_SECONDS
  ) {
    throw exomemErrors.invalidRequest();
  }
  if (
    utf8Length(input.credential.reveal()) < 32 ||
    !CREDENTIAL_VERSION.test(input.credentialVersion) ||
    canonicalOrigin !== input.origin ||
    canonicalTransferOrigin(canonicalOrigin) !== input.origin ||
    !CELL_ID.test(input.cellId) ||
    !canonicalPrincipalScope(input.principalScope) ||
    !UUID_V4.test(input.jti)
  ) {
    throw exomemErrors.invalidRequest();
  }
  if (input.operation === "upload") {
    if (
      input.target.kind !== "upload-v1" ||
      uploadTarget(input.target.metadata, input.maxBytes).metadata_sha256 !==
        input.target.metadata_sha256
    ) {
      throw exomemErrors.invalidRequest();
    }
  } else if (input.target.kind !== "download-v1" || !validDownloadPath(input.target.path)) {
    throw exomemErrors.invalidRequest();
  }
  const method = input.operation === "upload" ? "PUT" : "GET";
  const claims = {
    v: TRANSFER_GRANT_VERSION,
    aud: TRANSFER_AUDIENCE,
    kid: input.credentialVersion,
    origin: input.origin,
    op: input.operation,
    method,
    cell: input.cellId,
    principal: input.principalScope,
    iat: input.issuedAt,
    nbf: input.issuedAt,
    exp: input.issuedAt + ttlSeconds,
    jti: input.jti,
    limits: { max_bytes: input.maxBytes },
    target: input.target,
  };
  const payload = base64url(Buffer.from(JSON.stringify(canonicalize(claims)), "utf8"));
  const signature = createHmac("sha256", input.credential.reveal())
    .update(payload, "ascii")
    .digest();
  const token = `${payload}.${base64url(signature)}`;
  if (Buffer.byteLength(token, "ascii") > 8192) throw exomemErrors.invalidRequest();
  return {
    token,
    expiresAt: claims.exp,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validNfcOptional(value: string | null, maximum: number): boolean {
  return (
    value === null ||
    (value.length > 0 &&
      value.isWellFormed() &&
      value.normalize("NFC") === value &&
      utf8Length(value) <= maximum)
  );
}

function validFilename(value: string): boolean {
  return (
    value.isWellFormed() &&
    value.normalize("NFC") === value &&
    utf8Length(value) >= 1 &&
    utf8Length(value) <= 512 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function validDownloadPath(value: string): boolean {
  const parts = value.split("/");
  return (
    value.isWellFormed() &&
    value.normalize("NFC") === value &&
    utf8Length(value) >= 1 &&
    utf8Length(value) <= 4096 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    utf8Length(parts.at(-1) ?? "") <= 512
  );
}

const ADOPTION_STAGING_SCOPE = "adoption-staging";

function validStagingPath(value: string): boolean {
  const parts = value.split("/");
  return (
    value.isWellFormed() &&
    value.normalize("NFC") === value &&
    utf8Length(value) >= 1 &&
    utf8Length(value) <= 2048 &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function adoptionUploadTarget(
  metadata: AdoptionUploadMetadataV1,
  maxBytes: number
): UploadGrantTarget {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !== "content_type,filename,path,run_id,sha256,size" ||
    typeof metadata.run_id !== "string" ||
    !ADOPTION_RUN_ID.test(metadata.run_id) ||
    (metadata.path !== null &&
      (typeof metadata.path !== "string" || !validStagingPath(metadata.path)))
  ) {
    throw exomemErrors.invalidRequest();
  }
  return uploadTarget(
    {
      category: metadata.run_id,
      content_type: metadata.content_type,
      description: metadata.path,
      filename: metadata.filename,
      scope: ADOPTION_STAGING_SCOPE,
      sha256: metadata.sha256,
      size: metadata.size,
    },
    maxBytes
  );
}

function uploadTarget(metadata: UploadMetadataV2, maxBytes: number): UploadGrantTarget {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !==
      "category,content_type,description,filename,scope,sha256,size" ||
    typeof metadata.filename !== "string" ||
    !validFilename(metadata.filename) ||
    typeof metadata.content_type !== "string" ||
    !metadata.content_type.match(MEDIA_TYPE) ||
    !metadata.content_type.isWellFormed() ||
    Buffer.byteLength(metadata.content_type, "ascii") > 255 ||
    !validNfcOptional(metadata.scope, 512) ||
    !validNfcOptional(metadata.category, 512) ||
    !validNfcOptional(metadata.description, 2048) ||
    !SHA256.test(metadata.sha256) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > maxBytes ||
    metadata.size > TRANSFER_UPLOAD_MAX_BYTES
  ) {
    throw exomemErrors.invalidRequest();
  }
  const metadataSha256 = createHash("sha256").update(canonicalJson(metadata), "utf8").digest("hex");
  return {
    kind: "upload-v1",
    metadata: structuredClone(metadata),
    metadata_sha256: metadataSha256,
  };
}

function transferLimit(
  target: Awaited<ReturnType<typeof resolveGatewayPrivateTarget>>,
  operation: TransferOperation
): number {
  const key = operation === "upload" ? "uploadBytes" : "storageBytes";
  const value = target.row.resourceLimits[key];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw exomemErrors.entitlementDenied();
  }
  return operation === "upload" ? Math.min(value, TRANSFER_UPLOAD_MAX_BYTES) : value;
}

function assertTransferEntitlement(
  target: Awaited<ReturnType<typeof resolveGatewayPrivateTarget>>,
  operation: TransferOperation
): void {
  const capability = operation === "upload" ? "capture" : "recall";
  if (
    !target.row.capabilities.includes(capability) ||
    target.row.manuallySuspended ||
    target.row.entitlementEffectiveState === "suspended"
  ) {
    throw exomemErrors.entitlementDenied();
  }
}

function transferHostFromEnv(value = process.env.EXOMEM_HOSTED_TRANSFER_HOST): string {
  if (!value || !/^[\x00-\x7f]+$/.test(value) || value.includes("/")) {
    throw exomemErrors.cellUnavailable();
  }
  const [host, port, ...extra] = value.split(":");
  if (
    extra.length > 0 ||
    !host ||
    !validDnsName(host) ||
    (port !== undefined &&
      (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535 || port === "443"))
  ) {
    throw exomemErrors.cellUnavailable();
  }
  return value;
}

export async function createDirectTransferTicket(input: {
  session: { userId: string; tenantId: string };
  request: DirectTransferRequest;
  dependencies?: TransferDependencies;
}): Promise<DirectTransferTicket> {
  const dependencies = input.dependencies ?? {};
  const operation: TransferOperation =
    input.request.operation === "download" ? "download" : "upload";
  const target = await resolveGatewayPrivateTarget(input.session, dependencies);
  assertTransferEntitlement(target, operation);
  const maxBytes = transferLimit(target, operation);
  const requestId = (dependencies.randomUUID ?? randomUUID)();
  const jti = (dependencies.randomUUID ?? randomUUID)();
  const issuedAt = Math.floor((dependencies.now ?? Date.now)() / 1000);
  const origin = parseExomemPublicBaseUrl(
    dependencies.publicOrigin ?? exomemPublicBaseUrlFromEnv()
  );
  const transferHost = transferHostFromEnv(dependencies.transferHost);
  const grantTarget: TransferGrantTarget =
    input.request.operation === "upload"
      ? uploadTarget(input.request.metadata, maxBytes)
      : input.request.operation === "adoption-upload"
        ? adoptionUploadTarget(input.request.metadata, maxBytes)
        : (() => {
            if (!validDownloadPath(input.request.path)) throw exomemErrors.invalidRequest();
            return { kind: "download-v1", path: input.request.path };
          })();
  const credentialVersion = String(target.row.credentialVersion);
  if (
    !CELL_ID.test(target.row.cellId) ||
    !Number.isSafeInteger(target.row.credentialVersion) ||
    target.row.credentialVersion <= 0 ||
    !CREDENTIAL_VERSION.test(credentialVersion) ||
    !canonicalPrincipalScope(target.principalScope)
  ) {
    throw exomemErrors.cellUnavailable();
  }
  const signed = mintCellTransferGrant({
    credential: target.credential,
    credentialVersion,
    origin,
    cellId: target.row.cellId,
    principalScope: target.principalScope,
    operation,
    jti,
    maxBytes,
    issuedAt,
    target: grantTarget,
  });
  const expiresAt = new Date(signed.expiresAt * 1000);
  const recorded = await (dependencies.createGrant ?? createTransferGrantRecord)({
    grantDigest: digestSecret(signed.token),
    tenantId: input.session.tenantId,
    cellId: target.row.cellId,
    userId: input.session.userId,
    principalScopeDigest: digestSecret(target.principalScope),
    operation,
    issuedAt: new Date(issuedAt * 1000),
    expiresAt,
    byteLimit: maxBytes,
  });
  if (!recorded) throw exomemErrors.cellUnavailable();
  const path = operation === "upload" ? TRANSFER_UPLOAD_PATH : TRANSFER_DOWNLOAD_PATH;
  return {
    url: `https://${transferHost}/cells/${target.row.cellId}${path}`,
    method: operation === "upload" ? "PUT" : "GET",
    headers: {
      [TRANSFER_GRANT_HEADER]: signed.token,
      ...(operation === "upload"
        ? { "Content-Type": (grantTarget as UploadGrantTarget).metadata.content_type }
        : {}),
    },
    expiresAt: expiresAt.toISOString(),
    maxBytes,
    requestId,
  };
}
