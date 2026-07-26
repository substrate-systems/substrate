import { executeExomemSql } from "./db";
import { EXOMEM_ALPHA_CAPACITY } from "./oauth-admission";

export type OAuthTokenContext = {
  grantId: string;
  familyId: string;
  clientId: string;
  resource: string;
};

export type ActiveOAuthAccessToken = OAuthTokenContext & {
  userId: string;
  tenantId: string;
  scopes: string[];
};

export type ApprovedOAuthClient = {
  id: string;
  clientId: string;
  redirectUris: string[];
  admissionMode: "pinned" | "cimd";
};

export async function resolveApprovedOAuthClient(
  clientId: string
): Promise<ApprovedOAuthClient | null> {
  const { rows } = await executeExomemSql`
    /* exomem:resolve-approved-oauth-client */
    SELECT id, client_id, redirect_uris, admission_mode
    FROM exomem_oauth_clients
    WHERE client_id = ${clientId}
      AND enabled = true
      AND admission_mode IN ('pinned', 'cimd')
      AND (metadata_expires_at IS NULL OR metadata_expires_at > now())
    LIMIT 1
  `;
  const row = rows[0] as
    | { id: string; client_id: string; redirect_uris: string[]; admission_mode: "pinned" | "cimd" }
    | undefined;
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        redirectUris: row.redirect_uris,
        admissionMode: row.admission_mode,
      }
    : null;
}

export async function createAuthorizationTransaction(input: {
  transactionDigest: Buffer;
  stateDigest: Buffer;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  pkceChallenge: string;
  expiresAt: Date;
}): Promise<{ id: string } | null> {
  const { rows } = await executeExomemSql`
    /* exomem:create-oauth-authorization-transaction */
    INSERT INTO exomem_oauth_authorization_transactions (
      transaction_digest, client_id, redirect_uri, resource, requested_scopes,
      state_digest, pkce_challenge, expires_at
    )
    SELECT ${input.transactionDigest}, client.id, ${input.redirectUri}, ${input.resource},
           ${input.scopes}, ${input.stateDigest}, ${input.pkceChallenge},
           ${input.expiresAt.toISOString()}
    FROM exomem_oauth_clients AS client
    WHERE client.client_id = ${input.clientId}
      AND client.enabled = true
    RETURNING id
  `;
  const row = rows[0] as { id: string } | undefined;
  return row ? { id: row.id } : null;
}

/**
 * The first OAuth invite completion is intentionally one statement: a failed
 * capacity compare-and-increment leaves the invite and authorization
 * transaction reusable, while success binds reservation, operation, session,
 * grant, and one-time code together.
 */
