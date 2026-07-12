import { createHash } from "node:crypto";
import { SensitiveSecret } from "./security";

export const PROVISIONER_PROTOCOL = "exomem-cell-provisioner.v1";

export type CellWorkerPolicy = {
  workerCount: number;
  semantic: boolean;
  media: boolean;
};

export type ProvisionerCallContext = {
  operationId: string;
  checkpoint: string;
  idempotencyKey: string;
};

export type ProvisionCellRequest = {
  context: ProvisionerCallContext;
  tenantId: string;
  cellId: string;
  protocolVersion: string;
  releaseVersion: string;
  serviceCredential: SensitiveSecret;
  workerPolicy: CellWorkerPolicy;
};

export type CellTargetRequest = ProvisionCellRequest & {
  providerRef: string;
};

export type RotateCredentialRequest = CellTargetRequest & {
  phase: "stage" | "finalize";
  credentialVersion: number;
  nextCredential: SensitiveSecret;
};

export type RestoreCellRequest = CellTargetRequest & {
  restoreRef?: string;
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
  code: string;
};

export type ExportRequestResult = {
  exportRef: string;
};

export interface CellProvisioner {
  provision(request: ProvisionCellRequest): Promise<ProvisionedCell>;
  health(request: CellTargetRequest): Promise<CellReadiness>;
  rotateCredential(request: RotateCredentialRequest): Promise<void>;
  quiesce(request: CellTargetRequest): Promise<void>;
  resume(request: CellTargetRequest): Promise<void>;
  stop(request: CellTargetRequest): Promise<void>;
  export(request: CellTargetRequest): Promise<ExportRequestResult>;
  restore(request: RestoreCellRequest): Promise<void>;
  seal(request: CellTargetRequest): Promise<void>;
  destroy(request: CellTargetRequest): Promise<void>;
}

export type ProvisionerFailureCode =
  | "PROVISIONER_CONFIGURATION_INVALID"
  | "PROVISIONER_UNAVAILABLE"
  | "PROVISIONER_TIMEOUT"
  | "PROVISIONER_REJECTED"
  | "PROVISIONER_RESPONSE_INVALID";

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

export type HttpProvisionerConfig = {
  endpoint: URL;
  credential: SensitiveSecret;
  timeoutMs: number;
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
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
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
  };
}

type Fetch = typeof fetch;

function contextBody(context: ProvisionerCallContext): Record<string, string> {
  return {
    operationId: context.operationId,
    checkpoint: context.checkpoint,
  };
}

