import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import {
  acquireCapacityProviderWorkAtomic,
  emitCapacityTransitionAfterCommit,
  markUnboundCellDestroyedAtomic,
  releaseCapacityProvisionClaim,
  transitionCapacityAllocationAtomic,
} from "./capacity-store";
import { exomemErrors } from "./errors";
import type {
  CandidateSecret,
  CellControlRecord,
  ExportRecordDisposition,
  LifecycleOperation,
  LifecycleOperationType,
  LifecycleEnqueueOptions,
  LifecycleStatus,
  LifecycleStore,
  LifecycleTarget,
} from "./reconciler";
import type {
  CellContractIdentity,
  CellWorkerPolicy,
  ProvisionerWireProtocol,
  RuntimeTarget,
} from "./provisioner";
import { provisionerWireProtocolFromEnv } from "./provisioner-wire-protocol";
import type { SecretEnvelope } from "./security";
import type { BillingDeletionTarget } from "./billing-deletion";
import { exomemContractFixture0340 } from "./gateway-contract-0-34-0";
import { exomemContractFixture0350 } from "./gateway-contract-0-35-0";
import { exomemContractFixture0392 } from "./gateway-contract-0-39-2";
import { exomemContractFixture0490 } from "./gateway-contract-0-49-0";
import { exomemContractFixture0500 } from "./gateway-contract-0-50-0";
import { exomemContractFixture0541 } from "./gateway-contract-0-54-1";
import { exomemContractFixture0572 } from "./gateway-contract-0-57-2";
import { revokeTenantOAuthOutsideAssignmentInTransaction } from "./agent-contract-canaries";
import { refreshRoutableProfileAuthorityInTransaction } from "./agent-contract-store";

type Row = Record<string, unknown>;

type LifecycleCapacityTransition = {
  succeeded: boolean;
  previous?: "reserved" | "occupied" | "uncertain" | "retained_storage" | "released";
};

export type ExomemHostedContractionReadiness = {
  ready: boolean;
  unfinishedV1Operations: number;
  retainedV1Exports: number;
};

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

function targetFromRow(row: Row): LifecycleTarget | null {
  if (!row.target_candidate_id) return null;
  if (
    !row.target_source_release ||
    !row.target_protocol_version ||
    !row.target_gateway_contract_digest ||
    !row.target_command_fingerprint ||
    !row.target_schema_digest ||
    !row.target_compatibility_digest
  ) {
    throw new Error("lifecycle target is incomplete");
  }
  return {
    candidateId: String(row.target_candidate_id),
    assignmentId: row.target_assignment_id ? String(row.target_assignment_id) : null,
    assignmentGeneration:
      row.target_assignment_generation == null ? null : Number(row.target_assignment_generation),
    sourceRelease: String(row.target_source_release),
    protocolVersion: String(row.target_protocol_version),
    gatewayContractDigest: String(row.target_gateway_contract_digest),
    commandFingerprint: String(row.target_command_fingerprint),
    schemaDigest: String(row.target_schema_digest),
    compatibilityDigest: String(row.target_compatibility_digest),
  };
}

function operationFromRow(row: Row): LifecycleOperation {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    cellId: row.cell_id ? String(row.cell_id) : null,
    operationType: String(row.operation_type) as LifecycleOperationType,
    provisionerWireProtocol: String(row.provisioner_wire_protocol) as ProvisionerWireProtocol,
    state: String(row.state) as LifecycleOperation["state"],
    idempotencyKey: String(row.idempotency_key),
    fenceGeneration: Number(row.fence_generation),
    checkpoint: String(row.checkpoint),
    requestId: String(row.request_id),
    attempts: Number(row.attempts),
    nextAttemptAt: asDate(row.next_attempt_at),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: row.lease_expires_at ? asDate(row.lease_expires_at) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    providerResultRef: row.provider_result_ref ? String(row.provider_result_ref) : null,
    inputReferenceEnvelope: row.input_reference_ciphertext
      ? (asObject(row.input_reference_ciphertext) as SecretEnvelope)
      : null,
    inputReferenceDigest: row.input_reference_digest ? asBuffer(row.input_reference_digest) : null,
    inputExportId: row.input_export_id ? String(row.input_export_id) : null,
    exportReleaseEnvelope: row.export_release_reference_ciphertext
      ? (asObject(row.export_release_reference_ciphertext) as SecretEnvelope)
      : null,
    exportReleaseDigest: row.export_release_reference_digest
      ? asBuffer(row.export_release_reference_digest)
      : null,
    exportExpiresAt: row.export_expires_at ? asDate(row.export_expires_at) : null,
    exportRequestStarted: row.export_request_started === true,
    inputSourceCellId: row.input_source_cell_id ? String(row.input_source_cell_id) : null,
    inputArchiveSha256: row.input_archive_sha256 ? String(row.input_archive_sha256) : null,
    inputManifestSha256: row.input_manifest_sha256 ? String(row.input_manifest_sha256) : null,
    inputArchiveSize: row.input_archive_size == null ? null : Number(row.input_archive_size),
    resumeAfterOperation: row.resume_after_operation !== false,
    expectedPreviousCellId: row.expected_previous_cell_id
      ? String(row.expected_previous_cell_id)
      : null,
    target: targetFromRow(row),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function cellFromRow(row: Row): CellControlRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    lifecycleState: String(row.lifecycle_state) as CellControlRecord["lifecycleState"],
    routingState: String(row.routing_state) as CellControlRecord["routingState"],
    desiredState: String(row.desired_state) as CellControlRecord["desiredState"],
    protocolVersion: String(row.protocol_version),
    releaseVersion: String(row.release_version),
    workerPolicy: asObject(row.worker_policy) as CellWorkerPolicy,
    providerRef: row.provider_ref ? String(row.provider_ref) : null,
    endpointEnvelope: row.private_endpoint_ciphertext
      ? (asObject(row.private_endpoint_ciphertext) as SecretEnvelope)
      : null,
    credentialEnvelope: row.service_credential_ciphertext
      ? (asObject(row.service_credential_ciphertext) as SecretEnvelope)
      : null,
    credentialDigest: row.service_credential_digest
      ? asBuffer(row.service_credential_digest)
      : null,
    credentialVersion: Number(row.credential_version),
    pendingCredentialEnvelope: row.pending_service_credential_ciphertext
      ? (asObject(row.pending_service_credential_ciphertext) as SecretEnvelope)
      : null,
    pendingCredentialDigest: row.pending_service_credential_digest
      ? asBuffer(row.pending_service_credential_digest)
      : null,
    pendingCredentialVersion: row.pending_credential_version
      ? Number(row.pending_credential_version)
      : null,
    readinessCode: row.readiness_code ? String(row.readiness_code) : null,
  };
}

export async function getExomemHostedContractionReadiness(): Promise<ExomemHostedContractionReadiness> {
  const { rows } = await executeExomemSql`
    /* exomem:hosted-contraction-readiness */
    SELECT
      (
        SELECT COUNT(*)
        FROM exomem_lifecycle_operations AS operation
        WHERE operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
          AND operation.state NOT IN ('succeeded', 'failed_terminal')
      ) AS unfinished_v1_operations,
      (
        SELECT COUNT(*)
        FROM exomem_exports AS export_row
        JOIN exomem_lifecycle_operations AS operation
          ON operation.id = export_row.operation_id
        WHERE operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
          AND export_row.state <> 'deleted'
      ) AS retained_v1_exports
  `;
  const row = rows[0] ?? {};
  const unfinishedV1Operations = Number(row.unfinished_v1_operations ?? 0);
  const retainedV1Exports = Number(row.retained_v1_exports ?? 0);
  return {
    ready: unfinishedV1Operations === 0 && retainedV1Exports === 0,
    unfinishedV1Operations,
    retainedV1Exports,
  };
}

