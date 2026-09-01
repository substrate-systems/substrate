import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { exomemErrors } from "./errors";
import { EXOMEM_HOSTED_PROFILE } from "./hosted-profile";
import {
  revokeOAuthAccountForOwnerTenantAtomic,
  revokeOAuthTokenFamilyForOwner,
} from "./oauth-store";
import {
  documentDigest,
  fetchCimdMetadata,
  normalizeOperatorOAuthClientRegistration,
  oauthClientConfigSha256,
  operatorOAuthClientFingerprint,
  type CimdFetchedMetadata,
  type OperatorOAuthClientRegistration,
} from "./oauth-client-admission";
import { exomemContractFixture0681 } from "./gateway-contract-0-68-1";

export type OperatorOAuthClient = {
  id: string;
  enabled: boolean;
  admissionMode: "pinned" | "cimd";
  clientFingerprint: string;
  redirectDigest: string;
  redirectCount: number;
  metadataExpiresAt: string | null;
};

export type ReviewerOAuthBootstrapAuthority = {
  id: string;
  state: "active" | "consumed" | "revoked" | "expired";
  expiresAt: string;
  outcomeTenantId: string | null;
  outcomeAssignmentId: string | null;
  outcomeAssignmentGeneration: number | null;
  outcomeOperationId: string | null;
  outcomeSessionId: string | null;
  outcomeGrantId: string | null;
};

export type ExpiredReviewerCleanupRecovery = {
  outcome: "enqueued" | "replayed";
  operationId: string;
} | null;

export type StrandedCellDeleteSupersession = {
  outcome: "enqueued" | "replayed";
  operationId: string;
} | null;

type StrandedCellDeleteInput = {
  operationId: string;
  expectedFence: number;
};

export type TerminalReviewerDeleteRecovery = {
  outcome: "enqueued" | "replayed";
  operationId: string;
} | null;

export type DivergedCellReleaseCorrection = {
  outcome: "corrected" | "replayed";
  assignmentId: string;
} | null;

type ExpiredReviewerCleanupInput = {
  sourceOperationId: string;
  expectedFence: number;
};

type TerminalReviewerDeleteInput = {
  operationId: string;
  expectedFence: number;
};

type DivergedCellReleaseInput = {
  cellId: string;
  candidateId: string;
  expectedCurrentRelease: string;
  expectedFence: number;
};

function assertExpiredReviewerCleanupInput(input: ExpiredReviewerCleanupInput): void {
  if (
    !UUID.test(input.sourceOperationId) ||
    !Number.isSafeInteger(input.expectedFence) ||
    input.expectedFence < 1
  ) {
    throw exomemErrors.invalidRequest();
  }
}

function assertTerminalReviewerDeleteInput(input: TerminalReviewerDeleteInput): void {
  if (
    !UUID.test(input.operationId) ||
    !Number.isSafeInteger(input.expectedFence) ||
    input.expectedFence < 1
  )
    throw exomemErrors.invalidRequest();
}

function assertDivergedCellReleaseInput(input: DivergedCellReleaseInput): void {
  if (
    !UUID.test(input.cellId) ||
    !UUID.test(input.candidateId) ||
    !RELEASE.test(input.expectedCurrentRelease) ||
    !Number.isSafeInteger(input.expectedFence) ||
    input.expectedFence < 1
  ) {
    throw exomemErrors.invalidRequest();
  }
}

/**
 * The facts a diverged cell must satisfy before its recorded release may be moved.
 *
 * Every clause is a corroboration, not a convenience: the correction never invents an
 * identity, it only copies one that was already minted for this tenant and cataloged as
 * a candidate. `prior` is the terminal assignment carrying that identity, and it is the
 * only source of `gateway_contract_digest` — that digest is not on the candidate row,
 * and synthesising one here would let the control plane assert a contract nobody
 * reviewed.
 *
 * The correction repeats this predicate inside its own single statement rather than
 * calling this. The duplication is deliberate: the reconciler does not take the cohort
 * lock, so it can create a lifecycle operation between a preflight read and a later
 * write, and only a predicate evaluated in the same statement as the mutation is sound.
 * A stale preflight can therefore produce a refusal but never an unsafe write.
 * `correctionAgreesWithPreflight` in the integration suite holds the two together.
 */
function divergedCellReleaseEligibility(tx: ExomemSql, input: DivergedCellReleaseInput) {
  return tx`
    SELECT cell.id AS cell_id, cell.tenant_id, tenant.marketplace_reviewer_purpose,
           prior.id AS prior_assignment_id, prior.candidate_id,
           prior.source_release, prior.protocol_version, prior.gateway_contract_digest,
           prior.command_fingerprint, prior.schema_digest, prior.compatibility_digest
    FROM exomem_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    JOIN exomem_agent_contract_candidates AS candidate
      ON candidate.id = ${input.candidateId}::uuid
     AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
     AND candidate.state = 'pending'
     AND candidate.protocol_version = cell.protocol_version
     AND candidate.source_release <> cell.release_version
    JOIN exomem_agent_contract_rollout_assignments AS prior
      ON prior.tenant_id = cell.tenant_id
     AND prior.candidate_id = candidate.id
     AND prior.marketplace_reviewer_purpose = true
     AND prior.source_release = candidate.source_release
     AND prior.protocol_version = candidate.protocol_version
     AND prior.command_fingerprint = candidate.command_fingerprint
     AND prior.schema_digest = candidate.schema_digest
     AND prior.compatibility_digest = candidate.compatibility_digest
     AND (
       (prior.state = 'expired' AND prior.expires_at <= now())
       OR (prior.state = 'failed' AND prior.ended_at IS NOT NULL)
     )
    WHERE cell.id = ${input.cellId}::uuid
      AND cell.release_version = ${input.expectedCurrentRelease}
      AND cell.lifecycle_state <> 'deleted'
      AND cell.routing_state IN ('bound', 'retiring')
      AND cell.observed_gateway_contract_digest IS NOT NULL
      AND cell.observed_command_fingerprint IS NOT NULL
      AND cell.observed_schema_digest IS NOT NULL
      AND cell.observed_compatibility_digest IS NOT NULL
      AND tenant.deleted_at IS NULL
      AND tenant.marketplace_reviewer_purpose = true
      AND tenant.fence_generation = ${input.expectedFence}::bigint
      AND (SELECT count(*) FROM exomem_cells AS only_cell
           WHERE only_cell.tenant_id = cell.tenant_id
             AND only_cell.lifecycle_state <> 'deleted') = 1
      AND NOT EXISTS (SELECT 1 FROM exomem_lifecycle_operations AS inflight
                      WHERE inflight.tenant_id = cell.tenant_id
                        AND inflight.state NOT IN ('succeeded', 'failed_terminal'))
      AND NOT EXISTS (SELECT 1 FROM exomem_agent_contract_rollout_assignments AS current
                      WHERE current.tenant_id = cell.tenant_id
                        AND current.state IN ('preparing', 'active'))
  `;
}

