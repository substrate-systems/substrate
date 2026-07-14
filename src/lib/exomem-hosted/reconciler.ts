import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";
import {
  type CellProvisioner,
  type CellReadiness,
  type CellTargetRequest,
  type CellWorkerPolicy,
  type ProvisionCellRequest,
  ProvisionerFailure,
  ProvisionerPending,
} from "./provisioner";
import {
  decryptSecret,
  digestSecret,
  encryptSecret,
  generateExternalToken,
  SensitiveSecret,
  type RandomBytesSource,
  type SecretEnvelope,
} from "./security";
import { exomemErrors } from "./errors";
import type { BillingDeletionTarget } from "./billing-deletion";

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
  "pending" | "running" | "waiting" | "succeeded" | "failed_retryable" | "failed_terminal";

export type LifecycleOperation = {
  id: string;
  tenantId: string;
  cellId: string | null;
  operationType: LifecycleOperationType;
  state: LifecycleOperationState;
  idempotencyKey: string;
  fenceGeneration: number;
  checkpoint: string;
  requestId: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  errorCode: string | null;
  providerResultRef: string | null;
  inputReferenceEnvelope: SecretEnvelope | null;
  inputReferenceDigest: Buffer | null;
  inputExportId: string | null;
  exportReleaseEnvelope: SecretEnvelope | null;
  exportReleaseDigest: Buffer | null;
  exportExpiresAt: Date | null;
  exportRequestStarted: boolean;
  inputSourceCellId: string | null;
  inputArchiveSha256: string | null;
  inputManifestSha256: string | null;
  inputArchiveSize: number | null;
  resumeAfterOperation: boolean;
  expectedPreviousCellId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantControlRecord = {
  id: string;
  status: "provisioning" | "active" | "suspended" | "deletion_pending" | "deleted";
  desiredState: "running" | "suspended" | "deleted";
  boundCellId: string | null;
  fenceGeneration: number;
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
  credentialEnvelope: SecretEnvelope | null;
  credentialDigest: Buffer | null;
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

export type ProductBillingTerminator = (tenantId: string) => Promise<BillingDeletionTarget | null>;

export type RestoreBinding = {
  exportId: string;
  sourceCellId: string;
  archiveSha256: string;
  manifestSha256: string;
  archiveSize: number;
};

export type LifecycleEnqueueOptions = {
  inputReferenceEnvelope?: SecretEnvelope;
  inputReferenceDigest?: Buffer;
  restoreBinding?: RestoreBinding;
  exportTtlMs?: number;
};

export type ExportRecordDisposition = "available" | "expired" | "conflict";

export interface LifecycleStore {
  enqueue(
    tenantId: string,
    operationType: LifecycleOperationType,
    idempotencyKey: string,
    cellId?: string | null,
    options?: LifecycleEnqueueOptions
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
  beginExport(operationId: string, owner: string, expiresAt: Date): Promise<boolean>;
  recoverRecordedExport(
    operationId: string,
    owner: string
  ): Promise<ExportRecordDisposition | "missing">;
  advanceBillingTerminated(input: {
    operationId: string;
    owner: string;
    proof: BillingDeletionTarget;
  }): Promise<boolean>;
  retry(
    operationId: string,
    owner: string,
    errorCode: string,
    nextAttemptAt: Date
  ): Promise<boolean>;
  waitForProvider(
    operationId: string,
    owner: string,
    expectedCheckpoint: string,
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
  recordExportResult(input: {
    operationId: string;
    owner: string;
    tenantId: string;
    cellId: string;
    storageReferenceEnvelope: SecretEnvelope;
    storageReferenceDigest: Buffer;
    releaseReferenceEnvelope: SecretEnvelope;
    releaseReferenceDigest: Buffer;
    archiveSha256: string;
    manifestSha256: string;
    archiveSize: number;
    encryptionScheme: "envelope-aes-256-gcm";
    integrityVerified: true;
    expiresAt: Date;
  }): Promise<ExportRecordDisposition>;
  acknowledgeExportRelease(operationId: string, owner: string): Promise<boolean>;
  prepareExpiredExportRelease(operationId: string, owner: string): Promise<boolean>;
  acknowledgeExpiredExportRelease(operationId: string, owner: string): Promise<boolean>;
  completeExpiredExportRestoration(operationId: string, owner: string): Promise<boolean>;
  bindCandidate(operationId: string, owner: string): Promise<boolean>;
  prepareCandidateCleanup(operationId: string, owner: string, errorCode: string): Promise<boolean>;
  prepareExportRecovery(operationId: string, owner: string, errorCode: string): Promise<boolean>;
  markUnboundCellDestroyed(operationId: string, owner: string, cellId: string): Promise<boolean>;
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
  exportTtlMs: number;
};

export function expectedCellConfiguration(
  input: Pick<ExpectedCellConfiguration, "protocolVersion" | "releaseVersion" | "workerPolicy"> &
    Partial<
      Pick<
        ExpectedCellConfiguration,
        "leaseMs" | "maxAttempts" | "retryBaseMs" | "retryMaxMs" | "exportTtlMs"
      >
    >
): ExpectedCellConfiguration {
  if (
    !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.protocolVersion) ||
    !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.releaseVersion) ||
    !Number.isInteger(input.workerPolicy.workerCount) ||
    input.workerPolicy.workerCount < 0 ||
    (input.exportTtlMs !== undefined &&
      (!Number.isSafeInteger(input.exportTtlMs) ||
        input.exportTtlMs < 60 * 60 * 1000 ||
        input.exportTtlMs > 30 * 24 * 60 * 60 * 1000))
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
    exportTtlMs: input.exportTtlMs ?? 24 * 60 * 60 * 1000,
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
  const exportTtlMs = exportTtlMsFromEnv(env);
  return expectedCellConfiguration({
    protocolVersion,
    releaseVersion,
    workerPolicy: {
      workerCount,
      semantic: env.EXOMEM_CELL_SEMANTIC_WORKERS === "true",
      media: env.EXOMEM_CELL_MEDIA_WORKERS === "true",
    },
    exportTtlMs,
  });
}

export function exportTtlMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const exportTtlHours = Number(env.EXOMEM_EXPORT_TTL_HOURS ?? "24");
  const exportTtlMs = exportTtlHours * 60 * 60 * 1000;
  if (
    !Number.isSafeInteger(exportTtlMs) ||
    exportTtlMs < 60 * 60 * 1000 ||
    exportTtlMs > 30 * 24 * 60 * 60 * 1000
  ) {
    throw new ProvisionerFailure({
      code: "PROVISIONER_CONFIGURATION_INVALID",
      retryable: false,
    });
  }
  return exportTtlMs;
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
    (readiness.live && readiness.ready && readiness.code !== "CELL_READY") ||
    !readiness.serviceAuthenticated ||
    !readiness.mutationAuthority ||
    !readiness.readAdmission ||
    !readiness.writeAdmission ||
    !sameWorkerPolicy(readiness.workerPolicy, config.workerPolicy)
  );
}

function pendingCheckpointMatches(operation: LifecycleOperation, checkpoint: string): boolean {
  if (checkpoint === operation.checkpoint) return true;
  const actionCheckpoints: Partial<Record<LifecycleOperation["checkpoint"], readonly string[]>> = {
    "candidate-cleanup": ["candidate-created", "candidate-discard"],
    "export-failure-resume": ["export-failure-readiness"],
    "rotation-staged": ["rotation-pending-readiness"],
    "export-stored": ["export-release"],
    "prior-retirement": ["restored-prior-discard"],
    "billing-terminated": ["tenant-destroy"],
    "billing-quiesced": ["tenant-destroy"],
    sealed: ["tenant-destroy"],
  };
  return actionCheckpoints[operation.checkpoint]?.includes(checkpoint) === true;
}

function mandatoryRecoveryCode(operation: LifecycleOperation): string | null {
  if (operation.checkpoint === "candidate-cleanup") return "CANDIDATE_CLEANUP_PENDING";
  if (operation.checkpoint === "export-requested") return "EXPORT_RESULT_RECOVERY_PENDING";
  if (operation.checkpoint === "export-stored") return "EXPORT_RELEASE_PENDING";
  if (operation.checkpoint === "export-expired-release") {
    return "EXPIRED_EXPORT_RELEASE_PENDING";
  }
  if (
    [
      "export-expired-released",
      "export-expired-resumed",
      "export-expired-readiness-proved",
    ].includes(operation.checkpoint)
  ) {
    return "EXPIRED_EXPORT_RESTORATION_PENDING";
  }
  if (
    operation.operationType === "export" &&
    operation.checkpoint === "quiesced" &&
    operation.exportRequestStarted &&
    !operation.exportReleaseEnvelope
  ) {
    return "EXPORT_RESULT_RECOVERY_PENDING";
  }
  if (
    operation.operationType === "export" &&
    operation.checkpoint === "quiesced" &&
    operation.exportReleaseEnvelope
  ) {
    return "EXPIRED_EXPORT_RELEASE_PENDING";
  }
  if (["prior-retirement", "prior-retired"].includes(operation.checkpoint)) {
    return "PRIOR_CELL_RETIREMENT_PENDING";
  }
  if (operation.checkpoint === "export-failure-resume") return "EXPORT_RECOVERY_PENDING";
  return null;
}

export class LifecycleReconciler {
  readonly #store: LifecycleStore;
  readonly #provisioner: CellProvisioner;
  readonly #config: ExpectedCellConfiguration;
  readonly #now: () => Date;
  readonly #randomBytes: RandomBytesSource;
  readonly #envelopeKey?: Buffer;
  readonly #terminateBilling: ProductBillingTerminator;

  constructor(input: {
    store: LifecycleStore;
    provisioner: CellProvisioner;
    config: ExpectedCellConfiguration;
    now?: () => Date;
    randomBytes?: RandomBytesSource;
    envelopeKey?: Buffer;
    terminateBilling?: ProductBillingTerminator;
  }) {
    this.#store = input.store;
    this.#provisioner = input.provisioner;
    this.#config = input.config;
    this.#now = input.now ?? (() => new Date());
    this.#randomBytes = input.randomBytes ?? nodeRandomBytes;
    this.#envelopeKey = input.envelopeKey;
    this.#terminateBilling = input.terminateBilling ?? (async () => null);
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

  #requireStored(value: boolean): void {
    if (!value) {
      throw new ProvisionerFailure({
        code: "CONTROL_PLANE_STATE_CONFLICT",
        retryable: true,
      });
    }
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
    if (
      ["provision", "restore"].includes(operation.operationType) &&
      operation.checkpoint !== "candidate-cleanup" &&
      operation.cellId
    ) {
      const cell = await this.#store.getCell(operation.cellId);
      if (cell && cell.routingState === "unbound" && cell.lifecycleState !== "deleted") {
        const prepared = await this.#store.prepareCandidateCleanup(operation.id, owner, code);
        if (prepared) {
          return {
            kind: "advanced",
            operationId: operation.id,
            checkpoint: "candidate-cleanup",
          };
        }
      }
    }
    if (
      operation.operationType === "export" &&
      operation.checkpoint !== "export-failure-resume" &&
      operation.resumeAfterOperation &&
      operation.checkpoint !== "created"
    ) {
      const prepared = await this.#store.prepareExportRecovery(operation.id, owner, code);
      if (prepared) {
        return {
          kind: "advanced",
          operationId: operation.id,
          checkpoint: "export-failure-resume",
        };
      }
    }
    const terminal = await this.#store.terminal(operation.id, owner, code);
    return terminal ? { kind: "terminal", operationId: operation.id, code } : { kind: "idle" };
  }

  #context(operation: LifecycleOperation) {
    return {
      operationId: operation.id,
      checkpoint: operation.checkpoint,
      idempotencyKey: `${operation.id}:${operation.checkpoint}`,
      fenceGeneration: operation.fenceGeneration,
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
    if (!cell.providerRef || !cell.credentialEnvelope) {
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
      serviceCredential: this.#cellCredential(cell),
      workerPolicy: cell.workerPolicy,
      providerRef: cell.providerRef,
    };
  }

  #cellCredential(cell: CellControlRecord) {
    if (!cell.credentialEnvelope) {
      throw new ProvisionerFailure({
        code: "PROVISIONER_CONFIGURATION_INVALID",
        retryable: false,
      });
    }
    return decryptSecret(cell.credentialEnvelope, { key: this.#envelopeKey });
  }

  #targetForAction(
    operation: LifecycleOperation,
    cell: CellControlRecord,
    action: string
  ): CellTargetRequest {
    return {
      ...this.#target(operation, cell),
      context: {
        operationId: operation.id,
        checkpoint: action,
        idempotencyKey: `${operation.id}:${action}:${cell.id}`,
        fenceGeneration: operation.fenceGeneration,
      },
    };
  }

  #tenantDestroyTarget(operation: LifecycleOperation) {
    return {
      context: {
        operationId: operation.id,
        checkpoint: "tenant-destroy",
        idempotencyKey: `${operation.id}:tenant-destroy`,
        fenceGeneration: operation.fenceGeneration,
      },
      tenantId: operation.tenantId,
    };
  }

  async #cleanupCandidate(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    const originalCode = operation.errorCode ?? "CELL_CANDIDATE_FAILED";
    if (!operation.cellId) {
      this.#requireStored(await this.#store.terminal(operation.id, owner, originalCode));
      return { kind: "terminal", operationId: operation.id, code: originalCode };
    }
    let cell = await this.#store.getCell(operation.cellId);
    if (!cell) {
      this.#requireStored(await this.#store.terminal(operation.id, owner, originalCode));
      return { kind: "terminal", operationId: operation.id, code: originalCode };
    }
    if (cell.routingState === "bound") {
      this.#requireStored(
        await this.#store.terminal(operation.id, owner, "CELL_CLEANUP_BINDING_CONFLICT")
      );
      return {
        kind: "terminal",
        operationId: operation.id,
        code: "CELL_CLEANUP_BINDING_CONFLICT",
      };
    }
    if (cell.lifecycleState !== "deleted") {
      // A provision call may have succeeded before its acknowledgement was
      // lost. Re-converge the original create key to recover the provider ref,
      // then destroy the exact unbound resource.
      if (!cell.providerRef) {
        const result = await this.#provisioner.provision({
          context: {
            operationId: operation.id,
            checkpoint: "candidate-created",
            idempotencyKey: `${operation.id}:candidate-created`,
            fenceGeneration: operation.fenceGeneration,
          },
          tenantId: operation.tenantId,
          cellId: cell.id,
          protocolVersion: cell.protocolVersion,
          releaseVersion: cell.releaseVersion,
          serviceCredential: this.#cellCredential(cell),
          workerPolicy: cell.workerPolicy,
        });
        const recorded = await this.#store.recordProvisioned({
          operationId: operation.id,
          owner,
          providerRef: result.providerRef,
          endpointEnvelope: encryptSecret(result.privateEndpoint, {
            key: this.#envelopeKey,
            randomBytes: this.#randomBytes,
          }),
        });
        if (!recorded) {
          throw new ProvisionerFailure({
            code: "PROVISIONER_UNAVAILABLE",
            retryable: true,
          });
        }
        cell = (await this.#store.getCell(cell.id)) ?? cell;
      }
      await this.#provisioner.discard(this.#targetForAction(operation, cell, "candidate-discard"));
      const marked = await this.#store.markUnboundCellDestroyed(operation.id, owner, cell.id);
      if (!marked) {
        throw new ProvisionerFailure({
          code: "PROVISIONER_UNAVAILABLE",
          retryable: true,
        });
      }
    }
    this.#requireStored(await this.#store.terminal(operation.id, owner, originalCode));
    return { kind: "terminal", operationId: operation.id, code: originalCode };
  }

  async #recoverFailedExport(
    operation: LifecycleOperation,
    owner: string
  ): Promise<ReconcileResult> {
    const originalCode = operation.errorCode ?? "EXPORT_FAILED";
    const cell = await this.#cell(operation);
    const target = this.#targetForAction(operation, cell, "export-failure-resume");
    await this.#provisioner.resume(target);
    const readiness = await this.#provisioner.health({
      ...target,
      context: {
        ...target.context,
        checkpoint: "export-failure-readiness",
        idempotencyKey: `${operation.id}:export-failure-readiness:${cell.id}`,
      },
    });
    if (readinessMismatch(readiness, cell, this.#config) || !readiness.live || !readiness.ready) {
      throw new ProvisionerFailure({ code: "PROVISIONER_UNAVAILABLE", retryable: true });
    }
    this.#requireStored(
      await this.#store.recordReadiness({
        operationId: operation.id,
        owner,
        code: readiness.code,
      })
    );
    const activated = await this.#store.activateAfterReadiness(operation.id, owner);
    if (!activated) {
      throw new ProvisionerFailure({ code: "PROVISIONER_UNAVAILABLE", retryable: true });
    }
    this.#requireStored(await this.#store.terminal(operation.id, owner, originalCode));
    return { kind: "terminal", operationId: operation.id, code: originalCode };
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
      const retried = await this.#store.retry(
        operation.id,
        owner,
        code,
        this.#backoff(operation.attempts)
      );
      return retried
        ? { kind: "retry_scheduled", operationId: operation.id, code }
        : { kind: "idle" };
    }
    this.#requireStored(
      await this.#store.recordReadiness({
        operationId: operation.id,
        owner,
        code: readiness.code,
      })
    );
    return this.#advance(operation, owner, nextCheckpoint);
  }

  async #provision(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "candidate-cleanup") {
      return this.#cleanupCandidate(operation, owner);
    }
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
        serviceCredential: this.#cellCredential(cell),
        workerPolicy: cell.workerPolicy,
      };
      const result = await this.#provisioner.provision(request);
      this.#requireStored(
        await this.#store.recordProvisioned({
          operationId: operation.id,
          owner,
          providerRef: result.providerRef,
          endpointEnvelope: encryptSecret(result.privateEndpoint, {
            key: this.#envelopeKey,
            randomBytes: this.#randomBytes,
          }),
        })
      );
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
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #restore(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "candidate-cleanup") {
      return this.#cleanupCandidate(operation, owner);
    }
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
        serviceCredential: this.#cellCredential(cell),
        workerPolicy: cell.workerPolicy,
      });
      this.#requireStored(
        await this.#store.recordProvisioned({
          operationId: operation.id,
          owner,
          providerRef: result.providerRef,
          endpointEnvelope: encryptSecret(result.privateEndpoint, {
            key: this.#envelopeKey,
            randomBytes: this.#randomBytes,
          }),
        })
      );
      return this.#advance(operation, owner, "provider-converged");
    }
    if (operation.checkpoint === "provider-converged") {
      const cell = await this.#cell(operation);
      if (
        !operation.inputReferenceEnvelope ||
        !operation.inputSourceCellId ||
        !operation.inputArchiveSha256 ||
        !operation.inputManifestSha256 ||
        !operation.inputArchiveSize
      ) {
        return this.#terminal(operation, owner, "RESTORE_REFERENCE_MISSING");
      }
      await this.#provisioner.restore({
        ...this.#target(operation, cell),
        restoreRef: decryptSecret(operation.inputReferenceEnvelope, {
          key: this.#envelopeKey,
        }),
        sourceCellId: operation.inputSourceCellId,
        archiveSha256: operation.inputArchiveSha256,
        manifestSha256: operation.inputManifestSha256,
        archiveSize: operation.inputArchiveSize,
      });
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
      if (
        operation.expectedPreviousCellId &&
        operation.expectedPreviousCellId !== operation.cellId
      ) {
        return this.#advance(operation, owner, "prior-retirement");
      }
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    if (operation.checkpoint === "prior-retirement") {
      const priorId = operation.expectedPreviousCellId;
      if (!priorId) return this.#advance(operation, owner, "prior-retired");
      const prior = await this.#store.getCell(priorId);
      if (!prior || !prior.providerRef || prior.routingState === "bound") {
        throw new ProvisionerFailure({ code: "PROVISIONER_UNAVAILABLE", retryable: true });
      }
      await this.#provisioner.discard(
        this.#targetForAction(operation, prior, "restored-prior-discard")
      );
      const marked = await this.#store.markUnboundCellDestroyed(operation.id, owner, prior.id);
      if (!marked) {
        throw new ProvisionerFailure({ code: "PROVISIONER_UNAVAILABLE", retryable: true });
      }
      return this.#advance(operation, owner, "prior-retired");
    }
    if (operation.checkpoint === "prior-retired") {
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #suspend(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      this.#requireStored(await this.#store.applyLocalGate(operation.id, owner, "suspended"));
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.quiesce(this.#target(operation, cell));
      return this.#advance(operation, owner, "quiesced");
    }
    if (operation.checkpoint === "quiesced") {
      this.#requireStored(await this.#store.markCellState(operation.id, owner, "quiesced"));
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #resume(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      this.#requireStored(await this.#store.applyLocalGate(operation.id, owner, "running"));
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
      this.#requireStored(await this.#store.activateAfterReadiness(operation.id, owner));
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #stop(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      this.#requireStored(await this.#store.applyLocalGate(operation.id, owner, "suspended"));
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.stop(this.#target(operation, cell));
      return this.#advance(operation, owner, "stopped");
    }
    if (operation.checkpoint === "stopped") {
      this.#requireStored(await this.#store.markCellState(operation.id, owner, "stopped"));
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #rotate(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "created") {
      this.#requireStored(
        await this.#store.prepareCredentialRotation(operation.id, owner, this.#credential())
      );
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
      const cell = await this.#cell(operation);
      if (!cell.pendingCredentialEnvelope) {
        return this.#terminal(operation, owner, "CREDENTIAL_ROTATION_STATE_INVALID");
      }
      const pendingCredential = decryptSecret(cell.pendingCredentialEnvelope, {
        key: this.#envelopeKey,
      });
      const target = this.#targetForAction(operation, cell, "rotation-pending-readiness");
      const readiness = await this.#provisioner.health({
        ...target,
        serviceCredential: pendingCredential,
      });
      if (
        readinessMismatch(readiness, cell, this.#config) ||
        !readiness.live ||
        !readiness.ready ||
        !readiness.serviceAuthenticated ||
        !readiness.mutationAuthority ||
        !readiness.readAdmission ||
        !readiness.writeAdmission
      ) {
        return this.#terminal(operation, owner, "CREDENTIAL_ROTATION_VERIFICATION_FAILED");
      }
      return this.#advance(operation, owner, "rotation-verified");
    }
    if (operation.checkpoint === "rotation-verified") {
      this.#requireStored(await this.#store.promoteCredential(operation.id, owner));
      return this.#advance(operation, owner, "rotation-promoted");
    }
    if (operation.checkpoint === "rotation-promoted") {
      const cell = await this.#cell(operation);
      await this.#provisioner.rotateCredential({
        ...this.#target(operation, cell),
        phase: "finalize",
        credentialVersion: cell.credentialVersion,
        nextCredential: this.#cellCredential(cell),
      });
      return this.#advance(operation, owner, "rotation-finalized");
    }
    if (operation.checkpoint === "rotation-finalized") {
      return this.#readiness(operation, owner, "rotation-confirmed");
    }
    if (operation.checkpoint === "rotation-confirmed") {
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #export(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    if (operation.checkpoint === "export-failure-resume") {
      return this.#recoverFailedExport(operation, owner);
    }
    if (operation.checkpoint === "export-expired-release") {
      const cell = await this.#cell(operation);
      if (!operation.exportReleaseEnvelope) {
        return this.#terminal(operation, owner, "EXPORT_RELEASE_REFERENCE_MISSING");
      }
      return this.#releaseExpiredExport(
        operation,
        owner,
        cell,
        decryptSecret(operation.exportReleaseEnvelope, { key: this.#envelopeKey })
      );
    }
    if (operation.checkpoint === "export-expired-released" && !operation.resumeAfterOperation) {
      this.#requireStored(await this.#store.markCellState(operation.id, owner, "quiesced"));
      this.#requireStored(await this.#store.completeExpiredExportRestoration(operation.id, owner));
      return { kind: "terminal", operationId: operation.id, code: "EXPORT_EXPIRED" };
    }
    if (operation.checkpoint === "export-expired-released") {
      const cell = await this.#cell(operation);
      await this.#provisioner.resume(this.#target(operation, cell));
      return this.#advance(operation, owner, "export-expired-resumed");
    }
    if (operation.checkpoint === "export-expired-resumed") {
      return this.#readiness(operation, owner, "export-expired-readiness-proved");
    }
    if (operation.checkpoint === "export-expired-readiness-proved") {
      this.#requireStored(await this.#store.activateAfterReadiness(operation.id, owner));
      this.#requireStored(await this.#store.completeExpiredExportRestoration(operation.id, owner));
      return { kind: "terminal", operationId: operation.id, code: "EXPORT_EXPIRED" };
    }
    if (operation.checkpoint === "created") {
      this.#requireStored(await this.#store.applyLocalGate(operation.id, owner, "suspended"));
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      const cell = await this.#cell(operation);
      await this.#provisioner.quiesce(this.#target(operation, cell));
      return this.#advance(operation, owner, "quiesced");
    }
    if (
      ["quiesced", "export-requested"].includes(operation.checkpoint) &&
      operation.exportReleaseEnvelope
    ) {
      const cell = await this.#cell(operation);
      const disposition = await this.#store.recoverRecordedExport(operation.id, owner);
      if (disposition === "missing") {
        return this.#terminal(operation, owner, "EXPORT_RECORD_CONFLICT");
      }
      if (disposition === "available") {
        return this.#advance(operation, owner, "export-stored");
      }
      this.#requireStored(await this.#store.prepareExpiredExportRelease(operation.id, owner));
      operation.checkpoint = "export-expired-release";
      return this.#releaseExpiredExport(
        operation,
        owner,
        cell,
        decryptSecret(operation.exportReleaseEnvelope, { key: this.#envelopeKey })
      );
    }
    if (operation.checkpoint === "quiesced") {
      const expiresAt =
        operation.exportExpiresAt ??
        new Date(operation.createdAt.getTime() + this.#config.exportTtlMs);
      if (
        expiresAt <= this.#now() &&
        operation.exportExpiresAt &&
        !operation.exportRequestStarted
      ) {
        if (!operation.resumeAfterOperation) {
          this.#requireStored(await this.#store.markCellState(operation.id, owner, "quiesced"));
        }
        return this.#terminal(operation, owner, "EXPORT_EXPIRED");
      }
      if (!operation.exportRequestStarted) {
        this.#requireStored(await this.#store.beginExport(operation.id, owner, expiresAt));
        operation.checkpoint = "export-requested";
        operation.exportExpiresAt = new Date(expiresAt);
        operation.exportRequestStarted = true;
      }
    }
    if (operation.checkpoint === "export-requested" && !operation.exportRequestStarted) {
      const expiresAt =
        operation.exportExpiresAt ??
        new Date(operation.createdAt.getTime() + this.#config.exportTtlMs);
      this.#requireStored(await this.#store.beginExport(operation.id, owner, expiresAt));
      operation.checkpoint = "export-requested";
      operation.exportExpiresAt = new Date(expiresAt);
      operation.exportRequestStarted = true;
    }
    if (["quiesced", "export-requested"].includes(operation.checkpoint)) {
      const cell = await this.#cell(operation);
      const expiresAt = operation.exportExpiresAt;
      if (!operation.exportRequestStarted || !expiresAt) {
        return this.#terminal(operation, owner, "EXPORT_REQUEST_INTENT_MISSING");
      }
      const result = await this.#provisioner.export({
        ...this.#target(operation, cell),
        expiresAt,
      });
      const disposition = await this.#store.recordExportResult({
        operationId: operation.id,
        owner,
        tenantId: operation.tenantId,
        cellId: cell.id,
        storageReferenceEnvelope: encryptSecret(result.exportRef, {
          key: this.#envelopeKey,
          randomBytes: this.#randomBytes,
        }),
        storageReferenceDigest: digestSecret(result.exportRef),
        releaseReferenceEnvelope: encryptSecret(result.releaseRef, {
          key: this.#envelopeKey,
          randomBytes: this.#randomBytes,
        }),
        releaseReferenceDigest: digestSecret(result.releaseRef),
        archiveSha256: result.archiveSha256,
        manifestSha256: result.manifestSha256,
        archiveSize: result.archiveSize,
        encryptionScheme: result.encryptionScheme,
        integrityVerified: result.integrityVerified,
        expiresAt,
      });
      if (disposition === "conflict") {
        return this.#terminal(operation, owner, "EXPORT_RECORD_CONFLICT");
      }
      if (disposition === "expired") {
        operation.checkpoint = "export-expired-release";
        return this.#releaseExpiredExport(
          operation,
          owner,
          cell,
          new SensitiveSecret(result.releaseRef)
        );
      }
      return this.#advance(operation, owner, "export-stored");
    }
    if (operation.checkpoint === "export-stored") {
      const cell = await this.#cell(operation);
      if (!operation.exportReleaseEnvelope) {
        return this.#terminal(operation, owner, "EXPORT_RELEASE_REFERENCE_MISSING");
      }
      await this.#provisioner.releaseExport({
        ...this.#targetForAction(operation, cell, "export-release"),
        releaseRef: decryptSecret(operation.exportReleaseEnvelope, {
          key: this.#envelopeKey,
        }),
      });
      const acknowledged = await this.#store.acknowledgeExportRelease(operation.id, owner);
      return acknowledged
        ? {
            kind: "advanced",
            operationId: operation.id,
            checkpoint: "cell-artifact-released",
          }
        : { kind: "idle" };
    }
    if (operation.checkpoint === "cell-artifact-released" && !operation.resumeAfterOperation) {
      this.#requireStored(await this.#store.markCellState(operation.id, owner, "quiesced"));
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    if (operation.checkpoint === "cell-artifact-released") {
      const cell = await this.#cell(operation);
      await this.#provisioner.resume(this.#target(operation, cell));
      return this.#advance(operation, owner, "resumed");
    }
    if (operation.checkpoint === "resumed") {
      return this.#readiness(operation, owner, "readiness-proved");
    }
    if (operation.checkpoint === "readiness-proved") {
      this.#requireStored(await this.#store.activateAfterReadiness(operation.id, owner));
      this.#requireStored(await this.#store.succeed(operation.id, owner));
      return { kind: "succeeded", operationId: operation.id };
    }
    return this.#terminal(operation, owner, "LIFECYCLE_CHECKPOINT_INVALID");
  }

  async #releaseExpiredExport(
    operation: LifecycleOperation,
    owner: string,
    cell: CellControlRecord,
    releaseRef: SensitiveSecret
  ): Promise<ReconcileResult> {
    await this.#provisioner.releaseExport({
      ...this.#targetForAction(operation, cell, "export-expired-release"),
      releaseRef,
    });
    const acknowledged = await this.#store.acknowledgeExpiredExportRelease(operation.id, owner);
    return acknowledged
      ? {
          kind: "advanced",
          operationId: operation.id,
          checkpoint: "export-expired-released",
        }
      : { kind: "idle" };
  }

  async #sealOrDelete(operation: LifecycleOperation, owner: string): Promise<ReconcileResult> {
    const deleting = operation.operationType === "delete";
    if (operation.checkpoint === "created") {
      this.#requireStored(
        await this.#store.applyLocalGate(operation.id, owner, deleting ? "deleted" : "suspended")
      );
      return this.#advance(operation, owner, "local-gated");
    }
    if (operation.checkpoint === "local-gated") {
      if (deleting && !operation.cellId) {
        return this.#advance(operation, owner, "quiesced");
      }
      const cell = await this.#cell(operation);
      await this.#provisioner.quiesce(this.#target(operation, cell));
      return this.#advance(operation, owner, "quiesced");
    }
    if (operation.checkpoint === "quiesced") {
      if (deleting) {
        const proof = await this.#terminateBilling(operation.tenantId);
        if (!proof) {
          throw new ProvisionerFailure({
            code: "BILLING_TERMINATION_UNAVAILABLE",
            retryable: true,
          });
        }
        const advanced = await this.#store.advanceBillingTerminated({
          operationId: operation.id,
          owner,
          proof,
        });
        if (!advanced) {
          throw new ProvisionerFailure({
            code: "BILLING_TERMINATION_UNAVAILABLE",
            retryable: true,
          });
        }
        return {
          kind: "advanced",
          operationId: operation.id,
          checkpoint: "billing-quiesced",
        };
      }
      const cell = await this.#cell(operation);
      await this.#provisioner.seal(this.#target(operation, cell));
      return this.#advance(operation, owner, "sealed");
    }
    if (operation.checkpoint === "billing-terminated") {
      if (!operation.cellId) {
        await this.#provisioner.destroy(this.#tenantDestroyTarget(operation));
        return this.#advance(operation, owner, "destroyed");
      }
      const cell = await this.#cell(operation);
      await this.#provisioner.quiesce(this.#target(operation, cell));
      return this.#advance(operation, owner, "billing-quiesced");
    }
    if (operation.checkpoint === "billing-quiesced") {
      if (!operation.cellId) {
        await this.#provisioner.destroy(this.#tenantDestroyTarget(operation));
        return this.#advance(operation, owner, "destroyed");
      }
      const cell = await this.#cell(operation);
      await this.#provisioner.seal(this.#target(operation, cell));
      return this.#advance(operation, owner, "sealed");
    }
    if (operation.checkpoint === "sealed" && deleting) {
      await this.#provisioner.destroy(this.#tenantDestroyTarget(operation));
      return this.#advance(operation, owner, "destroyed");
    }
    if (operation.checkpoint === "sealed" || operation.checkpoint === "destroyed") {
      this.#requireStored(
        await this.#store.markCellState(operation.id, owner, deleting ? "deleted" : "sealed")
      );
      this.#requireStored(await this.#store.succeed(operation.id, owner));
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
    const initialRecoveryCode = mandatoryRecoveryCode(operation);
    if (operation.attempts > this.#config.maxAttempts && !initialRecoveryCode) {
      return this.#terminal(operation, input.owner, "LIFECYCLE_MAX_ATTEMPTS");
    }
    try {
      this.#requireStored(
        await this.#store.renewLease(operation.id, input.owner, this.#config.leaseMs)
      );
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
      if (error instanceof ProvisionerPending) {
        if (
          error.operationId !== operation.id ||
          !pendingCheckpointMatches(operation, error.checkpoint) ||
          !Number.isInteger(error.retryAfterSeconds) ||
          error.retryAfterSeconds < 1 ||
          error.retryAfterSeconds > 300
        ) {
          return this.#terminal(operation, input.owner, "PROVISIONER_RESPONSE_INVALID");
        }
        const waiting = await this.#store.waitForProvider(
          operation.id,
          input.owner,
          operation.checkpoint,
          new Date(this.#now().getTime() + error.retryAfterSeconds * 1_000)
        );
        return waiting
          ? {
              kind: "retry_scheduled",
              operationId: operation.id,
              code: "PROVISIONER_PENDING",
            }
          : { kind: "idle" };
      }
      const failure =
        error instanceof ProvisionerFailure
          ? error
          : new ProvisionerFailure({
              code: "PROVISIONER_UNAVAILABLE",
              retryable: true,
              cause: error,
            });
      if (
        operation.operationType === "export" &&
        ["quiesced", "export-requested"].includes(operation.checkpoint) &&
        operation.exportRequestStarted &&
        operation.exportExpiresAt !== null &&
        operation.exportExpiresAt <= this.#now() &&
        failure.code === "EXPORT_REQUEST_EXPIRED" &&
        !failure.retryable
      ) {
        if (!operation.resumeAfterOperation) {
          this.#requireStored(
            await this.#store.markCellState(operation.id, input.owner, "quiesced")
          );
        }
        return this.#terminal(operation, input.owner, "EXPORT_EXPIRED");
      }
      const recoveryCode = mandatoryRecoveryCode(operation);
      if (recoveryCode) {
        const retried = await this.#store.retry(
          operation.id,
          input.owner,
          recoveryCode,
          this.#backoff(operation.attempts)
        );
        return retried
          ? { kind: "retry_scheduled", operationId: operation.id, code: recoveryCode }
          : { kind: "idle" };
      }
      if (!failure.retryable) return this.#terminal(operation, input.owner, failure.code);
      if (operation.attempts >= this.#config.maxAttempts) {
        return this.#terminal(operation, input.owner, "LIFECYCLE_MAX_ATTEMPTS");
      }
      const retried = await this.#store.retry(
        operation.id,
        input.owner,
        failure.code,
        this.#backoff(operation.attempts)
      );
      return retried
        ? {
            kind: "retry_scheduled",
            operationId: operation.id,
            code: failure.code,
          }
        : { kind: "idle" };
    }
  }
}

