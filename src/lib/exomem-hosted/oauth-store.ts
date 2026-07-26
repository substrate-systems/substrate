import { executeExomemSql, withExomemTransaction } from "./db";
import { EXOMEM_ALPHA_CAPACITY } from "./oauth-admission";
import type { SecretEnvelope } from "./security";

export type OAuthTokenContext = {
  grantId: string;
  familyId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  refreshAllowed?: boolean;
  refreshInserted?: boolean;
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

const MAX_PENDING_OAUTH_AUTHORIZATIONS = 2_000;

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
  stateEnvelope: SecretEnvelope;
  formNonceDigest: Buffer;
  continuationBinding: Buffer;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  pkceChallenge: string;
  expiresAt: Date;
}): Promise<{ id: string } | null> {
  const { rows } = await executeExomemSql`
    /* exomem:create-oauth-authorization-transaction */
    WITH pruned AS (
      DELETE FROM exomem_oauth_authorization_transactions
      WHERE id IN (
        SELECT id FROM exomem_oauth_authorization_transactions
        WHERE expires_at <= now() OR consumed_at < now() - interval '1 day'
        ORDER BY expires_at
        LIMIT 50
      )
      RETURNING id
    )
    INSERT INTO exomem_oauth_authorization_transactions (
      transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
    )
    SELECT ${input.transactionDigest}, client.id, ${input.redirectUri}, ${input.resource},
            ${input.scopes}, ${input.stateDigest}, ${JSON.stringify(input.stateEnvelope)}::jsonb,
            ${input.formNonceDigest}, ${input.continuationBinding},
           ${input.pkceChallenge},
           ${input.expiresAt.toISOString()}
    FROM exomem_oauth_clients AS client
    WHERE client.client_id = ${input.clientId}
      AND client.enabled = true
      AND (
        SELECT count(*) FROM exomem_oauth_authorization_transactions
        WHERE consumed_at IS NULL AND expires_at > now()
      ) < ${MAX_PENDING_OAUTH_AUTHORIZATIONS}
    RETURNING id
  `;
  const row = rows[0] as { id: string } | undefined;
  return row ? { id: row.id } : null;
}

export type PendingOAuthAuthorization = {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  stateEnvelope: SecretEnvelope;
  stateDigest: Buffer;
  formNonceDigest: Buffer;
  continuationBinding: Buffer;
  pkceChallenge: string;
};