/** Read-only fail-closed eligibility check for the single terminal reviewer delete replay. */
export async function preflightRecoverTerminalReviewerDelete(
  input: TerminalReviewerDeleteInput
): Promise<{ eligible: boolean }> {
  assertTerminalReviewerDeleteInput(input);
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:preflight-recover-terminal-reviewer-delete */
    SELECT EXISTS (
      SELECT 1
      FROM exomem_lifecycle_operations AS operation
      JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
      JOIN exomem_cells AS cell ON cell.tenant_id = tenant.id
      JOIN exomem_capacity_allocations AS allocation ON allocation.tenant_id = tenant.id
      JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
      JOIN exomem_lifecycle_operations AS source
        ON source.tenant_id = tenant.id
       AND source.fence_generation = operation.fence_generation - 1
       AND source.state = 'failed_terminal' AND source.error_code = 'DELETION_SUPERSEDED'
       AND source.operation_type IN ('provision', 'restore')
      JOIN exomem_access_tokens AS confirmation
        ON confirmation.tenant_id = tenant.id
       AND confirmation.user_id = tenant.owner_user_id
       AND confirmation.purpose = 'deletion_confirmation'
       AND confirmation.consumed_at IS NOT NULL
      JOIN exomem_agent_contract_rollout_assignments AS assignment
       ON assignment.id = source.target_assignment_id
       AND assignment.tenant_id = tenant.id
       AND assignment.candidate_id = source.target_candidate_id
       AND assignment.generation = source.target_assignment_generation
       AND assignment.marketplace_reviewer_purpose = true
       AND assignment.source_release = source.target_source_release
       AND assignment.protocol_version = source.target_protocol_version
       AND assignment.gateway_contract_digest = source.target_gateway_contract_digest
       AND assignment.command_fingerprint = source.target_command_fingerprint
       AND assignment.schema_digest = source.target_schema_digest
       AND assignment.compatibility_digest = source.target_compatibility_digest
       AND ((assignment.state = 'expired' AND assignment.expires_at <= now())
         OR (assignment.state = 'failed' AND assignment.ended_at IS NOT NULL))
      JOIN exomem_agent_contract_candidates AS candidate
        ON candidate.id = source.target_candidate_id
       AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
       AND candidate.source_release = source.target_source_release
       AND candidate.protocol_version = source.target_protocol_version
       AND candidate.command_fingerprint = source.target_command_fingerprint
       AND candidate.schema_digest = source.target_schema_digest
       AND candidate.compatibility_digest = source.target_compatibility_digest
      JOIN exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
       ON bootstrap.state = 'consumed'
       AND bootstrap.outcome_tenant_id = tenant.id
       AND bootstrap.outcome_assignment_id = assignment.id
       AND bootstrap.outcome_assignment_generation = assignment.generation
       AND bootstrap.outcome_operation_id = source.id
       AND bootstrap.candidate_id = source.target_candidate_id
       AND bootstrap.candidate_profile_id = ${EXOMEM_HOSTED_PROFILE}
       AND bootstrap.candidate_contract_digest = candidate.schema_digest
       AND bootstrap.candidate_source_release = source.target_source_release
       AND bootstrap.candidate_protocol_version = source.target_protocol_version
       AND bootstrap.candidate_gateway_contract_digest = source.target_gateway_contract_digest
       AND bootstrap.candidate_command_fingerprint = source.target_command_fingerprint
       AND bootstrap.candidate_schema_digest = source.target_schema_digest
       AND bootstrap.candidate_compatibility_digest = source.target_compatibility_digest
      JOIN exomem_invites AS invite
        ON invite.id = bootstrap.invite_id AND invite.consumed_at IS NOT NULL
       AND invite.redeemed_tenant_id = tenant.id AND invite.redeemed_session_id = bootstrap.outcome_session_id
      JOIN exomem_sessions AS session
        ON session.id = bootstrap.outcome_session_id AND session.tenant_id = tenant.id
       AND session.revoked_at IS NOT NULL
      WHERE operation.id = ${input.operationId}::uuid
        AND operation.operation_type = 'delete'
        AND operation.state = 'failed_terminal' AND operation.error_code = 'LIFECYCLE_MAX_ATTEMPTS'
        AND operation.checkpoint = 'destroyed'
        AND operation.completed_at IS NOT NULL AND operation.lease_owner IS NULL
        AND operation.lease_expires_at IS NULL AND operation.fence_generation = ${input.expectedFence}::bigint
        AND operation.cell_id IS NULL AND operation.expected_previous_cell_id IS NULL
        AND operation.target_candidate_id IS NULL AND operation.target_assignment_id IS NULL
        AND operation.target_assignment_generation IS NULL
        AND operation.idempotency_key = 'confirmed-deletion-' || confirmation.id::text
        AND tenant.fence_generation = ${input.expectedFence}::bigint
        AND tenant.marketplace_reviewer_purpose = true
        AND tenant.status = 'deletion_pending' AND tenant.desired_state = 'deleted'
        AND tenant.deleted_at IS NULL AND tenant.bound_cell_id IS NULL
        AND cell.routing_state = 'unbound' AND cell.lifecycle_state <> 'deleted' AND cell.provider_ref IS NULL
        AND source.cell_id = cell.id
        AND (SELECT count(*) FROM exomem_cells AS only_cell
             WHERE only_cell.tenant_id = tenant.id AND only_cell.lifecycle_state <> 'deleted') = 1
        AND allocation.state = 'uncertain'
        AND pool.reserved_storage_bytes = (SELECT COALESCE(sum(a.storage_bytes), 0)
                                          FROM exomem_capacity_allocations AS a
                                          WHERE a.pool_id = pool.id AND a.state <> 'released')
        AND pool.reserved_runtime_slots = (SELECT COALESCE(sum(a.runtime_slots), 0)
                                           FROM exomem_capacity_allocations AS a
                                           WHERE a.pool_id = pool.id AND a.state IN ('reserved', 'occupied', 'uncertain'))
        AND pool.reserved_provision_slots = (SELECT COALESCE(sum(a.provision_slots), 0)
                                             FROM exomem_capacity_allocations AS a
                                             WHERE a.pool_id = pool.id AND a.state = 'reserved')
        AND NOT EXISTS (SELECT 1 FROM exomem_lifecycle_operations AS conflicting
                        WHERE conflicting.tenant_id = tenant.id AND conflicting.id <> operation.id
                          AND conflicting.state NOT IN ('succeeded', 'failed_terminal'))
        AND NOT EXISTS (SELECT 1 FROM exomem_agent_contract_rollout_assignments AS live_assignment
                        WHERE live_assignment.tenant_id = tenant.id AND live_assignment.state = 'active'
                          AND live_assignment.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
                        WHERE credential.tenant_id = tenant.id AND credential.revoked_at IS NULL
                          AND credential.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS live_bootstrap
                        WHERE live_bootstrap.state = 'active' AND live_bootstrap.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM exomem_oauth_grants AS grant_row
                        WHERE grant_row.tenant_id = tenant.id AND grant_row.revoked_at IS NULL)
    ) AS eligible
    `;
    return { eligible: rows[0]?.eligible === true };
  });
}

/** Reopen only the stored local finalizer for a provider-proven terminal delete. */
export async function recoverTerminalReviewerDelete(
  input: TerminalReviewerDeleteInput & { requestId: string; operatorPrincipalDigest: Buffer }
): Promise<TerminalReviewerDeleteRecovery> {
  assertTerminalReviewerDeleteInput(input);
  if (!UUID.test(input.requestId) || input.operatorPrincipalDigest.byteLength !== 32)
    throw exomemErrors.invalidRequest();
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:recover-terminal-reviewer-delete */
      WITH operation AS MATERIALIZED (
        SELECT operation.*, tenant.owner_user_id AS tenant_owner_user_id,
               tenant.fence_generation AS tenant_fence_generation,
               tenant.status AS tenant_status, tenant.desired_state AS tenant_desired_state,
               tenant.marketplace_reviewer_purpose, tenant.deleted_at AS tenant_deleted_at,
               tenant.bound_cell_id
        FROM exomem_lifecycle_operations AS operation
        JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
        WHERE operation.id = ${input.operationId}::uuid
          AND operation.fence_generation = ${input.expectedFence}::bigint
        FOR UPDATE OF operation, tenant
      ), replay AS MATERIALIZED (
        SELECT operation.id AS operation_id, operation.tenant_id
        FROM operation
        WHERE operation.operation_type = 'delete' AND operation.checkpoint = 'destroyed'
          AND operation.fence_generation = operation.tenant_fence_generation
          AND operation.state IN ('waiting', 'running', 'succeeded')
          AND EXISTS (SELECT 1 FROM exomem_audit_events AS audit
                      WHERE audit.operation_id = operation.id
                        AND audit.event_type = 'operator.terminal_reviewer_delete.authorized')
      ), eligible AS MATERIALIZED (
        SELECT operation.*
        FROM operation
        JOIN exomem_cells AS cell ON cell.tenant_id = operation.tenant_id
        JOIN exomem_capacity_allocations AS allocation ON allocation.tenant_id = operation.tenant_id
        JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
        JOIN exomem_lifecycle_operations AS source
          ON source.tenant_id = operation.tenant_id
         AND source.fence_generation = operation.fence_generation - 1
         AND source.state = 'failed_terminal' AND source.error_code = 'DELETION_SUPERSEDED'
         AND source.operation_type IN ('provision', 'restore')
        JOIN exomem_access_tokens AS confirmation
          ON confirmation.tenant_id = operation.tenant_id
         AND confirmation.user_id = operation.tenant_owner_user_id
         AND confirmation.purpose = 'deletion_confirmation'
         AND confirmation.consumed_at IS NOT NULL
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.id = source.target_assignment_id
         AND assignment.tenant_id = operation.tenant_id
         AND assignment.candidate_id = source.target_candidate_id
         AND assignment.generation = source.target_assignment_generation
         AND assignment.marketplace_reviewer_purpose = true
         AND assignment.source_release = source.target_source_release
         AND assignment.protocol_version = source.target_protocol_version
         AND assignment.gateway_contract_digest = source.target_gateway_contract_digest
         AND assignment.command_fingerprint = source.target_command_fingerprint
         AND assignment.schema_digest = source.target_schema_digest
         AND assignment.compatibility_digest = source.target_compatibility_digest
         AND ((assignment.state = 'expired' AND assignment.expires_at <= now())
           OR (assignment.state = 'failed' AND assignment.ended_at IS NOT NULL))
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = source.target_candidate_id
         AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
         AND candidate.source_release = source.target_source_release
         AND candidate.protocol_version = source.target_protocol_version
         AND candidate.command_fingerprint = source.target_command_fingerprint
         AND candidate.schema_digest = source.target_schema_digest
         AND candidate.compatibility_digest = source.target_compatibility_digest
        JOIN exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
          ON bootstrap.state = 'consumed'
         AND bootstrap.outcome_tenant_id = operation.tenant_id
         AND bootstrap.outcome_assignment_id = assignment.id
         AND bootstrap.outcome_assignment_generation = assignment.generation
         AND bootstrap.outcome_operation_id = source.id
         AND bootstrap.candidate_id = source.target_candidate_id
         AND bootstrap.candidate_profile_id = ${EXOMEM_HOSTED_PROFILE}
         AND bootstrap.candidate_contract_digest = candidate.schema_digest
         AND bootstrap.candidate_source_release = source.target_source_release
         AND bootstrap.candidate_protocol_version = source.target_protocol_version
         AND bootstrap.candidate_gateway_contract_digest = source.target_gateway_contract_digest
         AND bootstrap.candidate_command_fingerprint = source.target_command_fingerprint
         AND bootstrap.candidate_schema_digest = source.target_schema_digest
         AND bootstrap.candidate_compatibility_digest = source.target_compatibility_digest
        JOIN exomem_invites AS invite
          ON invite.id = bootstrap.invite_id AND invite.consumed_at IS NOT NULL
         AND invite.redeemed_tenant_id = operation.tenant_id
         AND invite.redeemed_session_id = bootstrap.outcome_session_id
        JOIN exomem_sessions AS session
          ON session.id = bootstrap.outcome_session_id AND session.tenant_id = operation.tenant_id
         AND session.revoked_at IS NOT NULL
        WHERE NOT EXISTS (SELECT 1 FROM replay)
          AND operation.operation_type = 'delete'
          AND operation.state = 'failed_terminal' AND operation.error_code = 'LIFECYCLE_MAX_ATTEMPTS'
          AND operation.checkpoint = 'destroyed'
          AND operation.completed_at IS NOT NULL AND operation.lease_owner IS NULL
          AND operation.lease_expires_at IS NULL
          AND operation.cell_id IS NULL AND operation.expected_previous_cell_id IS NULL
          AND operation.target_candidate_id IS NULL AND operation.target_assignment_id IS NULL
          AND operation.target_assignment_generation IS NULL
          AND operation.idempotency_key = 'confirmed-deletion-' || confirmation.id::text
          AND operation.tenant_fence_generation = ${input.expectedFence}::bigint
          AND operation.marketplace_reviewer_purpose = true
          AND operation.tenant_status = 'deletion_pending' AND operation.tenant_desired_state = 'deleted'
          AND operation.tenant_deleted_at IS NULL AND operation.bound_cell_id IS NULL
          AND cell.routing_state = 'unbound' AND cell.lifecycle_state <> 'deleted' AND cell.provider_ref IS NULL
          AND source.cell_id = cell.id
          AND (SELECT count(*) FROM exomem_cells AS only_cell
               WHERE only_cell.tenant_id = operation.tenant_id AND only_cell.lifecycle_state <> 'deleted') = 1
          AND allocation.state = 'uncertain'
          AND pool.reserved_storage_bytes = (SELECT COALESCE(sum(a.storage_bytes), 0)
                                            FROM exomem_capacity_allocations AS a
                                            WHERE a.pool_id = pool.id AND a.state <> 'released')
          AND pool.reserved_runtime_slots = (SELECT COALESCE(sum(a.runtime_slots), 0)
                                             FROM exomem_capacity_allocations AS a
                                             WHERE a.pool_id = pool.id AND a.state IN ('reserved', 'occupied', 'uncertain'))
          AND pool.reserved_provision_slots = (SELECT COALESCE(sum(a.provision_slots), 0)
                                               FROM exomem_capacity_allocations AS a
                                               WHERE a.pool_id = pool.id AND a.state = 'reserved')
          AND NOT EXISTS (SELECT 1 FROM exomem_lifecycle_operations AS conflicting
                          WHERE conflicting.tenant_id = operation.tenant_id AND conflicting.id <> operation.id
                            AND conflicting.state NOT IN ('succeeded', 'failed_terminal'))
          AND NOT EXISTS (SELECT 1 FROM exomem_agent_contract_rollout_assignments AS live_assignment
                          WHERE live_assignment.tenant_id = operation.tenant_id AND live_assignment.state = 'active'
                            AND live_assignment.expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
                          WHERE credential.tenant_id = operation.tenant_id AND credential.revoked_at IS NULL
                            AND credential.expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS live_bootstrap
                          WHERE live_bootstrap.state = 'active' AND live_bootstrap.expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM exomem_oauth_grants AS grant_row
                          WHERE grant_row.tenant_id = operation.tenant_id AND grant_row.revoked_at IS NULL)
      ), reopened AS (
        UPDATE exomem_lifecycle_operations AS operation
        SET state = 'waiting', attempts = 0, error_code = NULL, next_attempt_at = now(),
            lease_owner = NULL, lease_expires_at = NULL, completed_at = NULL, updated_at = now()
        FROM eligible
        WHERE operation.id = eligible.id
        RETURNING operation.id, operation.tenant_id
      ), authorized_audit AS (
        INSERT INTO exomem_audit_events (event_type, outcome, tenant_id, operation_id, request_id, principal_scope_digest)
        SELECT 'operator.terminal_reviewer_delete.authorized', 'pending', tenant_id, id,
               ${input.requestId}::uuid, ${input.operatorPrincipalDigest}
        FROM reopened RETURNING id
      ), replay_audit AS (
        INSERT INTO exomem_audit_events (event_type, outcome, tenant_id, operation_id, request_id, principal_scope_digest)
        SELECT 'operator.terminal_reviewer_delete.replayed', 'succeeded', tenant_id, operation_id,
               ${input.requestId}::uuid, ${input.operatorPrincipalDigest}
        FROM replay RETURNING id
      )
      SELECT 'enqueued'::text AS outcome, id::text AS operation_id FROM reopened
      UNION ALL
      SELECT 'replayed'::text AS outcome, operation_id::text FROM replay
    `;
    const row = rows[0] as { outcome?: unknown; operation_id?: unknown } | undefined;
    return (row?.outcome === "enqueued" || row?.outcome === "replayed") &&
      typeof row.operation_id === "string"
      ? { outcome: row.outcome, operationId: row.operation_id }
      : null;
  });
}

