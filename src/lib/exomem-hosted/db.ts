import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { exomemErrors } from "./errors";

export type ExomemSqlResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
};

export type ExomemSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<ExomemSqlResult>;

let sqlClient: ExomemSql | null = null;

function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<ExomemSqlResult> {
  if (!sqlClient) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is not set");
    const client: NeonQueryFunction<false, true> = neon(databaseUrl, {
      fullResults: true,
    });
    sqlClient = (queryStrings, ...queryValues) =>
      client(queryStrings, ...queryValues) as Promise<ExomemSqlResult>;
  }
  return sqlClient(strings, ...values);
}

export function __setExomemSqlForTests(next: ExomemSql | null): void {
  sqlClient = next;
}

/** Shared product-scoped SQL executor for narrowly typed store modules. */
export function executeExomemSql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<ExomemSqlResult> {
  return sql(strings, ...values);
}

export type EntitlementSource = "complimentary" | "paddle";

export type CreateInviteRecordInput = {
  tokenDigest: Buffer;
  emailNormalized: string;
  entitlementSource: EntitlementSource;
  capabilities: string[];
  resourceLimits: Record<string, number>;
  operatorPrincipalDigest: Buffer;
  expiresAt: Date;
};

export async function createInviteRecord(
  input: CreateInviteRecordInput
): Promise<{ inviteId: string }> {
  const { rows } = await sql`
    /* exomem:create-invite */
    INSERT INTO exomem_invites (
      token_digest,
      email_normalized,
      entitlement_source,
      entitlement_capabilities,
      entitlement_limits,
      created_by_principal_digest,
      expires_at
    ) VALUES (
      ${input.tokenDigest},
      ${input.emailNormalized},
      ${input.entitlementSource},
      ${JSON.stringify(input.capabilities)}::jsonb,
      ${JSON.stringify(input.resourceLimits)}::jsonb,
      ${input.operatorPrincipalDigest},
      ${input.expiresAt.toISOString()}
    )
    RETURNING id
  `;
  const row = rows[0] as { id: string } | undefined;
  if (!row) throw new Error("createInviteRecord returned no row");
  return { inviteId: row.id };
}

export async function markInviteDelivered(inviteId: string): Promise<void> {
  await sql`
    /* exomem:invite-delivered */
    UPDATE exomem_invites
    SET delivery_state = 'sent',
        delivery_attempts = delivery_attempts + 1,
        delivered_at = now(),
        delivery_error_code = NULL
    WHERE id = ${inviteId} AND consumed_at IS NULL AND revoked_at IS NULL
  `;
}

export async function markInviteDeliveryFailed(inviteId: string, errorCode: string): Promise<void> {
  await sql`
    /* exomem:invite-delivery-failed */
    UPDATE exomem_invites
    SET delivery_state = 'failed',
        delivery_attempts = delivery_attempts + 1,
        delivery_error_code = ${errorCode},
        revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${inviteId} AND consumed_at IS NULL
  `;
}

export type RedeemInviteAtomicInput = {
  tokenDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
};

export type RedeemedAccess = {
  userId: string;
  tenantId: string;
  sessionId: string;
  operationId: string;
};

/**
 * Consume an invite and create every product-scoped row in one SQL statement.
 * The locked invite is the dependency root for all data-modifying CTEs, so a
 * replay or concurrent caller returns no row and cannot create a second tenant.
 */