function baseCellBody(request: ProvisionCellRequest): Record<string, unknown> {
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

function targetBody(request: CellTargetRequest): Record<string, unknown> {
  return {
    ...baseCellBody(request),
    providerRef: request.providerRef,
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

function parseWorkerPolicy(value: unknown): CellWorkerPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  if (
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

export class HttpCellProvisioner implements CellProvisioner {
  readonly #config: HttpProvisionerConfig;
  readonly #fetch: Fetch;

  constructor(config: HttpProvisionerConfig, fetchImplementation: Fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
  }

  async #call(action: string, request: ProvisionCellRequest, body: Record<string, unknown>) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const base = this.#config.endpoint.toString().replace(/\/$/, "");
      const response = await this.#fetch(`${base}/cells/${action}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#config.credential.reveal()}`,
          "content-type": "application/json",
          "idempotency-key": request.context.idempotencyKey,
          "x-exomem-provisioner-protocol": PROVISIONER_PROTOCOL,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ProvisionerFailure({
          code: retryable ? "PROVISIONER_UNAVAILABLE" : "PROVISIONER_REJECTED",
          retryable,
        });
      }
      if (response.status === 204) return {};
      try {
        return (await response.json()) as Record<string, unknown>;
      } catch {
        throw new ProvisionerFailure({
          code: "PROVISIONER_RESPONSE_INVALID",
          retryable: false,
        });
      }
    } catch (error) {
      if (error instanceof ProvisionerFailure) throw error;
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
    const response = await this.#call("provision", request, baseCellBody(request));
    const providerRef = boundedOpaqueReference(response.providerRef);
    const privateEndpoint = boundedLabel(response.privateEndpoint, 2_048);
    if (!providerRef || !privateEndpoint) {
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

  async health(request: CellTargetRequest): Promise<CellReadiness> {
    const response = await this.#call("health", request, targetBody(request));
    const cellId = boundedLabel(response.cellId);
    const protocolVersion = boundedLabel(response.protocolVersion, 64);
    const releaseVersion = boundedLabel(response.releaseVersion, 64);
    const code = boundedLabel(response.code, 64);
    const workerPolicy = parseWorkerPolicy(response.workerPolicy);
    if (
      !cellId ||
      !protocolVersion ||
      !releaseVersion ||
      !code ||
      !workerPolicy ||
      typeof response.live !== "boolean" ||
      typeof response.ready !== "boolean" ||
      typeof response.serviceAuthenticated !== "boolean" ||
      typeof response.mutationAuthority !== "boolean" ||
      typeof response.readAdmission !== "boolean" ||
      typeof response.writeAdmission !== "boolean"
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
      code,
    };
  }

  async rotateCredential(request: RotateCredentialRequest): Promise<void> {
    await this.#call("rotate-credential", request, {
      ...targetBody(request),
      phase: request.phase,
      credentialVersion: request.credentialVersion,
      nextCredential: request.nextCredential.reveal(),
    });
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

  async export(request: CellTargetRequest): Promise<ExportRequestResult> {
    const response = await this.#call("export", request, targetBody(request));
    const exportRef = boundedOpaqueReference(response.exportRef);
    if (!exportRef) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_RESPONSE_INVALID",
        retryable: false,
      });
    }
    return { exportRef };
  }

  async restore(request: RestoreCellRequest): Promise<void> {
    if (request.restoreRef && !boundedOpaqueReference(request.restoreRef)) {
      throw configurationFailure();
    }
    await this.#call("restore", request, {
      ...targetBody(request),
      ...(request.restoreRef ? { restoreRef: request.restoreRef } : {}),
    });
  }

  async seal(request: CellTargetRequest): Promise<void> {
    await this.#call("seal", request, targetBody(request));
  }

  async destroy(request: CellTargetRequest): Promise<void> {
    await this.#call("destroy", request, targetBody(request));
  }
}

type FakeResource = {
  tenantId: string;
  cellId: string;
  protocolVersion: string;
  releaseVersion: string;
  credential: SensitiveSecret;
  pendingCredential: SensitiveSecret | null;
  credentialVersion: number;
  workerPolicy: CellWorkerPolicy;
  providerRef: string;
  endpoint: SensitiveSecret;
  state: "running" | "quiesced" | "stopped" | "sealed";
};

type ProvisionerAction =
  | "provision"
  | "health"
  | "rotate-credential"
  | "quiesce"
  | "resume"
  | "stop"
  | "export"
  | "restore"
  | "seal"
  | "destroy";

export class FakeCellProvisioner implements CellProvisioner {
  readonly resources = new Map<string, FakeResource>();
  readonly calls: Array<{
    action: ProvisionerAction;
    cellId: string;
    idempotencyKey: string;
  }> = [];
  readonly #results = new Map<string, unknown>();
  readonly #requestDigests = new Map<string, string>();
  readonly #lostAcknowledgements = new Set<ProvisionerAction>();
  failure: ProvisionerFailure | null = null;
  readinessOverride: Partial<CellReadiness> = {};

  loseNextAcknowledgement(action: ProvisionerAction): void {
    this.#lostAcknowledgements.add(action);
  }