/** Read-only fail-closed eligibility check for the single expired-reviewer recovery. */
export async function preflightRecoverExpiredReviewerCleanup(
  input: ExpiredReviewerCleanupInput
): Promise<{ eligible: boolean }> {
  assertExpiredReviewerCleanupInput(input);
  const { rows } = await executeExomemSql`
    /* exomem:preflight-recover-expired-reviewer-cleanup */
    SELECT EXISTS (
      SELECT 1
      FROM exomem_lifecycle_operations AS source
      JOIN exomem_tenants AS tenant ON tenant.id = source.tenant_id
      JOIN exomem_cells AS cell ON cell.id = source.cell_id AND cell.tenant_id = tenant.id
      JOIN exomem_agent_contract_candidates AS candidate
        ON candidate.id = source.target_candidate_id
       AND candidate.source_release = source.target_source_release
       AND candidate.protocol_version = source.target_protocol_version
       AND candidate.command_fingerprint = source.target_command_fingerprint
       AND candidate.schema_digest = source.target_schema_digest
       AND candidate.compatibility_digest = source.target_compatibility_digest
      JOIN exomem_agent_contract_rollout_assignments AS assignment
        ON assignment.id = source.target_assignment_id
       AND assignment.tenant_id = tenant.id
       AND assignment.candidate_id = source.target_candidate_id
       AND assignment.generation = source.target_assignment_generation
       AND assignment.source_release = source.target_source_release
       AND assignment.protocol_version = source.target_protocol_version
       AND assignment.gateway_contract_digest = source.target_gateway_contract_digest
       AND assignment.command_fingerprint = source.target_command_fingerprint
       AND assignment.schema_digest = source.target_schema_digest
       AND assignment.compatibility_digest = source.target_compatibility_digest
      WHERE source.id = ${input.sourceOperationId}::uuid
        AND (source.lease_expires_at IS NULL OR source.lease_expires_at <= now())
        AND source.fence_generation = ${input.expectedFence}::bigint
        AND tenant.fence_generation = ${input.expectedFence}::bigint
        AND tenant.marketplace_reviewer_purpose = true
        AND tenant.deleted_at IS NULL
        AND (SELECT COUNT(*) FROM exomem_cells AS only_cell
             WHERE only_cell.tenant_id = tenant.id AND only_cell.lifecycle_state <> 'deleted') = 1
        AND (
          (
            source.operation_type IN ('provision', 'restore')
            AND source.state IN ('waiting', 'failed_retryable')
            AND source.checkpoint = 'candidate-cleanup'
            AND tenant.status = 'provisioning' AND tenant.desired_state = 'running'
            AND tenant.bound_cell_id IS NULL
            AND cell.routing_state = 'unbound' AND cell.lifecycle_state <> 'deleted'
          )
          OR
          (
            source.operation_type = 'provision'
            AND source.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
            AND source.state = 'succeeded'
            AND source.checkpoint = 'bound'
            AND source.error_code IS NULL
            AND source.completed_at IS NOT NULL
            AND source.lease_owner IS NULL AND source.lease_expires_at IS NULL
            AND tenant.status = 'active' AND tenant.desired_state = 'running'
            AND tenant.bound_cell_id = cell.id
            AND cell.lifecycle_state = 'active'
            AND cell.routing_state = 'bound'
            AND cell.desired_state = 'running'
            AND cell.readiness_code = 'CELL_READY'
            AND cell.provider_ref IS NOT NULL
            AND cell.release_version = source.target_source_release
            AND cell.protocol_version = source.target_protocol_version
            AND cell.observed_gateway_contract_digest = source.target_gateway_contract_digest
            AND cell.observed_command_fingerprint = source.target_command_fingerprint
            AND cell.observed_schema_digest = source.target_schema_digest
            AND cell.observed_compatibility_digest = source.target_compatibility_digest
            AND EXISTS (
              SELECT 1 FROM exomem_routable_cell_contracts AS route
              WHERE route.cell_id = cell.id
                AND route.profile_id = candidate.profile_id
                AND route.source_release = source.target_source_release
                AND route.protocol_version = source.target_protocol_version
                AND route.command_fingerprint = source.target_command_fingerprint
                AND route.contract_digest = source.target_schema_digest
                AND route.compatibility_digest = source.target_compatibility_digest
                AND route.routable = true
            )
          )
        )
        AND assignment.marketplace_reviewer_purpose = true
        AND (
          (assignment.state = 'expired' AND assignment.expires_at <= now())
          OR (assignment.state = 'failed' AND assignment.ended_at IS NOT NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM exomem_agent_contract_rollout_assignments AS live_assignment
          WHERE live_assignment.tenant_id = tenant.id AND live_assignment.state = 'active'
            AND live_assignment.expires_at > now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
          WHERE authority.state = 'active' AND authority.expires_at > now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM exomem_lifecycle_operations AS conflicting
          WHERE conflicting.tenant_id = tenant.id
            AND conflicting.fence_generation = tenant.fence_generation
            AND conflicting.id <> source.id
            AND conflicting.state NOT IN ('succeeded', 'failed_terminal')
        )
    ) AS eligible
  `;
  return { eligible: rows[0]?.eligible === true };
}

/**
 * Authorize exactly one stranded reviewer cleanup.  This is deliberately one
 * SQL statement so access revocation cannot commit without a higher-fence
 * target-free DESTROY operation and its durable receipt.
 */
