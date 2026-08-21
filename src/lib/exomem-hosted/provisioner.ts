import { createHash } from "node:crypto";
import {
  cloudflareAccessConfigFromEnv,
  cloudflareAccessHeaders,
  type CloudflareAccessConfig,
} from "./cloudflare-access";
import { SensitiveSecret } from "./security";

export const PROVISIONER_PROTOCOL_V1 = "exomem-cell-provisioner.v1";
export const PROVISIONER_PROTOCOL_V2 = "exomem-cell-provisioner.v2";
export const PROVISIONER_PROTOCOL = PROVISIONER_PROTOCOL_V1;
export type ProvisionerWireProtocol =
  | typeof PROVISIONER_PROTOCOL_V1
  | typeof PROVISIONER_PROTOCOL_V2;
const MAX_PROVISIONER_RESPONSE_BYTES = 1024 * 1024;

export type CellWorkerPolicy = {
  workerCount: number;
  semantic: boolean;
  media: boolean;
};

export type CellContractIdentity = {
  gatewayContractDigest: string;
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
};

export type RuntimeTarget = {
  releaseVersion: string;
  protocolVersion: string;
  agentProfile: string;
  gatewayContractDigest: string;
  commandFingerprint: string;
  schemaDigest: string;
};

export type ProvisionerCallContext = {
  operationId: string;
  checkpoint: string;
  idempotencyKey: string;
  fenceGeneration: number;
};

type CellRequest = {
  context: ProvisionerCallContext;
  tenantId: string;
  cellId: string;
  protocolVersion: string;
  releaseVersion: string;
  serviceCredential: SensitiveSecret;
  workerPolicy: CellWorkerPolicy;
  provisionerWireProtocol?: ProvisionerWireProtocol;
  agentProfile?: string;
  runtimeTarget?: RuntimeTarget;
  contractIdentity?: CellContractIdentity;
};

export type ProvisionMode = "serve" | "restore-candidate";

export type ProvisionCellRequest = CellRequest & {
  provisionMode: ProvisionMode;
};

export type CellTargetRequest = CellRequest & {
  providerRef: string;
};

export type RollforwardCellRequest = CellTargetRequest & {
  compatibilityDigest: string;
};

export type RotateCredentialRequest = CellTargetRequest & {
  phase: "stage" | "finalize";
  credentialVersion: number;
  nextCredential: SensitiveSecret;
};

export type CredentialRotationResult = {
  previousCredentialRejected: boolean;
};

export type RestoreCellRequest = CellTargetRequest & {
  restoreRef: SensitiveSecret;
  sourceCellId: string;
  archiveSha256: string;
  manifestSha256: string;
  archiveSize: number;
};

export type ProvisionedCell = {
  providerRef: string;
  privateEndpoint: SensitiveSecret;
};

export type CellReadiness = {
  live: boolean;
  ready: boolean;
  cellId: string;
  protocolVersion: string;
  releaseVersion: string;
  serviceAuthenticated: boolean;
  mutationAuthority: boolean;
  readAdmission: boolean;
  writeAdmission: boolean;
  workerPolicy: CellWorkerPolicy;
  runtimeIdentity?: RuntimeTarget;
  contractIdentity?: CellContractIdentity;
  code: string;
};

export type ExportRequestResult = {
  exportRef: string;
  releaseRef: string;
  archiveSha256: string;
  manifestSha256: string;
  archiveSize: number;
  encryptionScheme: "envelope-aes-256-gcm";
  integrityVerified: true;
};

export type CreateExportRequest = CellTargetRequest & {
  expiresAt: Date;
};

export type ReleaseExportRequest = CellTargetRequest & {
  releaseRef: SensitiveSecret;
};

export type DeleteExportRequest = {
  context: ProvisionerCallContext;
  tenantId: string;
  exportRef: SensitiveSecret;
  provisionerWireProtocol?: ProvisionerWireProtocol;
};

export type ExportDeletionProof = {
  objectDestroyed: true;
};

export type DestructionProof = {
  computeDestroyed: true;
  storageDestroyed: true;
  keysDestroyed: true;
};

export type TenantDestructionProof = DestructionProof & {
  tenantResourcesDestroyed: true;
};

export type DestroyTenantRequest = {
  context: ProvisionerCallContext;
  tenantId: string;
  provisionerWireProtocol?: ProvisionerWireProtocol;
};

export type ExportDownloadRequest = {
  context: ProvisionerCallContext;
  tenantId: string;
  exportRef: SensitiveSecret;
  provisionerWireProtocol?: ProvisionerWireProtocol;
};

export type ExportDownloadResult = {
  url: URL;
  expiresAt: Date;
};

export interface CellProvisioner {
  provision(request: ProvisionCellRequest): Promise<ProvisionedCell>;
  rollforward(request: RollforwardCellRequest): Promise<void>;
  health(request: CellTargetRequest): Promise<CellReadiness>;
  rotateCredential(request: RotateCredentialRequest): Promise<CredentialRotationResult>;
  quiesce(request: CellTargetRequest): Promise<void>;
  resume(request: CellTargetRequest): Promise<void>;
  stop(request: CellTargetRequest): Promise<void>;
  export(request: CreateExportRequest): Promise<ExportRequestResult>;
  releaseExport(request: ReleaseExportRequest): Promise<void>;
  deleteExport(request: DeleteExportRequest): Promise<ExportDeletionProof>;
  createExportDownload(request: ExportDownloadRequest): Promise<ExportDownloadResult>;
  restore(request: RestoreCellRequest): Promise<void>;
  seal(request: CellTargetRequest): Promise<void>;
  discard(request: CellTargetRequest): Promise<DestructionProof>;
  destroy(request: DestroyTenantRequest): Promise<TenantDestructionProof>;
}

