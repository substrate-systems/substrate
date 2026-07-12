import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import {
  type CellProvisioner,
  type CellReadiness,
  type CellTargetRequest,
  type CellWorkerPolicy,
  type ProvisionCellRequest,
  ProvisionerFailure,
} from "./provisioner";
import {
  decryptSecret,
  digestSecret,
  encryptSecret,
  generateExternalToken,
  type RandomBytesSource,
  type SecretEnvelope,
} from "./security";

export type LifecycleOperationType =
  | "provision"
  | "suspend"
  | "resume"
  | "rotate_credential"
  | "export"
  | "restore"
  | "stop"
  | "seal"
  | "delete";

export type LifecycleOperationState =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal";

export type LifecycleOperation = {
  id: string;
  tenantId: string;
  cellId: string | null;
  operationType: LifecycleOperationType;
  state: LifecycleOperationState;
  idempotencyKey: string;
  checkpoint: string;
  requestId: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  errorCode: string | null;
  providerResultRef: string | null;
  expectedPreviousCellId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantControlRecord = {
  id: string;
  status: "provisioning" | "active" | "suspended" | "deletion_pending" | "deleted";
  desiredState: "running" | "suspended" | "deleted";
  boundCellId: string | null;
};

export type CellControlRecord = {
  id: string;
  tenantId: string;
  lifecycleState:
    | "provisioning"
    | "active"
    | "draining"
    | "quiesced"
    | "restoring"
    | "stopped"
    | "sealed"
    | "failed"
    | "retired"
    | "deleted";
  routingState: "unbound" | "bound" | "retiring";
  desiredState: "running" | "quiesced" | "stopped" | "deleted";
  protocolVersion: string;
  releaseVersion: string;
  workerPolicy: CellWorkerPolicy;
  providerRef: string | null;
  endpointEnvelope: SecretEnvelope | null;
  credentialEnvelope: SecretEnvelope;
  credentialDigest: Buffer;
  credentialVersion: number;
  pendingCredentialEnvelope: SecretEnvelope | null;
  pendingCredentialDigest: Buffer | null;
  pendingCredentialVersion: number | null;
  readinessCode: string | null;
};

export type LifecycleStatus = {
  state: "preparing" | "ready" | "degraded" | "suspended" | "deletion_pending" | "deleted";
  code: string;
  requestId?: string;
  retryable: boolean;
};

export type CandidateSecret = {
  plaintext: string;
  envelope: SecretEnvelope;
  digest: Buffer;
};

export interface LifecycleStore {
  enqueue(
    tenantId: string,
    operationType: LifecycleOperationType,
    idempotencyKey: string,
    cellId?: string | null
  ): Promise<LifecycleOperation>;
  claim(input: {
    owner: string;
    leaseMs: number;
    maxAttempts: number;
    tenantId?: string;
  }): Promise<LifecycleOperation | null>;
  renewLease(operationId: string, owner: string, leaseMs: number): Promise<boolean>;
  advance(
    operationId: string,
    owner: string,
    expectedCheckpoint: string,
    nextCheckpoint: string
  ): Promise<boolean>;
  retry(
    operationId: string,
    owner: string,
    errorCode: string,
    nextAttemptAt: Date
  ): Promise<boolean>;
  terminal(operationId: string, owner: string, errorCode: string): Promise<boolean>;
  succeed(operationId: string, owner: string): Promise<boolean>;
  ensureCandidate(input: {
    operationId: string;
    owner: string;
    protocolVersion: string;
    releaseVersion: string;
    workerPolicy: CellWorkerPolicy;
    credential: CandidateSecret;
    lifecycleState: "provisioning" | "restoring";
  }): Promise<CellControlRecord | null>;
  getCell(cellId: string): Promise<CellControlRecord | null>;
  recordProvisioned(input: {
    operationId: string;
    owner: string;
    providerRef: string;
    endpointEnvelope: SecretEnvelope;
  }): Promise<boolean>;
  recordReadiness(input: { operationId: string; owner: string; code: string }): Promise<boolean>;
  recordOperationReference(
    operationId: string,
    owner: string,
    opaqueReference: string
  ): Promise<boolean>;
  bindCandidate(operationId: string, owner: string): Promise<boolean>;
  applyLocalGate(
    operationId: string,
    owner: string,
    desired: "suspended" | "running" | "deleted"
  ): Promise<boolean>;
  markCellState(
    operationId: string,
    owner: string,
    state: CellControlRecord["lifecycleState"]
  ): Promise<boolean>;
  activateAfterReadiness(operationId: string, owner: string): Promise<boolean>;
  prepareCredentialRotation(
    operationId: string,
    owner: string,
    credential: CandidateSecret
  ): Promise<boolean>;
  promoteCredential(operationId: string, owner: string): Promise<boolean>;
  statusForTenant(tenantId: string): Promise<LifecycleStatus> | LifecycleStatus;
}

export type ExpectedCellConfiguration = {
  protocolVersion: string;
  releaseVersion: string;
  workerPolicy: CellWorkerPolicy;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

export function expectedCellConfiguration(
  input: Pick<ExpectedCellConfiguration, "protocolVersion" | "releaseVersion" | "workerPolicy"> &
    Partial<
      Pick<ExpectedCellConfiguration, "leaseMs" | "maxAttempts" | "retryBaseMs" | "retryMaxMs">
    >
): ExpectedCellConfiguration {
  if (
    !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.protocolVersion) ||
    !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.releaseVersion) ||
    !Number.isInteger(input.workerPolicy.workerCount) ||
    input.workerPolicy.workerCount < 0
  ) {
    throw new ProvisionerFailure({
      code: "PROVISIONER_CONFIGURATION_INVALID",
      retryable: false,
    });
  }
  return {
    protocolVersion: input.protocolVersion,
    releaseVersion: input.releaseVersion,
    workerPolicy: structuredClone(input.workerPolicy),
    leaseMs: input.leaseMs ?? 15_000,
    maxAttempts: input.maxAttempts ?? 6,
    retryBaseMs: input.retryBaseMs ?? 1_000,
    retryMaxMs: input.retryMaxMs ?? 60_000,
  };
}