export async function recoverExpiredReviewerCleanup(
  input: ExpiredReviewerCleanupInput & { requestId: string; operatorPrincipalDigest: Buffer }
): Promise<ExpiredReviewerCleanupRecovery> {
  assertExpiredReviewerCleanupInput(input);
  if (!UUID.test(input.requestId) || input.operatorPrincipalDigest.byteLength !== 32)
    throw exomemErrors.invalidRequest();
  return withReviewerCleanupControlLocks(async (tx) => {
    const { rows } = await tx`
      /* exomem:recover-expired-reviewer-cleanup */
      WITH source AS MATERIALIZED (
        SELECT source.*, tenant.owner_user_id, tenant.fence_generation AS tenant_fence_generation,
               tenant.status AS tenant_status, tenant.desired_state AS tenant_desired_state,
               tenant.marketplace_reviewer_purpose, tenant.deleted_at AS tenant_deleted_at,
               tenant.bound_cell_id, cell.id AS matched_cell_id,
               candidate.profile_id AS target_profile_id
        FROM exomem_lifecycle_operations AS source
        JOIN exomem_tenants AS tenant ON tenant.id = source.tenant_id
        JOIN exomem_cells AS cell ON cell.id = source.cell_id AND cell.tenant_id = tenant.id
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = source.target_candidate_id
         AND candidate.source_release = source.target_source_release
         AND candidate.protocol_version = source.target_protocol_version
         AND candidate.command_fingerprint = source.target_command_fingerprint
         AND candidate.schema_digest = source.target_schema_digest
         AND candidate.compatibility_digest = source.target_compatibility_digest
        WHERE source.id = ${input.sourceOperationId}::uuid
          AND source.fence_generation = ${input.expectedFence}::bigint
        FOR UPDATE OF source, tenant, cell
      ), delete_key AS MATERIALIZED (
        SELECT source.id, encode(digest(convert_to(source.id::text || ':recover-expired-reviewer-cleanup', 'utf8'), 'sha256'), 'hex') AS value
        FROM source
      ), replay AS MATERIALIZED (
        SELECT delete_operation.id AS operation_id
        FROM source
        JOIN delete_key ON delete_key.id = source.id
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.id = source.target_assignment_id
         AND assignment.tenant_id = source.tenant_id
         AND assignment.candidate_id = source.target_candidate_id
         AND assignment.generation = source.target_assignment_generation
         AND assignment.source_release = source.target_source_release
         AND assignment.protocol_version = source.target_protocol_version
         AND assignment.gateway_contract_digest = source.target_gateway_contract_digest
         AND assignment.command_fingerprint = source.target_command_fingerprint
         AND assignment.schema_digest = source.target_schema_digest
         AND assignment.compatibility_digest = source.target_compatibility_digest
        JOIN exomem_lifecycle_operations AS delete_operation
          ON delete_operation.tenant_id = source.tenant_id
         AND delete_operation.operation_type = 'delete'
         AND delete_operation.idempotency_key = delete_key.value
         AND delete_operation.fence_generation = ${input.expectedFence}::bigint + 1
         AND delete_operation.target_candidate_id IS NULL
         AND delete_operation.target_assignment_id IS NULL
         AND delete_operation.target_assignment_generation IS NULL
        WHERE (
            (source.state = 'failed_terminal' AND source.error_code = 'DELETION_SUPERSEDED')
            OR
            (source.operation_type = 'provision'
             AND source.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
             AND source.state = 'succeeded'
             AND source.checkpoint = 'bound')
          )
          AND source.marketplace_reviewer_purpose = true
          AND source.tenant_deleted_at IS NULL
          AND assignment.marketplace_reviewer_purpose = true
          AND (
            (assignment.state = 'expired' AND assignment.expires_at <= now())
            OR (assignment.state = 'failed' AND assignment.ended_at IS NOT NULL)
          )
          AND source.tenant_status = 'deletion_pending'
          AND source.tenant_desired_state = 'deleted'
          AND source.tenant_fence_generation = ${input.expectedFence}::bigint + 1
          AND (SELECT COUNT(*) FROM exomem_lifecycle_operations AS exact_delete
               WHERE exact_delete.tenant_id = source.tenant_id
                 AND exact_delete.operation_type = 'delete'
                 AND exact_delete.idempotency_key = delete_key.value
                 AND exact_delete.fence_generation = ${input.expectedFence}::bigint + 1
                 AND exact_delete.target_candidate_id IS NULL
                 AND exact_delete.target_assignment_id IS NULL
                 AND exact_delete.target_assignment_generation IS NULL) = 1
      ), eligible AS MATERIALIZED (
        SELECT source.*
        FROM source
        JOIN exomem_cells AS cell ON cell.id = source.matched_cell_id
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.id = source.target_assignment_id
         AND assignment.tenant_id = source.tenant_id
         AND assignment.candidate_id = source.target_candidate_id
         AND assignment.generation = source.target_assignment_generation
         AND assignment.source_release = source.target_source_release
         AND assignment.protocol_version = source.target_protocol_version
         AND assignment.gateway_contract_digest = source.target_gateway_contract_digest
         AND assignment.command_fingerprint = source.target_command_fingerprint
         AND assignment.schema_digest = source.target_schema_digest
         AND assignment.compatibility_digest = source.target_compatibility_digest
        WHERE NOT EXISTS (SELECT 1 FROM replay)
          AND (source.lease_expires_at IS NULL OR source.lease_expires_at <= now())
          AND source.tenant_fence_generation = ${input.expectedFence}::bigint
          AND source.marketplace_reviewer_purpose = true
          AND source.tenant_deleted_at IS NULL
          AND (SELECT COUNT(*) FROM exomem_cells AS only_cell
               WHERE only_cell.tenant_id = source.tenant_id AND only_cell.lifecycle_state <> 'deleted') = 1
          AND (
            (
              source.operation_type IN ('provision', 'restore')
              AND source.state IN ('waiting', 'failed_retryable')
              AND source.checkpoint = 'candidate-cleanup'
              AND source.tenant_status = 'provisioning'
              AND source.tenant_desired_state = 'running'
              AND source.bound_cell_id IS NULL
              AND cell.routing_state = 'unbound'
              AND cell.lifecycle_state <> 'deleted'
            )
            OR
            (
              source.operation_type = 'provision'
              AND source.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
              AND source.state = 'succeeded'
              AND source.checkpoint = 'bound'
              AND source.error_code IS NULL
              AND source.completed_at IS NOT NULL
              AND source.lease_owner IS NULL AND source.lease_expires_at IS NULL
              AND source.tenant_status = 'active'
              AND source.tenant_desired_state = 'running'
              AND source.bound_cell_id = cell.id
              AND cell.lifecycle_state = 'active'
              AND cell.routing_state = 'bound'
              AND cell.desired_state = 'running'
              AND cell.readiness_code = 'CELL_READY'
              AND cell.provider_ref IS NOT NULL
              AND cell.release_version = source.target_source_release
              AND cell.protocol_version = source.target_protocol_version
              AND cell.observed_gateway_contract_digest = source.target_gateway_contract_digest
              AND cell.observed_command_fingerprint = source.target_command_fingerprint
              AND cell.observed_schema_digest = source.target_schema_digest
              AND cell.observed_compatibility_digest = source.target_compatibility_digest
              AND EXISTS (
                SELECT 1 FROM exomem_routable_cell_contracts AS route
                WHERE route.cell_id = cell.id
                  AND route.profile_id = source.target_profile_id
                  AND route.source_release = source.target_source_release
                  AND route.protocol_version = source.target_protocol_version
                  AND route.command_fingerprint = source.target_command_fingerprint
                  AND route.contract_digest = source.target_schema_digest
                  AND route.compatibility_digest = source.target_compatibility_digest
                  AND route.routable = true
              )
            )
          )
          AND assignment.marketplace_reviewer_purpose = true
          AND (
            (assignment.state = 'expired' AND assignment.expires_at <= now())
            OR (assignment.state = 'failed' AND assignment.ended_at IS NOT NULL)
          )
          AND NOT EXISTS (SELECT 1 FROM exomem_agent_contract_rollout_assignments AS live_assignment
                          WHERE live_assignment.tenant_id = source.tenant_id AND live_assignment.state = 'active'
                            AND live_assignment.expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
                          WHERE authority.state = 'active' AND authority.expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM exomem_lifecycle_operations AS conflicting
                          WHERE conflicting.tenant_id = source.tenant_id
                            AND conflicting.fence_generation = source.tenant_fence_generation
                            AND conflicting.id <> source.id
                            AND conflicting.state NOT IN ('succeeded', 'failed_terminal'))
      ), tenant_gated AS (
        UPDATE exomem_tenants AS tenant
        SET status = 'deletion_pending', desired_state = 'deleted',
            fence_generation = tenant.fence_generation + 1, updated_at = now()
        FROM eligible WHERE tenant.id = eligible.tenant_id
        RETURNING tenant.id, tenant.owner_user_id, tenant.fence_generation
      ), oauth_blocked AS (
        INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason)
        SELECT id, owner_user_id, 'lifecycle_deleted' FROM tenant_gated
        ON CONFLICT (tenant_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id
        RETURNING tenant_id
      ), sessions_revoked AS (
        UPDATE exomem_sessions AS session SET revoked_at = COALESCE(session.revoked_at, now())
        FROM tenant_gated WHERE session.tenant_id = tenant_gated.id RETURNING session.id
      ), tokens_revoked AS (
        UPDATE exomem_access_tokens AS token SET revoked_at = COALESCE(token.revoked_at, now())
        FROM tenant_gated
        WHERE token.tenant_id = tenant_gated.id
          AND token.consumed_at IS NULL
          AND token.revoked_at IS NULL
        RETURNING token.id
      ), transfers_revoked AS (
        UPDATE exomem_transfer_grants AS transfer SET revoked_at = COALESCE(transfer.revoked_at, now()),
            outcome_code = COALESCE(transfer.outcome_code, 'DELETION_REVOKED')
        FROM tenant_gated WHERE transfer.tenant_id = tenant_gated.id RETURNING transfer.id
      ), invites_revoked AS (
        UPDATE exomem_invites AS invite SET revoked_at = COALESCE(invite.revoked_at, now())
        FROM tenant_gated
        JOIN users AS owner ON owner.id = tenant_gated.owner_user_id
        WHERE invite.email_normalized = owner.email
          AND invite.marketplace_reviewer_purpose = true
          AND invite.consumed_at IS NULL
          AND invite.revoked_at IS NULL
        RETURNING invite.id
      ), credentials_revoked AS (
        UPDATE exomem_marketplace_reviewer_credentials AS credential
        SET revoked_at = COALESCE(credential.revoked_at, now()),
            revoked_by_principal_digest = COALESCE(credential.revoked_by_principal_digest, ${input.operatorPrincipalDigest})
        FROM tenant_gated WHERE credential.tenant_id = tenant_gated.id RETURNING credential.id
      ), bootstrap_revoked AS (
        UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
        SET state = 'revoked', revoked_at = now()
        FROM tenant_gated WHERE authority.state = 'active' AND authority.outcome_tenant_id = tenant_gated.id
        RETURNING authority.id
      ), oauth_grants_revoked AS (
        UPDATE exomem_oauth_grants AS grant_row SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
        WHERE grant_row.tenant_id IN (SELECT id FROM tenant_gated)
           OR EXISTS (
             SELECT 1 FROM source
             JOIN tenant_gated ON tenant_gated.id = source.tenant_id
             WHERE grant_row.candidate_id = source.target_candidate_id
               AND grant_row.assignment_id = source.target_assignment_id
               AND grant_row.assignment_generation = source.target_assignment_generation
           )
        RETURNING grant_row.id, grant_row.authorization_transaction_id
      ), oauth_codes_consumed AS (
        UPDATE exomem_oauth_authorization_codes AS code SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE code.grant_id IN (SELECT id FROM oauth_grants_revoked) RETURNING code.id
      ), oauth_transactions_consumed AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE transaction.id IN (SELECT authorization_transaction_id FROM oauth_grants_revoked WHERE authorization_transaction_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM exomem_sessions AS session JOIN tenant_gated ON tenant_gated.id = session.tenant_id
                      WHERE session.id = transaction.redeemed_session_id)
           OR EXISTS (SELECT 1 FROM source
                      JOIN tenant_gated ON tenant_gated.id = source.tenant_id
                      WHERE transaction.candidate_id = source.target_candidate_id
                        AND transaction.assignment_id = source.target_assignment_id
                        AND transaction.assignment_generation = source.target_assignment_generation)
        RETURNING transaction.id
      ), oauth_families_revoked AS (
        UPDATE exomem_oauth_token_families AS family SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'lifecycle_deleted')
        WHERE family.grant_id IN (SELECT id FROM oauth_grants_revoked) RETURNING family.id
      ), oauth_access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM oauth_grants_revoked)
           OR token.family_id IN (SELECT id FROM oauth_families_revoked) RETURNING token.id
      ), oauth_refresh_consumed AS (
        UPDATE exomem_oauth_refresh_tokens AS refresh SET consumed_at = COALESCE(refresh.consumed_at, now())
        WHERE refresh.family_id IN (SELECT id FROM oauth_families_revoked) RETURNING refresh.id
      ), entitlement_gated AS (
        UPDATE exomem_entitlements AS entitlement SET effective_state = 'deleted', capabilities = '[]'::jsonb, updated_at = now()
        FROM tenant_gated WHERE entitlement.tenant_id = tenant_gated.id RETURNING entitlement.id
      ), exports_gated AS (
        UPDATE exomem_exports AS export_row SET state = 'deleting'
        FROM tenant_gated WHERE export_row.tenant_id = tenant_gated.id AND export_row.state <> 'deleted'
        RETURNING export_row.id
      ), operations_superseded AS (
        UPDATE exomem_lifecycle_operations AS pending
        SET state = 'failed_terminal', error_code = 'DELETION_SUPERSEDED', lease_owner = NULL,
            lease_expires_at = NULL, completed_at = now(), updated_at = now()
        FROM tenant_gated WHERE pending.tenant_id = tenant_gated.id
          AND pending.fence_generation < tenant_gated.fence_generation
          AND pending.state NOT IN ('succeeded', 'failed_terminal')
        RETURNING pending.id
      ), delete_enqueued AS (
        INSERT INTO exomem_lifecycle_operations (
          tenant_id, operation_type, idempotency_key, fence_generation, provisioner_wire_protocol, request_id
        )
        SELECT tenant_gated.id, 'delete', delete_key.value, tenant_gated.fence_generation,
               source.provisioner_wire_protocol, ${input.requestId}::uuid
        FROM tenant_gated JOIN source ON source.tenant_id = tenant_gated.id
        JOIN delete_key ON delete_key.id = source.id
        RETURNING id
      ), authorized_audit AS (
        INSERT INTO exomem_audit_events (event_type, outcome, tenant_id, cell_id, operation_id, request_id, principal_scope_digest)
        SELECT 'operator.reviewer_cleanup.authorized', 'succeeded', eligible.tenant_id, eligible.matched_cell_id,
               eligible.id, ${input.requestId}::uuid, ${input.operatorPrincipalDigest}
        FROM eligible RETURNING id
      ), result_audit AS (
        INSERT INTO exomem_audit_events (event_type, outcome, tenant_id, operation_id, request_id, principal_scope_digest)
        SELECT 'operator.reviewer_cleanup.delete_enqueued', 'pending', tenant_gated.id, delete_enqueued.id,
               ${input.requestId}::uuid, ${input.operatorPrincipalDigest}
        FROM tenant_gated JOIN delete_enqueued ON true RETURNING id
      ), replay_audit AS (
        INSERT INTO exomem_audit_events (event_type, outcome, tenant_id, operation_id, request_id, principal_scope_digest)
        SELECT 'operator.reviewer_cleanup.replayed', 'succeeded', source.tenant_id, replay.operation_id,
               ${input.requestId}::uuid, ${input.operatorPrincipalDigest}
        FROM source JOIN replay ON true RETURNING id
      )
      SELECT 'enqueued'::text AS outcome, id::text AS operation_id FROM delete_enqueued
      UNION ALL
      SELECT 'replayed'::text AS outcome, operation_id::text FROM replay
    `;
    const row = rows[0] as { outcome?: unknown; operation_id?: unknown } | undefined;
    return (row?.outcome === "enqueued" || row?.outcome === "replayed") &&
      typeof row.operation_id === "string"
      ? { outcome: row.outcome, operationId: row.operation_id }
      : null;
  });
}

function assertStrandedCellDeleteInput(input: StrandedCellDeleteInput): void {
  if (
    !UUID.test(input.operationId) ||
    !Number.isSafeInteger(input.expectedFence) ||
    input.expectedFence < 1
  ) {
    throw exomemErrors.invalidRequest();
  }
}