export async function redeemInviteAtomic(
  input: RedeemInviteAtomicInput
): Promise<RedeemedAccess | null> {
  const { rows } = await sql`
    /* exomem:redeem-invite */
    WITH locked_invite AS (
      SELECT id, email_normalized, entitlement_source,
             entitlement_capabilities, entitlement_limits
      FROM exomem_invites
      WHERE token_digest = ${input.tokenDigest}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      FOR UPDATE
    ),
    owner AS (
      INSERT INTO users (email, email_verified_at)
      SELECT email_normalized, now()
      FROM locked_invite
      ON CONFLICT (email) DO UPDATE
      SET email = EXCLUDED.email,
          email_verified_at = COALESCE(users.email_verified_at, now())
      WHERE users.deleted_at IS NULL
      RETURNING id
    ),
    tenant AS (
      INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
      SELECT id, 'provisioning', 'running'
      FROM owner
      ON CONFLICT (owner_user_id) DO UPDATE
      SET updated_at = exomem_tenants.updated_at
      WHERE exomem_tenants.status <> 'deleted'
      RETURNING id, owner_user_id
    ),
    existing_entitlement AS (
      SELECT entitlement.tenant_id
      FROM exomem_entitlements AS entitlement
      JOIN tenant ON tenant.id = entitlement.tenant_id
    ),
    entitlement_insert AS (
      INSERT INTO exomem_entitlements (
        tenant_id, source, source_state, effective_state,
        capabilities, resource_limits
      )
      SELECT tenant.id,
             locked_invite.entitlement_source,
             CASE
               WHEN locked_invite.entitlement_source = 'complimentary'
               THEN 'complimentary_active'
               ELSE 'awaiting_checkout'
             END,
             CASE
               WHEN locked_invite.entitlement_source = 'complimentary'
               THEN 'active'
               ELSE 'provisioning'
             END,
             locked_invite.entitlement_capabilities,
             locked_invite.entitlement_limits
      FROM tenant
      CROSS JOIN locked_invite
      WHERE NOT EXISTS (
        SELECT 1 FROM existing_entitlement
        WHERE existing_entitlement.tenant_id = tenant.id
      )
      ON CONFLICT (tenant_id) DO NOTHING
      RETURNING tenant_id
    ),
    entitlement_ready AS (
      SELECT tenant_id FROM existing_entitlement
      UNION ALL
      SELECT tenant_id FROM entitlement_insert
    ),
    product_session AS (
      INSERT INTO exomem_sessions (
        user_id, tenant_id, session_digest, csrf_digest, expires_at
      )
      SELECT tenant.owner_user_id,
             tenant.id,
             ${input.sessionDigest},
             ${input.csrfDigest},
             ${input.sessionExpiresAt.toISOString()}
      FROM tenant
      JOIN entitlement_ready AS entitlement
        ON entitlement.tenant_id = tenant.id
      RETURNING id, user_id, tenant_id
    ),
    operation AS (
      INSERT INTO exomem_lifecycle_operations (
        tenant_id, operation_type, idempotency_key
      )
      SELECT tenant.id, 'provision', 'initial-provision'
      FROM tenant
      ON CONFLICT (tenant_id, operation_type, idempotency_key) DO UPDATE
      SET updated_at = exomem_lifecycle_operations.updated_at
      RETURNING id, tenant_id
    ),
    consumed AS (
      UPDATE exomem_invites AS invite
      SET consumed_at = now(),
          consumed_by_user_id = product_session.user_id,
          redeemed_tenant_id = product_session.tenant_id,
          redeemed_session_id = product_session.id
      FROM locked_invite, product_session, operation
      WHERE invite.id = locked_invite.id
        AND operation.tenant_id = product_session.tenant_id
      RETURNING product_session.user_id,
                product_session.tenant_id,
                product_session.id AS session_id,
                operation.id AS operation_id
    )
    SELECT user_id, tenant_id, session_id, operation_id
    FROM consumed
  `;
  const row = rows[0] as
    | {
        user_id: string;
        tenant_id: string;
        session_id: string;
        operation_id: string;
      }
    | undefined;
  return row
    ? {
        userId: row.user_id,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        operationId: row.operation_id,
      }
    : null;
}

export type CreateMagicAccessTokenInput = {
  emailNormalized: string;
  tokenDigest: Buffer;
  expiresAt: Date;
};

export async function createMagicAccessToken(
  input: CreateMagicAccessTokenInput
): Promise<{ tokenId: string; emailNormalized: string } | null> {
  const { rows } = await sql`
    /* exomem:create-magic-access-token */
    INSERT INTO exomem_access_tokens (
      purpose, token_digest, user_id, tenant_id, expires_at
    )
    SELECT 'magic_link',
           ${input.tokenDigest},
           users.id,
           tenant.id,
           ${input.expiresAt.toISOString()}
    FROM users
    JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
    WHERE users.email = ${input.emailNormalized}
      AND users.deleted_at IS NULL
      AND tenant.status <> 'deleted'
      AND tenant.deleted_at IS NULL
    ON CONFLICT (token_digest) DO NOTHING
    RETURNING id, ${input.emailNormalized}::text AS email_normalized
  `;
  const row = rows[0] as { id: string; email_normalized: string } | undefined;
  return row ? { tokenId: row.id, emailNormalized: row.email_normalized } : null;
}

export async function markAccessTokenDelivered(tokenId: string): Promise<void> {
  await sql`
    /* exomem:access-token-delivered */
    UPDATE exomem_access_tokens
    SET delivery_state = 'sent', delivered_at = now(), delivery_error_code = NULL
    WHERE id = ${tokenId} AND consumed_at IS NULL AND revoked_at IS NULL
  `;
}