export async function admitFirstOAuthInviteAtomic(input: {
  inviteDigest: Buffer;
  transactionDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
  codeDigest: Buffer;
  codeExpiresAt: Date;
}): Promise<{ tenantId: string; sessionId: string; operationId: string; grantId: string } | null> {
  const { rows } = await executeExomemSql`
    /* exomem:admit-first-oauth-invite */
    WITH invite AS (
      SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits
      FROM exomem_invites
      WHERE token_digest = ${input.inviteDigest}
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      FOR UPDATE
    ),
    transaction AS (
      SELECT transaction.id, transaction.client_id, transaction.redirect_uri,
             transaction.resource, transaction.requested_scopes, transaction.pkce_challenge
      FROM exomem_oauth_authorization_transactions AS transaction
      JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id AND client.enabled = true
      WHERE transaction.transaction_digest = ${input.transactionDigest}
        AND transaction.consumed_at IS NULL AND transaction.expires_at > now()
      FOR UPDATE OF transaction
    ),
    pool_reservation AS (
      UPDATE exomem_capacity_pools AS pool
      SET reserved_storage_bytes = reserved_storage_bytes + ${EXOMEM_ALPHA_CAPACITY.storageBytes},
          reserved_runtime_slots = reserved_runtime_slots + ${EXOMEM_ALPHA_CAPACITY.runtimeSlots},
          reserved_provision_slots = reserved_provision_slots + ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots},
          updated_at = now()
      WHERE pool.pool_key = 'exomem-hosted-alpha'
        AND pool.configured_at IS NOT NULL
        AND pool.storage_capacity_bytes >= pool.reserved_storage_bytes + ${EXOMEM_ALPHA_CAPACITY.storageBytes}
        AND pool.runtime_capacity_slots >= pool.reserved_runtime_slots + ${EXOMEM_ALPHA_CAPACITY.runtimeSlots}
        AND pool.provision_reservation_capacity >= pool.reserved_provision_slots + ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots}
      RETURNING id
    ),
    owner AS (
      INSERT INTO users (email, email_verified_at)
      SELECT email_normalized, now() FROM invite CROSS JOIN transaction CROSS JOIN pool_reservation
      ON CONFLICT (email) DO UPDATE SET email_verified_at = COALESCE(users.email_verified_at, now())
      WHERE users.deleted_at IS NULL
      RETURNING id
    ),
    tenant AS (
      INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
      SELECT id, 'provisioning', 'running' FROM owner
      ON CONFLICT (owner_user_id) DO NOTHING
      RETURNING id, owner_user_id, fence_generation
    ),
    entitlement AS (
      INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state, capabilities, resource_limits)
      SELECT tenant.id, invite.entitlement_source,
             CASE WHEN invite.entitlement_source = 'complimentary' THEN 'complimentary_active' ELSE 'awaiting_checkout' END,
             CASE WHEN invite.entitlement_source = 'complimentary' THEN 'active' ELSE 'provisioning' END,
             invite.entitlement_capabilities, invite.entitlement_limits
      FROM tenant CROSS JOIN invite
      RETURNING tenant_id
    ),
    operation AS (
      INSERT INTO exomem_lifecycle_operations (tenant_id, operation_type, idempotency_key, fence_generation)
      SELECT tenant.id, 'provision', 'initial-provision', tenant.fence_generation FROM tenant
      RETURNING id, tenant_id
    ),
    allocation AS (
      INSERT INTO exomem_capacity_allocations (
        pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state, operation_id
      )
      SELECT pool_reservation.id, tenant.id, ${EXOMEM_ALPHA_CAPACITY.storageBytes},
             ${EXOMEM_ALPHA_CAPACITY.runtimeSlots}, ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots},
             'reserved', operation.id
      FROM pool_reservation CROSS JOIN tenant JOIN operation ON operation.tenant_id = tenant.id
      RETURNING tenant_id
    ),
    session AS (
      INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
      SELECT tenant.owner_user_id, tenant.id, ${input.sessionDigest}, ${input.csrfDigest}, ${input.sessionExpiresAt.toISOString()}
      FROM tenant JOIN allocation ON allocation.tenant_id = tenant.id
      RETURNING id, user_id, tenant_id
    ),
    grant AS (
      INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, authorization_transaction_id)
      SELECT session.user_id, session.tenant_id, transaction.client_id, transaction.resource,
             transaction.requested_scopes, transaction.id
      FROM session CROSS JOIN transaction
      RETURNING id, tenant_id
    ),
    code AS (
      INSERT INTO exomem_oauth_authorization_codes (
        code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, expires_at
      )
      SELECT ${input.codeDigest}, grant.id, transaction.client_id, transaction.redirect_uri,
             transaction.resource, transaction.pkce_challenge, ${input.codeExpiresAt.toISOString()}
      FROM grant CROSS JOIN transaction
      RETURNING grant_id
    ),
    consumed AS (
      UPDATE exomem_invites AS invite_row
      SET consumed_at = now(), consumed_by_user_id = session.user_id,
          redeemed_tenant_id = session.tenant_id, redeemed_session_id = session.id
      FROM invite JOIN session ON true JOIN operation ON operation.tenant_id = session.tenant_id
      WHERE invite_row.id = invite.id
      RETURNING session.tenant_id, session.id AS session_id, operation.id AS operation_id
    ),
    consumed_transaction AS (
      UPDATE exomem_oauth_authorization_transactions AS transaction_row
      SET consumed_at = now(), redeemed_session_id = session.id
      FROM transaction CROSS JOIN session JOIN code ON code.grant_id IS NOT NULL
      WHERE transaction_row.id = transaction.id
      RETURNING transaction_row.id
    )
    SELECT consumed.tenant_id, consumed.session_id, consumed.operation_id, grant.id AS grant_id
    FROM consumed CROSS JOIN grant CROSS JOIN consumed_transaction
  `;
  const row = rows[0] as
    | { tenant_id: string; session_id: string; operation_id: string; grant_id: string }
    | undefined;
  return row
    ? {
        tenantId: row.tenant_id,
        sessionId: row.session_id,
        operationId: row.operation_id,
        grantId: row.grant_id,
      }
    : null;
}