export type ProvisionerFailureCode =
  | "CONTROL_PLANE_STATE_CONFLICT"
  | "PROVISIONER_CONFIGURATION_INVALID"
  | "PROVISIONER_UNAVAILABLE"
  | "PROVISIONER_TIMEOUT"
  | "PROVISIONER_REJECTED"
  | "EXPORT_REQUEST_EXPIRED"
  | "PROVISIONER_RESPONSE_INVALID"
  | "BILLING_TERMINATION_UNAVAILABLE";

export class ProvisionerFailure extends Error {
  readonly code: ProvisionerFailureCode;
  readonly retryable: boolean;

  constructor(input: { code: ProvisionerFailureCode; retryable: boolean; cause?: unknown }) {
    super(input.code, { cause: input.cause });
    this.name = "ProvisionerFailure";
    this.code = input.code;
    this.retryable = input.retryable;
  }

  toJSON(): { code: ProvisionerFailureCode; retryable: boolean } {
    return { code: this.code, retryable: this.retryable };
  }
}

export class ProvisionerPending extends Error {
  readonly operationId: string;
  readonly checkpoint: string;
  readonly retryAfterSeconds: number;

  constructor(input: { operationId: string; checkpoint: string; retryAfterSeconds: number }) {
    super("PROVISIONER_PENDING");
    this.name = "ProvisionerPending";
    this.operationId = input.operationId;
    this.checkpoint = input.checkpoint;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }

  toJSON(): {
    code: "PROVISIONER_PENDING";
    operationId: string;
    checkpoint: string;
    retryAfterSeconds: number;
  } {
    return {
      code: "PROVISIONER_PENDING",
      operationId: this.operationId,
      checkpoint: this.checkpoint,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

export type HttpProvisionerConfig = {
  endpoint: URL;
  credential: SensitiveSecret;
  timeoutMs: number;
  access?: CloudflareAccessConfig | null;
};

function configurationFailure(): ProvisionerFailure {
  return new ProvisionerFailure({
    code: "PROVISIONER_CONFIGURATION_INVALID",
    retryable: false,
  });
}

export function provisionerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): HttpProvisionerConfig {
  const endpointRaw = env.EXOMEM_PROVISIONER_ENDPOINT;
  const credentialRaw = env.EXOMEM_PROVISIONER_CREDENTIAL;
  if (!endpointRaw || !credentialRaw || credentialRaw.length < 32) {
    throw configurationFailure();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    throw configurationFailure();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw configurationFailure();
  }
  const timeoutRaw = env.EXOMEM_PROVISIONER_TIMEOUT_MS ?? "5000";
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw configurationFailure();
  }
  return {
    endpoint,
    credential: new SensitiveSecret(credentialRaw),
    timeoutMs,
    access: cloudflareAccessConfigFromEnv(env),
  };
}

type Fetch = typeof fetch;

function contextBody(context: ProvisionerCallContext): Record<string, unknown> {
  return {
    operationId: context.operationId,
    checkpoint: context.checkpoint,
    fenceGeneration: context.fenceGeneration,
  };
}

function wireProtocol(request: {
  provisionerWireProtocol?: ProvisionerWireProtocol;
}): ProvisionerWireProtocol {
  if (request.provisionerWireProtocol === undefined) return PROVISIONER_PROTOCOL_V1;
  if (
    request.provisionerWireProtocol === PROVISIONER_PROTOCOL_V1 ||
    request.provisionerWireProtocol === PROVISIONER_PROTOCOL_V2
  ) {
    return request.provisionerWireProtocol;
  }
  throw configurationFailure();
}

function baseCellBodyV1(request: CellRequest): Record<string, unknown> {
  return {
    ...contextBody(request.context),
    tenantId: request.tenantId,
    cellId: request.cellId,
    protocolVersion: request.protocolVersion,
    releaseVersion: request.releaseVersion,
    serviceCredential: request.serviceCredential.reveal(),
    workerPolicy: request.workerPolicy,
  };
}

function runtimeTarget(request: CellRequest): RuntimeTarget {
  if (request.runtimeTarget) {
    const parsed = parseRuntimeIdentity(request.runtimeTarget);
    if (parsed) return parsed;
    throw configurationFailure();
  }
  const agentProfile = boundedLabel(request.agentProfile, 128);
  const identity = parseContractIdentity(request.contractIdentity);
  if (!agentProfile || !identity) throw configurationFailure();
  return {
    releaseVersion: request.releaseVersion,
    protocolVersion: request.protocolVersion,
    agentProfile,
    gatewayContractDigest: identity.gatewayContractDigest,
    commandFingerprint: identity.commandFingerprint,
    schemaDigest: identity.schemaDigest,
  };
}

function baseCellBodyV2(request: CellRequest): Record<string, unknown> {
  return {
    ...contextBody(request.context),
    tenantId: request.tenantId,
    cellId: request.cellId,
    serviceCredential: request.serviceCredential.reveal(),
    workerPolicy: request.workerPolicy,
    runtimeTarget: runtimeTarget(request),
  };
}

function baseCellBody(request: CellRequest): Record<string, unknown> {
  return wireProtocol(request) === PROVISIONER_PROTOCOL_V1
    ? baseCellBodyV1(request)
    : baseCellBodyV2(request);
}

function provisionBody(request: ProvisionCellRequest): Record<string, unknown> {
  return {
    ...baseCellBody(request),
    provisionMode: request.provisionMode,
  };
}

function targetBody(request: CellTargetRequest): Record<string, unknown> {
  return {
    ...baseCellBody(request),
    providerRef: request.providerRef,
  };
}

function rollforwardBody(request: RollforwardCellRequest): Record<string, unknown> {
  const compatibilityDigest = boundedLabel(request.compatibilityDigest, 64);
  if (!compatibilityDigest || !/^[a-f0-9]{64}$/.test(compatibilityDigest)) {
    throw configurationFailure();
  }
  if (wireProtocol(request) !== PROVISIONER_PROTOCOL_V2) throw configurationFailure();
  return {
    ...targetBody(request),
    compatibilityDigest,
  };
}

function boundedLabel(value: unknown, max = 256): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:/-]+$/.test(value) && value.length <= max
    ? value
    : null;
}

