import { timingSafeEqual } from "node:crypto";
import type { CellControlRecord, LifecycleOperation } from "./reconciler";
import { executeExomemSql, type ExomemSql } from "./db";
import {
  HttpCellProvisioner,
  PROVISIONER_PROTOCOL_V2,
  provisionerConfigFromEnv,
  type CellProvisioner,
  type CellReadiness,
  type CellTargetRequest,
  type CellWorkerPolicy,
} from "./provisioner";
import { routableSetDigest, type RoutableCellIdentity } from "./routable-authority";
import {
  controlPlaneKeyFromEnv,
  decryptSecret,
  digestSecret,
  type SecretEnvelope,
} from "./security";

const EXOMEM_HOSTED_PROFILE = "hosted-alpha-agent-v1";
let testProvisioner: Pick<CellProvisioner, "health"> | null = null;

/** Abort the enclosing promotion transaction after a post-write authority fence misses. */
export class PromotionRuntimePreconditionError extends Error {
  constructor() {
    super("promotion runtime authority precondition failed");
  }
}

export function __setPromotionProvisionerForTests(
  provisioner: Pick<CellProvisioner, "health"> | null
): void {
  testProvisioner = provisioner;
}

function sameWorkerPolicy(left: CellWorkerPolicy, right: CellWorkerPolicy): boolean {
  return (
    left.workerCount === right.workerCount &&
    left.semantic === right.semantic &&
    left.media === right.media
  );
}

/** Shared strict outer-v2 identity comparison for lifecycle reconciliation and promotion. */
export function strictOuterV2ReadinessMismatch(
  readiness: CellReadiness,
  cell: CellControlRecord,
  operation: LifecycleOperation,
  expectedWorkerPolicy: CellWorkerPolicy = cell.workerPolicy
): boolean {
  const target = operation.target;
  return (
    operation.provisionerWireProtocol !== PROVISIONER_PROTOCOL_V2 ||
    !target ||
    readiness.cellId !== cell.id ||
    readiness.protocolVersion !== target.protocolVersion ||
    readiness.releaseVersion !== target.sourceRelease ||
    (readiness.live && readiness.ready && readiness.code !== "CELL_READY") ||
    !readiness.serviceAuthenticated ||
    !readiness.mutationAuthority ||
    !readiness.readAdmission ||
    !readiness.writeAdmission ||
    !sameWorkerPolicy(readiness.workerPolicy, expectedWorkerPolicy) ||
    !readiness.runtimeIdentity ||
    readiness.runtimeIdentity.releaseVersion !== target.sourceRelease ||
    readiness.runtimeIdentity.protocolVersion !== target.protocolVersion ||
    readiness.runtimeIdentity.agentProfile !== EXOMEM_HOSTED_PROFILE ||
    readiness.runtimeIdentity.gatewayContractDigest !== target.gatewayContractDigest ||
    readiness.runtimeIdentity.commandFingerprint !== target.commandFingerprint ||
    readiness.runtimeIdentity.schemaDigest !== target.schemaDigest ||
    readiness.runtimeIdentity.compatibilityDigest !== target.compatibilityDigest
  );
}

/** Build the exact persisted outer-v2 health request; promotion has no caller-controlled target. */
export function promotionHealthTarget(input: {
  operation: LifecycleOperation;
  cell: CellControlRecord;
  envelopeKey?: Buffer;
}): CellTargetRequest | null {
  const { operation, cell } = input;
  const target = operation.target;
  if (
    operation.provisionerWireProtocol !== PROVISIONER_PROTOCOL_V2 ||
    !target ||
    !cell.providerRef ||
    !cell.credentialEnvelope ||
    !cell.credentialDigest ||
    cell.credentialDigest.length !== 32
  )
    return null;
  const serviceCredential = decryptSecret(cell.credentialEnvelope, { key: input.envelopeKey });
  if (!timingSafeEqual(digestSecret(serviceCredential.reveal()), cell.credentialDigest))
    return null;
  return {
    context: {
      operationId: operation.id,
      checkpoint: "promote-cohort-health",
      idempotencyKey: `${operation.id}:promote-cohort-health:${cell.id}`,
      fenceGeneration: operation.fenceGeneration,
    },
    tenantId: operation.tenantId,
    cellId: cell.id,
    protocolVersion: cell.protocolVersion,
    releaseVersion: cell.releaseVersion,
    serviceCredential,
    workerPolicy: cell.workerPolicy,
    provisionerWireProtocol: PROVISIONER_PROTOCOL_V2,
    runtimeTarget: {
      releaseVersion: target.sourceRelease,
      protocolVersion: target.protocolVersion,
      agentProfile: EXOMEM_HOSTED_PROFILE,
      gatewayContractDigest: target.gatewayContractDigest,
      commandFingerprint: target.commandFingerprint,
      schemaDigest: target.schemaDigest,
      compatibilityDigest: target.compatibilityDigest,
    },
    providerRef: cell.providerRef,
  };
}