export class SqlLifecycleStore implements LifecycleStore {
  async #transitionCapacityForOwnedOperation(
    operationId: string,
    owner: string,
    state: "occupied" | "retained_storage" | "released",
    transaction?: ExomemSql
  ): Promise<LifecycleCapacityTransition> {
    const sql = transaction ?? executeExomemSql;
    const legacy = await sql`
      SELECT tenant.legacy_unmetered
      FROM exomem_lifecycle_operations AS operation
      JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
      WHERE operation.id = ${operationId}::uuid
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.fence_generation = tenant.fence_generation
      FOR UPDATE OF operation, tenant
    `;
    if (!legacy.rows[0]) return { succeeded: false };
    if ((legacy.rows[0] as { legacy_unmetered?: boolean }).legacy_unmetered === true) {
      return { succeeded: true };
    }
    const { rows } = await sql`
      /* exomem:lifecycle-capacity-transition */
      SELECT allocation.id AS allocation_id
      FROM exomem_lifecycle_operations AS operation
      JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
      JOIN exomem_capacity_allocations AS allocation ON allocation.tenant_id = tenant.id
      JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
      WHERE operation.id = ${operationId}::uuid
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.fence_generation = tenant.fence_generation
        AND allocation.state <> 'released'
      FOR UPDATE OF operation, tenant, allocation, pool
    `;
    const allocation = rows[0] as { allocation_id?: string } | undefined;
    if (!allocation?.allocation_id) return { succeeded: false };
    const receipt: {
      value?: {
        previous: "reserved" | "occupied" | "uncertain" | "retained_storage" | "released";
      };
    } = {};
    const succeeded = await transitionCapacityAllocationAtomic({
      allocationId: allocation.allocation_id,
      state,
      transaction,
      receipt,
    });
    return { succeeded, previous: receipt.value?.previous };
  }

  async enqueue(
    tenantId: string,
    operationType: LifecycleOperationType,
    idempotencyKey: string,
    cellId: string | null = null,
    options: LifecycleEnqueueOptions = {}
  ): Promise<LifecycleOperation> {
    const provisionerWireProtocol =
      operationType === "rollforward"
        ? "exomem-cell-provisioner.v2"
        : provisionerWireProtocolFromEnv();
    const exportTtlMs = options.exportTtlMs ?? 24 * 60 * 60 * 1000;
    if (
      operationType === "export" &&
      (!Number.isSafeInteger(exportTtlMs) ||
        exportTtlMs < 60 * 60 * 1000 ||
        exportTtlMs > 30 * 24 * 60 * 60 * 1000)
    ) {
      throw exomemErrors.invalidRequest();
    }
    if (operationType === "delete") {
      // Deletion must atomically consume the owner confirmation, bump the
      // tenant fence, gate access, and enqueue via
      // consumeDeletionConfirmationAtomic. A generic enqueue cannot provide
      // that transaction boundary.
      throw exomemErrors.invalidRequest();
    }
    if (operationType === "restore") {
      const exportId = options.restoreBinding?.exportId;
      if (!exportId) throw exomemErrors.invalidRequest();
      const { rows } = await executeExomemSql`
        /* exomem:lifecycle-enqueue-restore */
        WITH cohort_lock AS MATERIALIZED (
          SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))
        ), tenant AS (
          SELECT tenant.*
          FROM exomem_tenants AS tenant CROSS JOIN cohort_lock
          WHERE tenant.id = ${tenantId}
            AND tenant.status <> 'deleted'
            AND tenant.desired_state <> 'deleted'
          FOR UPDATE OF tenant
        ), existing AS (
          SELECT operation.*
          FROM exomem_lifecycle_operations AS operation
          JOIN tenant ON tenant.id = operation.tenant_id
          WHERE operation.operation_type = 'restore'
            AND operation.idempotency_key = ${idempotencyKey}
            AND operation.input_export_id = ${exportId}::uuid
        ), source_export AS MATERIALIZED (
          SELECT export_row.*,
                 tenant.fence_generation AS tenant_fence_generation
          FROM exomem_exports AS export_row
          JOIN tenant ON tenant.id = export_row.tenant_id
          WHERE export_row.id = ${exportId}::uuid
            AND export_row.state = 'available'
            AND export_row.expires_at > now()
            AND NOT EXISTS (SELECT 1 FROM existing)
          FOR UPDATE OF export_row
        ), assignment_target AS MATERIALIZED (
          SELECT assignment.candidate_id, assignment.id AS assignment_id,
                 assignment.generation AS assignment_generation, assignment.source_release,
                 assignment.protocol_version, assignment.gateway_contract_digest,
                 assignment.command_fingerprint, assignment.schema_digest,
                 assignment.compatibility_digest
          FROM exomem_agent_contract_rollout_assignments AS assignment
          JOIN tenant ON tenant.id = assignment.tenant_id
          WHERE assignment.state = 'preparing' AND assignment.expires_at > now()
          FOR SHARE OF assignment
        ), live_target AS MATERIALIZED (
          SELECT candidate.id AS candidate_id, NULL::uuid AS assignment_id,
                 NULL::bigint AS assignment_generation, candidate.source_release,
                 candidate.protocol_version,
                 CASE candidate.source_release || ':' || candidate.protocol_version
                   WHEN ${exomemContractFixture0340.release + ":" + exomemContractFixture0340.protocol}
                     THEN ${exomemContractFixture0340.digest}
                   WHEN ${exomemContractFixture0350.release + ":" + exomemContractFixture0350.protocol}
                     THEN ${exomemContractFixture0350.digest}
                   WHEN ${exomemContractFixture0392.release + ":" + exomemContractFixture0392.protocol}
                     THEN ${exomemContractFixture0392.digest}
                   WHEN ${exomemContractFixture0490.release + ":" + exomemContractFixture0490.protocol}
                     THEN ${exomemContractFixture0490.digest}
                   WHEN ${exomemContractFixture0500.release + ":" + exomemContractFixture0500.protocol}
                     THEN ${exomemContractFixture0500.digest}
                   WHEN ${exomemContractFixture0541.release + ":" + exomemContractFixture0541.protocol}
                     THEN ${exomemContractFixture0541.digest}
                   WHEN ${exomemContractFixture0572.release + ":" + exomemContractFixture0572.protocol}
                     THEN ${exomemContractFixture0572.digest}
                   ELSE NULL
                 END AS gateway_contract_digest,
                 candidate.command_fingerprint, candidate.schema_digest,
                 candidate.compatibility_digest
          FROM exomem_agent_contract_candidates AS candidate
          JOIN exomem_cells AS catalog_cell
            ON catalog_cell.routing_state = 'bound'
           AND catalog_cell.release_version = candidate.source_release
           AND catalog_cell.protocol_version = candidate.protocol_version
           AND catalog_cell.observed_gateway_contract_digest IS NOT NULL
           AND catalog_cell.observed_command_fingerprint = candidate.command_fingerprint
           AND catalog_cell.observed_schema_digest = candidate.schema_digest
          WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
            AND candidate.state = 'live'
            AND NOT EXISTS (SELECT 1 FROM assignment_target)
          GROUP BY candidate.id, candidate.source_release, candidate.protocol_version,
                   candidate.command_fingerprint, candidate.schema_digest, candidate.compatibility_digest
          HAVING COUNT(DISTINCT catalog_cell.observed_gateway_contract_digest) = 1
        ), target AS MATERIALIZED (
          SELECT * FROM assignment_target
          UNION ALL
          SELECT * FROM live_target WHERE gateway_contract_digest IS NOT NULL
        ), inserted AS (
          INSERT INTO exomem_lifecycle_operations (
            tenant_id, cell_id, operation_type, idempotency_key,
            fence_generation, provisioner_wire_protocol,
            input_reference_ciphertext, input_reference_digest,
            input_export_id, input_source_cell_id,
            input_archive_sha256, input_manifest_sha256, input_archive_size,
            resume_after_operation,
            target_candidate_id, target_assignment_id, target_assignment_generation,
            target_source_release, target_protocol_version, target_gateway_contract_digest,
            target_command_fingerprint, target_schema_digest, target_compatibility_digest
          )
          SELECT source_export.tenant_id,
                 NULL,
                 'restore',
                 ${idempotencyKey},
                 source_export.tenant_fence_generation,
                 ${provisionerWireProtocol},
                 source_export.storage_reference_ciphertext,
                 source_export.storage_reference_digest,
                 source_export.id,
                 source_export.cell_id,
                 source_export.archive_sha256,
                 source_export.manifest_sha256,
                 source_export.archive_size,
                 true,
                 target.candidate_id,
                 target.assignment_id,
                 target.assignment_generation,
                 target.source_release,
                 target.protocol_version,
                 target.gateway_contract_digest,
                 target.command_fingerprint,
                 target.schema_digest,
                 target.compatibility_digest
          FROM source_export
          JOIN target ON TRUE
          ON CONFLICT (tenant_id, operation_type, idempotency_key) DO NOTHING
          RETURNING *
        )
        SELECT * FROM existing
        UNION ALL
        SELECT * FROM inserted
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) throw exomemErrors.idempotencyConflict();
      return operationFromRow(row);
    }
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-enqueue */
      WITH cohort_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))
      ), tenant AS (
        SELECT tenant.*
        FROM exomem_tenants AS tenant CROSS JOIN cohort_lock
        WHERE tenant.id = ${tenantId}
          AND tenant.status <> 'deleted'
        FOR UPDATE OF tenant
      ), assignment_target AS MATERIALIZED (
        SELECT assignment.candidate_id,
               assignment.id AS assignment_id,
               assignment.generation AS assignment_generation,
               assignment.source_release,
               assignment.protocol_version,
               assignment.gateway_contract_digest,
               assignment.command_fingerprint,
               assignment.schema_digest,
               assignment.compatibility_digest
        FROM exomem_agent_contract_rollout_assignments AS assignment
        JOIN tenant ON tenant.id = assignment.tenant_id
        WHERE assignment.expires_at > now()
          AND (
            assignment.state = 'preparing'
            OR (
              ${operationType}::text = 'rollforward'
              AND assignment.state = 'active'
              AND NOT EXISTS (
                SELECT 1
                FROM exomem_agent_contract_rollout_assignments AS preparing
                WHERE preparing.tenant_id = assignment.tenant_id
                  AND preparing.state = 'preparing'
                  AND preparing.expires_at > now()
              )
            )
          )
        FOR SHARE OF assignment
      ), live_target AS MATERIALIZED (
        SELECT candidate.id AS candidate_id,
               NULL::uuid AS assignment_id,
               NULL::bigint AS assignment_generation,
               candidate.source_release,
               candidate.protocol_version,
               CASE candidate.source_release || ':' || candidate.protocol_version
                 WHEN ${exomemContractFixture0340.release + ":" + exomemContractFixture0340.protocol}
                   THEN ${exomemContractFixture0340.digest}
                 WHEN ${exomemContractFixture0350.release + ":" + exomemContractFixture0350.protocol}
                   THEN ${exomemContractFixture0350.digest}
                 WHEN ${exomemContractFixture0392.release + ":" + exomemContractFixture0392.protocol}
                   THEN ${exomemContractFixture0392.digest}
                 WHEN ${exomemContractFixture0490.release + ":" + exomemContractFixture0490.protocol}
                   THEN ${exomemContractFixture0490.digest}
                 WHEN ${exomemContractFixture0500.release + ":" + exomemContractFixture0500.protocol}
                   THEN ${exomemContractFixture0500.digest}
                 WHEN ${exomemContractFixture0541.release + ":" + exomemContractFixture0541.protocol}
                   THEN ${exomemContractFixture0541.digest}
                 WHEN ${exomemContractFixture0572.release + ":" + exomemContractFixture0572.protocol}
                   THEN ${exomemContractFixture0572.digest}
                 ELSE NULL
               END AS gateway_contract_digest,
               candidate.command_fingerprint,
               candidate.schema_digest,
               candidate.compatibility_digest
        FROM exomem_agent_contract_candidates AS candidate
        JOIN exomem_cells AS catalog_cell
          ON catalog_cell.routing_state = 'bound'
         AND catalog_cell.release_version = candidate.source_release
         AND catalog_cell.protocol_version = candidate.protocol_version
         AND catalog_cell.observed_gateway_contract_digest IS NOT NULL
         AND catalog_cell.observed_command_fingerprint = candidate.command_fingerprint
         AND catalog_cell.observed_schema_digest = candidate.schema_digest
        WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
          AND candidate.state = 'live'
          AND NOT EXISTS (SELECT 1 FROM assignment_target)
        GROUP BY candidate.id, candidate.source_release, candidate.protocol_version,
                 candidate.command_fingerprint, candidate.schema_digest, candidate.compatibility_digest
        HAVING COUNT(DISTINCT catalog_cell.observed_gateway_contract_digest) = 1
      ), bound_assignment_target AS MATERIALIZED (
        SELECT assignment.candidate_id,
               assignment.id AS assignment_id,
               assignment.generation AS assignment_generation,
               assignment.source_release,
               assignment.protocol_version,
               assignment.gateway_contract_digest,
               assignment.command_fingerprint,
               assignment.schema_digest,
               assignment.compatibility_digest
        FROM exomem_cells AS bound_cell
        JOIN tenant ON tenant.id = bound_cell.tenant_id
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.tenant_id = tenant.id
         AND assignment.state = 'active'
         AND assignment.expires_at > now()
         AND assignment.source_release = bound_cell.release_version
         AND assignment.protocol_version = bound_cell.protocol_version
         AND assignment.gateway_contract_digest = bound_cell.observed_gateway_contract_digest
         AND assignment.command_fingerprint = bound_cell.observed_command_fingerprint
         AND assignment.schema_digest = bound_cell.observed_schema_digest
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = assignment.candidate_id
         AND candidate.state IN ('pending', 'live')
         AND candidate.source_release = assignment.source_release
         AND candidate.protocol_version = assignment.protocol_version
         AND candidate.command_fingerprint = assignment.command_fingerprint
         AND candidate.schema_digest = assignment.schema_digest
         AND candidate.compatibility_digest = assignment.compatibility_digest
        WHERE bound_cell.id = COALESCE(${cellId}::uuid, tenant.bound_cell_id)
          AND bound_cell.routing_state IN ('bound', 'retiring')
          AND bound_cell.observed_gateway_contract_digest IS NOT NULL
        FOR SHARE OF bound_cell, assignment, candidate
      ), strict_v1_reviewer_target AS MATERIALIZED (
        SELECT operation.target_candidate_id AS candidate_id,
               operation.target_assignment_id AS assignment_id,
               operation.target_assignment_generation AS assignment_generation,
               operation.target_source_release AS source_release,
               operation.target_protocol_version AS protocol_version,
               operation.target_gateway_contract_digest AS gateway_contract_digest,
               operation.target_command_fingerprint AS command_fingerprint,
               operation.target_schema_digest AS schema_digest,
               operation.target_compatibility_digest AS compatibility_digest
        FROM exomem_cells AS bound_cell
        JOIN tenant ON tenant.id = bound_cell.tenant_id
        JOIN exomem_lifecycle_operations AS operation
          ON operation.tenant_id = tenant.id
         AND operation.cell_id = bound_cell.id
         AND operation.operation_type IN ('provision', 'restore')
         AND operation.state = 'succeeded'
         AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
         AND operation.target_candidate_id IS NOT NULL
         AND operation.target_assignment_id IS NOT NULL
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.id = operation.target_assignment_id
         AND assignment.tenant_id = tenant.id
         AND assignment.marketplace_reviewer_purpose = true
         AND assignment.generation = operation.target_assignment_generation
         AND assignment.source_release = operation.target_source_release
         AND assignment.protocol_version = operation.target_protocol_version
         AND assignment.gateway_contract_digest = operation.target_gateway_contract_digest
         AND assignment.command_fingerprint = operation.target_command_fingerprint
         AND assignment.schema_digest = operation.target_schema_digest
         AND assignment.compatibility_digest = operation.target_compatibility_digest
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = operation.target_candidate_id
         AND candidate.profile_id = 'hosted-alpha-agent-v1'
         AND candidate.source_release = operation.target_source_release
         AND candidate.protocol_version = operation.target_protocol_version
         AND candidate.command_fingerprint = operation.target_command_fingerprint
         AND candidate.schema_digest = operation.target_schema_digest
         AND candidate.compatibility_digest = operation.target_compatibility_digest
        WHERE bound_cell.id = COALESCE(${cellId}::uuid, tenant.bound_cell_id)
          AND bound_cell.routing_state IN ('bound', 'retiring')
          AND tenant.marketplace_reviewer_purpose = true
          AND operation.target_source_release = bound_cell.release_version
          AND operation.target_protocol_version = bound_cell.protocol_version
        GROUP BY operation.target_candidate_id, operation.target_assignment_id,
                 operation.target_assignment_generation, operation.target_source_release,
                 operation.target_protocol_version, operation.target_gateway_contract_digest,
                 operation.target_command_fingerprint, operation.target_schema_digest,
                 operation.target_compatibility_digest
      ), origin_target_identities AS MATERIALIZED (
        SELECT operation.target_candidate_id AS candidate_id,
               operation.target_assignment_id AS assignment_id,
               operation.target_assignment_generation AS assignment_generation,
               operation.target_source_release AS source_release,
               operation.target_protocol_version AS protocol_version,
               operation.target_gateway_contract_digest AS gateway_contract_digest,
               operation.target_command_fingerprint AS command_fingerprint,
               operation.target_schema_digest AS schema_digest,
               operation.target_compatibility_digest AS compatibility_digest,
               MAX(operation.completed_at) AS installed_at
        FROM exomem_cells AS bound_cell
        JOIN tenant ON tenant.id = bound_cell.tenant_id
        JOIN exomem_lifecycle_operations AS operation
          ON operation.tenant_id = tenant.id
         AND operation.cell_id = bound_cell.id
         AND operation.operation_type IN ('provision', 'restore')
         AND operation.state = 'succeeded'
         AND operation.target_candidate_id IS NOT NULL
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = operation.target_candidate_id
         AND candidate.profile_id = 'hosted-alpha-agent-v1'
         AND candidate.source_release = operation.target_source_release
         AND candidate.protocol_version = operation.target_protocol_version
         AND candidate.command_fingerprint = operation.target_command_fingerprint
         AND candidate.schema_digest = operation.target_schema_digest
         AND candidate.compatibility_digest = operation.target_compatibility_digest
        WHERE bound_cell.id = COALESCE(${cellId}::uuid, tenant.bound_cell_id)
          AND bound_cell.routing_state IN ('bound', 'retiring')
          AND operation.target_source_release = bound_cell.release_version
          AND operation.target_protocol_version = bound_cell.protocol_version
          AND operation.target_gateway_contract_digest = bound_cell.observed_gateway_contract_digest
          AND operation.target_command_fingerprint = bound_cell.observed_command_fingerprint
          AND operation.target_schema_digest = bound_cell.observed_schema_digest
          AND operation.target_compatibility_digest = bound_cell.observed_compatibility_digest
          AND candidate.compatibility_digest = bound_cell.observed_compatibility_digest
        GROUP BY operation.target_candidate_id, operation.target_assignment_id,
                 operation.target_assignment_generation, operation.target_source_release,
                 operation.target_protocol_version, operation.target_gateway_contract_digest,
                 operation.target_command_fingerprint, operation.target_schema_digest,
                 operation.target_compatibility_digest
      ), latest_origin_target AS MATERIALIZED (
        SELECT identity.*
        FROM origin_target_identities AS identity
        WHERE identity.installed_at = (SELECT MAX(installed_at) FROM origin_target_identities)
          AND 1 = (
            SELECT COUNT(*)
            FROM origin_target_identities AS current_identity
            WHERE current_identity.installed_at = identity.installed_at
          )
      ), has_cell_target_history AS MATERIALIZED (
        SELECT 1
        FROM exomem_cells AS bound_cell
        JOIN tenant ON tenant.id = bound_cell.tenant_id
        JOIN exomem_lifecycle_operations AS operation
          ON operation.tenant_id = tenant.id
         AND operation.cell_id = bound_cell.id
         AND operation.operation_type IN ('provision', 'restore')
         AND operation.state = 'succeeded'
         AND operation.target_candidate_id IS NOT NULL
        WHERE bound_cell.id = COALESCE(${cellId}::uuid, tenant.bound_cell_id)
      ), legacy_cell_target_candidates AS MATERIALIZED (
        SELECT candidate.id AS candidate_id,
               NULL::uuid AS assignment_id,
               NULL::bigint AS assignment_generation,
               candidate.source_release,
               candidate.protocol_version,
               bound_cell.observed_gateway_contract_digest AS gateway_contract_digest,
               candidate.command_fingerprint,
               candidate.schema_digest,
               candidate.compatibility_digest
        FROM exomem_cells AS bound_cell
        JOIN tenant ON tenant.id = bound_cell.tenant_id
        JOIN exomem_routable_cell_contracts AS authority
          ON authority.cell_id = bound_cell.id
         AND authority.profile_id = 'hosted-alpha-agent-v1'
         AND authority.routable
         AND authority.source_release = bound_cell.release_version
         AND authority.protocol_version = bound_cell.protocol_version
         AND authority.command_fingerprint = bound_cell.observed_command_fingerprint
         AND authority.contract_digest = bound_cell.observed_schema_digest
         AND authority.compatibility_digest = bound_cell.observed_compatibility_digest
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.profile_id = 'hosted-alpha-agent-v1'
         AND candidate.state = 'live'
         AND candidate.source_release = bound_cell.release_version
         AND candidate.protocol_version = bound_cell.protocol_version
         AND candidate.command_fingerprint = bound_cell.observed_command_fingerprint
         AND candidate.schema_digest = bound_cell.observed_schema_digest
         AND candidate.compatibility_digest = bound_cell.observed_compatibility_digest
        WHERE bound_cell.id = COALESCE(${cellId}::uuid, tenant.bound_cell_id)
          AND bound_cell.routing_state IN ('bound', 'retiring')
          AND bound_cell.observed_gateway_contract_digest IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM has_cell_target_history)
      ), legacy_cell_target AS MATERIALIZED (
        SELECT candidate_id, assignment_id, assignment_generation, source_release,
               protocol_version, gateway_contract_digest, command_fingerprint,
               schema_digest, compatibility_digest
        FROM legacy_cell_target_candidates
        WHERE 1 = (SELECT COUNT(DISTINCT candidate_id) FROM legacy_cell_target_candidates)
      ), target AS MATERIALIZED (
        SELECT * FROM assignment_target
        WHERE ${operationType}::text IN ('provision', 'restore', 'rollforward')
        UNION ALL
        SELECT * FROM live_target
        WHERE ${operationType}::text IN ('provision', 'restore')
          AND gateway_contract_digest IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM assignment_target)
        UNION ALL
        SELECT candidate_id, assignment_id, assignment_generation, source_release,
               protocol_version, gateway_contract_digest, command_fingerprint,
               schema_digest, compatibility_digest
        FROM strict_v1_reviewer_target
        WHERE ${operationType}::text NOT IN ('provision', 'restore', 'rollforward')
          AND NOT EXISTS (SELECT 1 FROM bound_assignment_target)
        UNION ALL
        SELECT candidate_id, assignment_id, assignment_generation, source_release,
               protocol_version, gateway_contract_digest, command_fingerprint,
               schema_digest, compatibility_digest
        FROM latest_origin_target
        WHERE ${operationType}::text NOT IN ('provision', 'restore', 'rollforward')
          AND NOT EXISTS (SELECT 1 FROM bound_assignment_target)
          AND NOT EXISTS (SELECT 1 FROM strict_v1_reviewer_target)
        UNION ALL
        SELECT * FROM legacy_cell_target
        WHERE ${operationType}::text NOT IN ('provision', 'restore', 'rollforward')
          AND NOT EXISTS (SELECT 1 FROM bound_assignment_target)
          AND NOT EXISTS (SELECT 1 FROM strict_v1_reviewer_target)
          AND NOT EXISTS (SELECT 1 FROM latest_origin_target)
        UNION ALL
        SELECT * FROM bound_assignment_target
        WHERE ${operationType}::text NOT IN ('provision', 'restore', 'rollforward')
      )
      INSERT INTO exomem_lifecycle_operations (
        tenant_id, cell_id, operation_type, idempotency_key,
        fence_generation, provisioner_wire_protocol,
        input_reference_ciphertext, input_reference_digest,
        input_export_id, input_source_cell_id, input_archive_sha256, input_manifest_sha256,
        input_archive_size, resume_after_operation, export_expires_at,
        target_candidate_id, target_assignment_id, target_assignment_generation,
        target_source_release, target_protocol_version, target_gateway_contract_digest,
        target_command_fingerprint, target_schema_digest, target_compatibility_digest
      )
      SELECT tenant.id,
             CASE
               WHEN ${cellId}::uuid IS NOT NULL THEN ${cellId}::uuid
               WHEN ${operationType}::text IN ('provision', 'restore') THEN NULL
               ELSE tenant.bound_cell_id
             END,
             ${operationType},
             ${idempotencyKey},
             tenant.fence_generation,
             ${provisionerWireProtocol},
             ${
               options.inputReferenceEnvelope
                 ? JSON.stringify(options.inputReferenceEnvelope)
                 : null
             }::jsonb,
             ${options.inputReferenceDigest ?? null},
             ${options.restoreBinding?.exportId ?? null}::uuid,
             ${options.restoreBinding?.sourceCellId ?? null}::uuid,
             ${options.restoreBinding?.archiveSha256 ?? null},
             ${options.restoreBinding?.manifestSha256 ?? null},
             ${options.restoreBinding?.archiveSize ?? null},
             CASE WHEN ${operationType}::text = 'export'
               THEN tenant.desired_state = 'running'
               ELSE true
             END,
             CASE WHEN ${operationType}::text = 'export'
               THEN date_trunc('milliseconds', now())
                    + (${exportTtlMs} * interval '1 millisecond')
               ELSE NULL
             END,
             target.candidate_id,
             target.assignment_id,
             target.assignment_generation,
             target.source_release,
             target.protocol_version,
             target.gateway_contract_digest,
             target.command_fingerprint,
             target.schema_digest,
             target.compatibility_digest
      FROM tenant
      JOIN target ON TRUE
      WHERE ${operationType}::text <> 'rollforward'
         OR (
           ${cellId}::uuid IS NOT NULL
           AND tenant.bound_cell_id = ${cellId}::uuid
           AND (
             EXISTS (
               SELECT 1
               FROM exomem_cells AS bound_cell
               WHERE bound_cell.id = ${cellId}::uuid
                 AND bound_cell.tenant_id = tenant.id
                 AND bound_cell.routing_state = 'bound'
                 AND bound_cell.lifecycle_state = 'active'
                 AND bound_cell.desired_state = 'running'
             )
             OR EXISTS (
               SELECT 1
               FROM exomem_lifecycle_operations AS existing_operation
               WHERE existing_operation.tenant_id = tenant.id
                 AND existing_operation.cell_id = ${cellId}::uuid
                 AND existing_operation.operation_type = 'rollforward'
                 AND existing_operation.idempotency_key = ${idempotencyKey}
             )
           )
         )
      ON CONFLICT (tenant_id, operation_type, idempotency_key) DO UPDATE
      SET updated_at = exomem_lifecycle_operations.updated_at
      WHERE exomem_lifecycle_operations.input_reference_digest
              IS NOT DISTINCT FROM EXCLUDED.input_reference_digest
        AND exomem_lifecycle_operations.cell_id
              IS NOT DISTINCT FROM EXCLUDED.cell_id
        AND exomem_lifecycle_operations.provisioner_wire_protocol
              IS NOT DISTINCT FROM EXCLUDED.provisioner_wire_protocol
        AND exomem_lifecycle_operations.target_candidate_id
              IS NOT DISTINCT FROM EXCLUDED.target_candidate_id
        AND exomem_lifecycle_operations.target_assignment_id
              IS NOT DISTINCT FROM EXCLUDED.target_assignment_id
        AND exomem_lifecycle_operations.target_assignment_generation
              IS NOT DISTINCT FROM EXCLUDED.target_assignment_generation
        AND exomem_lifecycle_operations.target_source_release
              IS NOT DISTINCT FROM EXCLUDED.target_source_release
        AND exomem_lifecycle_operations.target_protocol_version
              IS NOT DISTINCT FROM EXCLUDED.target_protocol_version
        AND exomem_lifecycle_operations.target_gateway_contract_digest
              IS NOT DISTINCT FROM EXCLUDED.target_gateway_contract_digest
        AND exomem_lifecycle_operations.target_command_fingerprint
              IS NOT DISTINCT FROM EXCLUDED.target_command_fingerprint
        AND exomem_lifecycle_operations.target_schema_digest
              IS NOT DISTINCT FROM EXCLUDED.target_schema_digest
        AND exomem_lifecycle_operations.target_compatibility_digest
              IS NOT DISTINCT FROM EXCLUDED.target_compatibility_digest
        AND exomem_lifecycle_operations.input_source_cell_id
              IS NOT DISTINCT FROM EXCLUDED.input_source_cell_id
        AND exomem_lifecycle_operations.input_export_id
              IS NOT DISTINCT FROM EXCLUDED.input_export_id
        AND exomem_lifecycle_operations.input_archive_sha256
              IS NOT DISTINCT FROM EXCLUDED.input_archive_sha256
        AND exomem_lifecycle_operations.input_manifest_sha256
              IS NOT DISTINCT FROM EXCLUDED.input_manifest_sha256
        AND exomem_lifecycle_operations.input_archive_size
              IS NOT DISTINCT FROM EXCLUDED.input_archive_size
      RETURNING *
    `;
    const row = rows[0];
    if (!row) throw exomemErrors.idempotencyConflict();
    return operationFromRow(row);
  }

  async getAvailableRestoreBinding(
    tenantId: string,
    exportId: string
  ): Promise<import("./reconciler").RestoreBinding | null> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-available-restore-binding */
      SELECT export_row.id::text AS export_id, export_row.cell_id::text AS source_cell_id,
             export_row.archive_sha256, export_row.manifest_sha256, export_row.archive_size
      FROM exomem_exports AS export_row
      WHERE export_row.id = ${exportId}::uuid
        AND export_row.tenant_id = ${tenantId}::uuid
        AND export_row.state = 'available'
        AND export_row.expires_at > now()
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (
      !row ||
      typeof row.export_id !== "string" ||
      typeof row.source_cell_id !== "string" ||
      typeof row.archive_sha256 !== "string" ||
      typeof row.manifest_sha256 !== "string" ||
      !Number.isSafeInteger(Number(row.archive_size))
    )
      return null;
    return {
      exportId: row.export_id,
      sourceCellId: row.source_cell_id,
      archiveSha256: row.archive_sha256,
      manifestSha256: row.manifest_sha256,
      archiveSize: Number(row.archive_size),
    };
  }

  async claim(input: {
    owner: string;
    leaseMs: number;
    maxAttempts: number;
    tenantId?: string;
  }): Promise<LifecycleOperation | null> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-claim */
      WITH stale_cancelled AS (
        UPDATE exomem_lifecycle_operations AS stale
        SET state = 'failed_terminal',
            error_code = 'DELETION_SUPERSEDED',
            lease_owner = NULL,
            lease_expires_at = NULL,
            completed_at = now(),
            updated_at = now()
        FROM exomem_tenants AS fenced_tenant
        WHERE stale.tenant_id = fenced_tenant.id
          AND fenced_tenant.desired_state = 'deleted'
          AND stale.fence_generation < fenced_tenant.fence_generation
          AND stale.state NOT IN ('succeeded', 'failed_terminal')
          AND NOT (
            stale.state = 'running'
            AND stale.lease_expires_at > now()
          )
        RETURNING stale.id
      ), candidate AS (
        SELECT operation.id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        WHERE operation.next_attempt_at <= now()
          AND (
            operation.attempts <= ${input.maxAttempts}
            OR operation.error_code = 'CAPACITY_UNAVAILABLE'
            OR operation.checkpoint IN (
              'candidate-cleanup', 'export-failure-resume',
              'export-requested',
              'export-stored', 'export-expired-release',
              'export-expired-released', 'export-expired-resumed',
              'export-expired-readiness-proved',
              'prior-retirement', 'prior-retired',
              'rollforward-recovery', 'verified', 'recorded', 'complete'
            )
            OR (
              operation.operation_type = 'export'
              AND operation.checkpoint = 'quiesced'
              AND (
                operation.export_request_started
                OR operation.export_release_reference_ciphertext IS NOT NULL
              )
            )
          )
          AND (${input.tenantId ?? null}::uuid IS NULL OR operation.tenant_id = ${input.tenantId ?? null}::uuid)
          AND operation.fence_generation = tenant.fence_generation
          AND (operation.operation_type = 'delete' OR tenant.desired_state <> 'deleted')
          AND (
            operation.state IN ('pending', 'failed_retryable', 'waiting')
            OR (operation.state = 'running' AND operation.lease_expires_at <= now())
          )
          AND (operation.lease_expires_at IS NULL OR operation.lease_expires_at <= now())
          AND NOT EXISTS (
            SELECT 1
            FROM exomem_lifecycle_operations AS blocker
            WHERE blocker.tenant_id = operation.tenant_id
              AND blocker.id <> operation.id
              AND blocker.state NOT IN ('succeeded', 'failed_terminal')
              AND (
                blocker.fence_generation = tenant.fence_generation
                OR (
                  operation.operation_type = 'delete'
                  AND blocker.state = 'running'
                  AND blocker.lease_expires_at > now()
                )
              )
              AND (
                (
                  operation.operation_type = 'delete'
                  AND blocker.state = 'running'
                  AND blocker.lease_expires_at > now()
                  AND blocker.fence_generation < tenant.fence_generation
                )
                OR blocker.operation_type = 'delete'
                OR (blocker.created_at, blocker.id) < (operation.created_at, operation.id)
              )
          )
        ORDER BY CASE WHEN operation.operation_type = 'delete' THEN 0 ELSE 1 END,
                 operation.next_attempt_at,
                 operation.created_at
        FOR UPDATE OF operation SKIP LOCKED
        LIMIT 1
      )
      UPDATE exomem_lifecycle_operations AS operation
      SET state = 'running',
          lease_owner = ${input.owner},
          lease_expires_at = now() + (${input.leaseMs} * interval '1 millisecond'),
          attempts = attempts + 1,
          updated_at = now()
      FROM candidate
      WHERE operation.id = candidate.id
      RETURNING operation.*
    `;
    const operation = rows[0] ? operationFromRow(rows[0]) : null;
    if (
      operation &&
      !operation.target &&
      operation.provisionerWireProtocol === "exomem-cell-provisioner.v1" &&
      (operation.operationType === "provision" || operation.operationType === "restore")
    ) {
      return this.#snapshotLegacyTarget(operation, input.owner);
    }
    return operation;
  }

  async #snapshotLegacyTarget(
    operation: LifecycleOperation,
    owner: string
  ): Promise<LifecycleOperation | null> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-snapshot-legacy-target */
      WITH owned AS (
        SELECT operation.id, operation.tenant_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        LEFT JOIN exomem_cells AS candidate ON candidate.id = operation.cell_id
        WHERE operation.id = ${operation.id}::uuid
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
          AND operation.target_candidate_id IS NULL
          AND operation.provider_result_ref IS NULL
          AND (candidate.id IS NULL OR candidate.provider_ref IS NULL)
        FOR UPDATE OF operation, tenant
      ), assignment_target AS MATERIALIZED (
        SELECT assignment.candidate_id, assignment.id AS assignment_id,
               assignment.generation AS assignment_generation, assignment.source_release,
               assignment.protocol_version, assignment.gateway_contract_digest,
               assignment.command_fingerprint, assignment.schema_digest,
               assignment.compatibility_digest
        FROM exomem_agent_contract_rollout_assignments AS assignment
        JOIN owned ON owned.tenant_id = assignment.tenant_id
        WHERE assignment.state = 'preparing' AND assignment.expires_at > now()
        FOR SHARE OF assignment
      ), live_target AS MATERIALIZED (
        SELECT candidate.id AS candidate_id, NULL::uuid AS assignment_id,
               NULL::bigint AS assignment_generation, candidate.source_release,
               candidate.protocol_version,
               CASE candidate.source_release || ':' || candidate.protocol_version
                 WHEN ${exomemContractFixture0340.release + ":" + exomemContractFixture0340.protocol}
                   THEN ${exomemContractFixture0340.digest}
                 WHEN ${exomemContractFixture0350.release + ":" + exomemContractFixture0350.protocol}
                   THEN ${exomemContractFixture0350.digest}
                   WHEN ${exomemContractFixture0392.release + ":" + exomemContractFixture0392.protocol}
                     THEN ${exomemContractFixture0392.digest}
                   WHEN ${exomemContractFixture0490.release + ":" + exomemContractFixture0490.protocol}
                     THEN ${exomemContractFixture0490.digest}
                   WHEN ${exomemContractFixture0500.release + ":" + exomemContractFixture0500.protocol}
                     THEN ${exomemContractFixture0500.digest}
                   WHEN ${exomemContractFixture0541.release + ":" + exomemContractFixture0541.protocol}
                     THEN ${exomemContractFixture0541.digest}
                   WHEN ${exomemContractFixture0572.release + ":" + exomemContractFixture0572.protocol}
                     THEN ${exomemContractFixture0572.digest}
                   ELSE NULL
               END AS gateway_contract_digest,
               candidate.command_fingerprint, candidate.schema_digest,
               candidate.compatibility_digest
        FROM exomem_agent_contract_candidates AS candidate
        WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
          AND candidate.state = 'live'
          AND NOT EXISTS (SELECT 1 FROM assignment_target)
        FOR SHARE OF candidate
      ), target AS MATERIALIZED (
        SELECT * FROM assignment_target
        UNION ALL
        SELECT * FROM live_target WHERE gateway_contract_digest IS NOT NULL
      ), snapshotted AS (
        UPDATE exomem_lifecycle_operations AS operation
        SET target_candidate_id = target.candidate_id,
            target_assignment_id = target.assignment_id,
            target_assignment_generation = target.assignment_generation,
            target_source_release = target.source_release,
            target_protocol_version = target.protocol_version,
            target_gateway_contract_digest = target.gateway_contract_digest,
            target_command_fingerprint = target.command_fingerprint,
            target_schema_digest = target.schema_digest,
            target_compatibility_digest = target.compatibility_digest,
            updated_at = now()
        FROM owned, target
        WHERE operation.id = owned.id
        RETURNING operation.*
      )
      SELECT * FROM snapshotted
    `;
    if (rows[0]) return operationFromRow(rows[0]);
    const { rows: catalogRows } = await executeExomemSql`
      /* exomem:lifecycle-legacy-deployment-gap */
      SELECT EXISTS (
        SELECT 1
        FROM exomem_agent_contract_candidates
        WHERE profile_id = 'hosted-alpha-agent-v1'
      ) AS has_contract_catalog
    `;
    if (
      !operation.cellId &&
      !operation.providerResultRef &&
      catalogRows[0]?.has_contract_catalog === false
    ) {
      return operation;
    }
    const derived = await this.#deriveLegacyTarget(operation, owner);
    if (derived) return derived;
    await executeExomemSql`
      /* exomem:lifecycle-quarantine-legacy-target */
      UPDATE exomem_lifecycle_operations AS operation
      SET state = 'failed_terminal',
          error_code = 'LIFECYCLE_TARGET_QUARANTINED',
          completed_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operation.id}::uuid
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.target_candidate_id IS NULL
      RETURNING operation.id
    `;
    return null;
  }

  async #deriveLegacyTarget(
    operation: LifecycleOperation,
    owner: string
  ): Promise<LifecycleOperation | null> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-derive-legacy-target-from-routable-cell */
      WITH owned AS (
        SELECT operation.id, operation.tenant_id, operation.cell_id,
               cell.protocol_version, cell.release_version
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant
          ON tenant.id = operation.tenant_id AND tenant.bound_cell_id = operation.cell_id
        JOIN exomem_cells AS cell
          ON cell.id = operation.cell_id
         AND cell.tenant_id = operation.tenant_id
         AND cell.routing_state = 'bound'
        WHERE operation.id = ${operation.id}::uuid
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
          AND operation.target_candidate_id IS NULL
          AND (operation.provider_result_ref IS NOT NULL OR cell.provider_ref IS NOT NULL)
        FOR UPDATE OF operation, tenant, cell
      ), observed AS MATERIALIZED (
        SELECT observation.cell_id, observation.source_release, observation.protocol_version,
               observation.command_fingerprint, observation.contract_digest,
               observation.compatibility_digest
        FROM exomem_routable_cell_contracts AS observation
        JOIN owned ON owned.cell_id = observation.cell_id
        WHERE observation.profile_id = 'hosted-alpha-agent-v1' AND observation.routable
        FOR SHARE OF observation
      ), assignment_target AS MATERIALIZED (
        SELECT assignment.candidate_id, assignment.id AS assignment_id,
               assignment.generation AS assignment_generation, assignment.source_release,
               assignment.protocol_version, assignment.gateway_contract_digest,
               assignment.command_fingerprint, assignment.schema_digest,
               assignment.compatibility_digest
        FROM exomem_agent_contract_rollout_assignments AS assignment
        JOIN owned ON owned.tenant_id = assignment.tenant_id
        JOIN observed ON observed.source_release = assignment.source_release
                     AND observed.protocol_version = assignment.protocol_version
                     AND observed.command_fingerprint = assignment.command_fingerprint
                     AND observed.contract_digest = assignment.schema_digest
                     AND observed.compatibility_digest = assignment.compatibility_digest
        WHERE assignment.state = 'active' AND assignment.expires_at > now()
        FOR SHARE OF assignment
      ), live_target AS MATERIALIZED (
        SELECT candidate.id AS candidate_id, NULL::uuid AS assignment_id,
               NULL::bigint AS assignment_generation, candidate.source_release,
               candidate.protocol_version,
               CASE candidate.source_release || ':' || candidate.protocol_version
                 WHEN ${exomemContractFixture0340.release + ":" + exomemContractFixture0340.protocol}
                   THEN ${exomemContractFixture0340.digest}
                 WHEN ${exomemContractFixture0350.release + ":" + exomemContractFixture0350.protocol}
                   THEN ${exomemContractFixture0350.digest}
                   WHEN ${exomemContractFixture0392.release + ":" + exomemContractFixture0392.protocol}
                     THEN ${exomemContractFixture0392.digest}
                   WHEN ${exomemContractFixture0490.release + ":" + exomemContractFixture0490.protocol}
                     THEN ${exomemContractFixture0490.digest}
                   WHEN ${exomemContractFixture0500.release + ":" + exomemContractFixture0500.protocol}
                     THEN ${exomemContractFixture0500.digest}
                   WHEN ${exomemContractFixture0541.release + ":" + exomemContractFixture0541.protocol}
                     THEN ${exomemContractFixture0541.digest}
                   WHEN ${exomemContractFixture0572.release + ":" + exomemContractFixture0572.protocol}
                     THEN ${exomemContractFixture0572.digest}
                   ELSE NULL
               END AS gateway_contract_digest,
               candidate.command_fingerprint, candidate.schema_digest,
               candidate.compatibility_digest
        FROM exomem_agent_contract_candidates AS candidate
        JOIN observed ON observed.source_release = candidate.source_release
                     AND observed.protocol_version = candidate.protocol_version
                     AND observed.command_fingerprint = candidate.command_fingerprint
                     AND observed.contract_digest = candidate.schema_digest
                     AND observed.compatibility_digest = candidate.compatibility_digest
        WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
          AND candidate.state = 'live'
          AND NOT EXISTS (SELECT 1 FROM assignment_target)
        FOR SHARE OF candidate
      ), target AS MATERIALIZED (
        SELECT * FROM assignment_target
        UNION ALL
        SELECT * FROM live_target WHERE gateway_contract_digest IS NOT NULL
      ), snapshotted AS (
        UPDATE exomem_lifecycle_operations AS operation
        SET target_candidate_id = target.candidate_id,
            target_assignment_id = target.assignment_id,
            target_assignment_generation = target.assignment_generation,
            target_source_release = target.source_release,
            target_protocol_version = target.protocol_version,
            target_gateway_contract_digest = target.gateway_contract_digest,
            target_command_fingerprint = target.command_fingerprint,
            target_schema_digest = target.schema_digest,
            target_compatibility_digest = target.compatibility_digest,
            updated_at = now()
        FROM owned, target
        WHERE operation.id = owned.id
        RETURNING operation.*
      )
      SELECT * FROM snapshotted
    `;
    return rows[0] ? operationFromRow(rows[0]) : null;
  }

  async renewLease(operationId: string, owner: string, leaseMs: number): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-renew-lease */
      UPDATE exomem_lifecycle_operations AS operation
      SET lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async advance(
    operationId: string,
    owner: string,
    expectedCheckpoint: string,
    nextCheckpoint: string
  ): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-advance */
      UPDATE exomem_lifecycle_operations AS operation
      SET checkpoint = ${nextCheckpoint},
          state = 'waiting',
          attempts = 0,
          error_code = NULL,
          next_attempt_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.checkpoint = ${expectedCheckpoint}
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async beginExport(operationId: string, owner: string, expiresAt: Date): Promise<boolean> {
    if (!Number.isFinite(expiresAt.getTime())) return false;
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-begin-export */
      UPDATE exomem_lifecycle_operations AS operation
      SET checkpoint = 'export-requested',
          export_expires_at = date_trunc(
            'milliseconds',
            COALESCE(operation.export_expires_at, ${expiresAt.toISOString()}::timestamptz)
          ),
          export_request_started = true,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.operation_type = 'export'
        AND operation.checkpoint IN ('quiesced', 'export-requested')
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.export_release_reference_ciphertext IS NULL
        AND (
          operation.export_expires_at IS NULL
          OR date_trunc('milliseconds', operation.export_expires_at)
               = ${expiresAt.toISOString()}::timestamptz
        )
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async recoverRecordedExport(
    operationId: string,
    owner: string
  ): Promise<ExportRecordDisposition | "missing"> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-recover-recorded-export */
      UPDATE exomem_lifecycle_operations AS operation
      SET export_expires_at = export_row.expires_at,
          export_request_started = true,
          updated_at = now()
      FROM exomem_exports AS export_row
      WHERE operation.id = ${operationId}
        AND operation.operation_type = 'export'
        AND operation.checkpoint IN ('quiesced', 'export-requested')
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.export_release_reference_ciphertext IS NOT NULL
        AND export_row.operation_id = operation.id
        AND export_row.tenant_id = operation.tenant_id
        AND export_row.cell_id = operation.cell_id
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING CASE
        WHEN export_row.expires_at > now() THEN 'available'
        ELSE 'expired'
      END AS disposition
    `;
    const disposition = rows[0]?.disposition;
    return disposition === "available" || disposition === "expired" ? disposition : "missing";
  }

  async advanceBillingTerminated(input: {
    operationId: string;
    owner: string;
    proof: BillingDeletionTarget;
  }): Promise<boolean> {
    const { proof } = input;
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-advance-billing-terminated */
      WITH matching AS MATERIALIZED (
        SELECT operation.id AS operation_id,
               entitlement.id AS entitlement_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
        WHERE operation.id = ${input.operationId}
          AND operation.operation_type = 'delete'
          AND operation.state = 'running'
          AND operation.checkpoint = 'quiesced'
          AND operation.lease_owner = ${input.owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
          AND operation.tenant_id = ${proof.tenantId}
          AND tenant.owner_user_id = ${proof.userId}
          AND tenant.status = 'deletion_pending'
          AND tenant.desired_state = 'deleted'
          AND entitlement.effective_state = 'deleted'
          AND entitlement.source = ${proof.source}
          AND entitlement.source_state = ${proof.sourceState}
          AND entitlement.source_revision IS NOT DISTINCT FROM ${proof.sourceRevision}
          AND entitlement.provider_environment IS NOT DISTINCT FROM ${proof.providerEnvironment}
          AND entitlement.provider_customer_ref IS NOT DISTINCT FROM ${proof.customerRef}
          AND entitlement.provider_subscription_ref IS NOT DISTINCT FROM ${proof.subscriptionRef}
          AND entitlement.provider_transaction_ref IS NOT DISTINCT FROM ${proof.transactionRef}
        FOR UPDATE OF operation, tenant, entitlement
      ),
      entitlement_marked AS (
        UPDATE exomem_entitlements AS entitlement
        SET source_state = CASE
              WHEN entitlement.source = 'paddle' THEN 'deletion_cancelled'
              ELSE entitlement.source_state
            END,
            provider_environment = NULL,
            provider_provenance_unresolved_fingerprint = NULL,
            provider_customer_ref = NULL,
            provider_subscription_ref = NULL,
            provider_transaction_ref = NULL,
            updated_at = now()
        FROM matching
        WHERE entitlement.id = matching.entitlement_id
        RETURNING matching.operation_id
      ),
      operation_advanced AS (
        UPDATE exomem_lifecycle_operations AS operation
        SET checkpoint = 'billing-quiesced',
            state = 'waiting',
            attempts = 0,
            error_code = NULL,
            next_attempt_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        FROM entitlement_marked
        WHERE operation.id = entitlement_marked.operation_id
        RETURNING operation.id
      )
      SELECT id FROM operation_advanced
    `;
    return rows.length === 1;
  }

  async retry(
    operationId: string,
    owner: string,
    errorCode: string,
    nextAttemptAt: Date
  ): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-retry */
      UPDATE exomem_lifecycle_operations AS operation
      SET state = 'failed_retryable',
          attempts = CASE WHEN ${errorCode} = 'CAPACITY_UNAVAILABLE' THEN GREATEST(attempts - 1, 0) ELSE attempts END,
          error_code = CASE
            WHEN operation.checkpoint IN (
              'candidate-cleanup', 'export-failure-resume', 'rollforward-recovery'
            )
              THEN operation.error_code
            ELSE ${errorCode}
          END,
          next_attempt_at = ${nextAttemptAt.toISOString()},
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async waitForProvider(
    operationId: string,
    owner: string,
    expectedCheckpoint: string,
    nextAttemptAt: Date
  ): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-wait-for-provider */
      UPDATE exomem_lifecycle_operations AS operation
      SET state = 'waiting',
          attempts = GREATEST(attempts - 1, 0),
          error_code = CASE
            WHEN operation.checkpoint = 'rollforward-recovery' THEN operation.error_code
            ELSE NULL
          END,
          next_attempt_at = ${nextAttemptAt.toISOString()},
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.checkpoint = ${expectedCheckpoint}
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async terminal(operationId: string, owner: string, errorCode: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-terminal */
      UPDATE exomem_lifecycle_operations AS operation
      SET state = 'failed_terminal',
          error_code = ${errorCode},
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async succeed(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-succeed */
      UPDATE exomem_lifecycle_operations AS operation
      SET state = 'succeeded',
          error_code = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
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
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-ensure-candidate */
      WITH owned AS (
        SELECT operation.id,
               operation.tenant_id,
               operation.cell_id,
               operation.expected_previous_cell_id,
               tenant.bound_cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        WHERE operation.id = ${input.operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${input.owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
          AND tenant.desired_state <> 'deleted'
        FOR UPDATE OF operation, tenant
      ),
      inserted AS (
        INSERT INTO exomem_cells (
          tenant_id, lifecycle_state, routing_state, desired_state,
          protocol_version, release_version, worker_policy,
          service_credential_ciphertext, service_credential_digest
        )
        SELECT owned.tenant_id,
               ${input.lifecycleState},
               'unbound',
               'running',
               ${input.protocolVersion},
               ${input.releaseVersion},
               ${JSON.stringify(input.workerPolicy)}::jsonb,
               ${JSON.stringify(input.credential.envelope)}::jsonb,
               ${input.credential.digest}
        FROM owned
        WHERE owned.cell_id IS NULL
        RETURNING *
      ),
      selected AS (
        SELECT cell.*
        FROM exomem_cells AS cell
        JOIN owned ON owned.cell_id = cell.id
                   AND owned.tenant_id = cell.tenant_id
        UNION ALL
        SELECT inserted.* FROM inserted
      ),
      attached AS (
        UPDATE exomem_lifecycle_operations AS operation
        SET cell_id = selected.id,
            expected_previous_cell_id = COALESCE(
              operation.expected_previous_cell_id,
              owned.bound_cell_id
            ),
            updated_at = now()
        FROM selected, owned
        WHERE operation.id = owned.id
        RETURNING operation.id
      )
      SELECT selected.*
      FROM selected
      JOIN attached ON TRUE
    `;
    return rows[0] ? cellFromRow(rows[0]) : null;
  }

  async getCell(cellId: string): Promise<CellControlRecord | null> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-get-cell */
      SELECT * FROM exomem_cells WHERE id = ${cellId} LIMIT 1
    `;
    return rows[0] ? cellFromRow(rows[0]) : null;
  }

  async recordProvisioned(input: {
    operationId: string;
    owner: string;
    providerRef: string;
    endpointEnvelope: SecretEnvelope;
  }): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-record-provisioned */
      UPDATE exomem_cells AS cell
      SET provider_ref = ${input.providerRef},
          private_endpoint_ciphertext = ${JSON.stringify(input.endpointEnvelope)}::jsonb,
          updated_at = now()
      FROM exomem_lifecycle_operations AS operation
      WHERE operation.id = ${input.operationId}
        AND operation.cell_id = cell.id
        AND operation.tenant_id = cell.tenant_id
        AND operation.state = 'running'
        AND operation.lease_owner = ${input.owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING cell.id
    `;
    return rows.length === 1;
  }

  async recordReadiness(input: {
    operationId: string;
    owner: string;
    code: string;
    contractIdentity?: CellContractIdentity;
    runtimeIdentity?: RuntimeTarget;
  }): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-record-readiness */
      UPDATE exomem_cells AS cell
      SET readiness_code = ${input.code},
          observed_gateway_contract_digest = CASE
            WHEN operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1' THEN NULL
            ELSE ${input.runtimeIdentity?.gatewayContractDigest ?? input.contractIdentity?.gatewayContractDigest ?? null}
          END,
          observed_command_fingerprint = CASE
            WHEN operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1' THEN NULL
            ELSE ${input.runtimeIdentity?.commandFingerprint ?? input.contractIdentity?.commandFingerprint ?? null}
          END,
          observed_schema_digest = CASE
            WHEN operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1' THEN NULL
            ELSE ${input.runtimeIdentity?.schemaDigest ?? input.contractIdentity?.schemaDigest ?? null}
          END,
          observed_compatibility_digest = CASE
            WHEN operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1' THEN NULL
            WHEN operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
              THEN operation.target_compatibility_digest
            ELSE ${input.contractIdentity?.compatibilityDigest ?? null}
          END,
          last_liveness_at = now(),
          last_readiness_at = now(),
          updated_at = now()
      FROM exomem_lifecycle_operations AS operation
      WHERE operation.id = ${input.operationId}
        AND operation.cell_id = cell.id
        AND operation.tenant_id = cell.tenant_id
        AND operation.state = 'running'
        AND operation.lease_owner = ${input.owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING cell.id
    `;
    return rows.length === 1;
  }

  async recordRollforward(input: {
    operationId: string;
    owner: string;
    code: string;
    runtimeIdentity: RuntimeTarget;
  }): Promise<boolean> {
    return withExomemTransaction(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
      const { rows } = await tx`
        /* exomem:lifecycle-record-rollforward */
        WITH owned AS MATERIALIZED (
          SELECT operation.id,
                 operation.tenant_id,
                 operation.cell_id,
                 operation.target_candidate_id,
                 operation.target_assignment_id,
                 operation.target_assignment_generation,
                 operation.target_source_release,
                 operation.target_protocol_version,
                 operation.target_gateway_contract_digest,
                 operation.target_command_fingerprint,
                 operation.target_schema_digest,
                 operation.target_compatibility_digest
          FROM exomem_lifecycle_operations AS operation
          JOIN exomem_tenants AS tenant
            ON tenant.id = operation.tenant_id
           AND tenant.bound_cell_id = operation.cell_id
           AND tenant.desired_state = 'suspended'
          JOIN exomem_cells AS cell
            ON cell.id = operation.cell_id
           AND cell.tenant_id = operation.tenant_id
           AND cell.routing_state = 'bound'
           AND cell.lifecycle_state = 'draining'
          JOIN exomem_agent_contract_candidates AS candidate
            ON candidate.id = operation.target_candidate_id
           AND candidate.profile_id = 'hosted-alpha-agent-v1'
           AND candidate.state IN ('pending', 'live')
           AND candidate.source_release = operation.target_source_release
           AND candidate.protocol_version = operation.target_protocol_version
           AND candidate.command_fingerprint = operation.target_command_fingerprint
           AND candidate.schema_digest = operation.target_schema_digest
           AND candidate.compatibility_digest = operation.target_compatibility_digest
          JOIN exomem_agent_contract_rollout_assignments AS assignment
            ON assignment.id = operation.target_assignment_id
           AND assignment.tenant_id = operation.tenant_id
           AND assignment.candidate_id = operation.target_candidate_id
           AND assignment.generation = operation.target_assignment_generation
           AND assignment.state IN ('preparing', 'active')
           AND assignment.expires_at > now()
           AND assignment.source_release = operation.target_source_release
           AND assignment.protocol_version = operation.target_protocol_version
           AND assignment.gateway_contract_digest = operation.target_gateway_contract_digest
           AND assignment.command_fingerprint = operation.target_command_fingerprint
           AND assignment.schema_digest = operation.target_schema_digest
           AND assignment.compatibility_digest = operation.target_compatibility_digest
          WHERE operation.id = ${input.operationId}::uuid
            AND operation.operation_type = 'rollforward'
            AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
            AND operation.checkpoint = 'verified'
            AND operation.state = 'running'
            AND operation.lease_owner = ${input.owner}
            AND operation.lease_expires_at > now()
            AND operation.fence_generation = tenant.fence_generation
            AND operation.expected_previous_cell_id IS NULL
            AND ${input.code} = 'CELL_READY'
            AND ${input.runtimeIdentity.releaseVersion} = operation.target_source_release
            AND ${input.runtimeIdentity.protocolVersion} = operation.target_protocol_version
            AND ${input.runtimeIdentity.agentProfile} = 'hosted-alpha-agent-v1'
            AND ${input.runtimeIdentity.gatewayContractDigest} = operation.target_gateway_contract_digest
            AND ${input.runtimeIdentity.commandFingerprint} = operation.target_command_fingerprint
            AND ${input.runtimeIdentity.schemaDigest} = operation.target_schema_digest
            AND ${input.runtimeIdentity.compatibilityDigest} = operation.target_compatibility_digest
          FOR UPDATE OF operation, tenant, cell, candidate, assignment
        ), retired_assignment AS (
          UPDATE exomem_agent_contract_rollout_assignments AS assignment
          SET state = 'retired',
              activated_at = NULL,
              ended_at = now(),
              version = version + 1,
              updated_at = now()
          FROM owned
          WHERE assignment.tenant_id = owned.tenant_id
            AND assignment.id <> owned.target_assignment_id
            AND assignment.state = 'active'
          RETURNING assignment.id
        ), activated_assignment AS (
          UPDATE exomem_agent_contract_rollout_assignments AS assignment
          SET state = 'active',
              activated_at = COALESCE(assignment.activated_at, now()),
              ended_at = NULL,
              version = CASE WHEN assignment.state = 'preparing' THEN version + 1 ELSE version END,
              updated_at = now()
          FROM owned
          WHERE assignment.id = owned.target_assignment_id
            AND assignment.state IN ('preparing', 'active')
            AND (
              NOT EXISTS (
                SELECT 1
                FROM exomem_agent_contract_rollout_assignments AS conflicting
                WHERE conflicting.tenant_id = owned.tenant_id
                  AND conflicting.id <> owned.target_assignment_id
                  AND conflicting.state = 'active'
              )
              OR EXISTS (SELECT 1 FROM retired_assignment)
            )
          RETURNING assignment.id
        ), cell_recorded AS (
          UPDATE exomem_cells AS cell
          SET release_version = owned.target_source_release,
              protocol_version = owned.target_protocol_version,
              observed_gateway_contract_digest = owned.target_gateway_contract_digest,
              observed_command_fingerprint = owned.target_command_fingerprint,
              observed_schema_digest = owned.target_schema_digest,
              observed_compatibility_digest = owned.target_compatibility_digest,
              readiness_code = 'CELL_READY',
              last_liveness_at = now(),
              last_readiness_at = now(),
              updated_at = now()
          FROM owned
          WHERE cell.id = owned.cell_id
            AND EXISTS (SELECT 1 FROM activated_assignment)
          RETURNING cell.id, cell.tenant_id
        ), observation_recorded AS (
          INSERT INTO exomem_routable_cell_contracts (
            cell_id, profile_id, source_release, protocol_version, command_fingerprint,
            contract_digest, compatibility_digest, routable, observed_at
          )
          SELECT owned.cell_id, 'hosted-alpha-agent-v1', owned.target_source_release,
                 owned.target_protocol_version, owned.target_command_fingerprint,
                 owned.target_schema_digest, owned.target_compatibility_digest, true, now()
          FROM owned
          JOIN cell_recorded ON cell_recorded.id = owned.cell_id
          ON CONFLICT (cell_id, profile_id) DO UPDATE
          SET source_release = EXCLUDED.source_release,
              protocol_version = EXCLUDED.protocol_version,
              command_fingerprint = EXCLUDED.command_fingerprint,
              contract_digest = EXCLUDED.contract_digest,
              compatibility_digest = EXCLUDED.compatibility_digest,
              routable = true,
              observed_at = now()
          RETURNING cell_id
        )
        SELECT owned.cell_id,
               owned.tenant_id,
               owned.target_candidate_id,
               owned.target_assignment_id,
               owned.target_assignment_generation
        FROM owned
        JOIN cell_recorded ON cell_recorded.id = owned.cell_id
        JOIN observation_recorded ON observation_recorded.cell_id = owned.cell_id
      `;
      const recorded = rows[0] as
        | {
            cell_id?: string;
            tenant_id?: string;
            target_candidate_id?: string;
            target_assignment_id?: string;
            target_assignment_generation?: number;
          }
        | undefined;
      if (
        !recorded?.cell_id ||
        !recorded.tenant_id ||
        !recorded.target_candidate_id ||
        !recorded.target_assignment_id ||
        !recorded.target_assignment_generation
      ) {
        return false;
      }
      await refreshRoutableProfileAuthorityInTransaction(tx, recorded.cell_id);
      await revokeTenantOAuthOutsideAssignmentInTransaction(tx, {
        tenantId: recorded.tenant_id,
        candidateId: recorded.target_candidate_id,
        assignmentId: recorded.target_assignment_id,
        assignmentGeneration: Number(recorded.target_assignment_generation),
      });
      return true;
    });
  }

  async recordOperationReference(
    operationId: string,
    owner: string,
    opaqueReference: string
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(opaqueReference)) return false;
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-record-provider-reference */
      UPDATE exomem_lifecycle_operations AS operation
      SET provider_result_ref = ${opaqueReference}, updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
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
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-record-export */
      WITH owned AS (
        SELECT operation.id, operation.tenant_id, operation.cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        WHERE operation.id = ${input.operationId}
          AND operation.tenant_id = ${input.tenantId}
          AND operation.cell_id = ${input.cellId}
          AND operation.operation_type = 'export'
          AND operation.checkpoint IN ('quiesced', 'export-requested')
          AND operation.export_request_started
          AND operation.export_expires_at = ${input.expiresAt.toISOString()}::timestamptz
          AND operation.state = 'running'
          AND operation.lease_owner = ${input.owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
      ),
      recorded AS (
        INSERT INTO exomem_exports (
          tenant_id, cell_id, operation_id, state,
          storage_reference_ciphertext, storage_reference_digest,
          archive_sha256, manifest_sha256, archive_size,
          encryption_scheme, integrity_verified, expires_at
        )
        SELECT owned.tenant_id,
               owned.cell_id,
               owned.id,
               CASE
                 WHEN ${input.expiresAt.toISOString()}::timestamptz > now() THEN 'available'
                 ELSE 'deleting'
               END,
               ${JSON.stringify(input.storageReferenceEnvelope)}::jsonb,
               ${input.storageReferenceDigest},
               ${input.archiveSha256},
               ${input.manifestSha256},
               ${input.archiveSize},
               ${input.encryptionScheme},
               ${input.integrityVerified},
               ${input.expiresAt.toISOString()}
        FROM owned
        ON CONFLICT (operation_id) DO UPDATE
        SET available_at = exomem_exports.available_at
        WHERE exomem_exports.storage_reference_digest = EXCLUDED.storage_reference_digest
          AND exomem_exports.archive_sha256 = EXCLUDED.archive_sha256
          AND exomem_exports.manifest_sha256 = EXCLUDED.manifest_sha256
          AND exomem_exports.archive_size = EXCLUDED.archive_size
          AND exomem_exports.encryption_scheme = EXCLUDED.encryption_scheme
          AND exomem_exports.integrity_verified
          AND exomem_exports.expires_at = EXCLUDED.expires_at
        RETURNING id,
                  CASE
                    WHEN expires_at > now() THEN 'available'
                    ELSE 'expired'
                  END AS disposition
      ), release_recorded AS (
        UPDATE exomem_lifecycle_operations AS operation
        SET export_release_reference_ciphertext =
              ${JSON.stringify(input.releaseReferenceEnvelope)}::jsonb,
            export_release_reference_digest = ${input.releaseReferenceDigest},
            checkpoint = CASE
              WHEN recorded.disposition = 'expired' THEN 'export-expired-release'
              ELSE operation.checkpoint
            END,
            updated_at = now()
        FROM recorded
        WHERE operation.id = ${input.operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${input.owner}
          AND operation.lease_expires_at > now()
          AND (
            operation.export_release_reference_digest IS NULL
            OR operation.export_release_reference_digest = ${input.releaseReferenceDigest}
          )
        RETURNING recorded.disposition
      )
      SELECT disposition FROM release_recorded
    `;
    const disposition = rows[0]?.disposition;
    return disposition === "available" || disposition === "expired" ? disposition : "conflict";
  }

  async acknowledgeExportRelease(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-acknowledge-export-release */
      UPDATE exomem_lifecycle_operations AS operation
      SET export_release_reference_ciphertext = NULL,
          export_release_reference_digest = NULL,
          checkpoint = 'cell-artifact-released',
          state = 'waiting',
          attempts = 0,
          error_code = NULL,
          next_attempt_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.operation_type = 'export'
        AND operation.checkpoint = 'export-stored'
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.export_release_reference_ciphertext IS NOT NULL
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async prepareExpiredExportRelease(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-prepare-expired-export-release */
      UPDATE exomem_lifecycle_operations AS operation
      SET checkpoint = 'export-expired-release', updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.operation_type = 'export'
        AND operation.checkpoint IN ('quiesced', 'export-requested')
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.export_release_reference_ciphertext IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async acknowledgeExpiredExportRelease(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-acknowledge-expired-export-release */
      UPDATE exomem_lifecycle_operations AS operation
      SET export_release_reference_ciphertext = NULL,
          export_release_reference_digest = NULL,
          checkpoint = 'export-expired-released',
          state = 'waiting',
          attempts = 0,
          error_code = NULL,
          next_attempt_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.operation_type = 'export'
        AND operation.checkpoint = 'export-expired-release'
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.export_release_reference_ciphertext IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async completeExpiredExportRestoration(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-complete-expired-export-restoration */
      UPDATE exomem_lifecycle_operations AS operation
      SET state = 'failed_terminal',
          error_code = 'EXPORT_EXPIRED',
          completed_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.operation_type = 'export'
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.export_release_reference_ciphertext IS NULL
        AND operation.export_release_reference_digest IS NULL
        AND (
          (
            NOT operation.resume_after_operation
            AND operation.checkpoint = 'export-expired-released'
            AND EXISTS (
              SELECT 1
              FROM exomem_tenants AS tenant
              JOIN exomem_cells AS cell
                ON cell.id = operation.cell_id
               AND cell.tenant_id = operation.tenant_id
              WHERE tenant.id = operation.tenant_id
                AND tenant.fence_generation = operation.fence_generation
                AND tenant.status = 'suspended'
                AND cell.lifecycle_state = 'quiesced'
            )
          )
          OR
          (
            operation.resume_after_operation
            AND operation.checkpoint = 'export-expired-readiness-proved'
            AND EXISTS (
              SELECT 1
              FROM exomem_tenants AS tenant
              JOIN exomem_cells AS cell
                ON cell.id = operation.cell_id
               AND cell.tenant_id = operation.tenant_id
              WHERE tenant.id = operation.tenant_id
                AND tenant.fence_generation = operation.fence_generation
                AND tenant.status = 'active'
                AND tenant.desired_state = 'running'
                AND cell.lifecycle_state = 'active'
                AND cell.desired_state = 'running'
                AND cell.readiness_code = 'CELL_READY'
            )
          )
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async bindCandidate(operationId: string, owner: string): Promise<boolean> {
    let transition: LifecycleCapacityTransition | undefined;
    const succeeded = await withExomemTransaction(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
      const { rows } = await tx`
      /* exomem:lifecycle-bind-candidate */
      WITH target_candidate_locked AS MATERIALIZED (
        SELECT contract_candidate.id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_agent_contract_candidates AS contract_candidate
          ON contract_candidate.id = operation.target_candidate_id
        WHERE operation.id = ${operationId}
        FOR UPDATE OF contract_candidate
      ),
      target_assignment_locked AS MATERIALIZED (
        SELECT assignment.id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.id = operation.target_assignment_id
        WHERE operation.id = ${operationId}
        FOR UPDATE OF assignment
      ),
      owned AS (
        SELECT operation.id,
               operation.tenant_id,
               operation.cell_id,
               operation.expected_previous_cell_id,
               operation.target_candidate_id,
               operation.target_assignment_id,
               operation.target_assignment_generation,
               operation.target_source_release,
               operation.target_protocol_version,
               operation.target_gateway_contract_digest,
               operation.target_command_fingerprint,
               operation.target_schema_digest,
               operation.target_compatibility_digest,
               operation.provisioner_wire_protocol,
               tenant.bound_cell_id,
               tenant.marketplace_reviewer_purpose AS tenant_marketplace_reviewer_purpose,
               candidate.routing_state,
               candidate.lifecycle_state
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        JOIN exomem_cells AS candidate
          ON candidate.id = operation.cell_id
         AND candidate.tenant_id = operation.tenant_id
        LEFT JOIN exomem_agent_contract_candidates AS contract_candidate
          ON contract_candidate.id = operation.target_candidate_id
        LEFT JOIN exomem_agent_contract_rollout_assignments AS target_assignment
          ON target_assignment.id = operation.target_assignment_id
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
          AND candidate.readiness_code = 'CELL_READY'
          AND tenant.desired_state <> 'deleted'
          AND (
            operation.target_candidate_id IS NULL
            OR (
              EXISTS (SELECT 1 FROM target_candidate_locked)
              AND contract_candidate.source_release = operation.target_source_release
              AND contract_candidate.protocol_version = operation.target_protocol_version
              AND contract_candidate.command_fingerprint = operation.target_command_fingerprint
              AND contract_candidate.schema_digest = operation.target_schema_digest
              AND contract_candidate.compatibility_digest = operation.target_compatibility_digest
              AND (
                (operation.target_assignment_id IS NULL AND contract_candidate.state = 'live')
                OR (
                  operation.target_assignment_id IS NOT NULL
                  AND contract_candidate.state IN ('pending', 'live')
                )
              )
              AND (
                (
                  operation.provisioner_wire_protocol <> 'exomem-cell-provisioner.v1'
                  AND
                  candidate.observed_gateway_contract_digest = operation.target_gateway_contract_digest
                  AND candidate.observed_command_fingerprint = operation.target_command_fingerprint
                  AND candidate.observed_schema_digest = operation.target_schema_digest
                  AND candidate.observed_compatibility_digest = operation.target_compatibility_digest
                )
                OR (
                  operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
                  AND operation.target_assignment_id IS NOT NULL
                  AND tenant.marketplace_reviewer_purpose = true
                  AND target_assignment.marketplace_reviewer_purpose = true
                  AND candidate.observed_gateway_contract_digest IS NULL
                  AND candidate.observed_command_fingerprint IS NULL
                  AND candidate.observed_schema_digest IS NULL
                  AND candidate.observed_compatibility_digest IS NULL
                )
              )
            )
          )
          AND (
            operation.target_assignment_id IS NULL
            OR EXISTS (
              SELECT 1 FROM target_assignment_locked
              WHERE target_assignment.tenant_id = operation.tenant_id
                AND target_assignment.candidate_id = operation.target_candidate_id
                AND target_assignment.generation = operation.target_assignment_generation
                AND target_assignment.state IN ('preparing', 'active')
                AND target_assignment.expires_at > now()
                AND target_assignment.source_release = operation.target_source_release
                AND target_assignment.protocol_version = operation.target_protocol_version
                AND target_assignment.gateway_contract_digest = operation.target_gateway_contract_digest
                AND target_assignment.command_fingerprint = operation.target_command_fingerprint
                AND target_assignment.schema_digest = operation.target_schema_digest
                AND target_assignment.compatibility_digest = operation.target_compatibility_digest
                AND (
                  operation.provisioner_wire_protocol <> 'exomem-cell-provisioner.v1'
                  OR (
                    tenant.marketplace_reviewer_purpose = true
                    AND target_assignment.marketplace_reviewer_purpose = true
                    AND candidate.observed_gateway_contract_digest IS NULL
                    AND candidate.observed_command_fingerprint IS NULL
                    AND candidate.observed_schema_digest IS NULL
                    AND candidate.observed_compatibility_digest IS NULL
                  )
                )
            )
          )
        FOR UPDATE OF operation, tenant, candidate
      ),
      activated_assignment AS (
        UPDATE exomem_agent_contract_rollout_assignments AS assignment
        SET state = 'active',
            activated_at = now(),
            ended_at = NULL,
            version = version + 1,
            updated_at = now()
        FROM owned
        WHERE assignment.id = owned.target_assignment_id
          AND assignment.tenant_id = owned.tenant_id
          AND assignment.candidate_id = owned.target_candidate_id
          AND assignment.generation = owned.target_assignment_generation
          AND assignment.state = 'preparing'
          AND assignment.expires_at > now()
          AND assignment.source_release = owned.target_source_release
          AND assignment.protocol_version = owned.target_protocol_version
          AND assignment.gateway_contract_digest = owned.target_gateway_contract_digest
          AND assignment.command_fingerprint = owned.target_command_fingerprint
          AND assignment.schema_digest = owned.target_schema_digest
          AND assignment.compatibility_digest = owned.target_compatibility_digest
        RETURNING assignment.id
      ),
      already_bound AS (
        SELECT owned.cell_id AS id, owned.tenant_id
        FROM owned
        WHERE owned.bound_cell_id = owned.cell_id
          AND owned.routing_state = 'bound'
          AND owned.lifecycle_state = 'active'
      ),
      retired AS (
        UPDATE exomem_cells AS prior
        SET routing_state = 'retiring', updated_at = now()
        FROM owned
        WHERE prior.id = owned.expected_previous_cell_id
          AND prior.tenant_id = owned.tenant_id
          AND owned.bound_cell_id IS NOT DISTINCT FROM owned.expected_previous_cell_id
          AND owned.routing_state = 'unbound'
          AND (
            owned.target_assignment_id IS NULL
            OR EXISTS (SELECT 1 FROM activated_assignment)
          )
        RETURNING prior.id
      ),
      prior_observation_unrouted AS (
        UPDATE exomem_routable_cell_contracts AS observation
        SET routable = false, observed_at = now()
        FROM owned
        WHERE observation.cell_id = owned.expected_previous_cell_id
          AND observation.profile_id = 'hosted-alpha-agent-v1'
          AND owned.expected_previous_cell_id IS NOT NULL
          AND (
            owned.target_assignment_id IS NULL
            OR EXISTS (SELECT 1 FROM activated_assignment)
          )
        RETURNING observation.cell_id
      ),
      replacement_observation AS (
        INSERT INTO exomem_routable_cell_contracts (
          cell_id, profile_id, source_release, protocol_version, command_fingerprint,
          contract_digest, compatibility_digest, routable, observed_at
        )
        SELECT owned.cell_id, 'hosted-alpha-agent-v1', owned.target_source_release,
               owned.target_protocol_version, owned.target_command_fingerprint,
               owned.target_schema_digest, owned.target_compatibility_digest, true, now()
        FROM owned
        WHERE owned.target_candidate_id IS NOT NULL
          AND (
            owned.target_assignment_id IS NULL
            OR EXISTS (SELECT 1 FROM activated_assignment)
          )
        ON CONFLICT (cell_id, profile_id) DO UPDATE
        SET source_release = EXCLUDED.source_release,
            protocol_version = EXCLUDED.protocol_version,
            command_fingerprint = EXCLUDED.command_fingerprint,
            contract_digest = EXCLUDED.contract_digest,
            compatibility_digest = EXCLUDED.compatibility_digest,
            routable = true,
            observed_at = now()
        RETURNING cell_id
      ),
      published AS (
        UPDATE exomem_cells AS candidate
        SET routing_state = 'bound',
            lifecycle_state = 'active',
            desired_state = 'running',
            bound_at = COALESCE(bound_at, now()),
            updated_at = now()
        FROM owned
        WHERE candidate.id = owned.cell_id
          AND owned.bound_cell_id IS NOT DISTINCT FROM owned.expected_previous_cell_id
          AND owned.routing_state = 'unbound'
          AND (
            owned.expected_previous_cell_id IS NULL
            OR EXISTS (SELECT 1 FROM retired)
          )
          AND (
            owned.target_assignment_id IS NULL
            OR EXISTS (SELECT 1 FROM activated_assignment)
          )
          AND (
            owned.target_candidate_id IS NULL
            OR EXISTS (SELECT 1 FROM replacement_observation)
          )
        RETURNING candidate.id, candidate.tenant_id
      ),
      tenant_active AS (
        UPDATE exomem_tenants AS tenant
        SET bound_cell_id = published.id,
            status = 'active',
            desired_state = 'running',
            updated_at = now()
        FROM published
        WHERE tenant.id = published.tenant_id
        RETURNING tenant.id
      )
      SELECT published.id,
             owned.tenant_id,
             owned.target_candidate_id,
             owned.target_assignment_id,
             owned.target_assignment_generation,
             owned.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
               AND owned.target_candidate_id IS NOT NULL AS refresh_promotion_authority
      FROM published
      JOIN tenant_active ON tenant_active.id = published.tenant_id
      JOIN owned ON owned.tenant_id = published.tenant_id
      UNION ALL
      SELECT already_bound.id,
             NULL::uuid AS tenant_id,
             NULL::uuid AS target_candidate_id,
             NULL::uuid AS target_assignment_id,
             NULL::bigint AS target_assignment_generation,
             owned.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
               AND owned.target_candidate_id IS NOT NULL AS refresh_promotion_authority
      FROM already_bound
      JOIN owned ON owned.cell_id = already_bound.id
      LIMIT 1
      `;
      if (rows.length !== 1) return false;
      const activated = rows[0] as {
        id?: string;
        tenant_id?: string;
        target_candidate_id?: string;
        target_assignment_id?: string;
        target_assignment_generation?: number;
        refresh_promotion_authority?: boolean;
      };
      if (activated.id && activated.refresh_promotion_authority) {
        await refreshRoutableProfileAuthorityInTransaction(tx, activated.id);
      }
      if (
        activated.tenant_id &&
        activated.target_candidate_id &&
        activated.target_assignment_id &&
        activated.target_assignment_generation
      ) {
        await revokeTenantOAuthOutsideAssignmentInTransaction(tx, {
          tenantId: activated.tenant_id,
          candidateId: activated.target_candidate_id,
          assignmentId: activated.target_assignment_id,
          assignmentGeneration: Number(activated.target_assignment_generation),
        });
      }
      transition = await this.#transitionCapacityForOwnedOperation(
        operationId,
        owner,
        "occupied",
        tx
      );
      if (!transition.succeeded) {
        throw new Error("capacity transition rejected");
      }
      return true;
    });
    if (transition?.previous) {
      emitCapacityTransitionAfterCommit({
        operationId,
        previous: transition.previous,
        next: "occupied",
      });
    }
    return succeeded;
  }

  async prepareCandidateCleanup(
    operationId: string,
    owner: string,
    errorCode: string
  ): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-prepare-candidate-cleanup */
      UPDATE exomem_lifecycle_operations AS operation
      SET checkpoint = 'candidate-cleanup',
          state = 'waiting',
          attempts = 0,
          error_code = ${errorCode},
          next_attempt_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      FROM exomem_cells AS candidate, exomem_tenants AS tenant
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.operation_type IN ('provision', 'restore')
        AND candidate.id = operation.cell_id
        AND candidate.tenant_id = operation.tenant_id
        AND candidate.routing_state = 'unbound'
        AND tenant.id = operation.tenant_id
        AND operation.fence_generation = tenant.fence_generation
        AND tenant.bound_cell_id IS DISTINCT FROM candidate.id
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async prepareExportRecovery(
    operationId: string,
    owner: string,
    errorCode: string
  ): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-prepare-export-recovery */
      UPDATE exomem_lifecycle_operations AS operation
      SET checkpoint = 'export-failure-resume',
          state = 'waiting',
          attempts = 0,
          error_code = ${errorCode},
          next_attempt_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.operation_type = 'export'
        AND operation.resume_after_operation
        AND operation.checkpoint <> 'created'
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async prepareRollforwardRecovery(
    operationId: string,
    owner: string,
    errorCode: string
  ): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-prepare-rollforward-recovery */
      UPDATE exomem_lifecycle_operations AS operation
      SET checkpoint = 'rollforward-recovery',
          state = 'waiting',
          attempts = 0,
          error_code = ${errorCode},
          next_attempt_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      FROM exomem_tenants AS tenant, exomem_cells AS cell
      WHERE operation.id = ${operationId}
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND operation.operation_type = 'rollforward'
        AND operation.checkpoint NOT IN ('created', 'rollforward-recovery')
        AND tenant.id = operation.tenant_id
        AND tenant.bound_cell_id = operation.cell_id
        AND tenant.fence_generation = operation.fence_generation
        AND tenant.desired_state = 'suspended'
        AND cell.id = operation.cell_id
        AND cell.tenant_id = operation.tenant_id
      RETURNING operation.id
    `;
    return rows.length === 1;
  }

  async completeRollforwardRecovery(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-complete-rollforward-recovery */
      WITH owned AS MATERIALIZED (
        SELECT operation.id, operation.tenant_id, operation.cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant
          ON tenant.id = operation.tenant_id
         AND tenant.bound_cell_id = operation.cell_id
         AND tenant.desired_state <> 'deleted'
        JOIN exomem_cells AS cell
          ON cell.id = operation.cell_id
         AND cell.tenant_id = operation.tenant_id
        WHERE operation.id = ${operationId}
          AND operation.operation_type = 'rollforward'
          AND operation.checkpoint = 'rollforward-recovery'
          AND operation.error_code IS NOT NULL
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
        FOR UPDATE OF operation, tenant, cell
      ), cell_active AS (
        UPDATE exomem_cells AS cell
        SET lifecycle_state = 'active', desired_state = 'running', updated_at = now()
        FROM owned
        WHERE cell.id = owned.cell_id
        RETURNING cell.tenant_id
      ), tenant_active AS (
        UPDATE exomem_tenants AS tenant
        SET status = 'active', desired_state = 'running', updated_at = now()
        FROM cell_active
        WHERE tenant.id = cell_active.tenant_id
        RETURNING tenant.id
      ), operation_failed AS (
        UPDATE exomem_lifecycle_operations AS operation
        SET state = 'failed_terminal',
            completed_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        FROM owned, tenant_active
        WHERE operation.id = owned.id
          AND tenant_active.id = owned.tenant_id
        RETURNING operation.id
      )
      SELECT id FROM operation_failed
    `;
    return rows.length === 1;
  }

  async markUnboundCellDestroyed(
    operationId: string,
    owner: string,
    cellId: string
  ): Promise<boolean> {
    return markUnboundCellDestroyedAtomic({
      operationId,
      leaseOwner: owner,
      cellId,
    });
  }

  async applyLocalGate(
    operationId: string,
    owner: string,
    desired: "suspended" | "running" | "deleted"
  ): Promise<boolean> {
    const tenantStatus = desired === "deleted" ? "deletion_pending" : "suspended";
    const cellDesired =
      desired === "deleted" ? "deleted" : desired === "running" ? "running" : "quiesced";
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-local-gate */
      WITH owned AS (
        SELECT operation.tenant_id, operation.cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant
          ON tenant.id = operation.tenant_id
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
          AND (
            ${desired}::text = 'deleted'
            OR tenant.bound_cell_id = operation.cell_id
          )
          AND (${desired}::text = 'deleted' OR tenant.desired_state <> 'deleted')
        FOR UPDATE OF operation, tenant
      ),
      tenant_gated AS (
        UPDATE exomem_tenants AS tenant
        SET status = ${tenantStatus},
            desired_state = ${desired},
            updated_at = now()
        FROM owned
        WHERE tenant.id = owned.tenant_id
        RETURNING tenant.id
      ),
      oauth_blocked AS (
        INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason)
        SELECT tenant.id, tenant.owner_user_id, 'lifecycle_deleted'
        FROM exomem_tenants AS tenant
        JOIN tenant_gated ON tenant_gated.id = tenant.id
        WHERE ${desired}::text = 'deleted'
        ON CONFLICT (tenant_id) DO UPDATE
        SET owner_user_id = EXCLUDED.owner_user_id
        RETURNING tenant_id
      ),
      oauth_grants_revoked AS (
        UPDATE exomem_oauth_grants AS oauth_grant
        SET revoked_at = COALESCE(oauth_grant.revoked_at, now()), updated_at = now()
        FROM tenant_gated
        WHERE ${desired}::text = 'deleted' AND oauth_grant.tenant_id = tenant_gated.id
        RETURNING oauth_grant.id, oauth_grant.authorization_transaction_id
      ),
      oauth_codes_revoked AS (
        UPDATE exomem_oauth_authorization_codes AS code
        SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE ${desired}::text = 'deleted'
          AND code.grant_id IN (SELECT id FROM oauth_grants_revoked)
        RETURNING code.id
      ),
      oauth_transactions_revoked AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction
        SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE ${desired}::text = 'deleted'
          AND (
            transaction.id IN (
              SELECT authorization_transaction_id FROM oauth_grants_revoked
              WHERE authorization_transaction_id IS NOT NULL
            )
            OR EXISTS (
              SELECT 1 FROM exomem_sessions AS session
              JOIN tenant_gated ON tenant_gated.id = session.tenant_id
              WHERE session.id = transaction.redeemed_session_id
            )
          )
        RETURNING transaction.id
      ),
      oauth_families_revoked AS (
        UPDATE exomem_oauth_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'lifecycle_deleted')
        WHERE ${desired}::text = 'deleted'
          AND family.grant_id IN (SELECT id FROM oauth_grants_revoked)
        RETURNING family.id
      ),
      oauth_access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE ${desired}::text = 'deleted'
          AND (
            token.grant_id IN (SELECT id FROM oauth_grants_revoked)
            OR token.family_id IN (SELECT id FROM oauth_families_revoked)
          )
        RETURNING token.id
      ),
      cell_gated AS (
        UPDATE exomem_cells AS cell
        SET lifecycle_state = 'draining',
            desired_state = ${cellDesired},
            updated_at = now()
        FROM owned, tenant_gated
        WHERE cell.id = owned.cell_id
          AND cell.tenant_id = tenant_gated.id
        RETURNING cell.id
      ),
      sessions_revoked AS (
        UPDATE exomem_sessions AS session
        SET revoked_at = COALESCE(session.revoked_at, now())
        FROM owned
        WHERE ${desired}::text = 'deleted'
          AND session.tenant_id = owned.tenant_id
          AND session.revoked_at IS NULL
        RETURNING session.id
      ),
      access_revoked AS (
        UPDATE exomem_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        FROM owned
        WHERE ${desired}::text = 'deleted'
          AND token.tenant_id = owned.tenant_id
          AND token.consumed_at IS NULL
          AND token.revoked_at IS NULL
        RETURNING token.id
      ),
      invites_revoked AS (
        UPDATE exomem_invites AS invite
        SET revoked_at = COALESCE(invite.revoked_at, now())
        FROM owned
        WHERE ${desired}::text = 'deleted'
          AND invite.redeemed_tenant_id = owned.tenant_id
          AND invite.consumed_at IS NULL
          AND invite.revoked_at IS NULL
        RETURNING invite.id
      ),
      transfers_revoked AS (
        UPDATE exomem_transfer_grants AS grant_row
        SET revoked_at = COALESCE(grant_row.revoked_at, now()),
            outcome_code = COALESCE(grant_row.outcome_code, 'DELETION_REVOKED')
        FROM owned
        WHERE ${desired}::text = 'deleted'
          AND grant_row.tenant_id = owned.tenant_id
          AND grant_row.revoked_at IS NULL
        RETURNING grant_row.id
      ),
      entitlement_deleted AS (
        UPDATE exomem_entitlements AS entitlement
        SET effective_state = 'deleted',
            capabilities = '[]'::jsonb,
            updated_at = now()
        FROM owned
        WHERE ${desired}::text = 'deleted'
          AND entitlement.tenant_id = owned.tenant_id
        RETURNING entitlement.id
      ),
      exports_deleting AS (
        UPDATE exomem_exports AS export_row
        SET state = 'deleting'
        FROM owned
        WHERE ${desired}::text = 'deleted'
          AND export_row.tenant_id = owned.tenant_id
          AND export_row.state <> 'deleted'
        RETURNING export_row.id
      )
      SELECT id FROM tenant_gated WHERE ${desired}::text = 'deleted'
      UNION ALL
      SELECT id FROM cell_gated WHERE ${desired}::text <> 'deleted'
      LIMIT 1
    `;
    return rows.length === 1;
  }

  async markCellState(
    operationId: string,
    owner: string,
    state: CellControlRecord["lifecycleState"]
  ): Promise<boolean> {
    const deleting = state === "deleted";
    let transition: LifecycleCapacityTransition | undefined;
    const succeeded = await withExomemTransaction(async (tx) => {
      const { rows } = await tx`
      /* exomem:lifecycle-mark-cell-state */
      WITH owned AS (
        SELECT operation.tenant_id, operation.cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
      ),
      cell_updated AS (
        UPDATE exomem_cells AS cell
        SET lifecycle_state = ${state},
            routing_state = CASE WHEN ${deleting} THEN 'retiring' ELSE routing_state END,
            desired_state = CASE WHEN ${deleting} THEN 'deleted' ELSE desired_state END,
            provider_ref = CASE WHEN ${deleting} THEN NULL ELSE provider_ref END,
            private_endpoint_ciphertext = CASE
              WHEN ${deleting} THEN NULL ELSE private_endpoint_ciphertext
            END,
            service_credential_ciphertext = CASE
              WHEN ${deleting} THEN NULL ELSE service_credential_ciphertext
            END,
            service_credential_digest = CASE
              WHEN ${deleting} THEN NULL ELSE service_credential_digest
            END,
            pending_service_credential_ciphertext = CASE
              WHEN ${deleting} THEN NULL ELSE pending_service_credential_ciphertext
            END,
            pending_service_credential_digest = CASE
              WHEN ${deleting} THEN NULL ELSE pending_service_credential_digest
            END,
            pending_credential_version = CASE
              WHEN ${deleting} THEN NULL ELSE pending_credential_version
            END,
            readiness_code = CASE WHEN ${deleting} THEN 'TENANT_DESTROYED' ELSE readiness_code END,
            retired_at = CASE WHEN ${deleting} THEN COALESCE(retired_at, now()) ELSE retired_at END,
            updated_at = now()
        FROM owned
        WHERE cell.tenant_id = owned.tenant_id
          AND (${deleting} OR cell.id = owned.cell_id)
        RETURNING cell.tenant_id, cell.id
      ),
      -- A destroyed cell must stop being routable in the same statement that
      -- retires it. Promotion live-probes every row where routable is true, so a
      -- row left behind by a destroyed cell is a ghost that fails the probe and
      -- blocks every future promotion with an unhelpful precondition_failed.
      -- Until now routable = false was set in exactly one place, the cell
      -- replacement path, which is keyed on expected_previous_cell_id and so
      -- never runs for a destroy.
      routable_cleared AS (
        UPDATE exomem_routable_cell_contracts AS observation
        SET routable = false, observed_at = now()
        FROM cell_updated
        WHERE ${deleting}
          AND observation.cell_id = cell_updated.id
          AND observation.routable
        RETURNING observation.cell_id
      ),
      affected_tenant AS (
        SELECT DISTINCT tenant_id FROM cell_updated
        UNION
        SELECT owned.tenant_id FROM owned WHERE ${deleting}
      ),
      tenant_updated AS (
        UPDATE exomem_tenants AS tenant
        SET bound_cell_id = CASE WHEN ${deleting} THEN NULL ELSE bound_cell_id END,
            status = CASE WHEN ${deleting} THEN 'deleted' ELSE status END,
            desired_state = CASE WHEN ${deleting} THEN 'deleted' ELSE desired_state END,
            deleted_at = CASE WHEN ${deleting} THEN now() ELSE deleted_at END,
            updated_at = now()
        FROM affected_tenant
        WHERE tenant.id = affected_tenant.tenant_id
        RETURNING tenant.id
      ),
      exports_deleted AS (
        UPDATE exomem_exports AS export_row
        SET state = 'deleted',
            storage_reference_ciphertext = NULL,
            storage_reference_digest = NULL,
            archive_sha256 = NULL,
            manifest_sha256 = NULL,
            archive_size = NULL,
            encryption_scheme = NULL,
            integrity_verified = NULL,
            provider_deleted_at = COALESCE(export_row.provider_deleted_at, now()),
            deleted_at = COALESCE(export_row.deleted_at, now())
        FROM tenant_updated
        WHERE ${deleting}
          AND export_row.tenant_id = tenant_updated.id
        RETURNING export_row.id
      ),
      operation_secrets_scrubbed AS (
        UPDATE exomem_lifecycle_operations AS lifecycle
        SET input_reference_ciphertext = NULL,
            input_reference_digest = NULL,
            input_source_cell_id = NULL,
            input_archive_sha256 = NULL,
            input_manifest_sha256 = NULL,
            input_archive_size = NULL,
            input_destroyed_at = CASE
              WHEN lifecycle.operation_type = 'restore'
                THEN COALESCE(lifecycle.input_destroyed_at, now())
              ELSE lifecycle.input_destroyed_at
            END,
            provider_result_ref = NULL,
            export_release_reference_ciphertext = NULL,
            export_release_reference_digest = NULL,
            updated_at = now()
        FROM tenant_updated
        WHERE ${deleting}
          AND lifecycle.tenant_id = tenant_updated.id
        RETURNING lifecycle.id
      ),
      entitlement_refs_scrubbed AS (
        UPDATE exomem_entitlements AS entitlement
        SET provider_customer_ref = NULL,
            provider_subscription_ref = NULL,
            provider_transaction_ref = NULL,
            provider_environment = NULL,
            provider_provenance_unresolved_fingerprint = NULL,
            updated_at = now()
        FROM tenant_updated
        WHERE ${deleting}
          AND entitlement.tenant_id = tenant_updated.id
        RETURNING entitlement.id
      ),
      invites_purged AS (
        DELETE FROM exomem_invites AS invite
        USING tenant_updated
        WHERE ${deleting}
          AND invite.redeemed_tenant_id = tenant_updated.id
          AND NOT EXISTS (
            SELECT 1
            FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
            WHERE authority.state = 'consumed'
              AND authority.invite_id = invite.id
              AND authority.outcome_tenant_id = tenant_updated.id
              AND authority.outcome_session_id = invite.redeemed_session_id
              AND invite.consumed_at IS NOT NULL
          )
        RETURNING invite.id
      ),
      sessions_purged AS (
        DELETE FROM exomem_sessions AS session
        USING tenant_updated,
              (SELECT count(*) AS purged FROM invites_purged) AS invite_dependency
        WHERE ${deleting}
          AND session.tenant_id = tenant_updated.id
          AND NOT EXISTS (
            SELECT 1
            FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
            WHERE authority.state = 'consumed'
              AND authority.outcome_session_id = session.id
              AND authority.outcome_tenant_id = tenant_updated.id
              AND session.revoked_at IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM exomem_invites AS invite
                WHERE invite.id = authority.invite_id
                  AND invite.consumed_at IS NOT NULL
                  AND invite.redeemed_tenant_id = tenant_updated.id
                  AND invite.redeemed_session_id = session.id
              )
          )
        RETURNING session.id
      ),
      access_tokens_purged AS (
        DELETE FROM exomem_access_tokens AS token
        USING tenant_updated
        WHERE ${deleting}
          AND token.tenant_id = tenant_updated.id
        RETURNING token.id
      ),
      transfers_purged AS (
        DELETE FROM exomem_transfer_grants AS grant_row
        USING tenant_updated
        WHERE ${deleting}
          AND grant_row.tenant_id = tenant_updated.id
        RETURNING grant_row.id
      )
      SELECT id FROM tenant_updated
    `;
      if (rows.length !== 1) return false;
      if (state === "quiesced" || state === "stopped") {
        transition = await this.#transitionCapacityForOwnedOperation(
          operationId,
          owner,
          "retained_storage",
          tx
        );
        if (!transition.succeeded) {
          throw new Error("capacity transition rejected");
        }
        return true;
      }
      if (state === "deleted") {
        transition = await this.#transitionCapacityForOwnedOperation(
          operationId,
          owner,
          "released",
          tx
        );
        if (!transition.succeeded) {
          throw new Error("capacity transition rejected");
        }
        return true;
      }
      return true;
    });
    const next = state === "deleted" ? "released" : "retained_storage";
    if (
      transition?.previous &&
      (state === "quiesced" || state === "stopped" || state === "deleted")
    ) {
      emitCapacityTransitionAfterCommit({ operationId, previous: transition.previous, next });
    }
    return succeeded;
  }

  async activateAfterReadiness(operationId: string, owner: string): Promise<boolean> {
    let transition: LifecycleCapacityTransition | undefined;
    const succeeded = await withExomemTransaction(async (tx) => {
      const { rows } = await tx`
      /* exomem:lifecycle-activate-after-readiness */
      WITH owned AS (
        SELECT operation.tenant_id, operation.cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant
          ON tenant.id = operation.tenant_id
         AND tenant.bound_cell_id = operation.cell_id
        JOIN exomem_cells AS cell
          ON cell.id = operation.cell_id
         AND cell.tenant_id = operation.tenant_id
         AND cell.readiness_code = 'CELL_READY'
         AND tenant.desired_state <> 'deleted'
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND operation.fence_generation = tenant.fence_generation
        FOR UPDATE OF operation, tenant, cell
      ),
      cell_active AS (
        UPDATE exomem_cells AS cell
        SET lifecycle_state = 'active', desired_state = 'running', updated_at = now()
        FROM owned
        WHERE cell.id = owned.cell_id
        RETURNING cell.tenant_id
      ),
      tenant_active AS (
        UPDATE exomem_tenants AS tenant
        SET status = 'active', desired_state = 'running', updated_at = now()
        FROM cell_active
        WHERE tenant.id = cell_active.tenant_id
        RETURNING tenant.id
      )
      SELECT id FROM tenant_active
    `;
      if (rows.length !== 1) return false;
      transition = await this.#transitionCapacityForOwnedOperation(
        operationId,
        owner,
        "occupied",
        tx
      );
      if (!transition.succeeded) {
        throw new Error("capacity transition rejected");
      }
      return true;
    });
    if (transition?.previous) {
      emitCapacityTransitionAfterCommit({
        operationId,
        previous: transition.previous,
        next: "occupied",
      });
    }
    return succeeded;
  }

  async prepareCredentialRotation(
    operationId: string,
    owner: string,
    credential: CandidateSecret
  ): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-prepare-credential-rotation */
      UPDATE exomem_cells AS cell
      SET pending_service_credential_ciphertext = COALESCE(
            pending_service_credential_ciphertext,
            ${JSON.stringify(credential.envelope)}::jsonb
          ),
          pending_service_credential_digest = COALESCE(
            pending_service_credential_digest,
            ${credential.digest}
          ),
          pending_credential_version = COALESCE(
            pending_credential_version,
            credential_version + 1
          ),
          updated_at = now()
      FROM exomem_lifecycle_operations AS operation
      WHERE operation.id = ${operationId}
        AND operation.cell_id = cell.id
        AND operation.tenant_id = cell.tenant_id
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
      RETURNING cell.id
    `;
    return rows.length === 1;
  }

  async promoteCredential(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-promote-credential */
      UPDATE exomem_cells AS cell
      SET service_credential_ciphertext = pending_service_credential_ciphertext,
          service_credential_digest = pending_service_credential_digest,
          credential_version = pending_credential_version,
          pending_service_credential_ciphertext = NULL,
          pending_service_credential_digest = NULL,
          pending_credential_version = NULL,
          updated_at = now()
      FROM exomem_lifecycle_operations AS operation
      WHERE operation.id = ${operationId}
        AND operation.cell_id = cell.id
        AND operation.tenant_id = cell.tenant_id
        AND operation.state = 'running'
        AND operation.lease_owner = ${owner}
        AND operation.lease_expires_at > now()
        AND EXISTS (
          SELECT 1 FROM exomem_tenants AS tenant
          WHERE tenant.id = operation.tenant_id
            AND tenant.fence_generation = operation.fence_generation
        )
        AND cell.pending_service_credential_ciphertext IS NOT NULL
        AND cell.pending_service_credential_digest IS NOT NULL
        AND cell.pending_credential_version = cell.credential_version + 1
      RETURNING cell.id
    `;
    return rows.length === 1;
  }

  async prepareCapacityProviderWork(
    operationId: string,
    owner: string,
    kind: "initial_provision" | "resume",
    leaseSeconds: number
  ): Promise<"acquired" | "exhausted" | "conflict" | "legacy"> {
    return acquireCapacityProviderWorkAtomic({
      operationId,
      leaseOwner: owner,
      kind,
      leaseSeconds,
    });
  }

  async releaseCapacityProviderWork(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-capacity-provider-work-release */
      SELECT allocation.id AS allocation_id
      FROM exomem_lifecycle_operations AS operation
      JOIN exomem_capacity_allocations AS allocation ON allocation.tenant_id = operation.tenant_id
      WHERE operation.id = ${operationId}::uuid
        AND operation.lease_owner = ${owner}
      LIMIT 1
    `;
    const allocation = rows[0] as { allocation_id?: string } | undefined;
    if (!allocation?.allocation_id) return false;
    return releaseCapacityProvisionClaim({
      allocationId: allocation.allocation_id,
      operationId,
      leaseOwner: owner,
    });
  }

  async statusForTenant(tenantId: string): Promise<LifecycleStatus> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-owner-status */
      SELECT tenant.status AS tenant_status,
             tenant.bound_cell_id,
             entitlement.source AS entitlement_source,
             entitlement.source_state AS entitlement_source_state,
             allocation.state AS allocation_state,
             allocation.operation_id AS allocation_operation_id,
             cell.lifecycle_state,
             cell.readiness_code,
             latest.state AS operation_state,
             latest.operation_type,
             latest.error_code,
             latest.request_id
      FROM exomem_tenants AS tenant
      LEFT JOIN exomem_entitlements AS entitlement
        ON entitlement.tenant_id = tenant.id
      LEFT JOIN exomem_capacity_allocations AS allocation
        ON allocation.tenant_id = tenant.id
       AND allocation.state <> 'released'
      LEFT JOIN exomem_cells AS cell
        ON cell.id = tenant.bound_cell_id
       AND cell.tenant_id = tenant.id
      LEFT JOIN LATERAL (
        SELECT state, operation_type, error_code, request_id
        FROM exomem_lifecycle_operations
        WHERE tenant_id = tenant.id
        ORDER BY updated_at DESC
        LIMIT 1
      ) AS latest ON TRUE
      WHERE tenant.id = ${tenantId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { state: "preparing", code: "TENANT_PREPARING", retryable: true };
    const requestId = row.request_id ? String(row.request_id) : undefined;
    if (row.tenant_status === "deleted") {
      return { state: "deleted", code: "EXOMEM_DELETED", retryable: false };
    }
    if (row.tenant_status === "deletion_pending" || row.operation_type === "delete") {
      return {
        state: "deletion_pending",
        code: "DELETION_IN_PROGRESS",
        ...(requestId ? { requestId } : {}),
        retryable: true,
      };
    }
    if (row.error_code === "CAPACITY_UNAVAILABLE") {
      return {
        state: "degraded",
        code: "CAPACITY_UNAVAILABLE",
        ...(requestId ? { requestId } : {}),
        retryable: true,
      };
    }
    if (row.tenant_status === "suspended") {
      return {
        state: "suspended",
        code: "EXOMEM_SUSPENDED",
        ...(requestId ? { requestId } : {}),
        retryable: false,
      };
    }
    if (
      row.entitlement_source === "paddle" &&
      (row.entitlement_source_state === "awaiting_checkout" ||
        row.entitlement_source_state === "checkout_pending") &&
      row.allocation_state === "reserved" &&
      !row.allocation_operation_id &&
      !row.operation_type
    ) {
      return { state: "awaiting_payment", code: "PAYMENT_REQUIRED", retryable: false };
    }
    if (
      row.tenant_status === "active" &&
      row.lifecycle_state === "active" &&
      row.readiness_code === "CELL_READY"
    ) {
      return { state: "ready", code: "CELL_READY", retryable: false };
    }
    if (row.operation_state === "failed_retryable" || row.operation_state === "failed_terminal") {
      return {
        state: "degraded",
        code: row.error_code ? String(row.error_code) : "CELL_UNAVAILABLE",
        ...(requestId ? { requestId } : {}),
        retryable: row.operation_state === "failed_retryable",
      };
    }
    return {
      state: "preparing",
      code: "CELL_PREPARING",
      ...(requestId ? { requestId } : {}),
      retryable: true,
    };
  }
}