function boundedOpaqueReference(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : null;
}

function validProvisionMode(value: unknown): value is ProvisionMode {
  return value === "serve" || value === "restore-candidate";
}

function hasExactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(",") === keys;
}

function parseWorkerPolicy(value: unknown, exactKeys = false): CellWorkerPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (
    (exactKeys && !hasExactKeys(policy, "media,semantic,workerCount")) ||
    !Number.isInteger(policy.workerCount) ||
    Number(policy.workerCount) < 0 ||
    typeof policy.semantic !== "boolean" ||
    typeof policy.media !== "boolean"
  ) {
    return null;
  }
  return {
    workerCount: Number(policy.workerCount),
    semantic: policy.semantic,
    media: policy.media,
  };
}

function parseContractIdentity(value: unknown): CellContractIdentity | null | undefined {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const identity = value as Record<string, unknown>;
  const gatewayContractDigest = boundedLabel(identity.gatewayContractDigest, 64);
  const commandFingerprint = boundedLabel(identity.commandFingerprint, 64);
  const schemaDigest = boundedLabel(identity.schemaDigest, 64);
  const compatibilityDigest = boundedLabel(identity.compatibilityDigest, 64);
  if (
    !gatewayContractDigest ||
    !commandFingerprint ||
    !schemaDigest ||
    !compatibilityDigest ||
    !/^[a-f0-9]{64}$/.test(gatewayContractDigest) ||
    !/^[a-f0-9]{64}$/.test(commandFingerprint) ||
    !/^[a-f0-9]{64}$/.test(schemaDigest) ||
    !/^[a-f0-9]{64}$/.test(compatibilityDigest)
  ) {
    return undefined;
  }
  return { gatewayContractDigest, commandFingerprint, schemaDigest, compatibilityDigest };
}

function parseRuntimeIdentity(value: unknown): RuntimeTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (
    Object.keys(identity).sort().join(",") !==
    "agentProfile,commandFingerprint,gatewayContractDigest,protocolVersion,releaseVersion,schemaDigest"
  ) {
    return null;
  }
  const releaseVersion = boundedLabel(identity.releaseVersion, 64);
  const protocolVersion = boundedLabel(identity.protocolVersion, 64);
  const agentProfile = boundedLabel(identity.agentProfile, 128);
  const gatewayContractDigest = boundedLabel(identity.gatewayContractDigest, 64);
  const commandFingerprint = boundedLabel(identity.commandFingerprint, 64);
  const schemaDigest = boundedLabel(identity.schemaDigest, 64);
  if (
    !releaseVersion ||
    !protocolVersion ||
    !agentProfile ||
    !gatewayContractDigest ||
    !commandFingerprint ||
    !schemaDigest ||
    !/^[a-f0-9]{64}$/.test(gatewayContractDigest) ||
    !/^[a-f0-9]{64}$/.test(commandFingerprint) ||
    !/^[a-f0-9]{64}$/.test(schemaDigest)
  ) {
    return null;
  }
  return {
    releaseVersion,
    protocolVersion,
    agentProfile,
    gatewayContractDigest,
    commandFingerprint,
    schemaDigest,
  };
}