export async function findPendingOAuthAuthorization(
  transactionDigest: Buffer
): Promise<PendingOAuthAuthorization | null> {
  const { rows } = await executeExomemSql`
    /* exomem:find-pending-oauth-authorization */
    SELECT client.client_id, transaction.redirect_uri, transaction.resource,
           transaction.requested_scopes, transaction.state_envelope, transaction.state_digest,
           transaction.form_nonce_digest, transaction.continuation_binding, transaction.pkce_challenge
    FROM exomem_oauth_authorization_transactions AS transaction
    JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id
    WHERE transaction.transaction_digest = ${transactionDigest}
      AND transaction.consumed_at IS NULL
      AND transaction.expires_at > now()
      AND client.enabled = true
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        client_id: string;
        redirect_uri: string;
        resource: string;
        requested_scopes: string[];
        state_envelope: SecretEnvelope;
        state_digest: Uint8Array;
        form_nonce_digest: Uint8Array;
        continuation_binding: Uint8Array;
        pkce_challenge: string;
      }
    | undefined;
  return row
    ? {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        resource: row.resource,
        scopes: row.requested_scopes,
        stateEnvelope: row.state_envelope,
        stateDigest: Buffer.from(row.state_digest),
        formNonceDigest: Buffer.from(row.form_nonce_digest),
        continuationBinding: Buffer.from(row.continuation_binding),
        pkceChallenge: row.pkce_challenge,
      }
    : null;
}

/** Attaches a client grant/code to an already entitled browser-session owner; no capacity or lifecycle row is touched. */
export async function attachExistingOwnerAuthorizationAtomic(input: {
  sessionId: string;
  transactionDigest: Buffer;
  codeDigest: Buffer;
  codeExpiresAt: Date;
}): Promise<{ grantId: string; tenantId: string } | null> {
  const { rows } = await executeExomemSql`
    /* exomem:attach-existing-owner-oauth */
    WITH session AS (
      SELECT session.id, session.user_id, session.tenant_id
      FROM exomem_sessions AS session
      JOIN exomem_entitlements AS entitlement
        ON entitlement.tenant_id = session.tenant_id
       AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
      WHERE session.id = ${input.sessionId}::uuid
        AND session.revoked_at IS NULL AND session.expires_at > now()
      FOR UPDATE OF session
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
    grant AS (
      INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed, authorization_transaction_id)
      SELECT session.user_id, session.tenant_id, transaction.client_id, transaction.resource,
             array_remove(transaction.requested_scopes, 'offline_access'),
             'offline_access' = ANY(transaction.requested_scopes), transaction.id
      FROM session CROSS JOIN transaction
      ON CONFLICT (user_id, tenant_id, client_id, resource) WHERE revoked_at IS NULL
      DO UPDATE SET scopes = EXCLUDED.scopes,
                    refresh_allowed = EXCLUDED.refresh_allowed,
                    authorization_transaction_id = EXCLUDED.authorization_transaction_id,
                    updated_at = now()
      RETURNING id, tenant_id
    ),
    code AS (
      INSERT INTO exomem_oauth_authorization_codes (
        code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at
      )
      SELECT ${input.codeDigest}, grant.id, transaction.client_id, transaction.redirect_uri,
             transaction.resource, transaction.pkce_challenge,
             'offline_access' = ANY(transaction.requested_scopes), ${input.codeExpiresAt.toISOString()}
      FROM grant CROSS JOIN transaction
      RETURNING grant_id
    ),
    consumed AS (
      UPDATE exomem_oauth_authorization_transactions AS transaction_row
      SET consumed_at = now(), redeemed_session_id = session.id
      FROM transaction CROSS JOIN session CROSS JOIN code
      WHERE transaction_row.id = transaction.id
      RETURNING transaction_row.id
    )
    SELECT grant.id AS grant_id, grant.tenant_id FROM grant CROSS JOIN consumed
  `;
  const row = rows[0] as { grant_id: string; tenant_id: string } | undefined;
  return row ? { grantId: row.grant_id, tenantId: row.tenant_id } : null;
}

export async function pruneExpiredOAuthState(): Promise<void> {
  await executeExomemSql`
    /* exomem:prune-expired-oauth-state */
    WITH expired_transactions AS (
      DELETE FROM exomem_oauth_authorization_transactions
      WHERE id IN (
        SELECT id FROM exomem_oauth_authorization_transactions
        WHERE expires_at <= now() OR consumed_at < now() - interval '1 day'
        ORDER BY expires_at LIMIT 500
      )
      RETURNING id
    ), expired_codes AS (
      DELETE FROM exomem_oauth_authorization_codes
      WHERE id IN (
        SELECT id FROM exomem_oauth_authorization_codes
        WHERE expires_at <= now() OR consumed_at < now() - interval '1 day'
        ORDER BY expires_at LIMIT 500
      )
      RETURNING id
    ), expired_access AS (
      DELETE FROM exomem_oauth_access_tokens
      WHERE id IN (
        SELECT id FROM exomem_oauth_access_tokens
        WHERE expires_at <= now() OR revoked_at < now() - interval '1 day'
        ORDER BY expires_at LIMIT 500
      )
      RETURNING id
    ), expired_refresh AS (
      DELETE FROM exomem_oauth_refresh_tokens
      WHERE id IN (
        SELECT token.id FROM exomem_oauth_refresh_tokens AS token
        JOIN exomem_oauth_token_families AS family ON family.id = token.family_id
        WHERE family.expires_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM exomem_oauth_refresh_tokens AS child
            WHERE child.parent_refresh_token_id = token.id
          )
        ORDER BY token.expires_at LIMIT 500
      )
      RETURNING family_id
    ), expired_families AS (
      DELETE FROM exomem_oauth_token_families
      WHERE id IN (
        SELECT family.id FROM exomem_oauth_token_families AS family
        WHERE family.expires_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM exomem_oauth_refresh_tokens AS token WHERE token.family_id = family.id
          )
        ORDER BY family.expires_at LIMIT 500
      )
      RETURNING id
    )
    UPDATE exomem_oauth_clients
    SET enabled = false, metadata_expires_at = now()
    WHERE admission_mode = 'cimd' AND metadata_expires_at <= now()
  `;
}

class OAuthAdmissionRejected extends Error {}

type OAuthInviteAdmission = {
  tenantId: string;
  sessionId: string;
  operationId: string | null;
  grantId: string;
};

/**
 * Serializes duplicate identities on the users.email unique key. Capacity is
 * reserved only after the transaction has observed that no entitled tenant
 * exists, and every later zero-row anomaly rolls the whole transaction back.
 */
export async function admitFirstOAuthInviteAtomic(input: {
  inviteDigest: Buffer;
  transactionDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
  codeDigest: Buffer;
  codeExpiresAt: Date;
}): Promise<OAuthInviteAdmission | null> {
  try {
    return await withExomemTransaction(async (tx) => {
      const inviteResult = await tx`
        SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits
        FROM exomem_invites
        WHERE token_digest = ${input.inviteDigest}
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE
      `;
      const invite = inviteResult.rows[0] as
        | {
            id: string;
            email_normalized: string;
            entitlement_source: "complimentary" | "paddle";
            entitlement_capabilities: string[];
            entitlement_limits: Record<string, number>;
          }
        | undefined;
      if (!invite) throw new OAuthAdmissionRejected();

      const authorizationResult = await tx`
        SELECT transaction.id, transaction.client_id, transaction.redirect_uri,
               transaction.resource, transaction.requested_scopes, transaction.pkce_challenge
        FROM exomem_oauth_authorization_transactions AS transaction
        JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id AND client.enabled = true
        WHERE transaction.transaction_digest = ${input.transactionDigest}
          AND transaction.consumed_at IS NULL AND transaction.expires_at > now()
        FOR UPDATE OF transaction
      `;
      const authorization = authorizationResult.rows[0] as
        | {
            id: string;
            client_id: string;
            redirect_uri: string;
            resource: string;
            requested_scopes: string[];
            pkce_challenge: string;
          }
        | undefined;
      if (!authorization) throw new OAuthAdmissionRejected();

      const ownerResult = await tx`
        INSERT INTO users (email, email_verified_at)
        VALUES (${invite.email_normalized}, now())
        ON CONFLICT (email) DO UPDATE
        SET email = EXCLUDED.email,
            email_verified_at = COALESCE(users.email_verified_at, now())
        WHERE users.deleted_at IS NULL
        RETURNING id
      `;
      const owner = ownerResult.rows[0] as { id: string } | undefined;
      if (!owner) throw new OAuthAdmissionRejected();

      const existingResult = await tx`
        SELECT tenant.id, tenant.owner_user_id
        FROM exomem_tenants AS tenant
        JOIN exomem_entitlements AS entitlement
          ON entitlement.tenant_id = tenant.id
         AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
        WHERE tenant.owner_user_id = ${owner.id}::uuid
          AND tenant.status <> 'deleted'
          AND tenant.deleted_at IS NULL
        FOR UPDATE OF tenant
      `;
      const existing = existingResult.rows[0] as { id: string; owner_user_id: string } | undefined;

      let tenantId: string;
      let operationId: string | null = null;
      if (existing) {
        tenantId = existing.id;
      } else {
        const reservationResult = await tx`
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
        `;
        const pool = reservationResult.rows[0] as { id: string } | undefined;
        if (!pool) throw new OAuthAdmissionRejected();

        const tenantResult = await tx`
          INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
          VALUES (${owner.id}::uuid, 'provisioning', 'running')
          RETURNING id, fence_generation
        `;
        const tenant = tenantResult.rows[0] as { id: string; fence_generation: number } | undefined;
        if (!tenant) throw new OAuthAdmissionRejected();
        tenantId = tenant.id;

        const entitlementResult = await tx`
          INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state, capabilities, resource_limits)
          VALUES (
            ${tenant.id}::uuid,
            ${invite.entitlement_source},
            ${invite.entitlement_source === "complimentary" ? "complimentary_active" : "awaiting_checkout"},
            ${invite.entitlement_source === "complimentary" ? "active" : "provisioning"},
            ${JSON.stringify(invite.entitlement_capabilities)}::jsonb,
            ${JSON.stringify(invite.entitlement_limits)}::jsonb
          )
          RETURNING tenant_id
        `;
        if (!entitlementResult.rows[0]) throw new OAuthAdmissionRejected();

        const operationResult = await tx`
          INSERT INTO exomem_lifecycle_operations (tenant_id, operation_type, idempotency_key, fence_generation)
          VALUES (${tenant.id}::uuid, 'provision', 'initial-provision', ${tenant.fence_generation})
          RETURNING id
        `;
        const operation = operationResult.rows[0] as { id: string } | undefined;
        if (!operation) throw new OAuthAdmissionRejected();
        operationId = operation.id;

        const allocationResult = await tx`
          INSERT INTO exomem_capacity_allocations (
            pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state, operation_id
          ) VALUES (
            ${pool.id}::uuid, ${tenant.id}::uuid, ${EXOMEM_ALPHA_CAPACITY.storageBytes},
            ${EXOMEM_ALPHA_CAPACITY.runtimeSlots}, ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots},
            'reserved', ${operation.id}::uuid
          )
          RETURNING id
        `;
        if (!allocationResult.rows[0]) throw new OAuthAdmissionRejected();
      }

      const sessionResult = await tx`
        INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
        VALUES (${owner.id}::uuid, ${tenantId}::uuid, ${input.sessionDigest}, ${input.csrfDigest}, ${input.sessionExpiresAt.toISOString()})
        RETURNING id
      `;
      const session = sessionResult.rows[0] as { id: string } | undefined;
      if (!session) throw new OAuthAdmissionRejected();

      const grantResult = await tx`
        INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed, authorization_transaction_id)
        VALUES (
          ${owner.id}::uuid, ${tenantId}::uuid, ${authorization.client_id}::uuid, ${authorization.resource},
          ${authorization.requested_scopes.filter((scope) => scope !== "offline_access")},
          ${authorization.requested_scopes.includes("offline_access")}, ${authorization.id}::uuid
        )
        ON CONFLICT (user_id, tenant_id, client_id, resource) WHERE revoked_at IS NULL
        DO UPDATE SET scopes = EXCLUDED.scopes,
                      refresh_allowed = EXCLUDED.refresh_allowed,
                      authorization_transaction_id = EXCLUDED.authorization_transaction_id,
                      updated_at = now()
        RETURNING id
      `;
      const grant = grantResult.rows[0] as { id: string } | undefined;
      if (!grant) throw new OAuthAdmissionRejected();

      const codeResult = await tx`
        INSERT INTO exomem_oauth_authorization_codes (
          code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at
        ) VALUES (
          ${input.codeDigest}, ${grant.id}::uuid, ${authorization.client_id}::uuid,
          ${authorization.redirect_uri}, ${authorization.resource}, ${authorization.pkce_challenge},
          ${authorization.requested_scopes.includes("offline_access")}, ${input.codeExpiresAt.toISOString()}
        )
        RETURNING id
      `;
      if (!codeResult.rows[0]) throw new OAuthAdmissionRejected();

      const consumedInvite = await tx`
        UPDATE exomem_invites
        SET consumed_at = now(), consumed_by_user_id = ${owner.id}::uuid,
            redeemed_tenant_id = ${tenantId}::uuid, redeemed_session_id = ${session.id}::uuid
        WHERE id = ${invite.id}::uuid AND consumed_at IS NULL
        RETURNING id
      `;
      const consumedTransaction = await tx`
        UPDATE exomem_oauth_authorization_transactions
        SET consumed_at = now(), redeemed_session_id = ${session.id}::uuid
        WHERE id = ${authorization.id}::uuid AND consumed_at IS NULL
        RETURNING id
      `;
      if (!consumedInvite.rows[0] || !consumedTransaction.rows[0])
        throw new OAuthAdmissionRejected();

      return { tenantId, sessionId: session.id, operationId, grantId: grant.id };
    });
  } catch (error) {
    if (error instanceof OAuthAdmissionRejected) return null;
    if (typeof error === "object" && error && "code" in error && error.code === "23505")
      return null;
    throw error;
  }
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

/** MCP may report a durable lifecycle state, but token issuance/refresh remains fail-closed above. */
export async function findMcpOAuthAccessToken(
  accessDigest: Buffer
): Promise<ActiveOAuthAccessToken | null> {
  const { rows } = await executeExomemSql`
    /* exomem:find-mcp-oauth-access-token */
    SELECT token.family_id, token.grant_id, grant.user_id, grant.tenant_id,
           client.client_id, token.resource, token.scopes
    FROM exomem_oauth_access_tokens AS token
    JOIN exomem_oauth_token_families AS family
      ON family.id = token.family_id AND family.revoked_at IS NULL AND family.expires_at > now()
    JOIN exomem_oauth_grants AS grant ON grant.id = token.grant_id AND grant.revoked_at IS NULL
    JOIN exomem_oauth_clients AS client ON client.id = token.client_id AND client.enabled = true
    JOIN exomem_tenants AS tenant ON tenant.id = grant.tenant_id AND tenant.owner_user_id = grant.user_id
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
    WHERE token.access_digest = ${accessDigest} AND token.revoked_at IS NULL AND token.expires_at > now()
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  return row &&
    typeof row.family_id === "string" &&
    typeof row.grant_id === "string" &&
    typeof row.user_id === "string" &&
    typeof row.tenant_id === "string" &&
    typeof row.client_id === "string" &&
    typeof row.resource === "string" &&
    Array.isArray(row.scopes)
    ? {
        familyId: row.family_id,
        grantId: row.grant_id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        clientId: row.client_id,
        resource: row.resource,
        scopes: row.scopes.filter((scope): scope is string => typeof scope === "string"),
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

/** Operator revocation is always fenced to the authoritative owner and tenant. */
export async function revokeOAuthTokenFamilyForOwner(input: {
  ownerUserId: string;
  tenantId: string;
  familyId: string;
}): Promise<boolean> {
  const { rows } = await executeExomemSql`
    /* exomem:revoke-oauth-token-family-for-owner */
    UPDATE exomem_oauth_token_families AS family
    SET revoked_at = COALESCE(family.revoked_at, now()),
        revoked_reason = COALESCE(family.revoked_reason, 'operator_revoked')
    FROM exomem_oauth_grants AS grant
    JOIN exomem_tenants AS tenant ON tenant.id = grant.tenant_id
    WHERE family.id = ${input.familyId}::uuid
      AND grant.id = family.grant_id
      AND grant.user_id = ${input.ownerUserId}::uuid
      AND grant.tenant_id = ${input.tenantId}::uuid
      AND tenant.owner_user_id = grant.user_id
    RETURNING family.id
  `;
  return rows.length === 1;
}

/** Revokes every family for one authoritative owner/tenant pair, including deleted tenants. */
export async function revokeOAuthTokenFamiliesForOwnerTenant(input: {
  ownerUserId: string;
  tenantId: string;
  reason?: "operator_revoked" | "lifecycle_deleted";
}): Promise<number> {
  const { rows } = await executeExomemSql`
    /* exomem:revoke-oauth-token-families-for-owner-tenant */
    UPDATE exomem_oauth_token_families AS family
    SET revoked_at = COALESCE(family.revoked_at, now()),
        revoked_reason = COALESCE(family.revoked_reason, ${input.reason ?? "operator_revoked"})
    FROM exomem_oauth_grants AS grant
    JOIN exomem_tenants AS tenant ON tenant.id = grant.tenant_id
    WHERE grant.id = family.grant_id
      AND grant.user_id = ${input.ownerUserId}::uuid
      AND grant.tenant_id = ${input.tenantId}::uuid
      AND tenant.owner_user_id = grant.user_id
    RETURNING family.id
  `;
  return rows.length;
}

/** Lifecycle may revoke a tenant only after deletion has started; this is safe to call idempotently. */
export async function revokeOAuthTokenFamiliesForDeletingTenant(tenantId: string): Promise<number> {
  const { rows } = await executeExomemSql`
    /* exomem:revoke-oauth-token-families-for-deleting-tenant */
    UPDATE exomem_oauth_token_families AS family
    SET revoked_at = COALESCE(family.revoked_at, now()),
        revoked_reason = COALESCE(family.revoked_reason, 'lifecycle_deleted')
    FROM exomem_oauth_grants AS grant
    JOIN exomem_tenants AS tenant ON tenant.id = grant.tenant_id
    WHERE grant.id = family.grant_id
      AND grant.tenant_id = ${tenantId}::uuid
      AND (tenant.deleted_at IS NOT NULL OR tenant.status = 'deleted' OR tenant.desired_state = 'deleted')
    RETURNING family.id
  `;
  return rows.length;
}

/** RFC 7009 requires unknown or another client's credential to be indistinguishable. */
export async function revokeOAuthTokenForClient(input: {
  tokenDigest: Buffer;
  clientId: string;
}): Promise<void> {
  await executeExomemSql`
    /* exomem:revoke-oauth-token-for-client */
    UPDATE exomem_oauth_token_families AS family
    SET revoked_at = COALESCE(family.revoked_at, now()),
        revoked_reason = COALESCE(family.revoked_reason, 'client_revoked')
    FROM exomem_oauth_clients AS client
    WHERE family.client_id = client.id
      AND client.client_id = ${input.clientId}
      AND client.enabled = true
      AND (
        EXISTS (
          SELECT 1 FROM exomem_oauth_refresh_tokens AS refresh
          WHERE refresh.family_id = family.id AND refresh.refresh_digest = ${input.tokenDigest}
        )
        OR EXISTS (
          SELECT 1 FROM exomem_oauth_access_tokens AS access
          WHERE access.family_id = family.id AND access.access_digest = ${input.tokenDigest}
        )
      )
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
      JOIN exomem_oauth_clients AS client
        ON client.id = code.client_id
       AND client.client_id = ${input.clientId}
       AND client.enabled = true
      JOIN exomem_tenants AS tenant
        ON tenant.id = grant.tenant_id
       AND tenant.owner_user_id = grant.user_id
       AND tenant.status IN ('provisioning', 'active')
       AND tenant.desired_state = 'running'
      JOIN exomem_entitlements AS entitlement
        ON entitlement.tenant_id = tenant.id
       AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
      WHERE code.code_digest = ${input.codeDigest}
        AND code.grant_id = grant.id
        AND code.client_id = client.id
        AND grant.client_id = code.client_id
        AND grant.resource = code.resource
        AND code.redirect_uri = ${input.redirectUri}
        AND code.resource = ${input.resource}
        AND code.pkce_challenge = ${input.pkceChallenge}
        AND code.consumed_at IS NULL
        AND code.expires_at > now()
        AND grant.revoked_at IS NULL
      RETURNING code.grant_id, code.client_id, code.resource, code.refresh_allowed
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
      JOIN consumed_code ON consumed_code.grant_id = family.grant_id
      WHERE consumed_code.refresh_allowed
      RETURNING family_id
    ),
    access AS (
      INSERT INTO exomem_oauth_access_tokens (
        access_digest, grant_id, family_id, client_id, resource, scopes, expires_at
      )
      SELECT ${input.accessDigest}, consumed_code.grant_id, family.id, consumed_code.client_id,
             consumed_code.resource, grant.scopes, ${input.accessExpiresAt.toISOString()}
      FROM consumed_code
      JOIN family ON family.grant_id = consumed_code.grant_id
      JOIN exomem_oauth_grants AS grant ON grant.id = consumed_code.grant_id
      RETURNING id
    )
    SELECT consumed_code.grant_id, family.id AS family_id, client.client_id,
           consumed_code.resource, grant.scopes, consumed_code.refresh_allowed,
           (refresh.family_id IS NOT NULL) AS refresh_inserted
    FROM consumed_code
    JOIN family ON family.grant_id = consumed_code.grant_id
    JOIN exomem_oauth_clients AS client ON client.id = consumed_code.client_id
    LEFT JOIN refresh ON refresh.family_id = family.id
    JOIN access ON true
  `;
  const row = rows[0] as
    | {
        grant_id: string;
        family_id: string;
        client_id: string;
        resource: string;
        scopes: string[];
        refresh_allowed: boolean;
        refresh_inserted: boolean;
      }
    | undefined;
  return row
    ? {
        grantId: row.grant_id,
        familyId: row.family_id,
        clientId: row.client_id,
        resource: row.resource,
        scopes: row.scopes,
        refreshAllowed: row.refresh_allowed,
        refreshInserted: row.refresh_inserted,
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
    WITH credential AS (
      SELECT token.id, token.consumed_at, token.expires_at, token.family_id, family.grant_id, family.client_id,
             family.revoked_at, family.expires_at AS family_expires_at
      FROM exomem_oauth_refresh_tokens AS token
      JOIN exomem_oauth_token_families AS family ON family.id = token.family_id
      JOIN exomem_oauth_clients AS client ON client.id = family.client_id
      JOIN exomem_oauth_grants AS grant
        ON grant.id = family.grant_id
       AND grant.resource = ${input.resource}
      WHERE token.refresh_digest = ${input.refreshDigest}
        AND client.client_id = ${input.clientId}
        AND client.enabled = true
      FOR UPDATE OF token, family
    ),
    current_policy AS (
      SELECT credential.id
      FROM credential
      JOIN exomem_oauth_grants AS grant ON grant.id = credential.grant_id AND grant.revoked_at IS NULL
      JOIN exomem_tenants AS tenant ON tenant.id = grant.tenant_id
        AND tenant.owner_user_id = grant.user_id AND tenant.status IN ('provisioning', 'active')
        AND tenant.desired_state = 'running'
      JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
        AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
    ),
    consumed AS (
      UPDATE exomem_oauth_refresh_tokens AS token
      SET consumed_at = now()
      FROM credential
      JOIN current_policy ON current_policy.id = credential.id
      WHERE token.id = credential.id
        AND token.consumed_at IS NULL
        AND token.expires_at > now()
        AND credential.revoked_at IS NULL
        AND credential.family_expires_at > now()
      RETURNING credential.family_id, credential.grant_id, credential.client_id
    ),
    replay_revocation AS (
      UPDATE exomem_oauth_token_families AS family
      SET revoked_at = now(),
          revoked_reason = 'refresh_replayed'
      FROM credential
      WHERE family.id = credential.family_id
        AND credential.consumed_at IS NOT NULL
        AND family.revoked_at IS NULL
      RETURNING family.id
    ),
    replacement AS (
      INSERT INTO exomem_oauth_refresh_tokens (
        refresh_digest, family_id, parent_refresh_token_id, expires_at
      )
      SELECT ${input.replacementRefreshDigest}, consumed.family_id, credential.id,
             family.expires_at
      FROM consumed
      JOIN credential ON credential.family_id = consumed.family_id
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
    SELECT consumed.grant_id, consumed.family_id, client.client_id, grant.resource, grant.scopes
    FROM consumed
    JOIN replacement ON replacement.family_id = consumed.family_id
    JOIN access ON true
    JOIN exomem_oauth_grants AS grant ON grant.id = consumed.grant_id
    JOIN exomem_oauth_clients AS client ON client.id = consumed.client_id
  `;
  const row = rows[0] as
    | { grant_id: string; family_id: string; client_id: string; resource: string; scopes: string[] }
    | undefined;
  return row
    ? {
        grantId: row.grant_id,
        familyId: row.family_id,
        clientId: row.client_id,
        resource: row.resource,
        scopes: row.scopes,
      }
    : null;
}