function copyOperation(operation: LifecycleOperation): LifecycleOperation {
  return {
    ...operation,
    inputReferenceEnvelope: operation.inputReferenceEnvelope
      ? structuredClone(operation.inputReferenceEnvelope)
      : null,
    inputReferenceDigest: operation.inputReferenceDigest
      ? Buffer.from(operation.inputReferenceDigest)
      : null,
    exportReleaseEnvelope: operation.exportReleaseEnvelope
      ? structuredClone(operation.exportReleaseEnvelope)
      : null,
    exportReleaseDigest: operation.exportReleaseDigest
      ? Buffer.from(operation.exportReleaseDigest)
      : null,
    exportExpiresAt: operation.exportExpiresAt ? new Date(operation.exportExpiresAt) : null,
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
  readonly exports = new Map<
    string,
    {
      id: string;
      tenantId: string;
      cellId: string;
      storageReferenceEnvelope: SecretEnvelope | null;
      storageReferenceDigest: Buffer;
      archiveSha256: string;
      manifestSha256: string;
      archiveSize: number;
      expiresAt: Date;
    }
  >();
  readonly checkpointHistory: Array<{ operationId: string; checkpoint: string }> = [];
  readonly #now: () => Date;

  constructor(input: { now?: () => Date } = {}) {
    this.#now = input.now ?? (() => new Date());
  }

  #owned(operationId: string, owner: string): LifecycleOperation | null {
    const operation = this.operations.get(operationId);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const now = this.#now();
    return operation &&
      tenant?.fenceGeneration === operation.fenceGeneration &&
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
    cellId: string | null = null,
    options: LifecycleEnqueueOptions = {}
  ): Promise<LifecycleOperation> {
    const existing = [...this.operations.values()].find(
      (operation) =>
        operation.tenantId === tenantId &&
        operation.operationType === operationType &&
        operation.idempotencyKey === idempotencyKey
    );
    if (existing) {
      const incomingDigest = options.inputReferenceDigest ?? null;
      const sameDigest =
        existing.inputReferenceDigest === null
          ? incomingDigest === null
          : incomingDigest !== null && existing.inputReferenceDigest.equals(incomingDigest);
      const binding = options.restoreBinding;
      if (
        !sameDigest ||
        existing.inputSourceCellId !== (binding?.sourceCellId ?? null) ||
        existing.inputExportId !== (binding?.exportId ?? null) ||
        existing.inputArchiveSha256 !== (binding?.archiveSha256 ?? null) ||
        existing.inputManifestSha256 !== (binding?.manifestSha256 ?? null) ||
        existing.inputArchiveSize !== (binding?.archiveSize ?? null)
      ) {
        throw exomemErrors.idempotencyConflict();
      }
      return copyOperation(existing);
    }
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, {
        id: tenantId,
        status: "provisioning",
        desiredState: "running",
        boundCellId: null,
        fenceGeneration: 1,
      });
    }
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new Error("tenant initialization failed");
    if (operationType === "delete") {
      tenant.fenceGeneration += 1;
      tenant.status = "deletion_pending";
      tenant.desiredState = "deleted";
      for (const pending of this.operations.values()) {
        if (
          pending.tenantId === tenantId &&
          pending.fenceGeneration < tenant.fenceGeneration &&
          !["succeeded", "failed_terminal"].includes(pending.state) &&
          !(
            pending.state === "running" &&
            pending.leaseExpiresAt &&
            pending.leaseExpiresAt > this.#now()
          )
        ) {
          pending.state = "failed_terminal";
          pending.errorCode = "DELETION_SUPERSEDED";
          pending.leaseOwner = null;
          pending.leaseExpiresAt = null;
          pending.updatedAt = this.#now();
        }
      }
    }
    const now = this.#now();
    const operation: LifecycleOperation = {
      id: randomUUID(),
      tenantId,
      cellId,
      operationType,
      state: "pending",
      idempotencyKey,
      fenceGeneration: tenant.fenceGeneration,
      checkpoint: "created",
      requestId: randomUUID(),
      attempts: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
      providerResultRef: null,
      inputReferenceEnvelope: options.inputReferenceEnvelope
        ? structuredClone(options.inputReferenceEnvelope)
        : null,
      inputReferenceDigest: options.inputReferenceDigest
        ? Buffer.from(options.inputReferenceDigest)
        : null,
      inputExportId: options.restoreBinding?.exportId ?? null,
      exportReleaseEnvelope: null,
      exportReleaseDigest: null,
      exportExpiresAt:
        operationType === "export"
          ? new Date(now.getTime() + (options.exportTtlMs ?? 24 * 60 * 60 * 1000))
          : null,
      exportRequestStarted: false,
      inputSourceCellId: options.restoreBinding?.sourceCellId ?? null,
      inputArchiveSha256: options.restoreBinding?.archiveSha256 ?? null,
      inputManifestSha256: options.restoreBinding?.manifestSha256 ?? null,
      inputArchiveSize: options.restoreBinding?.archiveSize ?? null,
      resumeAfterOperation: operationType === "export" ? tenant.desiredState === "running" : true,
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
    for (const stale of this.operations.values()) {
      const tenant = this.tenants.get(stale.tenantId);
      if (
        tenant?.desiredState === "deleted" &&
        stale.fenceGeneration < tenant.fenceGeneration &&
        !["succeeded", "failed_terminal"].includes(stale.state) &&
        !(stale.state === "running" && stale.leaseExpiresAt && stale.leaseExpiresAt > now)
      ) {
        stale.state = "failed_terminal";
        stale.errorCode = "DELETION_SUPERSEDED";
        stale.leaseOwner = null;
        stale.leaseExpiresAt = null;
        stale.updatedAt = now;
      }
    }
    const candidate = [...this.operations.values()]
      .filter(
        (operation) =>
          (!input.tenantId || operation.tenantId === input.tenantId) &&
          operation.fenceGeneration === this.tenants.get(operation.tenantId)?.fenceGeneration &&
          (operation.attempts <= input.maxAttempts ||
            [
              "candidate-cleanup",
              "export-failure-resume",
              "export-requested",
              "export-stored",
              "export-expired-release",
              "export-expired-released",
              "export-expired-resumed",
              "export-expired-readiness-proved",
              "prior-retirement",
              "prior-retired",
            ].includes(operation.checkpoint) ||
            (operation.operationType === "export" &&
              operation.checkpoint === "quiesced" &&
              (operation.exportRequestStarted || operation.exportReleaseEnvelope))) &&
          (operation.operationType === "delete" ||
            this.tenants.get(operation.tenantId)?.desiredState !== "deleted") &&
          ![...this.operations.values()].some(
            (blocker) =>
              blocker.tenantId === operation.tenantId &&
              blocker.id !== operation.id &&
              !["succeeded", "failed_terminal"].includes(blocker.state) &&
              (blocker.fenceGeneration === this.tenants.get(operation.tenantId)?.fenceGeneration ||
                (operation.operationType === "delete" &&
                  blocker.state === "running" &&
                  Boolean(blocker.leaseExpiresAt && blocker.leaseExpiresAt > now))) &&
              ((operation.operationType === "delete" &&
                blocker.state === "running" &&
                Boolean(blocker.leaseExpiresAt && blocker.leaseExpiresAt > now) &&
                blocker.fenceGeneration <
                  (this.tenants.get(operation.tenantId)?.fenceGeneration ?? 0)) ||
                blocker.operationType === "delete" ||
                blocker.createdAt < operation.createdAt ||
                (blocker.createdAt.getTime() === operation.createdAt.getTime() &&
                  blocker.id < operation.id))
          ) &&
          operation.nextAttemptAt <= now &&
          (["pending", "waiting", "failed_retryable"].includes(operation.state) ||
            (operation.state === "running" &&
              (!operation.leaseExpiresAt || operation.leaseExpiresAt <= now)))
      )
      .sort((left, right) => {
        if (left.operationType === "delete" && right.operationType !== "delete") return -1;
        if (right.operationType === "delete" && left.operationType !== "delete") return 1;
        return left.createdAt.getTime() - right.createdAt.getTime();
      })[0];
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
    operation.attempts = 0;
    operation.errorCode = null;
    operation.nextAttemptAt = this.#now();
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    this.checkpointHistory.push({ operationId, checkpoint: nextCheckpoint });
    return true;
  }

  async beginExport(operationId: string, owner: string, expiresAt: Date): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (
      !operation ||
      operation.operationType !== "export" ||
      !["quiesced", "export-requested"].includes(operation.checkpoint) ||
      operation.exportReleaseEnvelope ||
      !Number.isFinite(expiresAt.getTime()) ||
      (operation.exportExpiresAt !== null &&
        operation.exportExpiresAt.getTime() !== expiresAt.getTime())
    ) {
      return false;
    }
    operation.exportExpiresAt ??= new Date(expiresAt);
    operation.exportRequestStarted = true;
    operation.checkpoint = "export-requested";
    operation.updatedAt = this.#now();
    return true;
  }

  async recoverRecordedExport(
    operationId: string,
    owner: string
  ): Promise<ExportRecordDisposition | "missing"> {
    const operation = this.#owned(operationId, owner);
    const record = this.exports.get(operationId);
    if (
      !operation ||
      operation.operationType !== "export" ||
      !["quiesced", "export-requested"].includes(operation.checkpoint) ||
      !operation.exportReleaseEnvelope ||
      !record ||
      record.tenantId !== operation.tenantId ||
      record.cellId !== operation.cellId
    ) {
      return "missing";
    }
    operation.exportExpiresAt = new Date(record.expiresAt);
    operation.exportRequestStarted = true;
    const disposition = record.expiresAt > this.#now() ? "available" : "expired";
    operation.updatedAt = this.#now();
    return disposition;
  }

  async advanceBillingTerminated(input: {
    operationId: string;
    owner: string;
    proof: BillingDeletionTarget;
  }): Promise<boolean> {
    const operation = this.#owned(input.operationId, input.owner);
    if (
      !operation ||
      operation.operationType !== "delete" ||
      operation.checkpoint !== "quiesced" ||
      operation.tenantId !== input.proof.tenantId
    ) {
      return false;
    }
    return this.advance(input.operationId, input.owner, "quiesced", "billing-quiesced");
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
    if (!["candidate-cleanup", "export-failure-resume"].includes(operation.checkpoint)) {
      operation.errorCode = errorCode;
    }
    operation.nextAttemptAt = nextAttemptAt;
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    return true;
  }

  async waitForProvider(
    operationId: string,
    owner: string,
    expectedCheckpoint: string,
    nextAttemptAt: Date
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (!operation || operation.checkpoint !== expectedCheckpoint) return false;
    operation.state = "waiting";
    operation.attempts = Math.max(0, operation.attempts - 1);
    operation.errorCode = null;
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
    if (tenant.desiredState === "deleted") return null;
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
      tenant.desiredState === "deleted" ||
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

  async prepareCandidateCleanup(
    operationId: string,
    owner: string,
    errorCode: string
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const candidate = operation?.cellId ? this.cells.get(operation.cellId) : null;
    if (
      !operation ||
      !tenant ||
      !candidate ||
      !["provision", "restore"].includes(operation.operationType) ||
      candidate.routingState !== "unbound" ||
      tenant.boundCellId === candidate.id
    ) {
      return false;
    }
    operation.checkpoint = "candidate-cleanup";
    operation.state = "waiting";
    operation.attempts = 0;
    operation.errorCode = errorCode;
    operation.nextAttemptAt = this.#now();
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    this.checkpointHistory.push({ operationId, checkpoint: "candidate-cleanup" });
    return true;
  }

  async prepareExportRecovery(
    operationId: string,
    owner: string,
    errorCode: string
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (
      !operation ||
      operation.operationType !== "export" ||
      !operation.resumeAfterOperation ||
      operation.checkpoint === "created"
    ) {
      return false;
    }
    operation.checkpoint = "export-failure-resume";
    operation.state = "waiting";
    operation.attempts = 0;
    operation.errorCode = errorCode;
    operation.nextAttemptAt = this.#now();
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    this.checkpointHistory.push({ operationId, checkpoint: "export-failure-resume" });
    return true;
  }

  async markUnboundCellDestroyed(
    operationId: string,
    owner: string,
    cellId: string
  ): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const cell = this.cells.get(cellId);
    if (
      !operation ||
      !tenant ||
      !cell ||
      cell.tenantId !== operation.tenantId ||
      cell.routingState === "bound" ||
      tenant.boundCellId === cell.id
    ) {
      return false;
    }
    cell.lifecycleState = "deleted";
    cell.routingState = "retiring";
    cell.desiredState = "deleted";
    cell.providerRef = null;
    cell.endpointEnvelope = null;
    cell.credentialEnvelope = null;
    cell.credentialDigest = null;
    cell.pendingCredentialEnvelope = null;
    cell.pendingCredentialDigest = null;
    cell.pendingCredentialVersion = null;
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

  async recordExportResult(input: {
    operationId: string;
    owner: string;
    tenantId: string;
    cellId: string;
    storageReferenceEnvelope: SecretEnvelope;
    storageReferenceDigest: Buffer;
    releaseReferenceEnvelope: SecretEnvelope;
    releaseReferenceDigest: Buffer;
    archiveSha256: string;
    manifestSha256: string;
    archiveSize: number;
    encryptionScheme: "envelope-aes-256-gcm";
    integrityVerified: true;
    expiresAt: Date;
  }): Promise<ExportRecordDisposition> {
    const operation = this.#owned(input.operationId, input.owner);
    if (
      !operation ||
      operation.operationType !== "export" ||
      operation.tenantId !== input.tenantId ||
      operation.cellId !== input.cellId ||
      !["quiesced", "export-requested"].includes(operation.checkpoint) ||
      !operation.exportRequestStarted ||
      operation.exportExpiresAt?.getTime() !== input.expiresAt.getTime()
    ) {
      return "conflict";
    }
    const existing = this.exports.get(input.operationId);
    if (existing) {
      const matches =
        existing.storageReferenceDigest.equals(input.storageReferenceDigest) &&
        existing.archiveSha256 === input.archiveSha256 &&
        existing.manifestSha256 === input.manifestSha256 &&
        existing.archiveSize === input.archiveSize &&
        existing.expiresAt.getTime() === input.expiresAt.getTime();
      if (!matches) return "conflict";
      if (input.expiresAt <= this.#now()) {
        operation.checkpoint = "export-expired-release";
        return "expired";
      }
      return "available";
    }
    this.exports.set(input.operationId, {
      id: randomUUID(),
      tenantId: input.tenantId,
      cellId: input.cellId,
      storageReferenceEnvelope: structuredClone(input.storageReferenceEnvelope),
      storageReferenceDigest: Buffer.from(input.storageReferenceDigest),
      archiveSha256: input.archiveSha256,
      manifestSha256: input.manifestSha256,
      archiveSize: input.archiveSize,
      expiresAt: new Date(input.expiresAt),
    });
    operation.exportReleaseEnvelope = structuredClone(input.releaseReferenceEnvelope);
    operation.exportReleaseDigest = Buffer.from(input.releaseReferenceDigest);
    if (input.expiresAt <= this.#now()) {
      operation.checkpoint = "export-expired-release";
      this.checkpointHistory.push({
        operationId: input.operationId,
        checkpoint: "export-expired-release",
      });
      return "expired";
    }
    return "available";
  }

  async acknowledgeExportRelease(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (
      !operation ||
      operation.operationType !== "export" ||
      operation.checkpoint !== "export-stored"
    ) {
      return false;
    }
    operation.exportReleaseEnvelope = null;
    operation.exportReleaseDigest = null;
    operation.checkpoint = "cell-artifact-released";
    operation.state = "waiting";
    operation.attempts = 0;
    operation.errorCode = null;
    operation.nextAttemptAt = this.#now();
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    this.checkpointHistory.push({ operationId, checkpoint: "cell-artifact-released" });
    return true;
  }

  async prepareExpiredExportRelease(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (
      !operation ||
      operation.operationType !== "export" ||
      !["quiesced", "export-requested"].includes(operation.checkpoint) ||
      !operation.exportReleaseEnvelope
    ) {
      return false;
    }
    operation.checkpoint = "export-expired-release";
    operation.updatedAt = this.#now();
    this.checkpointHistory.push({ operationId, checkpoint: "export-expired-release" });
    return true;
  }

  async acknowledgeExpiredExportRelease(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    if (
      !operation ||
      operation.operationType !== "export" ||
      operation.checkpoint !== "export-expired-release" ||
      !operation.exportReleaseEnvelope
    ) {
      return false;
    }
    operation.exportReleaseEnvelope = null;
    operation.exportReleaseDigest = null;
    operation.checkpoint = "export-expired-released";
    operation.state = "waiting";
    operation.attempts = 0;
    operation.errorCode = null;
    operation.nextAttemptAt = this.#now();
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
    this.checkpointHistory.push({ operationId, checkpoint: "export-expired-released" });
    return true;
  }

  async completeExpiredExportRestoration(operationId: string, owner: string): Promise<boolean> {
    const operation = this.#owned(operationId, owner);
    const tenant = operation ? this.tenants.get(operation.tenantId) : null;
    const cell = operation?.cellId ? this.cells.get(operation.cellId) : null;
    const suspendedRestored =
      operation?.resumeAfterOperation === false &&
      operation.checkpoint === "export-expired-released" &&
      tenant?.status === "suspended" &&
      cell?.lifecycleState === "quiesced";
    const runningRestored =
      operation?.resumeAfterOperation === true &&
      operation.checkpoint === "export-expired-readiness-proved" &&
      tenant?.status === "active" &&
      tenant.desiredState === "running" &&
      cell?.lifecycleState === "active" &&
      cell.desiredState === "running" &&
      cell.readinessCode === "CELL_READY";
    if (
      !operation ||
      operation.operationType !== "export" ||
      operation.exportReleaseEnvelope ||
      operation.exportReleaseDigest ||
      (!suspendedRestored && !runningRestored)
    ) {
      return false;
    }
    operation.state = "failed_terminal";
    operation.errorCode = "EXPORT_EXPIRED";
    operation.leaseOwner = null;
    operation.leaseExpiresAt = null;
    operation.updatedAt = this.#now();
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
    if (
      !operation ||
      !tenant ||
      (desired !== "deleted" && (!cell || tenant.boundCellId !== cell.id)) ||
      (desired !== "deleted" && tenant.desiredState === "deleted")
    ) {
      return false;
    }
    tenant.desiredState = desired;
    tenant.status = desired === "deleted" ? "deletion_pending" : "suspended";
    if (cell) {
      cell.lifecycleState = "draining";
      cell.desiredState =
        desired === "deleted" ? "deleted" : desired === "running" ? "running" : "quiesced";
    }
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
    if (!operation || !tenant || (!cell && state !== "deleted")) return false;
    if (cell) cell.lifecycleState = state;
    if (state === "deleted") {
      for (const tenantCell of this.cells.values()) {
        if (tenantCell.tenantId !== operation.tenantId) continue;
        tenantCell.lifecycleState = "deleted";
        tenantCell.routingState = "retiring";
        tenantCell.desiredState = "deleted";
        tenantCell.providerRef = null;
        tenantCell.endpointEnvelope = null;
        tenantCell.credentialEnvelope = null;
        tenantCell.credentialDigest = null;
        tenantCell.pendingCredentialEnvelope = null;
        tenantCell.pendingCredentialDigest = null;
        tenantCell.pendingCredentialVersion = null;
        tenantCell.readinessCode = "TENANT_DESTROYED";
      }
      for (const exportRow of this.exports.values()) {
        if (exportRow.tenantId === operation.tenantId) {
          exportRow.storageReferenceEnvelope = null;
        }
      }
      for (const tenantOperation of this.operations.values()) {
        if (tenantOperation.tenantId === operation.tenantId) {
          tenantOperation.inputReferenceEnvelope = null;
          tenantOperation.providerResultRef = null;
          tenantOperation.exportReleaseEnvelope = null;
          tenantOperation.exportReleaseDigest = null;
        }
      }
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
    if (
      !operation ||
      !tenant ||
      !cell ||
      tenant.boundCellId !== cell.id ||
      tenant.desiredState === "deleted"
    ) {
      return false;
    }
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
    if (
      tenant.status === "active" &&
      cell?.lifecycleState === "active" &&
      cell.readinessCode === "CELL_READY"
    ) {
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
      if (
        operation.tenantId === tenantId &&
        ["failed_retryable", "waiting"].includes(operation.state)
      ) {
        operation.nextAttemptAt = this.#now();
      }
    }
  }
}