  #before(
    action: ProvisionerAction,
    request: ProvisionCellRequest,
    additional: Record<string, unknown> = {}
  ): string {
    this.calls.push({
      action,
      cellId: request.cellId,
      idempotencyKey: request.context.idempotencyKey,
    });
    if (this.failure) throw this.failure;
    const key = `${action}\0${request.context.idempotencyKey}`;
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          operationId: request.context.operationId,
          checkpoint: request.context.checkpoint,
          tenantId: request.tenantId,
          cellId: request.cellId,
          protocolVersion: request.protocolVersion,
          releaseVersion: request.releaseVersion,
          serviceCredential: request.serviceCredential.reveal(),
          workerPolicy: request.workerPolicy,
          ...additional,
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

  #resource(request: CellTargetRequest): FakeResource {
    const resource = this.resources.get(request.cellId);
    if (!resource || resource.providerRef !== request.providerRef) {
      throw new ProvisionerFailure({ code: "PROVISIONER_REJECTED", retryable: false });
    }
    return resource;
  }

  async provision(request: ProvisionCellRequest): Promise<ProvisionedCell> {
    const key = this.#before("provision", request);
    const prior = this.#results.get(key) as ProvisionedCell | undefined;
    if (prior) return prior;
    const providerRef = `provider-${request.cellId}`;
    const endpoint = new SensitiveSecret(`https://${request.cellId}.cells.internal`);
    this.resources.set(request.cellId, {
      tenantId: request.tenantId,
      cellId: request.cellId,
      protocolVersion: request.protocolVersion,
      releaseVersion: request.releaseVersion,
      credential: request.serviceCredential,
      pendingCredential: null,
      credentialVersion: 1,
      workerPolicy: structuredClone(request.workerPolicy),
      providerRef,
      endpoint,
      state: "running",
    });
    return this.#after("provision", key, { providerRef, privateEndpoint: endpoint });
  }

  async health(request: CellTargetRequest): Promise<CellReadiness> {
    const key = this.#before("health", request, { providerRef: request.providerRef });
    const resource = this.#resource(request);
    const running = resource.state === "running";
    const readiness: CellReadiness = {
      live: resource.state !== "stopped",
      ready: running,
      cellId: resource.cellId,
      protocolVersion: resource.protocolVersion,
      releaseVersion: resource.releaseVersion,
      serviceAuthenticated: true,
      mutationAuthority: running,
      readAdmission: running,
      writeAdmission: running,
      workerPolicy: structuredClone(resource.workerPolicy),
      code: running ? "CELL_READY" : "CELL_NOT_READY",
      ...this.readinessOverride,
    };
    return this.#after("health", key, readiness);
  }

  async rotateCredential(request: RotateCredentialRequest): Promise<void> {
    const key = this.#before("rotate-credential", request, {
      providerRef: request.providerRef,
      phase: request.phase,
      credentialVersion: request.credentialVersion,
      nextCredential: request.nextCredential.reveal(),
    });
    if (this.#results.has(key)) return;
    const resource = this.#resource(request);
    if (request.phase === "stage") resource.pendingCredential = request.nextCredential;
    else {
      resource.credential = request.nextCredential;
      resource.pendingCredential = null;
      resource.credentialVersion = request.credentialVersion;
    }
    this.#after("rotate-credential", key, true);
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

  async export(request: CellTargetRequest): Promise<ExportRequestResult> {
    const key = this.#before("export", request, { providerRef: request.providerRef });
    const prior = this.#results.get(key) as ExportRequestResult | undefined;
    if (prior) return prior;
    this.#resource(request);
    return this.#after("export", key, { exportRef: `export-${request.context.operationId}` });
  }

  async restore(request: RestoreCellRequest): Promise<void> {
    if (request.restoreRef && !boundedOpaqueReference(request.restoreRef)) {
      throw configurationFailure();
    }
    const key = this.#before("restore", request, {
      providerRef: request.providerRef,
      restoreRef: request.restoreRef ?? null,
    });
    if (this.#results.has(key)) return;
    this.#resource(request).state = "running";
    this.#after("restore", key, true);
  }

  async seal(request: CellTargetRequest): Promise<void> {
    const key = this.#before("seal", request, { providerRef: request.providerRef });
    if (this.#results.has(key)) return;
    this.#resource(request).state = "sealed";
    this.#after("seal", key, true);
  }

  async destroy(request: CellTargetRequest): Promise<void> {
    const key = this.#before("destroy", request, { providerRef: request.providerRef });
    if (this.#results.has(key)) return;
    this.#resource(request);
    this.resources.delete(request.cellId);
    this.#after("destroy", key, true);
  }
}