export async function markAccessTokenDeliveryFailed(
  tokenId: string,
  errorCode: string
): Promise<void> {
  await sql`
    /* exomem:access-token-delivery-failed */
    UPDATE exomem_access_tokens
    SET delivery_state = 'failed',
        delivery_error_code = ${errorCode},
        revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${tokenId} AND consumed_at IS NULL
  `;
}

export type RedeemMagicAccessTokenInput = {
  tokenDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
};

export async function redeemMagicAccessTokenAtomic(
  input: RedeemMagicAccessTokenInput
): Promise<Omit<RedeemedAccess, "operationId"> | null> {
  const { rows } = await sql`
    /* exomem:redeem-magic-access-token */
    WITH locked_token AS (
      SELECT token.id, token.user_id, token.tenant_id
      FROM exomem_access_tokens AS token
      JOIN users ON users.id = token.user_id AND users.deleted_at IS NULL
      JOIN exomem_tenants AS tenant
        ON tenant.id = token.tenant_id
       AND tenant.owner_user_id = token.user_id
       AND tenant.status <> 'deleted'
       AND tenant.deleted_at IS NULL
      WHERE token.token_digest = ${input.tokenDigest}
        AND token.purpose = 'magic_link'
        AND token.consumed_at IS NULL
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
      FOR UPDATE OF token
    ),
    product_session AS (
      INSERT INTO exomem_sessions (
        user_id, tenant_id, session_digest, csrf_digest, expires_at
      )
      SELECT user_id,
             tenant_id,
             ${input.sessionDigest},
             ${input.csrfDigest},
             ${input.sessionExpiresAt.toISOString()}
      FROM locked_token
      RETURNING id, user_id, tenant_id
    ),
    consumed AS (
      UPDATE exomem_access_tokens AS token
      SET consumed_at = now()
      FROM locked_token, product_session
      WHERE token.id = locked_token.id
      RETURNING product_session.user_id,
                product_session.tenant_id,
                product_session.id AS session_id
    )
    SELECT user_id, tenant_id, session_id FROM consumed
  `;
  const row = rows[0] as { user_id: string; tenant_id: string; session_id: string } | undefined;
  return row
    ? {
        userId: row.user_id,
        tenantId: row.tenant_id,
        sessionId: row.session_id,
      }
    : null;
}

export type ExomemSessionRow = {
  id: string;
  userId: string;
  tenantId: string;
  csrfDigest: Buffer;
  expiresAt: string;
};