export type PromotionProbe = {
  route: RoutableCellIdentity;
  cell: CellControlRecord;
  operation: LifecycleOperation;
  readiness: CellReadiness;
};

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return object(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asWorkerPolicy(value: unknown): CellWorkerPolicy | null {
  const policy = object(value);
  return policy &&
    Number.isSafeInteger(policy.workerCount) &&
    typeof policy.semantic === "boolean" &&
    typeof policy.media === "boolean"
    ? {
        workerCount: Number(policy.workerCount),
        semantic: policy.semantic,
        media: policy.media,
      }
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buffer(value: unknown): Buffer | null {
  if (value === null) return null;
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex");
  return null;
}

function operationFromRow(row: Record<string, unknown>): LifecycleOperation | null {
  const targetFields = [
    "target_candidate_id",
    "target_assignment_id",
    "target_assignment_generation",
    "target_source_release",
    "target_protocol_version",
    "target_gateway_contract_digest",
    "target_command_fingerprint",
    "target_schema_digest",
    "target_compatibility_digest",
    "operation_id",
    "operation_tenant_id",
    "operation_fence_generation",
  ] as const;
  if (targetFields.some((field) => string(row[field]) === null)) return null;
  const fenceGeneration = Number(row.operation_fence_generation);
  const assignmentGeneration = Number(row.target_assignment_generation);
  if (
    !Number.isSafeInteger(fenceGeneration) ||
    fenceGeneration < 1 ||
    !Number.isSafeInteger(assignmentGeneration) ||
    assignmentGeneration < 1
  )
    return null;
  const operationType = String(row.operation_type) as LifecycleOperation["operationType"];
  return {
    id: String(row.operation_id),
    tenantId: String(row.operation_tenant_id),
    cellId: string(row.cell_id),
    operationType,
    provisionerWireProtocol: PROVISIONER_PROTOCOL_V2,
    state: "succeeded",
    idempotencyKey: `promotion-runtime:${String(row.operation_id)}`,
    fenceGeneration,
    checkpoint: operationType === "rollforward" ? "complete" : "bound",
    requestId: "promotion-runtime",
    attempts: 0,
    nextAttemptAt: new Date(0),
    leaseOwner: null,
    leaseExpiresAt: null,
    errorCode: null,
    providerResultRef: null,
    inputReferenceEnvelope: null,
    inputReferenceDigest: null,
    inputExportId: null,
    exportReleaseEnvelope: null,
    exportReleaseDigest: null,
    exportExpiresAt: null,
    exportRequestStarted: false,
    inputSourceCellId: null,
    inputArchiveSha256: null,
    inputManifestSha256: null,
    inputArchiveSize: null,
    resumeAfterOperation: true,
    expectedPreviousCellId: null,
    target: {
      candidateId: String(row.target_candidate_id),
      assignmentId: String(row.target_assignment_id),
      assignmentGeneration,
      sourceRelease: String(row.target_source_release),
      protocolVersion: String(row.target_protocol_version),
      gatewayContractDigest: String(row.target_gateway_contract_digest),
      commandFingerprint: String(row.target_command_fingerprint),
      schemaDigest: String(row.target_schema_digest),
      compatibilityDigest: String(row.target_compatibility_digest),
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function probeFromRow(row: Record<string, unknown>): Omit<PromotionProbe, "readiness"> | null {
  const workerPolicy = asWorkerPolicy(row.worker_policy);
  const credentialEnvelope = object(row.service_credential_ciphertext) as SecretEnvelope | null;
  const operation = operationFromRow(row);
  const cellId = string(row.cell_id);
  const tenantId = string(row.cell_tenant_id);
  const providerRef = string(row.provider_ref);
  const protocolVersion = string(row.cell_protocol_version);
  const releaseVersion = string(row.cell_release_version);
  const sourceRelease = string(row.source_release);
  const routeProtocolVersion = string(row.protocol_version);
  const commandFingerprint = string(row.command_fingerprint);
  const contractDigest = string(row.contract_digest);
  const compatibilityDigest = string(row.compatibility_digest);
  const credentialDigest = buffer(row.service_credential_digest);
  if (
    !workerPolicy ||
    !credentialEnvelope ||
    !operation ||
    !cellId ||
    !tenantId ||
    !providerRef ||
    !protocolVersion ||
    !releaseVersion ||
    !sourceRelease ||
    !routeProtocolVersion ||
    !commandFingerprint ||
    !contractDigest ||
    !compatibilityDigest ||
    credentialDigest === null
  )
    return null;
  return {
    route: {
      cell_id: cellId,
      source_release: sourceRelease,
      protocol_version: routeProtocolVersion,
      command_fingerprint: commandFingerprint,
      contract_digest: contractDigest,
      compatibility_digest: compatibilityDigest,
    },
    cell: {
      id: cellId,
      tenantId,
      lifecycleState: "active",
      routingState: "bound",
      desiredState: "running",
      protocolVersion,
      releaseVersion,
      workerPolicy,
      providerRef,
      endpointEnvelope: null,
      credentialEnvelope,
      credentialDigest,
      credentialVersion: Number(row.credential_version ?? 0),
      pendingCredentialEnvelope: null,
      pendingCredentialDigest: null,
      pendingCredentialVersion: null,
      readinessCode: "CELL_READY",
    },
    operation,
  };
}

async function loadPromotionProbes(
  candidateId: string
): Promise<Array<Omit<PromotionProbe, "readiness">> | null> {
  const { rows } = await executeExomemSql`
    /* exomem:load-promotion-runtime-probes */
    SELECT route.cell_id::text AS cell_id, route.source_release, route.protocol_version,
           route.command_fingerprint, route.contract_digest, route.compatibility_digest,
           cell.tenant_id::text AS cell_tenant_id, cell.provider_ref, cell.protocol_version AS cell_protocol_version,
           cell.release_version AS cell_release_version, cell.worker_policy,
           cell.service_credential_ciphertext, cell.service_credential_digest, cell.credential_version,
           operation.id::text AS operation_id, operation.tenant_id::text AS operation_tenant_id,
           operation.operation_type, operation.fence_generation AS operation_fence_generation,
           operation.target_candidate_id::text, operation.target_assignment_id::text,
           operation.target_assignment_generation, operation.target_source_release,
           operation.target_protocol_version, operation.target_gateway_contract_digest,
           operation.target_command_fingerprint, operation.target_schema_digest,
           operation.target_compatibility_digest
    FROM exomem_routable_cell_contracts AS route
    JOIN exomem_cells AS cell ON cell.id = route.cell_id
    JOIN exomem_tenants AS tenant
      ON tenant.id = cell.tenant_id AND tenant.bound_cell_id = cell.id
    LEFT JOIN LATERAL (
      SELECT operation.*
      FROM exomem_lifecycle_operations AS operation
      WHERE operation.cell_id = route.cell_id
        AND operation.tenant_id = cell.tenant_id
        AND operation.fence_generation = tenant.fence_generation
        AND operation.state = 'succeeded'
        AND (
          (operation.operation_type IN ('provision', 'restore') AND operation.checkpoint = 'bound')
          OR (operation.operation_type = 'rollforward' AND operation.checkpoint = 'complete')
        )
        AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
        AND operation.target_candidate_id = ${candidateId}::uuid
        AND route.source_release = operation.target_source_release
        AND route.protocol_version = operation.target_protocol_version
        AND route.command_fingerprint = operation.target_command_fingerprint
        AND route.contract_digest = operation.target_schema_digest
        AND route.compatibility_digest = operation.target_compatibility_digest
        AND EXISTS (
          SELECT 1
          FROM exomem_agent_contract_rollout_assignments AS assignment
          WHERE assignment.id = operation.target_assignment_id
            AND assignment.tenant_id = cell.tenant_id
            AND assignment.candidate_id = operation.target_candidate_id
            AND assignment.generation = operation.target_assignment_generation
            AND assignment.source_release = operation.target_source_release
            AND assignment.protocol_version = operation.target_protocol_version
            AND assignment.gateway_contract_digest = operation.target_gateway_contract_digest
            AND assignment.command_fingerprint = operation.target_command_fingerprint
            AND assignment.schema_digest = operation.target_schema_digest
            AND assignment.compatibility_digest = operation.target_compatibility_digest
            AND assignment.state = 'active'
            AND assignment.expires_at > now()
        )
      ORDER BY operation.completed_at DESC NULLS LAST, operation.id
      LIMIT 1
    ) AS operation ON true
    WHERE route.profile_id = ${EXOMEM_HOSTED_PROFILE} AND route.routable = true
      AND cell.routing_state = 'bound' AND cell.lifecycle_state = 'active'
      AND tenant.status = 'active' AND tenant.desired_state = 'running'
    ORDER BY route.cell_id
  `;
  if (!rows.length) return null;
  const probes = rows.map((row) => probeFromRow(row as Record<string, unknown>));
  return probes.every((probe): probe is Omit<PromotionProbe, "readiness"> => probe !== null)
    ? probes
    : null;
}

/** Derive strict server-owned outer-v2 health before taking the cohort transaction lock. */
export async function preparePromotionRuntimeHealth(input: {
  candidateId: string;
  expectedRoutableCellDigest: string;
  provisioner?: Pick<CellProvisioner, "health">;
  envelopeKey?: Buffer;
}): Promise<PromotionProbe[] | null> {
  try {
    const probes = await loadPromotionProbes(input.candidateId);
    if (!probes) return null;
    const snapshotDigest = routableSetDigest(
      EXOMEM_HOSTED_PROFILE,
      probes.map((probe) => probe.route)
    );
    if (snapshotDigest !== input.expectedRoutableCellDigest) return null;
    const provisioner =
      input.provisioner ?? testProvisioner ?? new HttpCellProvisioner(provisionerConfigFromEnv());
    const envelopeKey = input.envelopeKey ?? controlPlaneKeyFromEnv();
    const observed = await Promise.all(
      probes.map(async (probe) => {
        const request = promotionHealthTarget({ ...probe, envelopeKey });
        if (!request) return null;
        const readiness = await provisioner.health(request);
        return !readiness.live ||
          !readiness.ready ||
          strictOuterV2ReadinessMismatch(readiness, probe.cell, probe.operation)
          ? null
          : { ...probe, readiness };
      })
    );
    const successful = observed.filter((probe): probe is PromotionProbe => probe !== null);
    return successful.length === probes.length ? successful : null;
  } catch {
    return null;
  }
}

/** Caller holds the cohort lock; persist the matching pre-probe snapshot before promotion. */
export async function recordPromotionRuntimeAuthorityInTransaction(input: {
  transaction: ExomemSql;
  candidateId: string;
  expectedRoutableCellDigest: string;
  probes: PromotionProbe[];
  refreshAuthority: (transaction: ExomemSql, observedCellId: string) => Promise<void>;
}): Promise<boolean> {
  const snapshotDigest = routableSetDigest(
    EXOMEM_HOSTED_PROFILE,
    input.probes.map((probe) => probe.route)
  );
  const { rows } = await input.transaction`
    /* exomem:lock-promotion-runtime-route-set */
    SELECT cell_id::text AS cell_id, source_release, protocol_version, command_fingerprint,
           contract_digest, compatibility_digest
    FROM exomem_routable_cell_contracts
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND routable = true
    ORDER BY cell_id
    FOR UPDATE
  `;
  const currentDigest = routableSetDigest(EXOMEM_HOSTED_PROFILE, rows as RoutableCellIdentity[]);
  if (currentDigest !== input.expectedRoutableCellDigest || currentDigest !== snapshotDigest)
    return false;
  for (const probe of input.probes) {
    const target = probe.operation.target!;
    const cellUpdate = await input.transaction`
          /* exomem:record-promotion-runtime-cell-observation */
          UPDATE exomem_cells
          SET readiness_code = ${probe.readiness.code},
              observed_gateway_contract_digest = ${probe.readiness.runtimeIdentity!.gatewayContractDigest},
              observed_command_fingerprint = ${probe.readiness.runtimeIdentity!.commandFingerprint},
              observed_schema_digest = ${probe.readiness.runtimeIdentity!.schemaDigest},
              observed_compatibility_digest = ${target.compatibilityDigest},
              last_liveness_at = now(), last_readiness_at = now(), updated_at = now()
          FROM exomem_tenants AS tenant
          WHERE exomem_cells.id = ${probe.cell.id}::uuid
            AND exomem_cells.tenant_id = ${probe.cell.tenantId}::uuid
            AND exomem_cells.routing_state = 'bound' AND exomem_cells.lifecycle_state = 'active'
            AND exomem_cells.provider_ref = ${probe.cell.providerRef}
            AND exomem_cells.credential_version = ${probe.cell.credentialVersion}
            AND exomem_cells.worker_policy = ${JSON.stringify(probe.cell.workerPolicy)}::jsonb
            AND exomem_cells.protocol_version = ${probe.cell.protocolVersion}
            AND exomem_cells.release_version = ${probe.cell.releaseVersion}
            AND exomem_cells.service_credential_ciphertext = ${JSON.stringify(probe.cell.credentialEnvelope)}::jsonb
            AND exomem_cells.service_credential_digest IS NOT DISTINCT FROM ${probe.cell.credentialDigest}
            AND tenant.id = exomem_cells.tenant_id AND tenant.bound_cell_id = exomem_cells.id
            AND tenant.status = 'active' AND tenant.desired_state = 'running'
            AND EXISTS (
              SELECT 1
              FROM exomem_lifecycle_operations AS operation
              JOIN exomem_agent_contract_rollout_assignments AS assignment
                ON assignment.id = operation.target_assignment_id
              WHERE operation.id = ${probe.operation.id}::uuid
                AND operation.cell_id = exomem_cells.id
                AND operation.tenant_id = exomem_cells.tenant_id
                AND operation.fence_generation = tenant.fence_generation
                AND operation.state = 'succeeded'
                AND (
                  (operation.operation_type IN ('provision', 'restore') AND operation.checkpoint = 'bound')
                  OR (operation.operation_type = 'rollforward' AND operation.checkpoint = 'complete')
                )
                AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
                AND operation.target_candidate_id = ${input.candidateId}::uuid
                AND operation.target_source_release = ${target.sourceRelease}
                AND operation.target_protocol_version = ${target.protocolVersion}
                AND operation.target_gateway_contract_digest = ${target.gatewayContractDigest}
                AND operation.target_command_fingerprint = ${target.commandFingerprint}
                AND operation.target_schema_digest = ${target.schemaDigest}
                AND operation.target_compatibility_digest = ${target.compatibilityDigest}
                AND assignment.tenant_id = exomem_cells.tenant_id
                AND assignment.candidate_id = operation.target_candidate_id
                AND assignment.generation = operation.target_assignment_generation
                AND assignment.source_release = operation.target_source_release
                AND assignment.protocol_version = operation.target_protocol_version
                AND assignment.gateway_contract_digest = operation.target_gateway_contract_digest
                AND assignment.command_fingerprint = operation.target_command_fingerprint
                AND assignment.schema_digest = operation.target_schema_digest
                AND assignment.compatibility_digest = operation.target_compatibility_digest
                AND assignment.state = 'active' AND assignment.expires_at > now()
            )
          RETURNING exomem_cells.id
    `;
    if (cellUpdate.rows.length !== 1) throw new PromotionRuntimePreconditionError();
    const routeUpdate = await input.transaction`
          /* exomem:record-promotion-runtime-route-observation */
          UPDATE exomem_routable_cell_contracts
          SET source_release = ${target.sourceRelease}, protocol_version = ${target.protocolVersion},
              command_fingerprint = ${target.commandFingerprint}, contract_digest = ${target.schemaDigest},
              compatibility_digest = ${target.compatibilityDigest}, observed_at = now()
          WHERE cell_id = ${probe.cell.id}::uuid AND profile_id = ${EXOMEM_HOSTED_PROFILE} AND routable = true
            AND EXISTS (
              SELECT 1
              FROM exomem_cells AS cell
              JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
              WHERE cell.id = exomem_routable_cell_contracts.cell_id
                AND cell.tenant_id = ${probe.cell.tenantId}::uuid
                AND cell.routing_state = 'bound' AND cell.lifecycle_state = 'active'
                AND tenant.bound_cell_id = cell.id
                AND tenant.status = 'active' AND tenant.desired_state = 'running'
            )
          RETURNING cell_id
    `;
    if (routeUpdate.rows.length !== 1) throw new PromotionRuntimePreconditionError();
  }
  await input.refreshAuthority(input.transaction, input.probes[0]!.cell.id);
  return true;
}