/**
 * The facts a stranded cell-scoped delete must satisfy before it may be superseded.
 *
 * `checkpoint = 'local-gated'` is the load-bearing clause, not a detail. It is the last
 * checkpoint before the first provider call, so an operation sitting there is one whose
 * quiesce never succeeded and whose cell the provider has not begun tearing down.
 * Superseding it therefore cannot orphan destructive work that already happened, which
 * is the only irreversible mistake available here.
 *
 * `PROVISIONER_REJECTED` narrows it further to the admission failure this exists for.
 * A delete stranded for some other reason may need its provider state inspected first
 * and is deliberately out of scope.
 */
function strandedCellDeleteEligibility(tx: ExomemSql, input: StrandedCellDeleteInput) {
  return tx`
    SELECT source.id, source.tenant_id, source.cell_id
    FROM exomem_lifecycle_operations AS source
    JOIN exomem_tenants AS tenant ON tenant.id = source.tenant_id
    JOIN exomem_cells AS cell ON cell.id = source.cell_id AND cell.tenant_id = tenant.id
    WHERE source.id = ${input.operationId}::uuid
      AND source.operation_type = 'delete'
      AND source.state = 'failed_terminal'
      AND source.error_code = 'PROVISIONER_REJECTED'
      AND source.checkpoint = 'local-gated'
      AND source.completed_at IS NOT NULL
      AND source.lease_owner IS NULL
      AND source.lease_expires_at IS NULL
      AND source.cell_id IS NOT NULL
      AND source.target_candidate_id IS NOT NULL
      AND source.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
      AND source.fence_generation = ${input.expectedFence}::bigint
      AND tenant.fence_generation = ${input.expectedFence}::bigint
      AND tenant.marketplace_reviewer_purpose = true
      AND tenant.status = 'deletion_pending'
      AND tenant.desired_state = 'deleted'
      AND tenant.deleted_at IS NULL
      AND cell.lifecycle_state <> 'deleted'
      AND (SELECT count(*) FROM exomem_cells AS only_cell
           WHERE only_cell.tenant_id = tenant.id
             AND only_cell.lifecycle_state <> 'deleted') = 1
      AND NOT EXISTS (SELECT 1 FROM exomem_lifecycle_operations AS conflicting
                      WHERE conflicting.tenant_id = tenant.id
                        AND conflicting.id <> source.id
                        AND conflicting.state NOT IN ('succeeded', 'failed_terminal'))
  `;
}

/** Read-only fail-closed eligibility check for superseding one stranded cell-scoped delete. */
export async function preflightSupersedeStrandedCellDelete(
  input: StrandedCellDeleteInput
): Promise<{ eligible: boolean }> {
  assertStrandedCellDeleteInput(input);
  return withCohortControlLock(async (tx) => {
    /* exomem:preflight-supersede-stranded-cell-delete */
    const { rows } = await strandedCellDeleteEligibility(tx, input);
    return { eligible: rows.length === 1 };
  });
}

/**
 * Replace a cell-scoped delete that admission can never accept with a target-free one.
 *
 * A v2 request carries a `runtimeTarget` copied from the operation's own columns at
 * creation, and the provisioner admits it only when that target is byte-equal to the
 * deployment lock's active runtime. Once a runtime moves out of band, an operation
 * created before the move is permanently inadmissible: its target is frozen, the
 * reconciler builds the request from the operation rather than the cell, and correcting
 * the cell underneath it changes nothing. Reopening it re-sends the rejected target.
 *
 * Tenant destruction has an admissible shape and this restores the operation to it.
 * A target-free delete — `cell_id` and every `target_*` column NULL — carries no
 * `runtimeTarget` at all, so there is nothing for admission to compare and the lock is
 * irrelevant to it. The reconciler already routes such an operation past the per-cell
 * quiesce and seal straight to the tenant destroy, and `markCellState` on the destroy
 * matches every cell of the tenant rather than the operation's own `cell_id`, so the
 * cell is still marked deleted and its routable observation still cleared.
 *
 * This does not call the provider and does not itself destroy anything. It supersedes
 * the stranded operation, advances the tenant fence so nothing at the old fence can
 * still act, and enqueues the delete that the normal reconciler can actually run.
 */