async function readBoundedJsonRecord(response: Response): Promise<Record<string, unknown> | null> {
  const declaredRaw = response.headers.get("content-length");
  if (declaredRaw !== null) {
    if (!/^\d+$/.test(declaredRaw) || Number(declaredRaw) > MAX_PROVISIONER_RESPONSE_BYTES) {
      await response.body?.cancel();
      return null;
    }
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    received += item.value.byteLength;
    if (received > MAX_PROVISIONER_RESPONSE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseExactServerFailure(
  response: Response,
  value: Record<string, unknown> | null
): ProvisionerFailure | null {
  if (!value || Object.keys(value).sort().join(",") !== "code,retryable") return null;
  const code = value.code;
  const retryable = value.retryable;
  const allowed: Partial<
    Record<ProvisionerFailureCode, { retryable: boolean; statuses: number[] }>
  > = {
    CONTROL_PLANE_STATE_CONFLICT: { retryable: false, statuses: [409] },
    PROVISIONER_REJECTED: { retryable: false, statuses: [400, 401, 409, 413, 415, 422] },
    EXPORT_REQUEST_EXPIRED: { retryable: false, statuses: [422] },
    PROVISIONER_RESPONSE_INVALID: { retryable: false, statuses: [500] },
    PROVISIONER_UNAVAILABLE: { retryable: true, statuses: [500, 503] },
  };
  if (typeof code !== "string" || typeof retryable !== "boolean") return null;
  const contract = allowed[code as ProvisionerFailureCode];
  if (
    !contract ||
    contract.retryable !== retryable ||
    !contract.statuses.includes(response.status)
  ) {
    return null;
  }
  return new ProvisionerFailure({ code: code as ProvisionerFailureCode, retryable });
}

function parsePendingResponse(
  response: Response,
  value: Record<string, unknown>,
  context: ProvisionerCallContext
): ProvisionerPending | null {
  if (
    Object.keys(value).sort().join(",") !== "checkpoint,operationId,retryAfterSeconds,status" ||
    value.status !== "pending" ||
    value.operationId !== context.operationId ||
    value.checkpoint !== context.checkpoint ||
    !boundedLabel(value.operationId) ||
    !boundedLabel(value.checkpoint)
  ) {
    return null;
  }
  const retryAfterHeader = response.headers.get("retry-after");
  if (!retryAfterHeader || !/^[1-9]\d{0,2}$/.test(retryAfterHeader)) return null;
  const retryAfterSeconds = Number(value.retryAfterSeconds);
  if (
    !Number.isInteger(value.retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    retryAfterSeconds > 300 ||
    retryAfterSeconds !== Number(retryAfterHeader)
  ) {
    return null;
  }
  return new ProvisionerPending({
    operationId: context.operationId,
    checkpoint: context.checkpoint,
    retryAfterSeconds,
  });
}

export class HttpCellProvisioner implements CellProvisioner {
  readonly #config: HttpProvisionerConfig;
  readonly #fetch: Fetch;

  constructor(config: HttpProvisionerConfig, fetchImplementation: Fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
  }

  async #call(
    action: string,
    request: Pick<ProvisionCellRequest, "context" | "provisionerWireProtocol">,
    body: Record<string, unknown>
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const base = this.#config.endpoint.toString().replace(/\/$/, "");
      const response = await this.#fetch(`${base}/cells/${action}`, {
        method: "POST",
        headers: {
          ...cloudflareAccessHeaders(this.#config.access ?? null),
          authorization: `Bearer ${this.#config.credential.reveal()}`,
          "content-type": "application/json",
          "idempotency-key": request.context.idempotencyKey,
          "x-exomem-provisioner-protocol": wireProtocol(request),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        const exactFailure = parseExactServerFailure(
          response,
          await readBoundedJsonRecord(response)
        );
        if (exactFailure) throw exactFailure;
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ProvisionerFailure({
          code: retryable ? "PROVISIONER_UNAVAILABLE" : "PROVISIONER_REJECTED",
          retryable,
        });
      }
      if (
        wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        ["rollforward", "quiesce", "resume", "stop", "export-release", "restore", "seal"].includes(
          action
        ) &&
        response.status !== 202 &&
        response.status !== 204
      ) {
        throw new ProvisionerFailure({
          code: "PROVISIONER_RESPONSE_INVALID",
          retryable: false,
        });
      }
      if (response.status === 204) return {};
      const parsed = await readBoundedJsonRecord(response);
      if (!parsed) {
        throw new ProvisionerFailure({
          code: "PROVISIONER_RESPONSE_INVALID",
          retryable: false,
        });
      }
      if (response.status === 202) {
        const pending = parsePendingResponse(response, parsed, request.context);
        if (pending) throw pending;
        throw new ProvisionerFailure({ code: "PROVISIONER_RESPONSE_INVALID", retryable: false });
      }
      return parsed;
    } catch (error) {
      if (error instanceof ProvisionerFailure || error instanceof ProvisionerPending) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ProvisionerFailure({
        code: aborted ? "PROVISIONER_TIMEOUT" : "PROVISIONER_UNAVAILABLE",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async provision(request: ProvisionCellRequest): Promise<ProvisionedCell> {
    if (!validProvisionMode(request.provisionMode)) throw configurationFailure();
    const response = await this.#call("provision", request, provisionBody(request));
    const providerRef = boundedOpaqueReference(response.providerRef);
    const privateEndpoint = boundedLabel(response.privateEndpoint, 2_048);
    if (
      (wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        !hasExactKeys(response, "privateEndpoint,providerRef")) ||
      !providerRef ||
      !privateEndpoint
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(privateEndpoint);
    } catch {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    if (parsedEndpoint.protocol !== "https:") {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return { providerRef, privateEndpoint: new SensitiveSecret(privateEndpoint) };
  }

  async rollforward(request: RollforwardCellRequest): Promise<void> {
    await this.#call("rollforward", request, rollforwardBody(request));
  }

  async health(request: CellTargetRequest): Promise<CellReadiness> {
    const response = await this.#call("health", request, targetBody(request));
    if (wireProtocol(request) === PROVISIONER_PROTOCOL_V2) {
      const runtimeIdentity = parseRuntimeIdentity(response.runtimeIdentity);
      const cellId = boundedLabel(response.cellId);
      const code = boundedLabel(response.code, 64);
      const workerPolicy = parseWorkerPolicy(response.workerPolicy, true);
      if (
        !hasExactKeys(
          response,
          "cellId,code,live,mutationAuthority,readAdmission,ready,runtimeIdentity,serviceAuthenticated,workerPolicy,writeAdmission"
        ) ||
        !runtimeIdentity ||
        !cellId ||
        !code ||
        !workerPolicy ||
        typeof response.live !== "boolean" ||
        typeof response.ready !== "boolean" ||
        typeof response.serviceAuthenticated !== "boolean" ||
        typeof response.mutationAuthority !== "boolean" ||
        typeof response.readAdmission !== "boolean" ||
        typeof response.writeAdmission !== "boolean" ||
        (response.live && response.ready) !== (code === "CELL_READY")
      ) {
        throw new ProvisionerFailure({
          code: "PROVISIONER_RESPONSE_INVALID",
          retryable: false,
        });
      }
      return {
        live: response.live,
        ready: response.ready,
        cellId,
        protocolVersion: runtimeIdentity.protocolVersion,
        releaseVersion: runtimeIdentity.releaseVersion,
        serviceAuthenticated: response.serviceAuthenticated,
        mutationAuthority: response.mutationAuthority,
        readAdmission: response.readAdmission,
        writeAdmission: response.writeAdmission,
        workerPolicy,
        runtimeIdentity,
        code,
      };
    }
    const cellId = boundedLabel(response.cellId);
    const protocolVersion = boundedLabel(response.protocolVersion, 64);
    const releaseVersion = boundedLabel(response.releaseVersion, 64);
    const code = boundedLabel(response.code, 64);
    const workerPolicy = parseWorkerPolicy(response.workerPolicy);
    const contractIdentity = parseContractIdentity(response.contractIdentity);
    if (
      !cellId ||
      !protocolVersion ||
      !releaseVersion ||
      !code ||
      !workerPolicy ||
      contractIdentity === undefined ||
      typeof response.live !== "boolean" ||
      typeof response.ready !== "boolean" ||
      typeof response.serviceAuthenticated !== "boolean" ||
      typeof response.mutationAuthority !== "boolean" ||
      typeof response.readAdmission !== "boolean" ||
      typeof response.writeAdmission !== "boolean" ||
      (response.live && response.ready) !== (code === "CELL_READY")
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return {
      live: response.live,
      ready: response.ready,
      cellId,
      protocolVersion,
      releaseVersion,
      serviceAuthenticated: response.serviceAuthenticated,
      mutationAuthority: response.mutationAuthority,
      readAdmission: response.readAdmission,
      writeAdmission: response.writeAdmission,
      workerPolicy,
      ...(contractIdentity ? { contractIdentity } : {}),
      code,
    };
  }

  async rotateCredential(request: RotateCredentialRequest): Promise<CredentialRotationResult> {
    const response = await this.#call("rotate-credential", request, {
      ...targetBody(request),
      phase: request.phase,
      credentialVersion: request.credentialVersion,
      nextCredential: request.nextCredential.reveal(),
    });
    if (
      (wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        !hasExactKeys(response, "previousCredentialRejected")) ||
      (request.phase === "finalize" && response.previousCredentialRejected !== true)
    ) {
      throw new ProvisionerFailure({ code: "PROVISIONER_RESPONSE_INVALID", retryable: false });
    }
    return { previousCredentialRejected: response.previousCredentialRejected === true };
  }

  async quiesce(request: CellTargetRequest): Promise<void> {
    await this.#call("quiesce", request, targetBody(request));
  }

  async resume(request: CellTargetRequest): Promise<void> {
    await this.#call("resume", request, targetBody(request));
  }

  async stop(request: CellTargetRequest): Promise<void> {
    await this.#call("stop", request, targetBody(request));
  }

  async export(request: CreateExportRequest): Promise<ExportRequestResult> {
    const now = Date.now();
    const expiresAt = request.expiresAt.getTime();
    if (!Number.isFinite(expiresAt) || expiresAt - now > 30 * 24 * 60 * 60 * 1000) {
      throw configurationFailure();
    }
    const response = await this.#call("export", request, {
      ...targetBody(request),
      expiresAt: request.expiresAt.toISOString(),
    });
    const exportRef = boundedOpaqueReference(response.exportRef);
    const releaseRef = boundedOpaqueReference(response.releaseRef);
    const archiveSha256 = boundedLabel(response.archiveSha256, 64);
    const manifestSha256 = boundedLabel(response.manifestSha256, 64);
    const archiveSize = Number(response.archiveSize);
    if (
      (wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        !hasExactKeys(
          response,
          "archiveSha256,archiveSize,encryptionScheme,exportRef,integrityVerified,manifestSha256,releaseRef"
        )) ||
      !exportRef ||
      !releaseRef ||
      !archiveSha256 ||
      !manifestSha256 ||
      !/^[0-9a-f]{64}$/.test(archiveSha256) ||
      !/^[0-9a-f]{64}$/.test(manifestSha256) ||
      !Number.isSafeInteger(archiveSize) ||
      archiveSize <= 0 ||
      response.encryptionScheme !== "envelope-aes-256-gcm" ||
      response.integrityVerified !== true
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return {
      exportRef,
      releaseRef,
      archiveSha256,
      manifestSha256,
      archiveSize,
      encryptionScheme: "envelope-aes-256-gcm",
      integrityVerified: true,
    };
  }

  async releaseExport(request: ReleaseExportRequest): Promise<void> {
    if (!boundedOpaqueReference(request.releaseRef.reveal())) throw configurationFailure();
    await this.#call("export-release", request, {
      ...targetBody(request),
      releaseRef: request.releaseRef.reveal(),
    });
  }

  async deleteExport(request: DeleteExportRequest): Promise<ExportDeletionProof> {
    if (!boundedOpaqueReference(request.exportRef.reveal())) throw configurationFailure();
    const response = await this.#call("export-delete", request, {
      ...contextBody(request.context),
      tenantId: request.tenantId,
      exportRef: request.exportRef.reveal(),
    });
    if (
      (wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        !hasExactKeys(response, "objectDestroyed")) ||
      response.objectDestroyed !== true
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return { objectDestroyed: true };
  }

  async restore(request: RestoreCellRequest): Promise<void> {
    if (
      !boundedOpaqueReference(request.restoreRef.reveal()) ||
      !boundedOpaqueReference(request.sourceCellId) ||
      !/^[0-9a-f]{64}$/.test(request.archiveSha256) ||
      !/^[0-9a-f]{64}$/.test(request.manifestSha256) ||
      !Number.isSafeInteger(request.archiveSize) ||
      request.archiveSize <= 0
    ) {
      throw configurationFailure();
    }
    await this.#call("restore", request, {
      ...targetBody(request),
      restoreRef: request.restoreRef.reveal(),
      sourceCellId: request.sourceCellId,
      archiveSha256: request.archiveSha256,
      manifestSha256: request.manifestSha256,
      archiveSize: request.archiveSize,
    });
  }

  async createExportDownload(request: ExportDownloadRequest): Promise<ExportDownloadResult> {
    if (!boundedOpaqueReference(request.exportRef.reveal())) throw configurationFailure();
    const response = await this.#call("export-download", request, {
      ...contextBody(request.context),
      tenantId: request.tenantId,
      exportRef: request.exportRef.reveal(),
    });
    if (
      (wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        !hasExactKeys(response, "expiresAt,url")) ||
      typeof response.url !== "string" ||
      typeof response.expiresAt !== "string"
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    let url: URL;
    const expiresAt = new Date(response.expiresAt);
    try {
      url = new URL(response.url);
    } catch {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    const ttlMs = expiresAt.getTime() - Date.now();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !Number.isFinite(expiresAt.getTime()) ||
      ttlMs <= 0 ||
      ttlMs > 15 * 60 * 1000
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return { url, expiresAt };
  }

  async seal(request: CellTargetRequest): Promise<void> {
    await this.#call("seal", request, targetBody(request));
  }

  async discard(request: CellTargetRequest): Promise<DestructionProof> {
    const response = await this.#call("discard", request, targetBody(request));
    if (
      (wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        !hasExactKeys(response, "computeDestroyed,keysDestroyed,storageDestroyed")) ||
      response.computeDestroyed !== true ||
      response.storageDestroyed !== true ||
      response.keysDestroyed !== true
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return { computeDestroyed: true, storageDestroyed: true, keysDestroyed: true };
  }

  async destroy(request: DestroyTenantRequest): Promise<TenantDestructionProof> {
    const response = await this.#call("destroy", request, {
      ...contextBody(request.context),
      tenantId: request.tenantId,
    });
    if (
      (wireProtocol(request) === PROVISIONER_PROTOCOL_V2 &&
        !hasExactKeys(
          response,
          "computeDestroyed,keysDestroyed,storageDestroyed,tenantResourcesDestroyed"
        )) ||
      response.computeDestroyed !== true ||
      response.storageDestroyed !== true ||
      response.keysDestroyed !== true ||
      response.tenantResourcesDestroyed !== true
    ) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return {
      computeDestroyed: true,
      storageDestroyed: true,
      keysDestroyed: true,
      tenantResourcesDestroyed: true,
    };
  }
}

type FakeResource = {
  tenantId: string;
  cellId: string;
  protocolVersion: string;
  releaseVersion: string;
  provisionerWireProtocol: ProvisionerWireProtocol;
  agentProfile: string | null;
  runtimeTarget: RuntimeTarget | null;
  credential: SensitiveSecret;
  pendingCredential: SensitiveSecret | null;
  credentialVersion: number;
  workerPolicy: CellWorkerPolicy;
  contractIdentity: CellContractIdentity | null;
  providerRef: string;
  endpoint: SensitiveSecret;
  state: "running" | "quiesced" | "stopped" | "sealed";
};

type ProvisionerAction =
  | "provision"
  | "rollforward"
  | "health"
  | "rotate-credential"
  | "quiesce"
  | "resume"
  | "stop"
  | "export"
  | "release-export"
  | "delete-export"
  | "export-download"
  | "restore"
  | "seal"
  | "discard"
  | "destroy";

export class FakeCellProvisioner implements CellProvisioner {
  readonly resources = new Map<string, FakeResource>();
  readonly deletedTenants = new Set<string>();
  readonly exportArtifacts = new Map<string, string>();
  readonly deletedExports = new Set<string>();
  readonly tenantFences = new Map<string, number>();
  readonly calls: Array<{
    action: ProvisionerAction;
    cellId: string;
    idempotencyKey: string;
  }> = [];
  readonly #results = new Map<string, unknown>();
  readonly #requestDigests = new Map<string, string>();
  readonly #lostAcknowledgements = new Set<ProvisionerAction>();
  readonly #now: () => Date;
  failure: ProvisionerFailure | null = null;
  readinessOverride: Partial<CellReadiness> = {};

  constructor(input: { now?: () => Date } = {}) {
    this.#now = input.now ?? (() => new Date());
  }

  loseNextAcknowledgement(action: ProvisionerAction): void {
    this.#lostAcknowledgements.add(action);
  }

  #before(
    action: ProvisionerAction,
    request: CellRequest,
    additional: Record<string, unknown> = {}
  ): string {
    this.calls.push({
      action,
      cellId: request.cellId,
      idempotencyKey: request.context.idempotencyKey,
    });
    if (this.failure) throw this.failure;
    if (
      !Number.isSafeInteger(request.context.fenceGeneration) ||
      request.context.fenceGeneration < 1
    ) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    const currentFence = this.tenantFences.get(request.tenantId) ?? 0;
    if (
      request.context.fenceGeneration < currentFence ||
      (action !== "destroy" && this.deletedTenants.has(request.tenantId))
    ) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    this.tenantFences.set(
      request.tenantId,
      Math.max(currentFence, request.context.fenceGeneration)
    );
    const key = `${action}\0${request.context.idempotencyKey}`;
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          provisionerWireProtocol: wireProtocol(request),
          body: { ...baseCellBody(request), ...additional },
        })
      )
      .digest("base64url");
    const priorDigest = this.#requestDigests.get(key);
    if (priorDigest && priorDigest !== requestDigest) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    this.#requestDigests.set(key, requestDigest);
    return key;
  }

  #after<T>(action: ProvisionerAction, key: string, result: T): T {
    this.#results.set(key, result);
    if (this.#lostAcknowledgements.delete(action)) {
      throw new ProvisionerFailure({ code: "PROVISIONER_TIMEOUT", retryable: true });
    }
    return result;
  }

  #targetFreeBefore(
    action: "delete-export" | "export-download" | "destroy",
    request: Pick<DeleteExportRequest, "context" | "tenantId" | "provisionerWireProtocol">,
    body: Record<string, unknown>
  ): string {
    const key = `${action}\0${request.context.idempotencyKey}`;
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          provisionerWireProtocol: wireProtocol(request),
          body,
        })
      )
      .digest("base64url");
    const priorDigest = this.#requestDigests.get(key);
    if (priorDigest && priorDigest !== requestDigest) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    this.#requestDigests.set(key, requestDigest);
    return key;
  }

  #resource(request: CellTargetRequest): FakeResource {
    const resource = this.resources.get(request.cellId);
    if (!resource || resource.providerRef !== request.providerRef) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    return resource;
  }

  async provision(request: ProvisionCellRequest): Promise<ProvisionedCell> {
    if (!validProvisionMode(request.provisionMode)) throw configurationFailure();
    const selectedRuntimeTarget =
      wireProtocol(request) === PROVISIONER_PROTOCOL_V2 ? runtimeTarget(request) : null;
    const key = this.#before("provision", request, { provisionMode: request.provisionMode });
    const prior = this.#results.get(key) as ProvisionedCell | undefined;
    if (prior) return prior;
    if (this.deletedTenants.has(request.tenantId)) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    const providerRef = `provider-${request.cellId}`;
    const endpoint = new SensitiveSecret(`https://${request.cellId}.cells.internal`);
    this.resources.set(request.cellId, {
      tenantId: request.tenantId,
      cellId: request.cellId,
      protocolVersion: selectedRuntimeTarget?.protocolVersion ?? request.protocolVersion,
      releaseVersion: selectedRuntimeTarget?.releaseVersion ?? request.releaseVersion,
      provisionerWireProtocol: wireProtocol(request),
      agentProfile: selectedRuntimeTarget?.agentProfile ?? request.agentProfile ?? null,
      runtimeTarget: selectedRuntimeTarget,
      credential: request.serviceCredential,
      pendingCredential: null,
      credentialVersion: 1,
      workerPolicy: structuredClone(request.workerPolicy),
      contractIdentity: request.contractIdentity ? { ...request.contractIdentity } : null,
      providerRef,
      endpoint,
      state: "running",
    });
    return this.#after("provision", key, { providerRef, privateEndpoint: endpoint });
  }

  async rollforward(request: RollforwardCellRequest): Promise<void> {
    const selectedRuntimeTarget = runtimeTarget(request);
    const body = rollforwardBody(request);
    const key = this.#before("rollforward", request, {
      providerRef: request.providerRef,
      compatibilityDigest: body.compatibilityDigest,
    });
    if (this.#results.has(key)) return;
    const resource = this.#resource(request);
    resource.protocolVersion = selectedRuntimeTarget.protocolVersion;
    resource.releaseVersion = selectedRuntimeTarget.releaseVersion;
    resource.provisionerWireProtocol = PROVISIONER_PROTOCOL_V2;
    resource.agentProfile = selectedRuntimeTarget.agentProfile;
    resource.runtimeTarget = selectedRuntimeTarget;
    resource.contractIdentity = {
      gatewayContractDigest: selectedRuntimeTarget.gatewayContractDigest,
      commandFingerprint: selectedRuntimeTarget.commandFingerprint,
      schemaDigest: selectedRuntimeTarget.schemaDigest,
      compatibilityDigest: request.compatibilityDigest,
    };
    resource.state = "running";
    this.#after("rollforward", key, true);
  }

  async health(request: CellTargetRequest): Promise<CellReadiness> {
    const key = this.#before("health", request, { providerRef: request.providerRef });
    const resource = this.#resource(request);
    const running = resource.state === "running";
    const presented = request.serviceCredential.reveal();
    const serviceAuthenticated =
      presented === resource.credential.reveal() ||
      presented === resource.pendingCredential?.reveal();
    const runtimeIdentity =
      resource.runtimeTarget ??
      (resource.agentProfile && resource.contractIdentity
        ? {
            releaseVersion: resource.releaseVersion,
            protocolVersion: resource.protocolVersion,
            agentProfile: resource.agentProfile,
            gatewayContractDigest: resource.contractIdentity.gatewayContractDigest,
            commandFingerprint: resource.contractIdentity.commandFingerprint,
            schemaDigest: resource.contractIdentity.schemaDigest,
          }
        : null);
    const readiness: CellReadiness = {
      live: resource.state !== "stopped",
      ready: running,
      cellId: resource.cellId,
      protocolVersion: resource.protocolVersion,
      releaseVersion: resource.releaseVersion,
      serviceAuthenticated,
      mutationAuthority: running && serviceAuthenticated,
      readAdmission: running && serviceAuthenticated,
      writeAdmission: running && serviceAuthenticated,
      workerPolicy: structuredClone(resource.workerPolicy),
      ...(wireProtocol(request) === PROVISIONER_PROTOCOL_V2
        ? runtimeIdentity
          ? { runtimeIdentity }
          : {}
        : resource.contractIdentity
          ? { contractIdentity: { ...resource.contractIdentity } }
          : {}),
      code: running ? "CELL_READY" : "CELL_NOT_READY",
      ...this.readinessOverride,
    };
    return this.#after("health", key, readiness);
  }

  async rotateCredential(request: RotateCredentialRequest): Promise<CredentialRotationResult> {
    const key = this.#before("rotate-credential", request, {
      providerRef: request.providerRef,
      phase: request.phase,
      credentialVersion: request.credentialVersion,
      nextCredential: request.nextCredential.reveal(),
    });
    const prior = this.#results.get(key) as CredentialRotationResult | undefined;
    if (prior) return prior;
    const resource = this.#resource(request);
    if (request.phase === "stage") resource.pendingCredential = request.nextCredential;
    else {
      resource.credential = request.nextCredential;
      resource.pendingCredential = null;
      resource.credentialVersion = request.credentialVersion;
    }
    return this.#after("rotate-credential", key, {
      previousCredentialRejected: request.phase === "finalize",
    });
  }

  async quiesce(request: CellTargetRequest): Promise<void> {
    const key = this.#before("quiesce", request, { providerRef: request.providerRef });
    if (this.#results.has(key)) return;
    this.#resource(request).state = "quiesced";
    this.#after("quiesce", key, true);
  }

  async resume(request: CellTargetRequest): Promise<void> {
    const key = this.#before("resume", request, { providerRef: request.providerRef });
    if (this.#results.has(key)) return;
    this.#resource(request).state = "running";
    this.#after("resume", key, true);
  }

  async stop(request: CellTargetRequest): Promise<void> {
    const key = this.#before("stop", request, { providerRef: request.providerRef });
    if (this.#results.has(key)) return;
    this.#resource(request).state = "stopped";
    this.#after("stop", key, true);
  }

  async export(request: CreateExportRequest): Promise<ExportRequestResult> {
    const expiresAt = request.expiresAt.getTime();
    if (!Number.isFinite(expiresAt)) throw configurationFailure();
    const additional = {
      providerRef: request.providerRef,
      expiresAt: request.expiresAt.toISOString(),
    };
    const existingKey = `export\0${request.context.idempotencyKey}`;
    if (this.#results.has(existingKey)) {
      const key = this.#before("export", request, additional);
      return this.#results.get(key) as ExportRequestResult;
    }
    const now = this.#now().getTime();
    if (expiresAt <= now || expiresAt - now > 30 * 24 * 60 * 60 * 1000) {
      throw new ProvisionerFailure({
        code: "EXPORT_REQUEST_EXPIRED",
        retryable: false,
      });
    }
    const key = this.#before("export", request, additional);
    this.#resource(request);
    const archiveSha256 = createHash("sha256")
      .update(`archive\0${request.cellId}\0${request.context.operationId}`)
      .digest("hex");
    const manifestSha256 = createHash("sha256")
      .update(`manifest\0${request.cellId}\0${request.context.operationId}`)
      .digest("hex");
    const exportRef = `export-${request.context.operationId}`;
    const releaseRef = `release-${request.context.operationId}`;
    this.exportArtifacts.set(releaseRef, exportRef);
    return this.#after("export", key, {
      exportRef,
      releaseRef,
      archiveSha256,
      manifestSha256,
      archiveSize: 1024,
      encryptionScheme: "envelope-aes-256-gcm",
      integrityVerified: true,
    });
  }

  async releaseExport(request: ReleaseExportRequest): Promise<void> {
    const releaseRef = request.releaseRef.reveal();
    if (!boundedOpaqueReference(releaseRef)) throw configurationFailure();
    const key = this.#before("release-export", request, {
      providerRef: request.providerRef,
      releaseRef,
    });
    if (this.#results.has(key)) return;
    this.#resource(request);
    this.exportArtifacts.delete(releaseRef);
    this.#after("release-export", key, true);
  }

  async deleteExport(request: DeleteExportRequest): Promise<ExportDeletionProof> {
    const exportRef = request.exportRef.reveal();
    if (!boundedOpaqueReference(exportRef)) throw configurationFailure();
    const key = this.#targetFreeBefore("delete-export", request, {
      ...contextBody(request.context),
      tenantId: request.tenantId,
      exportRef,
    });
    this.calls.push({
      action: "delete-export",
      cellId: "export-object",
      idempotencyKey: request.context.idempotencyKey,
    });
    if (this.failure) throw this.failure;
    const prior = this.#results.get(key) as ExportDeletionProof | undefined;
    if (prior) return prior;
    this.deletedExports.add(exportRef);
    return this.#after("delete-export", key, { objectDestroyed: true });
  }

  async restore(request: RestoreCellRequest): Promise<void> {
    if (
      !boundedOpaqueReference(request.restoreRef.reveal()) ||
      !boundedOpaqueReference(request.sourceCellId) ||
      !/^[0-9a-f]{64}$/.test(request.archiveSha256) ||
      !/^[0-9a-f]{64}$/.test(request.manifestSha256) ||
      !Number.isSafeInteger(request.archiveSize) ||
      request.archiveSize <= 0
    ) {
      throw configurationFailure();
    }
    const key = this.#before("restore", request, {
      providerRef: request.providerRef,
      restoreRef: request.restoreRef.reveal(),
      sourceCellId: request.sourceCellId,
      archiveSha256: request.archiveSha256,
      manifestSha256: request.manifestSha256,
      archiveSize: request.archiveSize,
    });
    if (this.#results.has(key)) return;
    this.#resource(request).state = "running";
    this.#after("restore", key, true);
  }

  async createExportDownload(request: ExportDownloadRequest): Promise<ExportDownloadResult> {
    const exportRef = request.exportRef.reveal();
    if (!boundedOpaqueReference(exportRef)) throw configurationFailure();
    const key = this.#targetFreeBefore("export-download", request, {
      ...contextBody(request.context),
      tenantId: request.tenantId,
      exportRef,
    });
    const prior = this.#results.get(key) as ExportDownloadResult | undefined;
    if (prior) return prior;
    const digest = createHash("sha256").update(request.exportRef.reveal()).digest("base64url");
    return this.#after("export-download", key, {
      url: new URL(`https://downloads.invalid/exomem/${digest}`),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
  }

  async seal(request: CellTargetRequest): Promise<void> {
    const key = this.#before("seal", request, { providerRef: request.providerRef });
    if (this.#results.has(key)) return;
    this.#resource(request).state = "sealed";
    this.#after("seal", key, true);
  }

  async discard(request: CellTargetRequest): Promise<DestructionProof> {
    const key = this.#before("discard", request, { providerRef: request.providerRef });
    const prior = this.#results.get(key) as DestructionProof | undefined;
    if (prior) return prior;
    this.#resource(request);
    this.resources.delete(request.cellId);
    return this.#after("discard", key, {
      computeDestroyed: true,
      storageDestroyed: true,
      keysDestroyed: true,
    });
  }

  async destroy(request: DestroyTenantRequest): Promise<TenantDestructionProof> {
    const currentFence = this.tenantFences.get(request.tenantId) ?? 0;
    if (request.context.fenceGeneration < currentFence) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    this.tenantFences.set(request.tenantId, request.context.fenceGeneration);
    const key = this.#targetFreeBefore("destroy", request, {
      ...contextBody(request.context),
      tenantId: request.tenantId,
    });
    this.calls.push({
      action: "destroy",
      cellId: "tenant-wide",
      idempotencyKey: request.context.idempotencyKey,
    });
    if (this.failure) throw this.failure;
    const prior = this.#results.get(key) as TenantDestructionProof | undefined;
    if (prior) return prior;
    this.deletedTenants.add(request.tenantId);
    for (const [cellId, resource] of this.resources) {
      if (resource.tenantId === request.tenantId) this.resources.delete(cellId);
    }
    return this.#after("destroy", key, {
      computeDestroyed: true,
      storageDestroyed: true,
      keysDestroyed: true,
      tenantResourcesDestroyed: true,
    });
  }
}
