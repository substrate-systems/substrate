import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { exomemErrors } from "./errors";
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
import { exomemContractFixture0490 } from "./gateway-contract-0-49-0";

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

export type TerminalReviewerDeleteRecovery = {
  outcome: "enqueued" | "replayed";
  operationId: string;
} | null;

type ExpiredReviewerCleanupInput = {
  sourceOperationId: string;
  expectedFence: number;
};

type TerminalReviewerDeleteInput = {
  operationId: string;
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
  if (!UUID.test(input.operationId) || !Number.isSafeInteger(input.expectedFence) || input.expectedFence < 1)
    throw exomemErrors.invalidRequest();
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
      JOIN exomem_agent_contract_rollout_assignments AS assignment
        ON assignment.id = source.target_assignment_id
       AND assignment.tenant_id = tenant.id
       AND assignment.candidate_id = source.target_candidate_id
       AND assignment.generation = source.target_assignment_generation
       AND assignment.marketplace_reviewer_purpose = true
       AND ((assignment.state = 'expired' AND assignment.expires_at <= now())
         OR (assignment.state = 'failed' AND assignment.ended_at IS NOT NULL))
      JOIN exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
        ON bootstrap.state = 'consumed'
       AND bootstrap.outcome_tenant_id = tenant.id
       AND bootstrap.outcome_assignment_id = assignment.id
       AND bootstrap.outcome_assignment_generation = assignment.generation
       AND bootstrap.outcome_operation_id = source.id
      JOIN exomem_invites AS invite
        ON invite.id = bootstrap.invite_id AND invite.consumed_at IS NOT NULL
       AND invite.redeemed_tenant_id = tenant.id AND invite.redeemed_session_id = bootstrap.outcome_session_id
      JOIN exomem_sessions AS session
        ON session.id = bootstrap.outcome_session_id AND session.tenant_id = tenant.id
       AND session.revoked_at IS NOT NULL
      WHERE operation.id = ${input.operationId}::uuid
        AND operation.operation_type = 'delete'
        AND operation.state = 'failed_terminal' AND operation.error_code = 'LIFECYCLE_MAX_ATTEMPTS'
        AND operation.checkpoint = 'destroyed' AND operation.provider_result_ref IS NOT NULL
        AND operation.completed_at IS NOT NULL AND operation.lease_owner IS NULL
        AND operation.lease_expires_at IS NULL AND operation.fence_generation = ${input.expectedFence}::bigint
        AND operation.target_candidate_id IS NULL AND operation.target_assignment_id IS NULL
        AND operation.target_assignment_generation IS NULL
        AND tenant.fence_generation = ${input.expectedFence}::bigint
        AND tenant.marketplace_reviewer_purpose = true
        AND tenant.status = 'deletion_pending' AND tenant.desired_state = 'deleted'
        AND tenant.deleted_at IS NULL AND tenant.bound_cell_id IS NULL
        AND cell.routing_state = 'unbound' AND cell.lifecycle_state <> 'deleted' AND cell.provider_ref IS NULL
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
        SELECT operation.*, tenant.fence_generation AS tenant_fence_generation,
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
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.id = source.target_assignment_id
         AND assignment.tenant_id = operation.tenant_id
         AND assignment.candidate_id = source.target_candidate_id
         AND assignment.generation = source.target_assignment_generation
         AND assignment.marketplace_reviewer_purpose = true
         AND ((assignment.state = 'expired' AND assignment.expires_at <= now())
           OR (assignment.state = 'failed' AND assignment.ended_at IS NOT NULL))
        JOIN exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
          ON bootstrap.state = 'consumed'
         AND bootstrap.outcome_tenant_id = operation.tenant_id
         AND bootstrap.outcome_assignment_id = assignment.id
         AND bootstrap.outcome_assignment_generation = assignment.generation
         AND bootstrap.outcome_operation_id = source.id
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
          AND operation.checkpoint = 'destroyed' AND operation.provider_result_ref IS NOT NULL
          AND operation.completed_at IS NOT NULL AND operation.lease_owner IS NULL
          AND operation.lease_expires_at IS NULL
          AND operation.target_candidate_id IS NULL AND operation.target_assignment_id IS NULL
          AND operation.target_assignment_generation IS NULL
          AND operation.tenant_fence_generation = ${input.expectedFence}::bigint
          AND operation.marketplace_reviewer_purpose = true
          AND operation.tenant_status = 'deletion_pending' AND operation.tenant_desired_state = 'deleted'
          AND operation.tenant_deleted_at IS NULL AND operation.bound_cell_id IS NULL
          AND cell.routing_state = 'unbound' AND cell.lifecycle_state <> 'deleted' AND cell.provider_ref IS NULL
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
        AND source.operation_type IN ('provision', 'restore')
        AND source.state IN ('waiting', 'failed_retryable')
        AND source.checkpoint = 'candidate-cleanup'
        AND (source.lease_expires_at IS NULL OR source.lease_expires_at <= now())
        AND source.fence_generation = ${input.expectedFence}::bigint
        AND tenant.fence_generation = ${input.expectedFence}::bigint
        AND tenant.marketplace_reviewer_purpose = true
        AND tenant.status = 'provisioning' AND tenant.desired_state = 'running'
        AND tenant.deleted_at IS NULL AND tenant.bound_cell_id IS NULL
        AND cell.routing_state = 'unbound' AND cell.lifecycle_state <> 'deleted'
        AND (SELECT COUNT(*) FROM exomem_cells AS only_cell
             WHERE only_cell.tenant_id = tenant.id AND only_cell.lifecycle_state <> 'deleted') = 1
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
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:recover-expired-reviewer-cleanup */
      WITH source AS MATERIALIZED (
        SELECT source.*, tenant.owner_user_id, tenant.fence_generation AS tenant_fence_generation,
               tenant.status AS tenant_status, tenant.desired_state AS tenant_desired_state,
               tenant.marketplace_reviewer_purpose, tenant.deleted_at AS tenant_deleted_at,
               tenant.bound_cell_id, cell.id AS matched_cell_id
        FROM exomem_lifecycle_operations AS source
        JOIN exomem_tenants AS tenant ON tenant.id = source.tenant_id
        JOIN exomem_cells AS cell ON cell.id = source.cell_id AND cell.tenant_id = tenant.id
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
        JOIN exomem_lifecycle_operations AS delete_operation
          ON delete_operation.tenant_id = source.tenant_id
         AND delete_operation.operation_type = 'delete'
         AND delete_operation.idempotency_key = delete_key.value
         AND delete_operation.fence_generation = ${input.expectedFence}::bigint + 1
         AND delete_operation.target_candidate_id IS NULL
         AND delete_operation.target_assignment_id IS NULL
         AND delete_operation.target_assignment_generation IS NULL
        WHERE source.state = 'failed_terminal' AND source.error_code = 'DELETION_SUPERSEDED'
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
          AND source.operation_type IN ('provision', 'restore')
          AND source.state IN ('waiting', 'failed_retryable')
          AND source.checkpoint = 'candidate-cleanup'
          AND (source.lease_expires_at IS NULL OR source.lease_expires_at <= now())
          AND source.tenant_fence_generation = ${input.expectedFence}::bigint
          AND source.marketplace_reviewer_purpose = true
          AND source.tenant_status = 'provisioning' AND source.tenant_desired_state = 'running'
          AND source.tenant_deleted_at IS NULL AND source.bound_cell_id IS NULL
          AND cell.routing_state = 'unbound' AND cell.lifecycle_state <> 'deleted'
          AND (SELECT COUNT(*) FROM exomem_cells AS only_cell
               WHERE only_cell.tenant_id = source.tenant_id AND only_cell.lifecycle_state <> 'deleted') = 1
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
        FROM tenant_gated WHERE token.tenant_id = tenant_gated.id RETURNING token.id
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

async function withCohortControlLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
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
         AND candidate.profile_id = 'hosted-alpha-agent-v1'
         AND candidate.source_release = ${exomemContractFixture0490.release}
         AND candidate.protocol_version = ${exomemContractFixture0490.protocol}
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
            SELECT 1 FROM exomem_hosted_alpha_cohort
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
               stage.source_release, stage.protocol_version, ${exomemContractFixture0490.digest},
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
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
        SELECT count(*) < 32
          OR EXISTS (SELECT 1 FROM exomem_oauth_clients WHERE client_id = ${registration.clientId})
          AS allowed
        FROM exomem_oauth_clients
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
         AND candidate.profile_id = 'hosted-alpha-agent-v1'
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