export async function supersedeStrandedCellDelete(
  input: StrandedCellDeleteInput & { requestId: string; operatorPrincipalDigest: Buffer }
): Promise<StrandedCellDeleteSupersession> {
  assertStrandedCellDeleteInput(input);
  if (!UUID.test(input.requestId) || input.operatorPrincipalDigest.byteLength !== 32)
    throw exomemErrors.invalidRequest();
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:supersede-stranded-cell-delete */
      WITH source AS MATERIALIZED (
        SELECT source.*, tenant.fence_generation AS tenant_fence_generation,
               tenant.status AS tenant_status, tenant.desired_state AS tenant_desired_state,
               tenant.marketplace_reviewer_purpose, tenant.deleted_at AS tenant_deleted_at
        FROM exomem_lifecycle_operations AS source
        JOIN exomem_tenants AS tenant ON tenant.id = source.tenant_id
        WHERE source.id = ${input.operationId}::uuid
        FOR UPDATE OF source, tenant
      ), delete_key AS MATERIALIZED (
        SELECT source.id,
               encode(digest(convert_to(source.id::text || ':supersede-stranded-cell-delete', 'utf8'), 'sha256'), 'hex') AS value
        FROM source
      ), replay AS MATERIALIZED (
        SELECT delete_operation.id AS operation_id
        FROM source
        JOIN delete_key ON delete_key.id = source.id
        JOIN exomem_lifecycle_operations AS delete_operation
          ON delete_operation.tenant_id = source.tenant_id
         AND delete_operation.operation_type = 'delete'
         AND delete_operation.idempotency_key = delete_key.value
        WHERE source.state = 'failed_terminal' AND source.error_code = 'DELETION_SUPERSEDED'
      ), eligible AS MATERIALIZED (
        SELECT source.*
        FROM source
        JOIN exomem_cells AS cell ON cell.id = source.cell_id AND cell.tenant_id = source.tenant_id
        WHERE NOT EXISTS (SELECT 1 FROM replay)
          AND source.operation_type = 'delete'
          AND source.state = 'failed_terminal'
          AND source.error_code = 'PROVISIONER_REJECTED'
          AND source.checkpoint = 'local-gated'
          AND source.completed_at IS NOT NULL
          AND source.lease_owner IS NULL
          AND source.lease_expires_at IS NULL
          AND source.cell_id IS NOT NULL
          AND source.target_candidate_id IS NOT NULL
          AND source.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
          AND source.fence_generation = ${input.expectedFence}::bigint
          AND source.tenant_fence_generation = ${input.expectedFence}::bigint
          AND source.marketplace_reviewer_purpose = true
          AND source.tenant_status = 'deletion_pending'
          AND source.tenant_desired_state = 'deleted'
          AND source.tenant_deleted_at IS NULL
          AND cell.lifecycle_state <> 'deleted'
          AND (SELECT count(*) FROM exomem_cells AS only_cell
               WHERE only_cell.tenant_id = source.tenant_id
                 AND only_cell.lifecycle_state <> 'deleted') = 1
          AND NOT EXISTS (SELECT 1 FROM exomem_lifecycle_operations AS conflicting
                          WHERE conflicting.tenant_id = source.tenant_id
                            AND conflicting.id <> source.id
                            AND conflicting.state NOT IN ('succeeded', 'failed_terminal'))
      ), tenant_fenced AS (
        UPDATE exomem_tenants AS tenant
        SET fence_generation = tenant.fence_generation + 1, updated_at = now()
        FROM eligible WHERE tenant.id = eligible.tenant_id
        RETURNING tenant.id, tenant.fence_generation
      ), operations_superseded AS (
        UPDATE exomem_lifecycle_operations AS stale
        SET state = 'failed_terminal', error_code = 'DELETION_SUPERSEDED', lease_owner = NULL,
            lease_expires_at = NULL, completed_at = COALESCE(stale.completed_at, now()),
            updated_at = now()
        FROM tenant_fenced
        WHERE stale.tenant_id = tenant_fenced.id
          AND stale.fence_generation < tenant_fenced.fence_generation
          AND (stale.state NOT IN ('succeeded', 'failed_terminal')
               OR stale.id = ${input.operationId}::uuid)
        RETURNING stale.id
      ), assignments_ended AS (
        UPDATE exomem_agent_contract_rollout_assignments AS assignment
        SET state = 'expired', ended_at = COALESCE(assignment.ended_at, now()),
            activated_at = NULL, updated_at = now()
        FROM tenant_fenced
        WHERE assignment.tenant_id = tenant_fenced.id
          AND assignment.state IN ('preparing', 'active')
        RETURNING assignment.id
      ), delete_enqueued AS (
        INSERT INTO exomem_lifecycle_operations (
          tenant_id, operation_type, idempotency_key, fence_generation,
          provisioner_wire_protocol, request_id
        )
        SELECT tenant_fenced.id, 'delete', delete_key.value, tenant_fenced.fence_generation,
               eligible.provisioner_wire_protocol, ${input.requestId}::uuid
        FROM tenant_fenced
        JOIN eligible ON eligible.tenant_id = tenant_fenced.id
        JOIN delete_key ON delete_key.id = eligible.id
        RETURNING id
      ), authorized_audit AS (
        INSERT INTO exomem_audit_events (
          event_type, outcome, tenant_id, cell_id, operation_id, request_id, principal_scope_digest
        )
        SELECT 'operator.stranded_cell_delete.superseded', 'succeeded', eligible.tenant_id,
               eligible.cell_id, eligible.id, ${input.requestId}::uuid,
               ${input.operatorPrincipalDigest}
        FROM eligible WHERE EXISTS (SELECT 1 FROM delete_enqueued) RETURNING id
      ), result_audit AS (
        INSERT INTO exomem_audit_events (
          event_type, outcome, tenant_id, operation_id, request_id, principal_scope_digest
        )
        SELECT 'operator.stranded_cell_delete.delete_enqueued', 'pending', tenant_fenced.id,
               delete_enqueued.id, ${input.requestId}::uuid, ${input.operatorPrincipalDigest}
        FROM tenant_fenced JOIN delete_enqueued ON true RETURNING id
      ), replay_audit AS (
        INSERT INTO exomem_audit_events (
          event_type, outcome, tenant_id, operation_id, request_id, principal_scope_digest
        )
        SELECT 'operator.stranded_cell_delete.replayed', 'succeeded', source.tenant_id,
               replay.operation_id, ${input.requestId}::uuid, ${input.operatorPrincipalDigest}
        FROM source JOIN replay ON true RETURNING id
      )
      SELECT 'enqueued'::text AS outcome, id::text AS operation_id FROM delete_enqueued
      UNION ALL
      SELECT 'replayed'::text AS outcome, operation_id::text FROM replay
    `;
    const row = rows[0] as { outcome?: unknown; operation_id?: unknown } | undefined;
    return (row?.outcome === "enqueued" || row?.outcome === "replayed") &&
      typeof row.operation_id === "string"
      ? { outcome: row.outcome, operationId: row.operation_id }
      : null;
  });
}

/** Read-only fail-closed eligibility check for correcting one diverged cell's release. */
export async function preflightCorrectDivergedCellRelease(
  input: DivergedCellReleaseInput
): Promise<{ eligible: boolean }> {
  assertDivergedCellReleaseInput(input);
  return withCohortControlLock(async (tx) => {
    /* exomem:preflight-correct-diverged-cell-release */
    const { rows } = await divergedCellReleaseEligibility(tx, input);
    return { eligible: rows.length === 1 };
  });
}

/**
 * Move a cell's recorded runtime identity onto a cataloged candidate it already serves.
 *
 * A cell's recorded `release_version` pins the `runtimeTarget` of every later lifecycle
 * operation, and the provisioner admits a v2 request only when that target is byte-equal
 * to the deployment lock's active runtime. So once a runtime moves out of band, the
 * control plane's stale record makes the cell impossible to quiesce, seal, or destroy —
 * every request it can mint is rejected with a content-free `PROVISIONER_REJECTED`, and
 * there is no request shape that escapes it, because health carries the stale target too.
 *
 * The correction is what breaks that circle. It also installs the active assignment,
 * rather than leaving that to `create-assignment`, because the two facts are one fact:
 * a delete derives its target from `bound_assignment_target`, which matches an active
 * assignment against the cell's recorded identity. Correcting either alone leaves the
 * tenant with no derivable target at all, which is a worse stall than the one being
 * repaired. Ordinary assignment activation cannot be reused here — it is reachable only
 * from a succeeding provision, which is precisely what a diverged cell cannot run.
 *
 * This does not touch the provider. It asserts that the runtime already moved; the
 * operator is responsible for having verified that against the cluster first, and the
 * runbook says how. What the control enforces is that the identity being recorded was
 * genuinely minted and cataloged, never one composed at the call site.
 */
export async function correctDivergedCellRelease(
  input: DivergedCellReleaseInput & { requestId: string; operatorPrincipalDigest: Buffer }
): Promise<DivergedCellReleaseCorrection> {
  assertDivergedCellReleaseInput(input);
  if (!UUID.test(input.requestId) || input.operatorPrincipalDigest.byteLength !== 32)
    throw exomemErrors.invalidRequest();
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:correct-diverged-cell-release */
      WITH replay AS MATERIALIZED (
        SELECT assignment.id AS assignment_id
        FROM exomem_cells AS cell
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = ${input.candidateId}::uuid
         AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.tenant_id = cell.tenant_id
         AND assignment.candidate_id = candidate.id
         AND assignment.state = 'active'
         AND assignment.expires_at > now()
        WHERE cell.id = ${input.cellId}::uuid
          AND cell.release_version = candidate.source_release
          AND cell.protocol_version = candidate.protocol_version
          AND cell.observed_command_fingerprint = candidate.command_fingerprint
          AND cell.observed_schema_digest = candidate.schema_digest
          AND cell.observed_compatibility_digest = candidate.compatibility_digest
          AND EXISTS (SELECT 1 FROM exomem_audit_events AS audit
                      WHERE audit.cell_id = cell.id
                        AND audit.event_type = 'operator.diverged_cell_release.corrected')
      ), eligible AS MATERIALIZED (
        SELECT cell.id AS cell_id, cell.tenant_id,
               prior.source_release, prior.protocol_version, prior.gateway_contract_digest,
               prior.command_fingerprint, prior.schema_digest, prior.compatibility_digest
        FROM exomem_cells AS cell
        JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = ${input.candidateId}::uuid
         AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
         AND candidate.state = 'pending'
         AND candidate.protocol_version = cell.protocol_version
         AND candidate.source_release <> cell.release_version
        JOIN exomem_agent_contract_rollout_assignments AS prior
          ON prior.tenant_id = cell.tenant_id
         AND prior.candidate_id = candidate.id
         AND prior.marketplace_reviewer_purpose = true
         AND prior.source_release = candidate.source_release
         AND prior.protocol_version = candidate.protocol_version
         AND prior.command_fingerprint = candidate.command_fingerprint
         AND prior.schema_digest = candidate.schema_digest
         AND prior.compatibility_digest = candidate.compatibility_digest
         AND (
           (prior.state = 'expired' AND prior.expires_at <= now())
           OR (prior.state = 'failed' AND prior.ended_at IS NOT NULL)
         )
        WHERE NOT EXISTS (SELECT 1 FROM replay)
          AND cell.id = ${input.cellId}::uuid
          AND cell.release_version = ${input.expectedCurrentRelease}
          AND cell.lifecycle_state <> 'deleted'
          AND cell.routing_state IN ('bound', 'retiring')
          AND cell.observed_gateway_contract_digest IS NOT NULL
          AND cell.observed_command_fingerprint IS NOT NULL
          AND cell.observed_schema_digest IS NOT NULL
          AND cell.observed_compatibility_digest IS NOT NULL
          AND tenant.deleted_at IS NULL
          AND tenant.marketplace_reviewer_purpose = true
          AND tenant.fence_generation = ${input.expectedFence}::bigint
          AND (SELECT count(*) FROM exomem_cells AS only_cell
               WHERE only_cell.tenant_id = cell.tenant_id
                 AND only_cell.lifecycle_state <> 'deleted') = 1
          AND NOT EXISTS (SELECT 1 FROM exomem_lifecycle_operations AS inflight
                          WHERE inflight.tenant_id = cell.tenant_id
                            AND inflight.state NOT IN ('succeeded', 'failed_terminal'))
          AND NOT EXISTS (SELECT 1 FROM exomem_agent_contract_rollout_assignments AS current
                          WHERE current.tenant_id = cell.tenant_id
                            AND current.state IN ('preparing', 'active'))
        FOR UPDATE OF cell, tenant, candidate, prior
      ), corrected_cell AS (
        UPDATE exomem_cells AS cell
        SET release_version = eligible.source_release,
            observed_gateway_contract_digest = eligible.gateway_contract_digest,
            observed_command_fingerprint = eligible.command_fingerprint,
            observed_schema_digest = eligible.schema_digest,
            observed_compatibility_digest = eligible.compatibility_digest,
            updated_at = now()
        FROM eligible
        WHERE cell.id = eligible.cell_id
        RETURNING cell.id, cell.tenant_id
      ), corrected_observation AS (
        UPDATE exomem_routable_cell_contracts AS observation
        SET source_release = eligible.source_release,
            protocol_version = eligible.protocol_version,
            command_fingerprint = eligible.command_fingerprint,
            contract_digest = eligible.schema_digest,
            compatibility_digest = eligible.compatibility_digest,
            observed_at = now()
        FROM eligible
        WHERE observation.cell_id = eligible.cell_id
          AND observation.profile_id = ${EXOMEM_HOSTED_PROFILE}
        RETURNING observation.cell_id
      ), installed_assignment AS (
        INSERT INTO exomem_agent_contract_rollout_assignments (
          tenant_id, candidate_id, generation, state, source_release, protocol_version,
          command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
          marketplace_reviewer_purpose, created_by_principal_digest, activated_at, expires_at
        )
        SELECT eligible.tenant_id, ${input.candidateId}::uuid,
               COALESCE((SELECT max(prior.generation)
                         FROM exomem_agent_contract_rollout_assignments AS prior
                         WHERE prior.tenant_id = eligible.tenant_id), 0) + 1,
               'active', eligible.source_release, eligible.protocol_version,
               eligible.command_fingerprint, eligible.schema_digest, eligible.compatibility_digest,
               eligible.gateway_contract_digest, true,
               encode(${input.operatorPrincipalDigest}, 'hex'), now(),
               now() + interval '30 minutes'
        FROM eligible
        WHERE EXISTS (SELECT 1 FROM corrected_cell)
        RETURNING id, tenant_id
      ), corrected_audit AS (
        INSERT INTO exomem_audit_events (
          event_type, outcome, tenant_id, cell_id, request_id, principal_scope_digest,
          release_version, protocol_version
        )
        SELECT 'operator.diverged_cell_release.corrected', 'succeeded',
               eligible.tenant_id, eligible.cell_id, ${input.requestId}::uuid,
               ${input.operatorPrincipalDigest}, eligible.source_release,
               eligible.protocol_version
        FROM eligible
        WHERE EXISTS (SELECT 1 FROM installed_assignment)
        RETURNING id
      )
      SELECT 'corrected'::text AS outcome, id::text AS assignment_id FROM installed_assignment
      UNION ALL
      SELECT 'replayed'::text AS outcome, assignment_id::text FROM replay
    `;
    const row = rows[0] as { outcome?: unknown; assignment_id?: unknown } | undefined;
    return (row?.outcome === "corrected" || row?.outcome === "replayed") &&
      typeof row.assignment_id === "string"
      ? { outcome: row.outcome, assignmentId: row.assignment_id }
      : null;
  });
}

async function withCohortControlLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    return work(tx);
  });
}

async function withReviewerCleanupControlLocks<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-marketplace-reviewer-access'))`;
    return work(tx);
  });
}