export function expectedCellConfigurationFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ExpectedCellConfiguration {
  const protocolVersion = env.EXOMEM_CELL_PROTOCOL_VERSION;
  const releaseVersion = env.EXOMEM_CELL_RELEASE_VERSION;
  if (!protocolVersion || !releaseVersion) {
    throw new ProvisionerFailure({
      code: "PROVISIONER_CONFIGURATION_INVALID",
      retryable: false,
    });
  }
  const workerCount = Number(env.EXOMEM_CELL_WORKER_COUNT ?? "0");
  return expectedCellConfiguration({
    protocolVersion,
    releaseVersion,
    workerPolicy: {
      workerCount,
      semantic: env.EXOMEM_CELL_SEMANTIC_WORKERS === "true",
      media: env.EXOMEM_CELL_MEDIA_WORKERS === "true",
    },
  });
}

type ReconcileResult =
  | { kind: "idle" }
  | { kind: "advanced"; operationId: string; checkpoint: string }
  | { kind: "retry_scheduled"; operationId: string; code: string }
  | { kind: "terminal"; operationId: string; code: string }
  | { kind: "succeeded"; operationId: string };

function sameWorkerPolicy(left: CellWorkerPolicy, right: CellWorkerPolicy): boolean {
  return (
    left.workerCount === right.workerCount &&
    left.semantic === right.semantic &&
    left.media === right.media
  );
}

function readinessMismatch(
  readiness: CellReadiness,
  cell: CellControlRecord,
  config: ExpectedCellConfiguration
): boolean {
  return (
    readiness.cellId !== cell.id ||
    readiness.protocolVersion !== config.protocolVersion ||
    readiness.releaseVersion !== config.releaseVersion ||
    !readiness.serviceAuthenticated ||
    !readiness.mutationAuthority ||
    !readiness.readAdmission ||
    !readiness.writeAdmission ||
    !sameWorkerPolicy(readiness.workerPolicy, config.workerPolicy)
  );
}

export class LifecycleReconciler {
  readonly #store: LifecycleStore;
  readonly #provisioner: CellProvisioner;
  readonly #config: ExpectedCellConfiguration;
  readonly #now: () => Date;
  readonly #randomBytes: RandomBytesSource;
  readonly #envelopeKey?: Buffer;