export async function findExomemSessionByDigest(
  sessionDigest: Buffer
): Promise<ExomemSessionRow | null> {
  const { rows } = await sql`
    /* exomem:find-session */
    SELECT session.id,
           session.user_id,
           session.tenant_id,
           session.csrf_digest,
           session.expires_at
    FROM exomem_sessions AS session
    JOIN users ON users.id = session.user_id AND users.deleted_at IS NULL
    JOIN exomem_tenants AS tenant
      ON tenant.id = session.tenant_id
     AND tenant.owner_user_id = session.user_id
     AND tenant.status <> 'deleted'
    WHERE session.session_digest = ${sessionDigest}
      AND session.revoked_at IS NULL
      AND session.expires_at > now()
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        id: string;
        user_id: string;
        tenant_id: string;
        csrf_digest: Uint8Array;
        expires_at: string;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        csrfDigest: Buffer.from(row.csrf_digest),
        expiresAt: row.expires_at,
      }
    : null;
}

export async function revokeExomemSession(sessionId: string): Promise<void> {
  await sql`
    /* exomem:revoke-session */
    UPDATE exomem_sessions
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${sessionId}
  `;
}

export async function revokeTenantSessions(tenantId: string): Promise<number> {
  const { rowCount } = await sql`
    /* exomem:revoke-tenant-sessions */
    UPDATE exomem_sessions
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE tenant_id = ${tenantId} AND revoked_at IS NULL
  `;
  return rowCount ?? 0;
}

export async function rotateExomemSessionAtomic(input: {
  sessionId: string;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  expiresAt: Date;
}): Promise<{ sessionId: string } | null> {
  const { rows } = await sql`
    /* exomem:rotate-session */
    WITH previous AS (
      UPDATE exomem_sessions
      SET revoked_at = now()
      WHERE id = ${input.sessionId}
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id, tenant_id
    ),
    replacement AS (
      INSERT INTO exomem_sessions (
        user_id, tenant_id, session_digest, csrf_digest,
        expires_at, rotated_from_session_id
      )
      SELECT user_id,
             tenant_id,
             ${input.sessionDigest},
             ${input.csrfDigest},
             ${input.expiresAt.toISOString()},
             id
      FROM previous
      RETURNING id
    )
    SELECT id FROM replacement
  `;
  const row = rows[0] as { id: string } | undefined;
  return row ? { sessionId: row.id } : null;
}

export type OwnerTenant = {
  userId: string;
  tenantId: string;
  tenantStatus: string;
};

export async function resolveOwnerTenant(userId: string): Promise<OwnerTenant | null> {
  const { rows } = await sql`
    /* exomem:resolve-owner-tenant */
    SELECT owner_user_id, id, status
    FROM exomem_tenants
    WHERE owner_user_id = ${userId} AND status <> 'deleted'
    LIMIT 2
  `;
  if (rows.length > 1) throw exomemErrors.cellMappingAmbiguous();
  const row = rows[0] as { owner_user_id: string; id: string; status: string } | undefined;
  return row ? { userId: row.owner_user_id, tenantId: row.id, tenantStatus: row.status } : null;
}

export type ActiveCellBinding = {
  cellId: string;
  tenantId: string;
  protocolVersion: string;
  releaseVersion: string;
  credentialCiphertext: Record<string, unknown> | null;
  endpointCiphertext: Record<string, unknown> | null;
};

export async function resolveActiveCellBinding(
  tenantId: string
): Promise<ActiveCellBinding | null> {
  const { rows } = await sql`
    /* exomem:resolve-active-cell */
    SELECT cell.id,
           cell.tenant_id,
           cell.protocol_version,
           cell.release_version,
           cell.service_credential_ciphertext,
           cell.private_endpoint_ciphertext
    FROM exomem_tenants AS tenant
    JOIN exomem_cells AS cell
      ON cell.id = tenant.bound_cell_id
     AND cell.tenant_id = tenant.id
    WHERE tenant.id = ${tenantId}
      AND cell.routing_state = 'bound'
      AND cell.lifecycle_state = 'active'
    LIMIT 2
  `;
  if (rows.length > 1) throw exomemErrors.cellMappingAmbiguous();
  const row = rows[0] as
    | {
        id: string;
        tenant_id: string;
        protocol_version?: string;
        release_version?: string;
        service_credential_ciphertext?: Record<string, unknown> | null;
        private_endpoint_ciphertext?: Record<string, unknown> | null;
      }
    | undefined;
  return row
    ? {
        cellId: row.id,
        tenantId: row.tenant_id,
        protocolVersion: row.protocol_version ?? "",
        releaseVersion: row.release_version ?? "",
        credentialCiphertext: row.service_credential_ciphertext ?? null,
        endpointCiphertext: row.private_endpoint_ciphertext ?? null,
      }
    : null;
}

/**
 * Publish an initial or replacement cell in one statement. Replacement keeps
 * the prior cell authoritative until the tenant and candidate rows have been
 * locked and the expected binding has been proven. The tenant row is the stable
 * serialization point even for two initial candidates, while the cell partial
 * unique index remains defense in depth.
 */
export async function bindActiveCellAtomic(input: {
  tenantId: string;
  candidateCellId: string;
  expectedPreviousCellId: string | null;
}): Promise<{ cellId: string; previousCellId: string | null } | null> {
  const { rows } = await sql`
    /* exomem:bind-active-cell */
    WITH tenant_lock AS (
      SELECT id, bound_cell_id
      FROM exomem_tenants
      WHERE id = ${input.tenantId}
      FOR UPDATE
    ),
    candidate AS (
      SELECT cell.id
      FROM exomem_cells AS cell
      JOIN tenant_lock AS tenant ON tenant.id = cell.tenant_id
      WHERE cell.id = ${input.candidateCellId}
        AND cell.routing_state = 'unbound'
        AND cell.lifecycle_state IN ('provisioning', 'active', 'restoring')
      FOR UPDATE OF cell
    ),
    swap_guard AS (
      SELECT candidate.id AS candidate_id,
             tenant_lock.bound_cell_id AS previous_id,
             tenant_lock.id AS tenant_id
      FROM candidate
      JOIN tenant_lock ON TRUE
      WHERE (
        ${input.expectedPreviousCellId}::uuid IS NULL
        AND tenant_lock.bound_cell_id IS NULL
      ) OR tenant_lock.bound_cell_id = ${input.expectedPreviousCellId}::uuid
    ),
    authoritative_binding AS (
      UPDATE exomem_tenants AS tenant
      SET bound_cell_id = swap_guard.candidate_id,
          updated_at = now()
      FROM swap_guard
      WHERE tenant.id = swap_guard.tenant_id
      RETURNING tenant.id
    ),
    retired AS (
      UPDATE exomem_cells AS cell
      SET routing_state = 'retiring', updated_at = now()
      FROM swap_guard
      WHERE cell.id = swap_guard.previous_id
        AND EXISTS (SELECT 1 FROM authoritative_binding)
      RETURNING cell.id
    ),
    published AS (
      UPDATE exomem_cells AS cell
      SET routing_state = 'bound',
          lifecycle_state = 'active',
          bound_at = COALESCE(bound_at, now()),
          updated_at = now()
      FROM swap_guard
      WHERE cell.id = swap_guard.candidate_id
        AND EXISTS (SELECT 1 FROM authoritative_binding)
        AND (
          swap_guard.previous_id IS NULL
          OR EXISTS (SELECT 1 FROM retired)
        )
      RETURNING cell.id
    )
    SELECT published.id AS cell_id,
           swap_guard.previous_id AS previous_cell_id
    FROM published
    JOIN swap_guard ON swap_guard.candidate_id = published.id
  `;
  const row = rows[0] as { cell_id: string; previous_cell_id: string | null } | undefined;
  return row ? { cellId: row.cell_id, previousCellId: row.previous_cell_id } : null;
}

export async function projectEntitlement(input: {
  tenantId: string;
  source: EntitlementSource;
  sourceState: string;
  effectiveState: string;
  capabilities: string[];
  resourceLimits: Record<string, number>;
  sourceRevision?: string;
  sourceOccurredAt?: Date;
}): Promise<void> {
  await sql`
    /* exomem:project-entitlement */
    INSERT INTO exomem_entitlements (
      tenant_id, source, source_state, effective_state,
      capabilities, resource_limits, source_revision, source_occurred_at
    ) VALUES (
      ${input.tenantId},
      ${input.source},
      ${input.sourceState},
      ${input.effectiveState},
      ${JSON.stringify(input.capabilities)}::jsonb,
      ${JSON.stringify(input.resourceLimits)}::jsonb,
      ${input.sourceRevision ?? null},
      ${input.sourceOccurredAt?.toISOString() ?? null}
    )
    ON CONFLICT (tenant_id) DO UPDATE
    SET source = EXCLUDED.source,
        source_state = EXCLUDED.source_state,
        effective_state = EXCLUDED.effective_state,
        capabilities = EXCLUDED.capabilities,
        resource_limits = EXCLUDED.resource_limits,
        source_revision = EXCLUDED.source_revision,
        source_occurred_at = EXCLUDED.source_occurred_at,
        updated_at = now()
  `;
}

export type ClaimedLifecycleOperation = {
  id: string;
  tenantId: string;
  cellId: string | null;
  operationType: string;
  checkpoint: string;
  attempts: number;
};

export async function claimLifecycleOperation(input: {
  leaseOwner: string;
  leaseSeconds: number;
}): Promise<ClaimedLifecycleOperation | null> {
  const { rows } = await sql`
    /* exomem:claim-lifecycle-operation */
    WITH candidate AS (
      SELECT id
      FROM exomem_lifecycle_operations
      WHERE state IN ('pending', 'failed_retryable', 'waiting')
        AND next_attempt_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY next_attempt_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE exomem_lifecycle_operations AS operation
    SET state = 'running',
        lease_owner = ${input.leaseOwner},
        lease_expires_at = now() + (interval '1 second' * ${input.leaseSeconds}),
        attempts = attempts + 1,
        updated_at = now()
    FROM candidate
    WHERE operation.id = candidate.id
    RETURNING operation.id,
              operation.tenant_id,
              operation.cell_id,
              operation.operation_type,
              operation.checkpoint,
              operation.attempts
  `;
  const row = rows[0] as
    | {
        id: string;
        tenant_id: string;
        cell_id: string | null;
        operation_type: string;
        checkpoint: string;
        attempts: number;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        tenantId: row.tenant_id,
        cellId: row.cell_id,
        operationType: row.operation_type,
        checkpoint: row.checkpoint,
        attempts: row.attempts,
      }
    : null;
}

export async function takeRateLimit(input: {
  scope: string;
  keyDigest: string;
  limit: number;
  windowSeconds: number;
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:take-rate-limit */
    WITH recent AS (
      SELECT COUNT(*)::int AS count
      FROM rate_limit_events
      WHERE scope = ${input.scope}
        AND key = ${input.keyDigest}
        AND at > now() - (interval '1 second' * ${input.windowSeconds})
    ),
    recorded AS (
      INSERT INTO rate_limit_events (scope, key)
      SELECT ${input.scope}, ${input.keyDigest}
      FROM recent
      WHERE recent.count < ${input.limit}
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM recorded) AS allowed
  `;
  return Boolean((rows[0] as { allowed?: boolean } | undefined)?.allowed);
}