export async function listOperatorOAuthClients(): Promise<OperatorOAuthClient[]> {
  const { rows } = await executeExomemSql`
    /* exomem:list-operator-oauth-clients */
    SELECT id, client_id, enabled, admission_mode, redirect_uris_digest, metadata_expires_at,
           jsonb_array_length(redirect_uris)::integer AS redirect_count
    FROM exomem_oauth_clients
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const redirectCount = row.redirect_count;
    const redirectDigest = row.redirect_uris_digest;
    if (
      typeof row.id !== "string" ||
      typeof row.enabled !== "boolean" ||
      (row.admission_mode !== "pinned" && row.admission_mode !== "cimd") ||
      typeof redirectCount !== "number" ||
      !Number.isSafeInteger(redirectCount) ||
      !(redirectDigest instanceof Uint8Array) ||
      redirectDigest.byteLength !== 32 ||
      (row.metadata_expires_at !== null && !(row.metadata_expires_at instanceof Date))
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        enabled: row.enabled,
        admissionMode: row.admission_mode,
        clientFingerprint: operatorOAuthClientFingerprint(String(row.client_id ?? row.id)),
        redirectDigest: Buffer.from(redirectDigest).toString("hex"),
        redirectCount,
        metadataExpiresAt:
          row.metadata_expires_at instanceof Date ? row.metadata_expires_at.toISOString() : null,
      },
    ];
  });
}

export async function listReviewerOAuthBootstrapAuthorities(): Promise<
  ReviewerOAuthBootstrapAuthority[]
> {
  const { rows } = await executeExomemSql`
    /* exomem:list-reviewer-oauth-bootstrap-authorities */
    SELECT id::text AS id, state, expires_at, outcome_tenant_id::text AS outcome_tenant_id,
           outcome_assignment_id::text AS outcome_assignment_id, outcome_assignment_generation,
           outcome_operation_id::text AS outcome_operation_id,
           outcome_session_id::text AS outcome_session_id, outcome_grant_id::text AS outcome_grant_id
    FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
    ORDER BY created_at DESC LIMIT 20
  `;
  return rows.flatMap((row) => {
    if (
      typeof row.id !== "string" ||
      (row.state !== "active" &&
        row.state !== "consumed" &&
        row.state !== "revoked" &&
        row.state !== "expired") ||
      !(row.expires_at instanceof Date)
    )
      return [];
    return [
      {
        id: row.id,
        state: row.state,
        expiresAt: row.expires_at.toISOString(),
        outcomeTenantId: typeof row.outcome_tenant_id === "string" ? row.outcome_tenant_id : null,
        outcomeAssignmentId:
          typeof row.outcome_assignment_id === "string" ? row.outcome_assignment_id : null,
        outcomeAssignmentGeneration:
          typeof row.outcome_assignment_generation === "number"
            ? row.outcome_assignment_generation
            : null,
        outcomeOperationId:
          typeof row.outcome_operation_id === "string" ? row.outcome_operation_id : null,
        outcomeSessionId:
          typeof row.outcome_session_id === "string" ? row.outcome_session_id : null,
        outcomeGrantId: typeof row.outcome_grant_id === "string" ? row.outcome_grant_id : null,
      },
    ];
  });
}

export async function createReviewerOAuthBootstrapAuthority(input: {
  inviteId: string;
  stagedClientReleaseId: string;
  oauthClientId: string;
  expiresAt: Date;
  operatorPrincipalDigest: Buffer;
}): Promise<{ id: string; expiresAt: string } | null> {
  if (
    !UUID.test(input.inviteId) ||
    !UUID.test(input.stagedClientReleaseId) ||
    !UUID.test(input.oauthClientId) ||
    input.operatorPrincipalDigest.byteLength !== 32 ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= Date.now() ||
    input.expiresAt.getTime() > Date.now() + 30 * 60_000
  )
    throw exomemErrors.invalidRequest();
  return withCohortControlLock(async (tx) => {
    await tx`
      WITH expired AS (
        UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
        SET state = 'expired', expired_at = now()
        WHERE state = 'active' AND expires_at <= now()
        RETURNING oauth_client_id
      )
      UPDATE exomem_oauth_clients AS client
      SET enabled = false, authority_version = gen_random_uuid(), updated_at = now()
      WHERE client.id IN (SELECT oauth_client_id FROM expired)
    `;
    const { rows } = await tx`
      /* exomem:create-reviewer-oauth-bootstrap-authority */
      WITH invite AS (
        SELECT id, expires_at
        FROM exomem_invites
        WHERE id = ${input.inviteId}::uuid
          AND marketplace_reviewer_purpose = true
          AND delivery_state = 'sent' AND delivered_at IS NOT NULL
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE
      ), stage AS (
        SELECT stage.id, stage.candidate_id, stage.platform, stage.oauth_client_config_sha256,
               stage.expires_at, candidate.profile_id, candidate.schema_digest AS contract_sha256,
               candidate.source_release, candidate.protocol_version, candidate.command_fingerprint,
               candidate.compatibility_digest
        FROM exomem_staged_client_releases AS stage
        JOIN exomem_agent_contract_candidates AS candidate
         ON candidate.id = stage.candidate_id
         AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
         AND candidate.source_release = ${exomemContractFixture0681.release}
         AND candidate.protocol_version = ${exomemContractFixture0681.protocol}
         AND candidate.state = 'pending'
        WHERE stage.id = ${input.stagedClientReleaseId}::uuid
         AND stage.state = 'staged' AND stage.expires_at > now()
         AND stage.contract_sha256 = candidate.schema_digest
         AND stage.compatibility_sha256 = candidate.compatibility_digest
        FOR UPDATE OF stage, candidate
      ), client AS (
        UPDATE exomem_oauth_clients AS client
        SET enabled = true, reviewer_bootstrap_ever_authorized = true,
            authority_version = gen_random_uuid(), updated_at = now()
        FROM stage
        WHERE client.id = ${input.oauthClientId}::uuid
          AND client.admission_mode = 'pinned'
          AND client.client_platform = stage.platform
          AND client.oauth_client_config_sha256 = stage.oauth_client_config_sha256
          AND jsonb_array_length(client.redirect_uris) = 1
          AND client.redirect_uris->>0 ~ '^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?(/|$)'
          AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
          AND NOT EXISTS (
            SELECT 1 FROM exomem_hosted_alpha_platform_cohort
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
            WHERE state = 'active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_agent_contract_rollout_assignments AS assignment
            WHERE assignment.marketplace_reviewer_purpose = true
              AND assignment.state = 'active' AND assignment.expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
            WHERE credential.credential_kind = 'internal_canary'
              AND credential.revoked_at IS NULL AND credential.expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_tenants AS tenant
            JOIN exomem_cells AS cell ON cell.id = tenant.bound_cell_id
            WHERE tenant.marketplace_reviewer_purpose = true
              AND tenant.deleted_at IS NULL
              AND (cell.routing_state = 'bound' OR cell.readiness_code = 'CELL_READY')
          )
        RETURNING client.id, client.authority_version, client.oauth_client_config_sha256,
                  client.redirect_uris_digest
      ), authority AS (
        INSERT INTO exomem_marketplace_reviewer_oauth_bootstrap_authorities (
          state, invite_id, candidate_id, candidate_profile_id, candidate_contract_digest,
          candidate_source_release, candidate_protocol_version, candidate_gateway_contract_digest,
          candidate_command_fingerprint, candidate_schema_digest, candidate_compatibility_digest,
          staged_client_release_id, stage_platform, stage_config_sha256, oauth_client_id,
          oauth_client_authority_version, oauth_client_config_sha256, redirect_uri_digest,
          operator_principal_digest, expires_at
        )
        SELECT 'active', invite.id, stage.candidate_id, stage.profile_id, stage.contract_sha256,
               stage.source_release, stage.protocol_version, ${exomemContractFixture0681.digest},
               stage.command_fingerprint, stage.contract_sha256, stage.compatibility_digest,
               stage.id, stage.platform, stage.oauth_client_config_sha256, client.id,
               client.authority_version, client.oauth_client_config_sha256, client.redirect_uris_digest,
               ${input.operatorPrincipalDigest}, LEAST(${input.expiresAt.toISOString()}::timestamptz, invite.expires_at, stage.expires_at)
        FROM invite CROSS JOIN stage CROSS JOIN client
        WHERE ${input.expiresAt.toISOString()}::timestamptz <= invite.expires_at
          AND ${input.expiresAt.toISOString()}::timestamptz <= stage.expires_at
        RETURNING id::text AS id, expires_at
      ) SELECT * FROM authority
    `;
    const row = rows[0] as { id?: string; expires_at?: Date } | undefined;
    return row?.id && row.expires_at instanceof Date
      ? { id: row.id, expiresAt: row.expires_at.toISOString() }
      : null;
  });
}

export async function revokeReviewerOAuthBootstrapAuthority(input: {
  authorityId: string;
}): Promise<boolean> {
  if (!UUID.test(input.authorityId)) throw exomemErrors.invalidRequest();
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:revoke-reviewer-oauth-bootstrap-authority */
      WITH revoked AS (
        UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
        SET state = 'revoked', revoked_at = now()
        WHERE id = ${input.authorityId}::uuid AND state = 'active'
        RETURNING oauth_client_id
      )
      UPDATE exomem_oauth_clients AS client
      SET enabled = false, authority_version = gen_random_uuid(), updated_at = now()
      WHERE client.id IN (SELECT oauth_client_id FROM revoked)
      RETURNING client.id
    `;
    return rows.length === 1;
  });
}