  constructor(input: {
    store: LifecycleStore;
    provisioner: CellProvisioner;
    config: ExpectedCellConfiguration;
    now?: () => Date;
    randomBytes?: RandomBytesSource;
    envelopeKey?: Buffer;
  }) {
    this.#store = input.store;
    this.#provisioner = input.provisioner;
    this.#config = input.config;
    this.#now = input.now ?? (() => new Date());
    this.#randomBytes = input.randomBytes ?? nodeRandomBytes;
    this.#envelopeKey = input.envelopeKey;
  }

  #credential(): CandidateSecret {
    const plaintext = generateExternalToken(this.#randomBytes);
    return {
      plaintext,
      envelope: encryptSecret(plaintext, {
        key: this.#envelopeKey,
        randomBytes: this.#randomBytes,
      }),
      digest: digestSecret(plaintext),
    };
  }

  #backoff(attempts: number): Date {
    const delay = Math.min(
      this.#config.retryMaxMs,
      this.#config.retryBaseMs * 2 ** Math.max(0, attempts - 1)
    );
    return new Date(this.#now().getTime() + delay);
  }

  async #advance(
    operation: LifecycleOperation,
    owner: string,
    nextCheckpoint: string
  ): Promise<ReconcileResult> {
    const advanced = await this.#store.advance(
      operation.id,
      owner,
      operation.checkpoint,
      nextCheckpoint
    );
    return advanced
      ? { kind: "advanced", operationId: operation.id, checkpoint: nextCheckpoint }
      : { kind: "idle" };
  }

  async #terminal(
    operation: LifecycleOperation,
    owner: string,
    code: string
  ): Promise<ReconcileResult> {
    await this.#store.terminal(operation.id, owner, code);
    return { kind: "terminal", operationId: operation.id, code };
  }

  #context(operation: LifecycleOperation) {
    return {
      operationId: operation.id,
      checkpoint: operation.checkpoint,
      idempotencyKey: `${operation.id}:${operation.checkpoint}`,
    };
  }

  async #cell(operation: LifecycleOperation): Promise<CellControlRecord> {
    if (!operation.cellId) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_CONFIGURATION_INVALID",
        retryable: false,
      });
    }
    const cell = await this.#store.getCell(operation.cellId);
    if (!cell || !cell.providerRef) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_CONFIGURATION_INVALID",
        retryable: false,
      });
    }
    return cell;
  }

  #target(operation: LifecycleOperation, cell: CellControlRecord): CellTargetRequest {
    if (!cell.providerRef) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_CONFIGURATION_INVALID",
        retryable: false,
      });
    }
    return {
      context: this.#context(operation),
      tenantId: operation.tenantId,
      cellId: cell.id,
      protocolVersion: cell.protocolVersion,
      releaseVersion: cell.releaseVersion,
      serviceCredential: decryptSecret(cell.credentialEnvelope, { key: this.#envelopeKey }),
      workerPolicy: cell.workerPolicy,
      providerRef: cell.providerRef,
    };
  }

  async #readiness(
    operation: LifecycleOperation,
    owner: string,
    nextCheckpoint: string
  ): Promise<ReconcileResult> {
    const cell = await this.#cell(operation);
    const readiness = await this.#provisioner.health(this.#target(operation, cell));
    if (readinessMismatch(readiness, cell, this.#config)) {
      return this.#terminal(operation, owner, "CELL_READINESS_MISMATCH");
    }
    if (!readiness.live || !readiness.ready) {
      const code = readiness.code === "CELL_READY" ? "CELL_NOT_READY" : readiness.code;
      await this.#store.retry(operation.id, owner, code, this.#backoff(operation.attempts));
      return { kind: "retry_scheduled", operationId: operation.id, code };
    }
    await this.#store.recordReadiness({
      operationId: operation.id,
      owner,
      code: readiness.code,
    });
    return this.#advance(operation, owner, nextCheckpoint);
  }

  async #provision(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      const candidate = await this.#store.ensureCandidate({
        operationId: operation.id,
        owner,
        protocolVersion: this.#config.protocolVersion,
        releaseVersion: this.#config.releaseVersion,
        workerPolicy: this.#config.workerPolicy,
        credential: this.#credential(),
        lifecycleState: "provisioning",
      });
      if (!candidate) return { kind: "idle" };
      operation.cellId = candidate.id;
      return this.#advance(operation, owner, "candidate-created");
    }
    if (operation.checkpoint === "candidate-created") {
      const cell = await this.#store.getCell(operation.cellId ?? "");
      if (!cell) return this.#terminal(operation, owner, "CELL_CANDIDATE_MISSING");
      const request: ProvisionCellRequest = {
        context: this.#context(operation),
        tenantId: operation.tenantId,
        cellId: cell.id,
        protocolVersion: cell.protocolVersion,
        releaseVersion: cell.releaseVersion,
        serviceCredential: decryptSecret(cell.credentialEnvelope, { key: this.#envelopeKey }),
        workerPolicy: cell.workerPolicy,
      };
      const result = await this.#provisioner.provision(request);
      await this.#store.recordProvisioned({
        operationId: operation.id,
        owner,
        providerRef: result.providerRef,
        endpointEnvelope: encryptSecret(result.privateEndpoint, {
          key: this.#envelopeKey,
          randomBytes: this.#randomBytes,
        }),
      });
      return this.#advance(operation, owner, "provider-converged");
    }
    if (operation.checkpoint === "provider-converged") {
      return this.#readiness(operation, owner, "readiness-proved");
    }
    if (operation.checkpoint === "readiness-proved") {
      const bound = await this.#store.bindCandidate(operation.id, owner);
      return bound
        ? this.#advance(operation, owner, "bound")
        : this.#terminal(operation, owner, "CELL_BINDING_CONFLICT");
    }
    if (operation.checkpoint === "bound") {
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #restore(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      const candidate = await this.#store.ensureCandidate({
        operationId: operation.id,
        owner,
        protocolVersion: this.#config.protocolVersion,
        releaseVersion: this.#config.releaseVersion,
        workerPolicy: this.#config.workerPolicy,
        credential: this.#credential(),
        lifecycleState: "restoring",
      });
      if (!candidate) return { kind: "idle" };
      operation.cellId = candidate.id;
      return this.#advance(operation, owner, "candidate-created");
    }
    if (operation.checkpoint === "candidate-created") {
      const cell = await this.#store.getCell(operation.cellId ?? "");
      if (!cell) return this.#terminal(operation, owner, "CELL_CANDIDATE_MISSING");
      const result = await this.#provisioner.provision({
        context: this.#context(operation),
        tenantId: operation.tenantId,
        cellId: cell.id,
        protocolVersion: cell.protocolVersion,
        releaseVersion: cell.releaseVersion,
        serviceCredential: decryptSecret(cell.credentialEnvelope, { key: this.#envelopeKey }),
        workerPolicy: cell.workerPolicy,
      });
      await this.#store.recordProvisioned({
        operationId: operation.id,
        owner,
        providerRef: result.providerRef,
        endpointEnvelope: encryptSecret(result.privateEndpoint, {
          key: this.#envelopeKey,
          randomBytes: this.#randomBytes,
        }),
      });
      return this.#advance(operation, owner, "provider-converged");
    }
    if (operation.checkpoint === "provider-converged") {
      const cell = await this.#cell(operation);
      await this.#provisioner.restore(this.#target(operation, cell));
      return this.#advance(operation, owner, "restore-applied");
    }
    if (operation.checkpoint === "restore-applied") {
      return this.#readiness(operation, owner, "readiness-proved");
    }
    if (operation.checkpoint === "readiness-proved") {
      const bound = await this.#store.bindCandidate(operation.id, owner);
      return bound
        ? this.#advance(operation, owner, "bound")
        : this.#terminal(operation, owner, "CELL_BINDING_CONFLICT");
    }
    if (operation.checkpoint === "bound") {
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #suspend(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      await this.#store.applyLocalGate(operation.id, owner, "suspended");
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.quiesce(this.#target(operation, cell));
      return this.#advance(operation, owner, "quiesced");
    }
    if (operation.checkpoint === "quiesced") {
      await this.#store.markCellState(operation.id, owner, "quiesced");
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #resume(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      await this.#store.applyLocalGate(operation.id, owner, "running");
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.resume(this.#target(operation, cell));
      return this.#advance(operation, owner, "resumed");
    }
    if (operation.checkpoint === "resumed") {
      return this.#readiness(operation, owner, "readiness-proved");
    }
    if (operation.checkpoint === "readiness-proved") {
      await this.#store.activateAfterReadiness(operation.id, owner);
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #stop(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      await this.#store.applyLocalGate(operation.id, owner, "suspended");
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.stop(this.#target(operation, cell));
      return this.#advance(operation, owner, "stopped");
    }
    if (operation.checkpoint === "stopped") {
      await this.#store.markCellState(operation.id, owner, "stopped");
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #rotate(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      await this.#store.prepareCredentialRotation(operation.id, owner, this.#credential());
      return this.#advance(operation, owner, "rotation-prepared");
    }
    if (operation.checkpoint === "rotation-prepared") {
      const cell = await this.#cell(operation);
      if (!cell.pendingCredentialEnvelope || !cell.pendingCredentialVersion) {
        return this.#terminal(operation, owner, "CREDENTIAL_ROTATION_STATE_INVALID");
      }
      await this.#provisioner.rotateCredential({
        ...this.#target(operation, cell),
        phase: "stage",
        credentialVersion: cell.pendingCredentialVersion,
        nextCredential: decryptSecret(cell.pendingCredentialEnvelope, {
          key: this.#envelopeKey,
        }),
      });
      return this.#advance(operation, owner, "rotation-staged");
    }
    if (operation.checkpoint === "rotation-staged") {
      await this.#store.promoteCredential(operation.id, owner);
      return this.#advance(operation, owner, "rotation-promoted");
    }
    if (operation.checkpoint === "rotation-promoted") {
      const cell = await this.#cell(operation);
      await this.#provisioner.rotateCredential({
        ...this.#target(operation, cell),
        phase: "finalize",
        credentialVersion: cell.credentialVersion,
        nextCredential: decryptSecret(cell.credentialEnvelope, { key: this.#envelopeKey }),
      });
      return this.#advance(operation, owner, "rotation-finalized");
    }
    if (operation.checkpoint === "rotation-finalized") {
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #export(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      await this.#store.applyLocalGate(operation.id, owner, "suspended");
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.quiesce(this.#target(operation, cell));
      return this.#advance(operation, owner, "quiesced");
    }
    if (operation.checkpoint === "quiesced") {
      const cell = await this.#cell(operation);
      const result = await this.#provisioner.export(this.#target(operation, cell));
      await this.#store.recordOperationReference(operation.id, owner, result.exportRef);
      return this.#advance(operation, owner, "export-requested");
    }
    if (operation.checkpoint === "export-requested") {
      const cell = await this.#cell(operation);
      await this.#provisioner.resume(this.#target(operation, cell));
      return this.#advance(operation, owner, "resumed");
    }
    if (operation.checkpoint === "resumed") {
      return this.#readiness(operation, owner, "readiness-proved");
    }
    if (operation.checkpoint === "readiness-proved") {
      await this.#store.activateAfterReadiness(operation.id, owner);
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #sealOrDelete(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    const deleting = operation.operationType === "delete";
    if (operation.checkpoint === "created") {
      await this.#store.applyLocalGate(operation.id, owner, deleting ? "deleted" : "suspended");
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.seal(this.#target(operation, cell));
      return this.#advance(operation, owner, "sealed");
    }
    if (operation.checkpoint === "sealed" && deleting) {
      const cell = await this.#cell(operation);
      await this.#provisioner.destroy(this.#target(operation, cell));
      return this.#advance(operation, owner, "destroyed");
    }
    if (operation.checkpoint === "sealed" || operation.checkpoint === "destroyed") {
      await this.#store.markCellState(operation.id, owner, deleting ? "deleted" : "sealed");
      await this.#store.succeed(operation.id, owner);
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async reconcileOne(input: { owner: string; tenantId?: string }): Promise<ReconcileResult> {
    const operation = await this.#store.claim({
      owner: input.owner,
      leaseMs: this.#config.leaseMs,
      maxAttempts: this.#config.maxAttempts,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    });
    if (!operation) return { kind: "idle" };
    if (operation.attempts > this.#config.maxAttempts) {
      return this.#terminal(operation, input.owner, "LIFECYCLE_MAX_ATTEMPTS");
    }
    try {
      await this.#store.renewLease(operation.id, input.owner, this.#config.leaseMs);
      switch (operation.operationType) {
        case "provision":
          return await this.#provision(operation, input.owner);
        case "restore":
          return await this.#restore(operation, input.owner);
        case "suspend":
          return await this.#suspend(operation, input.owner);
        case "resume":
          return await this.#resume(operation, input.owner);
        case "stop":
          return await this.#stop(operation, input.owner);
        case "rotate_credential":
          return await this.#rotate(operation, input.owner);
        case "export":
          return await this.#export(operation, input.owner);
        case "seal":
        case "delete":
          return await this.#sealOrDelete(operation, input.owner);
      }
    } catch (error) {
      const failure =
        error instanceof ProvisionerFailure
          ? error
          : new ProvisionerFailure({
              code: "PROVISIONER_UNAVAILABLE",
              retryable: true,
              cause: error,
            });
      if (!failure.retryable) return this.#terminal(operation, input.owner, failure.code);
      if (operation.attempts >= this.#config.maxAttempts) {
        return this.#terminal(operation, input.owner, "LIFECYCLE_MAX_ATTEMPTS");
      }
      await this.#store.retry(
        operation.id,
        input.owner,
        failure.code,
        this.#backoff(operation.attempts)
      );
      return {
        kind: "retry_scheduled",
        operationId: operation.id,
        code: failure.code,
      };
    }
  }
}

function copyOperation(operation: LifecycleOperation): LifecycleOperation {
  return {
    ...operation,
    nextAttemptAt: new Date(operation.nextAttemptAt),
    leaseExpiresAt: operation.leaseExpiresAt ? new Date(operation.leaseExpiresAt) : null,
    createdAt: new Date(operation.createdAt),
    updatedAt: new Date(operation.updatedAt),
  };
}

export class InMemoryLifecycleStore implements LifecycleStore {
  readonly tenants = new Map<string, TenantControlRecord>();
  readonly cells = new Map<string, CellControlRecord>();
  readonly operations = new Map<string, LifecycleOperation>();
  readonly checkpointHistory: Array<{ operationId: string; checkpoint: string }> = [];
  readonly #now: () => Date;

  constructor(input: { now?: () => Date } = {}) {
    this.#now = input.now ?? (() => new Date());
  }

  #owned(operationId: string, owner: string): LifecycleOperation | null {
    const operation = this.operations.get(operationId);
    const now = this.#now();
    return operation &&
      operation.state === "running" &&
      operation.leaseOwner === owner &&
      operation.leaseExpiresAt &&
      operation.leaseExpiresAt > now
      ? operation
      : null;
  }

  async enqueue(
    tenantId: string,
    operationType: LifecycleOperationType,
    idempotencyKey: string,
    cellId: string | null = null
  ): Promise<LifecycleOperation> {
    const existing = [...this.operations.values()].find(
      (operation) =>
        operation.tenantId === tenantId &&
        operation.operationType === operationType &&
        operation.idempotencyKey === idempotencyKey
    );
    if (existing) return copyOperation(existing);
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, {
        id: tenantId,
        status: "provisioning",
        desiredState: "running",
        boundCellId: null,
      });
    }
    const now = this.#now();
    const operation: LifecycleOperation = {
      id: randomUUID(),
      tenantId,
      cellId,
      operationType,
      state: "pending",
      idempotencyKey,
      checkpoint: "created",
      requestId: randomUUID(),
      attempts: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
      providerResultRef: null,
      expectedPreviousCellId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(operation.id, operation);
    return copyOperation(operation);
  }

  async claim(input: {
    owner: string;
    leaseMs: number;
    maxAttempts: number;
    tenantId?: string;
  }): Promise<LifecycleOperation | null> {
    const now = this.#now();
    const candidate = [...this.operations.values()]
      .filter(
        (operation) =>
          (!input.tenantId || operation.tenantId === input.tenantId) &&
          operation.attempts <= input.maxAttempts &&
          operation.nextAttemptAt <= now &&
          (["pending", "waiting", "failed_retryable"].includes(operation.state) ||
            (operation.state === "running" &&
              (!operation.leaseExpiresAt || operation.leaseExpiresAt <= now)))
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
    if (!candidate) return null;
    candidate.state = "running";
    candidate.leaseOwner = input.owner;
    candidate.leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    candidate.attempts += 1;
    candidate.updatedAt = now;
    return copyOperation(candidate);
  }

  async renewLease(operationId: string, owner: string, leaseMs: number): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (!operation) return false;
    operation.leaseExpiresAt = new Date(this.#now().getTime() + leaseMs);
    return true;
  }

  async advance(
    operationId: string,
    owner: string,
    expectedCheckpoint: string,
    nextCheckpoint: string
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (!operation || operation.checkpoint !== expectedCheckpoint) return false;
    operation.checkpoint = nextCheckpoint;
    operation.state = "waiting";
    operation.errorCode = null;
    operation.nextAttemptAt = this.#now();
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    this.checkpointHistory.push({ operationId, checkpoint: nextCheckpoint });
    return true;
  }

  async retry(
    operationId: string,
    owner: string,
    errorCode: string,
    nextAttemptAt: Date
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (!operation) return false;
    operation.state = "failed_retryable";
    operation.errorCode = errorCode;
    operation.nextAttemptAt = nextAttemptAt;
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    return true;
  }

  async terminal(operationId: string, owner: string, errorCode: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (!operation) return false;
    operation.state = "failed_terminal";
    operation.errorCode = errorCode;
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    return true;
  }

  async succeed(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (!operation) return false;
    operation.state = "succeeded";
    operation.errorCode = null;
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    return true;
  }

  async ensureCandidate(input: {
    operationId: string;
    owner: string;
    protocolVersion: string;
    releaseVersion: string;
    workerPolicy: CellWorkerPolicy;
    credential: CandidateSecret;
    lifecycleState: "provisioning" | "restoring";
  }): Promise<CellControlRecord | null> {
    const operation = this.#owned(input.operationId, input.owner);
    if (!operation) return null;
    if (operation.cellId) return this.cells.get(operation.cellId) ?? null;
    const tenant = this.tenants.get(operation.tenantId);
    if (!tenant) return null;
    const cell: CellControlRecord = {
      id: randomUUID(),
      tenantId: operation.tenantId,
      lifecycleState: input.lifecycleState,
      routingState: "unbound",
      desiredState: "running",
      protocolVersion: input.protocolVersion,
      releaseVersion: input.releaseVersion,
      workerPolicy: structuredClone(input.workerPolicy),
      providerRef: null,
      endpointEnvelope: null,
      credentialEnvelope: structuredClone(input.credential.envelope),
      credentialDigest: Buffer.from(input.credential.digest),
      credentialVersion: 1,
      pendingCredentialEnvelope: null,
      pendingCredentialDigest: null,
      pendingCredentialVersion: null,
      readinessCode: null,
    };
    operation.expectedPreviousCellId = tenant.boundCellId;
    operation.cellId = cell.id;
    this.cells.set(cell.id, cell);
    return structuredClone(cell);
  }

  async getCell(cellId: string): Promise<CellControlRecord | null> {
    const cell = this.cells.get(cellId);
    return cell ? structuredClone(cell) : null;
  }

  async recordProvisioned(input: {
    operationId: string;
    owner: string;
    providerRef: string;
    endpointEnvelope: SecretEnvelope;
  }): Promise<boolean> {
    const operation = this.#owned(input.operationId, input.owner);
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (!operation || !cell) return false;
    cell.providerRef = input.providerRef;
    cell.endpointEnvelope = structuredClone(input.endpointEnvelope);
    return true;
  }

  async recordReadiness(input: {
    operationId: string;
    owner: string;
    code: string;
  }): Promise<boolean> {
    const operation = this.#owned(input.operationId, input.owner);
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (!cell) return false;
    cell.readinessCode = input.code;
    return true;
  }

  async bindCandidate(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const candidate = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (
      operation &&
      tenant &&
      candidate &&
      tenant.boundCellId === candidate.id &&
      candidate.routingState === "bound" &&
      candidate.lifecycleState === "active" &&
      candidate.readinessCode === "CELL_READY"
    ) {
      return true;
    }
    if (
      !operation ||
      !tenant ||
      !candidate ||
      tenant.boundCellId !== operation.expectedPreviousCellId ||
      candidate.routingState !== "unbound" ||
      candidate.readinessCode !== "CELL_READY"
    ) {
      return false;
    }
    if (tenant.boundCellId) {
      const prior = this.cells.get(tenant.boundCellId);
      if (prior) prior.routingState = "retiring";
    }
    candidate.routingState = "bound";
    candidate.lifecycleState = "active";
    tenant.boundCellId = candidate.id;
    tenant.status = "active";
    tenant.desiredState = "running";
    return true;
  }

  async recordOperationReference(
    operationId: string,
    owner: string,
    opaqueReference: string
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (!operation || !/^[A-Za-z0-9_.:-]{1,256}$/.test(opaqueReference)) return false;
    operation.providerResultRef = opaqueReference;
    return true;
  }

  async applyLocalGate(
    operationId: string,
    owner: string,
    desired: "suspended" | "running" | "deleted"
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (!operation || !tenant || !cell || tenant.boundCellId !== cell.id) return false;
    tenant.desiredState = desired;
    tenant.status = desired === "deleted" ? "deletion_pending" : "suspended";
    cell.lifecycleState = "draining";
    cell.desiredState =
      desired === "deleted" ? "deleted" : desired === "running" ? "running" : "quiesced";
    return true;
  }

  async markCellState(
    operationId: string,
    owner: string,
    state: CellControlRecord["lifecycleState"]
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (!operation || !tenant || !cell) return false;
    cell.lifecycleState = state;
    if (state === "deleted") {
      cell.routingState = "retiring";
      tenant.boundCellId = null;
      tenant.status = "deleted";
      tenant.desiredState = "deleted";
    }
    return true;
  }

  async activateAfterReadiness(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (!operation || !tenant || !cell || tenant.boundCellId !== cell.id) return false;
    cell.lifecycleState = "active";
    cell.desiredState = "running";
    tenant.status = "active";
    tenant.desiredState = "running";
    return true;
  }

  async prepareCredentialRotation(
    operationId: string,
    owner: string,
    credential: CandidateSecret
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (!cell) return false;
    if (!cell.pendingCredentialEnvelope) {
      cell.pendingCredentialEnvelope = structuredClone(credential.envelope);
      cell.pendingCredentialDigest = Buffer.from(credential.digest);
      cell.pendingCredentialVersion = cell.credentialVersion + 1;
    }
    return true;
  }

  async promoteCredential(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (
      !cell ||
      !cell.pendingCredentialEnvelope ||
      !cell.pendingCredentialDigest ||
      !cell.pendingCredentialVersion
    ) {
      return false;
    }
    cell.credentialEnvelope = cell.pendingCredentialEnvelope;
    cell.credentialDigest = cell.pendingCredentialDigest;
    cell.credentialVersion = cell.pendingCredentialVersion;
    cell.pendingCredentialEnvelope = null;
    cell.pendingCredentialDigest = null;
    cell.pendingCredentialVersion = null;
    return true;
  }

  statusForTenant(tenantId: string): LifecycleStatus {
    const tenant = this.tenants.get(tenantId);
    const latest = [...this.operations.values()]
      .filter((operation) => operation.tenantId === tenantId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
    const requestId = latest?.requestId;
    if (!tenant) return { state: "preparing", code: "TENANT_PREPARING", retryable: true };
    if (tenant.status === "deleted") {
      return { state: "deleted", code: "EXOMEM_DELETED", retryable: false };
    }
    if (tenant.status === "deletion_pending") {
      return {
        state: "deletion_pending",
        code: "DELETION_IN_PROGRESS",
        ...(requestId ? { requestId } : {}),
        retryable: true,
      };
    }
    if (tenant.status === "suspended") {
      return {
        state: "suspended",
        code: "EXOMEM_SUSPENDED",
        ...(requestId ? { requestId } : {}),
        retryable: false,
      };
    }
    const cell = tenant.boundCellId ? this.cells.get(tenant.boundCellId) : null;
    if (tenant.status === "active" && cell?.lifecycleState === "active") {
      return { state: "ready", code: "CELL_READY", retryable: false };
    }
    if (latest?.state === "failed_retryable" || latest?.state === "failed_terminal") {
      return {
        state: "degraded",
        code: latest.errorCode ?? "CELL_UNAVAILABLE",
        ...(requestId ? { requestId } : {}),
        retryable: latest.state === "failed_retryable",
      };
    }
    return {
      state: "preparing",
      code: "CELL_PREPARING",
      ...(requestId ? { requestId } : {}),
      retryable: true,
    };
  }

  async makeRunnable(tenantId: string): Promise<void> {
    for (const operation of this.operations.values()) {
      if (operation.tenantId === tenantId && operation.state === "failed_retryable") {
        operation.nextAttemptAt = this.#now();
      }
    }
  }
}
