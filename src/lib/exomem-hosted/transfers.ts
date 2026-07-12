import { createHmac, randomUUID } from "node:crypto";
import {
  consumeTransferGrantRecord,
  createTransferGrantRecord,
  finishTransferGrantRecord,
} from "./db";
import { exomemErrors } from "./errors";
import {
  privateGatewayHeaders,
  resolveGatewayPrivateTarget,
  type GatewayDependencies,
  type ResolvedPrivateTarget,
} from "./gateway";
import { digestSecret, type SensitiveSecret } from "./security";

export const TRANSFER_AUDIENCE = "exomem-hosted-transfer";
export const TRANSFER_GRANT_VERSION = 1;
export const TRANSFER_TTL_SECONDS = 5 * 60;
export const TRANSFER_MAX_TTL_SECONDS = 15 * 60;
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

type TransferOperation = "upload" | "download";

async function readTransferChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(exomemErrors.cellUnavailable());
          void reader.cancel().catch(() => undefined);
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readBoundedTransferJson(
  response: Response,
  maxBytes: number,
  idleTimeoutMs: number
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs <= 0
  ) {
    throw exomemErrors.cellResponseInvalid();
  }
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(length) || length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw exomemErrors.cellResponseInvalid();
    }
  }
  if (!response.body) throw exomemErrors.cellResponseInvalid();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const next = await readTransferChunk(reader, idleTimeoutMs);
    if (next.done) break;
    received += next.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw exomemErrors.cellResponseInvalid();
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw exomemErrors.cellResponseInvalid();
  }
}

export type TransferDependencies = GatewayDependencies & {
  createGrant?: typeof createTransferGrantRecord;
  consumeGrant?: typeof consumeTransferGrantRecord;
  finishGrant?: typeof finishTransferGrantRecord;
};

export type BoundTransfer = {
  grantId: string;
  grant: string;
  operation: TransferOperation;
  maxBytes: number;
  requestId: string;
  target: ResolvedPrivateTarget;
  expiresAt: Date;
};

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

export function mintCellTransferGrant(input: {
  credential: SensitiveSecret;
  tenantId: string;
  cellId: string;
  principalScope: string;
  operation: TransferOperation;
  jti: string;
  maxBytes: number;
  issuedAt: number;
  ttlSeconds?: number;
}): { token: string; expiresAt: number } {
  const ttlSeconds = input.ttlSeconds ?? TRANSFER_TTL_SECONDS;
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
  const claims = {
    v: TRANSFER_GRANT_VERSION,
    aud: TRANSFER_AUDIENCE,
    op: input.operation,
    tenant: input.tenantId,
    cell: input.cellId,
    principal: input.principalScope,
    iat: input.issuedAt,
    exp: input.issuedAt + ttlSeconds,
    jti: input.jti,
    limits: { max_bytes: input.maxBytes },
  };
  const payload = base64url(Buffer.from(JSON.stringify(canonicalize(claims)), "utf8"));
  const signature = createHmac("sha256", input.credential.reveal())
    .update(payload, "ascii")
    .digest();
  return {
    token: `${payload}.${base64url(signature)}`,
    expiresAt: claims.exp,
  };
}

function transferLimit(target: ResolvedPrivateTarget, operation: TransferOperation): number {
  const key = operation === "upload" ? "uploadBytes" : "storageBytes";
  const value = target.row.resourceLimits[key];
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw exomemErrors.entitlementDenied();
  }
  return value;
}

function assertTransferEntitlement(
  target: ResolvedPrivateTarget,
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

export async function createBoundTransfer(input: {
  session: { userId: string; tenantId: string };
  operation: TransferOperation;
  dependencies?: TransferDependencies;
}): Promise<BoundTransfer> {
  const dependencies = input.dependencies ?? {};
  const target = await resolveGatewayPrivateTarget(input.session, dependencies);
  assertTransferEntitlement(target, input.operation);
  const maxBytes = transferLimit(target, input.operation);
  const requestId = randomUUID();
  const jti = randomUUID();
  const issuedAt = Math.floor((dependencies.now ?? Date.now)() / 1000);
  const signed = mintCellTransferGrant({
    credential: target.credential,
    tenantId: input.session.tenantId,
    cellId: target.row.cellId,
    principalScope: target.principalScope,
    operation: input.operation,
    jti,
    maxBytes,
    issuedAt,
  });
  const expiresAt = new Date(signed.expiresAt * 1000);
  const recorded = await (dependencies.createGrant ?? createTransferGrantRecord)({
    grantDigest: digestSecret(signed.token),
    tenantId: input.session.tenantId,
    cellId: target.row.cellId,
    userId: input.session.userId,
    principalScopeDigest: digestSecret(target.principalScope),
    operation: input.operation,
    issuedAt: new Date(issuedAt * 1000),
    expiresAt,
    byteLimit: maxBytes,
  });
  if (!recorded) throw exomemErrors.cellUnavailable();
  const consumed = await (dependencies.consumeGrant ?? consumeTransferGrantRecord)({
    grantId: recorded.grantId,
    tenantId: input.session.tenantId,
    cellId: target.row.cellId,
    operation: input.operation,
  });
  if (!consumed) throw exomemErrors.cellUnavailable();
  return {
    grantId: recorded.grantId,
    grant: signed.token,
    operation: input.operation,
    maxBytes,
    requestId,
    target,
    expiresAt,
  };
}

export function privateTransferHeaders(transfer: BoundTransfer): Record<string, string> {
  return {
    ...privateGatewayHeaders(transfer.target, transfer.requestId),
    "x-exomem-transfer-grant": transfer.grant,
  };
}

export async function finishBoundTransfer(
  transfer: BoundTransfer,
  outcomeCode: string,
  dependencies: TransferDependencies = {}
): Promise<void> {
  const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(outcomeCode) ? outcomeCode : "TRANSFER_FAILED";
  await (dependencies.finishGrant ?? finishTransferGrantRecord)({
    grantId: transfer.grantId,
    outcomeCode: safeCode,
  });
}
