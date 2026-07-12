import { executeExomemSql } from "./db";
import type {
  CandidateSecret,
  CellControlRecord,
  LifecycleOperation,
  LifecycleOperationType,
  LifecycleStatus,
  LifecycleStore,
} from "./reconciler";
import type { CellWorkerPolicy } from "./provisioner";
import type { SecretEnvelope } from "./security";

type Row = Record<string, unknown>;

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

function operationFromRow(row: Row): LifecycleOperation {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    cellId: row.cell_id ? String(row.cell_id) : null,
    operationType: String(row.operation_type) as LifecycleOperationType,
    state: String(row.state) as LifecycleOperation["state"],
    idempotencyKey: String(row.idempotency_key),
    checkpoint: String(row.checkpoint),
    requestId: String(row.request_id),
    attempts: Number(row.attempts),
    nextAttemptAt: asDate(row.next_attempt_at),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: row.lease_expires_at ? asDate(row.lease_expires_at) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    providerResultRef: row.provider_result_ref ? String(row.provider_result_ref) : null,
    expectedPreviousCellId: row.expected_previous_cell_id
      ? String(row.expected_previous_cell_id)
      : null,
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
    credentialEnvelope: asObject(row.service_credential_ciphertext) as SecretEnvelope,
    credentialDigest: asBuffer(row.service_credential_digest),
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

export class SqlLifecycleStore implements LifecycleStore {
  async enqueue(
    tenantId: string,
    operationType: LifecycleOperationType,
    idempotencyKey: string,
    cellId: string | null = null
  ): Promise<LifecycleOperation> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-enqueue */
      INSERT INTO exomem_lifecycle_operations (
        tenant_id, cell_id, operation_type, idempotency_key
      )
      SELECT tenant.id,
             CASE
               WHEN ${cellId}::uuid IS NOT NULL THEN ${cellId}::uuid
               WHEN ${operationType}::text IN ('provision', 'restore') THEN NULL
               ELSE tenant.bound_cell_id
             END,
             ${operationType},
             ${idempotencyKey}
      FROM exomem_tenants AS tenant
      WHERE tenant.id = ${tenantId}
        AND tenant.status <> 'deleted'
      ON CONFLICT (tenant_id, operation_type, idempotency_key) DO UPDATE
      SET updated_at = exomem_lifecycle_operations.updated_at
      RETURNING *
    `;
    const row = rows[0];
    if (!row) throw new Error("lifecycle enqueue failed");
    return operationFromRow(row);
  }

  async claim(input: {
    owner: string;
    leaseMs: number;
    maxAttempts: number;
    tenantId?: string;
  }): Promise<LifecycleOperation | null> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-claim */
      WITH candidate AS (
        SELECT id
        FROM exomem_lifecycle_operations
        WHERE next_attempt_at <= now()
          AND attempts <= ${input.maxAttempts}
          AND (${input.tenantId ?? null}::uuid IS NULL OR tenant_id = ${input.tenantId ?? null}::uuid)
          AND (
            state IN ('pending', 'failed_retryable', 'waiting')
            OR (state = 'running' AND lease_expires_at <= now())
          )
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED
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
    return rows[0] ? operationFromRow(rows[0]) : null;
  }

  async renewLease(operationId: string, owner: string, leaseMs: number): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-renew-lease */
      UPDATE exomem_lifecycle_operations
      SET lease_expires_at = now() + (${leaseMs} * interval '1 millisecond'),
          updated_at = now()
      WHERE id = ${operationId}
        AND state = 'running'
        AND lease_owner = ${owner}
        AND lease_expires_at > now()
      RETURNING id
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
      UPDATE exomem_lifecycle_operations
      SET checkpoint = ${nextCheckpoint},
          state = 'waiting',
          error_code = NULL,
          next_attempt_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${operationId}
        AND state = 'running'
        AND lease_owner = ${owner}
        AND lease_expires_at > now()
        AND checkpoint = ${expectedCheckpoint}
      RETURNING id
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
      UPDATE exomem_lifecycle_operations
      SET state = 'failed_retryable',
          error_code = ${errorCode},
          next_attempt_at = ${nextAttemptAt.toISOString()},
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${operationId}
        AND state = 'running'
        AND lease_owner = ${owner}
        AND lease_expires_at > now()
      RETURNING id
    `;
    return rows.length === 1;
  }

  async terminal(operationId: string, owner: string, errorCode: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-terminal */
      UPDATE exomem_lifecycle_operations
      SET state = 'failed_terminal',
          error_code = ${errorCode},
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE id = ${operationId}
        AND state = 'running'
        AND lease_owner = ${owner}
        AND lease_expires_at > now()
      RETURNING id
    `;
    return rows.length === 1;
  }

  async succeed(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-succeed */
      UPDATE exomem_lifecycle_operations
      SET state = 'succeeded',
          error_code = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE id = ${operationId}
        AND state = 'running'
        AND lease_owner = ${owner}
        AND lease_expires_at > now()
      RETURNING id
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
               tenant.bound_cell_id,
               candidate.routing_state,
               candidate.lifecycle_state,
               candidate.readiness_code
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        WHERE operation.id = ${input.operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${input.owner}
          AND operation.lease_expires_at > now()
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
      RETURNING cell.id
    `;
    return rows.length === 1;
  }

  async recordReadiness(input: {
    operationId: string;
    owner: string;
    code: string;
  }): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-record-readiness */
      UPDATE exomem_cells AS cell
      SET readiness_code = ${input.code},
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
      RETURNING cell.id
    `;
    return rows.length === 1;
  }

  async recordOperationReference(
    operationId: string,
    owner: string,
    opaqueReference: string
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(opaqueReference)) return false;
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-record-provider-reference */
      UPDATE exomem_lifecycle_operations
      SET provider_result_ref = ${opaqueReference}, updated_at = now()
      WHERE id = ${operationId}
        AND state = 'running'
        AND lease_owner = ${owner}
        AND lease_expires_at > now()
      RETURNING id
    `;
    return rows.length === 1;
  }

  async bindCandidate(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-bind-candidate */
      WITH owned AS (
        SELECT operation.id,
               operation.tenant_id,
               operation.cell_id,
               operation.expected_previous_cell_id,
               tenant.bound_cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        JOIN exomem_cells AS candidate
          ON candidate.id = operation.cell_id
         AND candidate.tenant_id = operation.tenant_id
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
          AND candidate.readiness_code = 'CELL_READY'
        FOR UPDATE OF operation, tenant, candidate
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
        RETURNING prior.id
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
      SELECT published.id
      FROM published
      JOIN tenant_active ON tenant_active.id = published.tenant_id
      UNION ALL
      SELECT already_bound.id
      FROM already_bound
      LIMIT 1
    `;
    return rows.length === 1;
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
         AND tenant.bound_cell_id = operation.cell_id
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
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
      cell_gated AS (
        UPDATE exomem_cells AS cell
        SET lifecycle_state = 'draining',
            desired_state = ${cellDesired},
            updated_at = now()
        FROM owned, tenant_gated
        WHERE cell.id = owned.cell_id
          AND cell.tenant_id = tenant_gated.id
        RETURNING cell.id
      )
      SELECT id FROM cell_gated
    `;
    return rows.length === 1;
  }

  async markCellState(
    operationId: string,
    owner: string,
    state: CellControlRecord["lifecycleState"]
  ): Promise<boolean> {
    const deleting = state === "deleted";
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-mark-cell-state */
      WITH owned AS (
        SELECT operation.tenant_id, operation.cell_id
        FROM exomem_lifecycle_operations AS operation
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
      ),
      cell_updated AS (
        UPDATE exomem_cells AS cell
        SET lifecycle_state = ${state},
            routing_state = CASE WHEN ${deleting} THEN 'retiring' ELSE routing_state END,
            updated_at = now()
        FROM owned
        WHERE cell.id = owned.cell_id
          AND cell.tenant_id = owned.tenant_id
        RETURNING cell.tenant_id, cell.id
      ),
      tenant_updated AS (
        UPDATE exomem_tenants AS tenant
        SET bound_cell_id = CASE WHEN ${deleting} THEN NULL ELSE bound_cell_id END,
            status = CASE WHEN ${deleting} THEN 'deleted' ELSE status END,
            desired_state = CASE WHEN ${deleting} THEN 'deleted' ELSE desired_state END,
            deleted_at = CASE WHEN ${deleting} THEN now() ELSE deleted_at END,
            updated_at = now()
        FROM cell_updated
        WHERE tenant.id = cell_updated.tenant_id
        RETURNING tenant.id
      )
      SELECT id FROM tenant_updated
    `;
    return rows.length === 1;
  }

  async activateAfterReadiness(operationId: string, owner: string): Promise<boolean> {
    const { rows } = await executeExomemSql`
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
        WHERE operation.id = ${operationId}
          AND operation.state = 'running'
          AND operation.lease_owner = ${owner}
          AND operation.lease_expires_at > now()
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
    return rows.length === 1;
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
        AND cell.pending_service_credential_ciphertext IS NOT NULL
        AND cell.pending_service_credential_digest IS NOT NULL
        AND cell.pending_credential_version = cell.credential_version + 1
      RETURNING cell.id
    `;
    return rows.length === 1;
  }

  async statusForTenant(tenantId: string): Promise<LifecycleStatus> {
    const { rows } = await executeExomemSql`
      /* exomem:lifecycle-owner-status */
      SELECT tenant.status AS tenant_status,
             tenant.bound_cell_id,
             cell.lifecycle_state,
             cell.readiness_code,
             latest.state AS operation_state,
             latest.operation_type,
             latest.error_code,
             latest.request_id
      FROM exomem_tenants AS tenant
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
    if (row.tenant_status === "suspended") {
      return {
        state: "suspended",
        code: "EXOMEM_SUSPENDED",
        ...(requestId ? { requestId } : {}),
        retryable: false,
      };
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