type OperatorClientWriteResult = { id: string; enabled: boolean };
type StagedOperatorOAuthClientRegistration = OperatorOAuthClientRegistration & {
  stagedClientReleaseId?: string;
  existingClientRecordId?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The release the operator states the cell currently records, so a ticket written before
 * someone else corrected the same cell refuses instead of moving it a second time.
 */
const RELEASE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

function metadataProvenance(input: {
  mode: "pinned" | "cimd";
  host?: string;
  documentDigest?: Buffer;
}): string {
  return JSON.stringify({
    version: 1,
    mode: input.mode,
    ...(input.host ? { host: input.host } : {}),
    ...(input.documentDigest ? { documentDigest: input.documentDigest.toString("hex") } : {}),
  });
}

export async function preflightReusablePinnedOAuthClient(input: {
  platform: "claude" | "openai";
  clientId: string;
  redirectUris: string[];
}): Promise<{ eligible: boolean; clientRecordId: string | null }> {
  const registration = normalizeOperatorOAuthClientRegistration({
    admissionMode: "pinned",
    platform: input.platform,
    clientId: input.clientId,
    redirectUris: input.redirectUris,
  });
  const configSha256 = oauthClientConfigSha256(registration);
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:preflight-reusable-pinned-oauth-client */
      SELECT client.id
      FROM exomem_oauth_clients AS client
      WHERE client.client_id = ${registration.clientId}
        AND client.admission_mode = 'pinned'
        AND client.client_platform = ${registration.platform}
        AND client.oauth_client_config_sha256 = ${configSha256}
        AND client.enabled = false
        AND client.reviewer_bootstrap_ever_authorized = false
        AND client.metadata_provenance->>'mode' = 'pinned'
      ORDER BY client.id
      LIMIT 2
    `;
    const identifiers = rows.flatMap((row) =>
      typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : []
    );
    return identifiers.length === 1
      ? { eligible: true, clientRecordId: identifiers[0]! }
      : { eligible: false, clientRecordId: null };
  });
}

/** Register a pre-approved client only. Runtime authorization never creates or fetches a client. */
export async function registerOperatorOAuthClient(
  input: StagedOperatorOAuthClientRegistration,
  dependencies: { fetchCimd?: (clientId: string) => Promise<CimdFetchedMetadata> } = {}
): Promise<OperatorClientWriteResult> {
  const registration = normalizeOperatorOAuthClientRegistration(input);
  const stagedClientReleaseId = input.stagedClientReleaseId;
  if (
    !registration.artifactId &&
    (typeof stagedClientReleaseId !== "string" || !UUID.test(stagedClientReleaseId))
  )
    throw exomemErrors.invalidRequest();
  const configSha256 = oauthClientConfigSha256({
    platform: registration.platform,
    admissionMode: registration.admissionMode,
    clientId: registration.clientId,
    redirectUris: registration.redirectUris,
  });
  const existingClientRecordId = input.existingClientRecordId;
  if (existingClientRecordId !== undefined) {
    if (
      registration.admissionMode !== "pinned" ||
      registration.artifactId !== undefined ||
      typeof stagedClientReleaseId !== "string" ||
      !UUID.test(stagedClientReleaseId) ||
      !UUID.test(existingClientRecordId)
    ) {
      throw exomemErrors.invalidRequest();
    }
    return withCohortControlLock(async (tx) => {
      const { rows } = await tx`
        /* exomem:reuse-operator-pinned-oauth-client */
        WITH stage AS (
          SELECT stage.id
          FROM exomem_staged_client_releases AS stage
          JOIN exomem_agent_contract_candidates AS candidate
            ON candidate.id = stage.candidate_id
           AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
           AND candidate.state IN ('pending', 'live')
          WHERE stage.id = ${stagedClientReleaseId}::uuid
            AND stage.platform = ${registration.platform}
            AND stage.state IN ('staged', 'evidenced')
            AND stage.expires_at > now()
            AND stage.oauth_client_config_sha256 = ${configSha256}
            AND stage.registered_app_id_sha256 IS NULL
        ), eligible AS (
          SELECT client.id
          FROM exomem_oauth_clients AS client CROSS JOIN stage
          WHERE client.id = ${existingClientRecordId}::uuid
            AND client.client_id = ${registration.clientId}
            AND client.admission_mode = 'pinned'
            AND client.client_platform = ${registration.platform}
            AND client.oauth_client_config_sha256 = ${configSha256}
            AND client.enabled = false
            AND client.reviewer_bootstrap_ever_authorized = false
            AND client.metadata_provenance->>'mode' = 'pinned'
        )
        UPDATE exomem_oauth_clients AS client
        SET authority_version = gen_random_uuid(), updated_at = now()
        FROM eligible
        WHERE client.id = eligible.id
        RETURNING client.id, client.enabled
      `;
      const row = rows[0] as { id: string; enabled: boolean } | undefined;
      if (!row || row.enabled) throw exomemErrors.invalidRequest();
      return { id: row.id, enabled: false };
    });
  }
  let fetched: CimdFetchedMetadata | null = null;
  if (registration.admissionMode === "cimd") {
    fetched = await (dependencies.fetchCimd ?? fetchCimdMetadata)(registration.clientId);
    if (
      fetched.document.client_id !== registration.clientId ||
      JSON.stringify(fetched.document.redirect_uris) !== JSON.stringify(registration.redirectUris)
    ) {
      throw exomemErrors.invalidRequest();
    }
  }
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:register-operator-oauth-client */
      WITH available AS (
        SELECT exomem_oauth_client_partition_available(${registration.clientId}, false) AS allowed
      ), artifact AS (
        SELECT id FROM exomem_client_artifacts
        WHERE id = ${registration.artifactId}::uuid
          AND platform = ${registration.platform}
          AND state IN ('pending', 'live')
          AND oauth_client_config_sha256 = ${configSha256}
      ), stage AS (
        SELECT stage.id
        FROM exomem_staged_client_releases AS stage
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = stage.candidate_id
         AND candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
         AND candidate.state IN ('pending', 'live')
        WHERE stage.id = ${stagedClientReleaseId ?? "00000000-0000-0000-0000-000000000000"}::uuid
          AND stage.platform = ${registration.platform}
          AND stage.state IN ('staged', 'evidenced')
          AND stage.expires_at > now()
          AND stage.oauth_client_config_sha256 = ${configSha256}
          AND stage.registered_app_id_sha256 IS NOT DISTINCT FROM ${registration.registeredAppIdSha256 ?? null}
      ), authority AS (
        SELECT id FROM artifact
        UNION ALL
        SELECT id FROM stage
      )
      INSERT INTO exomem_oauth_clients (
        client_id, admission_mode, enabled, metadata_provenance, redirect_uris,
        redirect_uris_digest, metadata_document_digest, metadata_fetched_at,
        metadata_ttl_seconds, metadata_expires_at, cimd_host, client_platform,
        oauth_client_config_sha256, authority_version
      )
      SELECT ${registration.clientId}, ${registration.admissionMode}, false,
             ${metadataProvenance({
               mode: registration.admissionMode,
               ...(fetched
                 ? {
                     host: new URL(registration.clientId).hostname,
                     documentDigest: documentDigest(fetched.raw),
                   }
                 : {}),
             })}::jsonb,
             ${JSON.stringify(registration.redirectUris)}::jsonb,
             digest(convert_to(${JSON.stringify(registration.redirectUris)}::jsonb::text, 'utf8'), 'sha256'),
             ${fetched ? documentDigest(fetched.raw) : null},
             CASE WHEN ${fetched !== null} THEN now() ELSE NULL END,
             ${fetched ? registration.ttlSeconds : null},
             CASE WHEN ${fetched !== null}
               THEN now() + (${fetched ? registration.ttlSeconds : 0} * interval '1 second')
               ELSE NULL END,
             ${fetched ? new URL(registration.clientId).hostname.toLowerCase() : null},
             ${registration.platform}, ${configSha256},
             gen_random_uuid()
      FROM available CROSS JOIN authority
      WHERE available.allowed
      ON CONFLICT (client_id) DO UPDATE
      SET admission_mode = EXCLUDED.admission_mode,
          metadata_provenance = EXCLUDED.metadata_provenance,
          redirect_uris = EXCLUDED.redirect_uris,
          redirect_uris_digest = EXCLUDED.redirect_uris_digest,
          metadata_document_digest = EXCLUDED.metadata_document_digest,
          metadata_fetched_at = EXCLUDED.metadata_fetched_at,
          metadata_ttl_seconds = EXCLUDED.metadata_ttl_seconds,
          metadata_expires_at = EXCLUDED.metadata_expires_at,
          cimd_host = EXCLUDED.cimd_host,
          client_platform = EXCLUDED.client_platform,
          oauth_client_config_sha256 = EXCLUDED.oauth_client_config_sha256,
          enabled = CASE
            WHEN exomem_oauth_clients.oauth_client_config_sha256 IS NULL THEN false
            ELSE exomem_oauth_clients.enabled
          END,
          authority_version = gen_random_uuid(), updated_at = now()
        WHERE (
          exomem_oauth_clients.oauth_client_config_sha256 IS NULL
          OR (
           exomem_oauth_clients.client_platform = EXCLUDED.client_platform
           AND exomem_oauth_clients.oauth_client_config_sha256 = EXCLUDED.oauth_client_config_sha256
          )
        )
        AND exomem_oauth_clients.reviewer_bootstrap_ever_authorized = false
      RETURNING id, enabled
    `;
    const row = rows[0] as { id: string; enabled: boolean } | undefined;
    if (!row) throw exomemErrors.invalidRequest();
    return { id: row.id, enabled: row.enabled };
  });
}

/** Refresh happens outside the authority transaction, then commits only if the observed authority is unchanged. */
export async function refreshOperatorCimdOAuthClient(
  clientRecordId: string,
  dependencies: { fetchCimd?: (clientId: string) => Promise<CimdFetchedMetadata> } = {}
): Promise<OperatorClientWriteResult> {
  const { rows } = await executeExomemSql`
    /* exomem:read-operator-cimd-client-refresh */
    SELECT client_id, admission_mode, metadata_ttl_seconds, authority_version, client_platform,
           oauth_client_config_sha256
    FROM exomem_oauth_clients WHERE id = ${clientRecordId}::uuid LIMIT 1
  `;
  const current = rows[0] as
    | {
        client_id: string;
        admission_mode: string;
        metadata_ttl_seconds: number;
        authority_version: string;
        client_platform: "claude" | "openai";
        oauth_client_config_sha256: string;
      }
    | undefined;
  if (!current || current.admission_mode !== "cimd") throw exomemErrors.invalidRequest();
  const fetched = await (dependencies.fetchCimd ?? fetchCimdMetadata)(current.client_id);
  if (fetched.document.client_id !== current.client_id) throw exomemErrors.invalidRequest();
  const refreshed = normalizeOperatorOAuthClientRegistration({
    admissionMode: "cimd",
    platform: current.client_platform,
    clientId: current.client_id,
    redirectUris: fetched.document.redirect_uris,
    ttlSeconds: current.metadata_ttl_seconds,
  });
  const refreshedConfigSha256 = oauthClientConfigSha256({
    platform: refreshed.platform,
    admissionMode: refreshed.admissionMode,
    clientId: refreshed.clientId,
    redirectUris: refreshed.redirectUris,
  });
  if (current.oauth_client_config_sha256 !== refreshedConfigSha256) {
    await withCohortControlLock(async (tx) => {
      await tx`
        UPDATE exomem_oauth_clients
        SET enabled = false, updated_at = now()
        WHERE id = ${clientRecordId}::uuid AND authority_version = ${current.authority_version}::uuid
      `;
    });
    throw exomemErrors.invalidRequest();
  }
  return withCohortControlLock(async (tx) => {
    const { rows: updated } = await tx`
      /* exomem:refresh-operator-cimd-client */
      UPDATE exomem_oauth_clients
      SET redirect_uris = ${JSON.stringify(refreshed.redirectUris)}::jsonb,
          redirect_uris_digest = digest(convert_to(${JSON.stringify(refreshed.redirectUris)}::jsonb::text, 'utf8'), 'sha256'),
          metadata_document_digest = ${documentDigest(fetched.raw)},
          metadata_fetched_at = now(),
          metadata_ttl_seconds = ${refreshed.ttlSeconds},
          metadata_expires_at = now() + (${refreshed.ttlSeconds} * interval '1 second'),
          metadata_provenance = ${metadataProvenance({
            mode: "cimd",
            host: new URL(refreshed.clientId).hostname,
            documentDigest: documentDigest(fetched.raw),
          })}::jsonb,
          cimd_host = ${new URL(refreshed.clientId).hostname.toLowerCase()},
          enabled = CASE
            WHEN metadata_document_digest = ${documentDigest(fetched.raw)}
             AND redirect_uris_digest = digest(convert_to(${JSON.stringify(refreshed.redirectUris)}::jsonb::text, 'utf8'), 'sha256')
            THEN enabled ELSE false END,
          authority_version = gen_random_uuid(), updated_at = now()
      WHERE id = ${clientRecordId}::uuid
        AND admission_mode = 'cimd'
        AND authority_version = ${current.authority_version}::uuid
      RETURNING id, enabled
    `;
    const row = updated[0] as { id: string; enabled: boolean } | undefined;
    if (!row) throw exomemErrors.invalidRequest();
    return { id: row.id, enabled: row.enabled };
  });
}

export async function setOperatorOAuthClientEnabled(input: {
  clientRecordId: string;
  enabled: boolean;
}): Promise<boolean> {
  // Alpha rollout has no separate cohort table: invite eligibility, an enabled
  // approved client, and a live client artifact form the existing cohort gate.
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:set-operator-oauth-client-enabled */
    UPDATE exomem_oauth_clients AS client
    SET enabled = ${input.enabled}, updated_at = now()
    WHERE client.id = ${input.clientRecordId}::uuid
      AND (
        (${input.enabled} = false) OR (
          client.reviewer_bootstrap_ever_authorized = false AND EXISTS (
          SELECT 1 FROM exomem_client_artifacts AS artifact
          WHERE artifact.platform = client.client_platform
            AND artifact.state IN ('pending', 'live')
            AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
          )
        )
      )
    RETURNING id
  `;
    return rows.length === 1;
  });
}

export const revokeOperatorOAuthFamily = revokeOAuthTokenFamilyForOwner;
export const revokeOperatorOAuthAccount = revokeOAuthAccountForOwnerTenantAtomic;

export type OperatorClientArtifact = {
  id: string;
  platform: "claude" | "openai";
  state: "pending" | "live" | "failed" | "retired";
  packageSha256: string;
  archiveSha256: string;
  compatibilitySha256: string;
  contractSha256: string;
};

export async function listOperatorClientArtifacts(): Promise<OperatorClientArtifact[]> {
  const { rows } = await executeExomemSql`
    /* exomem:list-operator-client-artifacts */
    SELECT id, platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256
    FROM exomem_client_artifacts
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const packageSha256 = row.package_sha256;
    const archiveSha256 = row.archive_sha256;
    const compatibilitySha256 = row.compatibility_sha256;
    const contractSha256 = row.contract_sha256;
    if (
      typeof row.id !== "string" ||
      (row.platform !== "claude" && row.platform !== "openai") ||
      (row.state !== "pending" &&
        row.state !== "live" &&
        row.state !== "failed" &&
        row.state !== "retired") ||
      ![packageSha256, archiveSha256, compatibilitySha256, contractSha256].every(
        (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
      )
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        platform: row.platform,
        state: row.state,
        packageSha256: packageSha256 as string,
        archiveSha256: archiveSha256 as string,
        compatibilitySha256: compatibilitySha256 as string,
        contractSha256: contractSha256 as string,
      },
    ];
  });
}

/** Preserve the schema's only valid demotion transition: live to retired. */
export async function demoteOperatorClientArtifact(artifactId: string): Promise<boolean> {
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:demote-operator-client-artifact */
    UPDATE exomem_client_artifacts
    SET state = 'retired', retired_at = now()
    WHERE id = ${artifactId}::uuid AND state = 'live'
    RETURNING id
  `;
    return rows.length === 1;
  });
}