/** The MCP adapter must call this on every protected request. */
export async function findActiveOAuthAccessToken(
  accessDigest: Buffer
): Promise<ActiveOAuthAccessToken | null> {
  const { rows } = await executeExomemSql`
    /* exomem:find-active-oauth-access-token */
    SELECT token.family_id,
           token.grant_id,
           grant.user_id,
           grant.tenant_id,
           client.client_id,
           token.resource,
           token.scopes
    FROM exomem_oauth_access_tokens AS token
    JOIN exomem_oauth_token_families AS family
      ON family.id = token.family_id
     AND family.revoked_at IS NULL
     AND family.expires_at > now()
    JOIN exomem_oauth_grants AS grant
      ON grant.id = token.grant_id
     AND grant.revoked_at IS NULL
    JOIN exomem_oauth_clients AS client
      ON client.id = token.client_id
     AND client.enabled = true
    JOIN exomem_tenants AS tenant
      ON tenant.id = grant.tenant_id
     AND tenant.owner_user_id = grant.user_id
     AND tenant.status IN ('provisioning', 'active')
     AND tenant.desired_state = 'running'
    JOIN exomem_entitlements AS entitlement
      ON entitlement.tenant_id = tenant.id
     AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
    WHERE token.access_digest = ${accessDigest}
      AND token.revoked_at IS NULL
      AND token.expires_at > now()
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        family_id: string;
        grant_id: string;
        user_id: string;
        tenant_id: string;
        client_id: string;
        resource: string;
        scopes: string[];
      }
    | undefined;
  return row
    ? {
        familyId: row.family_id,
        grantId: row.grant_id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        clientId: row.client_id,
        resource: row.resource,
        scopes: row.scopes,
      }
    : null;
}

export async function revokeOAuthTokenFamily(familyId: string): Promise<void> {
  await executeExomemSql`
    /* exomem:revoke-oauth-token-family */
    UPDATE exomem_oauth_token_families
    SET revoked_at = COALESCE(revoked_at, now()),
        revoked_reason = COALESCE(revoked_reason, 'client_revoked')
    WHERE id = ${familyId}::uuid
  `;
}

export async function issueOAuthTokensFromCodeAtomic(input: {
  codeDigest: Buffer;
  clientId: string;
  redirectUri: string;
  resource: string;
  pkceChallenge: string;
  refreshDigest: Buffer;
  refreshExpiresAt: Date;
  accessDigest: Buffer;
  accessExpiresAt: Date;
}): Promise<OAuthTokenContext | null> {
  const { rows } = await executeExomemSql`
    /* exomem:oauth-code-exchange */
    WITH consumed_code AS (
      UPDATE exomem_oauth_authorization_codes AS code
      SET consumed_at = now()
      FROM exomem_oauth_grants AS grant
      WHERE code.code_digest = ${input.codeDigest}
        AND code.grant_id = grant.id
        AND code.client_id = ${input.clientId}::uuid
        AND code.redirect_uri = ${input.redirectUri}
        AND code.resource = ${input.resource}
        AND code.pkce_challenge = ${input.pkceChallenge}
        AND code.consumed_at IS NULL
        AND code.expires_at > now()
        AND grant.revoked_at IS NULL
      RETURNING code.grant_id, code.client_id, code.resource
    ),
    family AS (
      INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
      SELECT grant_id, client_id, now() + interval '30 days'
      FROM consumed_code
      RETURNING id, grant_id, client_id
    ),
    refresh AS (
      INSERT INTO exomem_oauth_refresh_tokens (refresh_digest, family_id, expires_at)
      SELECT ${input.refreshDigest}, id, ${input.refreshExpiresAt.toISOString()}
      FROM family
      RETURNING family_id
    ),
    access AS (
      INSERT INTO exomem_oauth_access_tokens (
        access_digest, grant_id, family_id, client_id, resource, scopes, expires_at
      )
      SELECT ${input.accessDigest}, family.grant_id, family.id, family.client_id,
             consumed_code.resource, grant.scopes, ${input.accessExpiresAt.toISOString()}
      FROM family
      JOIN consumed_code ON consumed_code.grant_id = family.grant_id
      JOIN exomem_oauth_grants AS grant ON grant.id = family.grant_id
      RETURNING id
    )
    SELECT consumed_code.grant_id, family.id AS family_id,
           client.client_id, consumed_code.resource
    FROM consumed_code
    JOIN family ON family.grant_id = consumed_code.grant_id
    JOIN exomem_oauth_clients AS client ON client.id = family.client_id
    JOIN refresh ON refresh.family_id = family.id
    JOIN access ON true
  `;
  const row = rows[0] as
    | { grant_id: string; family_id: string; client_id: string; resource: string }
    | undefined;
  return row
    ? {
        grantId: row.grant_id,
        familyId: row.family_id,
        clientId: row.client_id,
        resource: row.resource,
      }
    : null;
}

/**
 * The replay branch runs in the same statement as the attempted rotation.
 * No replacement credential is retained, so a consumed digest permanently
 * revokes its family even if the original response was lost.
 */
export async function rotateOAuthRefreshTokenAtomic(input: {
  refreshDigest: Buffer;
  replacementRefreshDigest: Buffer;
  accessDigest: Buffer;
  accessExpiresAt: Date;
  clientId: string;
  resource: string;
}): Promise<OAuthTokenContext | null> {
  const { rows } = await executeExomemSql`
    /* exomem:oauth-refresh-rotate */
    WITH known_token AS (
      SELECT token.id, token.family_id, family.grant_id, family.client_id
      FROM exomem_oauth_refresh_tokens AS token
      JOIN exomem_oauth_token_families AS family ON family.id = token.family_id
      WHERE token.refresh_digest = ${input.refreshDigest}
        AND family.client_id = ${input.clientId}::uuid
        AND EXISTS (
          SELECT 1 FROM exomem_oauth_grants AS grant
          WHERE grant.id = family.grant_id AND grant.resource = ${input.resource}
        )
      FOR UPDATE OF token, family
    ),
    consumed AS (
      UPDATE exomem_oauth_refresh_tokens AS token
      SET consumed_at = now()
      FROM known_token
      JOIN exomem_oauth_token_families AS family ON family.id = known_token.family_id
      JOIN exomem_oauth_grants AS grant ON grant.id = family.grant_id
      WHERE token.id = known_token.id
        AND token.consumed_at IS NULL
        AND token.expires_at > now()
        AND family.revoked_at IS NULL
        AND family.expires_at > now()
        AND grant.revoked_at IS NULL
      RETURNING known_token.family_id, known_token.grant_id, known_token.client_id
    ),
    replay_revocation AS (
      UPDATE exomem_oauth_token_families AS family
      SET revoked_at = now(),
          revoked_reason = 'refresh_replayed'
      FROM known_token
      WHERE family.id = known_token.family_id
        AND NOT EXISTS (SELECT 1 FROM consumed)
        AND family.revoked_at IS NULL
      RETURNING family.id
    ),
    replacement AS (
      INSERT INTO exomem_oauth_refresh_tokens (
        refresh_digest, family_id, parent_refresh_token_id, expires_at
      )
      SELECT ${input.replacementRefreshDigest}, consumed.family_id, known_token.id,
             family.expires_at
      FROM consumed
      JOIN known_token ON known_token.family_id = consumed.family_id
      JOIN exomem_oauth_token_families AS family ON family.id = consumed.family_id
      RETURNING family_id
    ),
    access AS (
      INSERT INTO exomem_oauth_access_tokens (
        access_digest, grant_id, family_id, client_id, resource, scopes, expires_at
      )
      SELECT ${input.accessDigest}, consumed.grant_id, consumed.family_id,
             consumed.client_id, grant.resource, grant.scopes,
             ${input.accessExpiresAt.toISOString()}
      FROM consumed
      JOIN exomem_oauth_grants AS grant ON grant.id = consumed.grant_id
      RETURNING id
    )
    SELECT consumed.grant_id, consumed.family_id, client.client_id, grant.resource
    FROM consumed
    JOIN replacement ON replacement.family_id = consumed.family_id
    JOIN access ON true
    JOIN exomem_oauth_grants AS grant ON grant.id = consumed.grant_id
    JOIN exomem_oauth_clients AS client ON client.id = consumed.client_id
  `;
  const row = rows[0] as
    | { grant_id: string; family_id: string; client_id: string; resource: string }
    | undefined;
  return row
    ? {
        grantId: row.grant_id,
        familyId: row.family_id,
        clientId: row.client_id,
        resource: row.resource,
      }
    : null;
}
