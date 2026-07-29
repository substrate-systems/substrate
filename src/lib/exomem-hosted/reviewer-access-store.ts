import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import {
  validateMarketplaceReviewerExpiry,
  type MarketplaceReviewerAuthenticationRecord,
  type MarketplaceReviewerProvider,
} from "./reviewer-access";

export type CreateMarketplaceReviewerCredentialInput = {
  provider: MarketplaceReviewerProvider;
  usernameDigest: Buffer;
  passwordHash: string;
  ownerUserId: string;
  tenantId: string;
  fixtureVersion: string;
  expiresAt: Date;
  operatorPrincipalDigest: Buffer;
};

export type MarketplaceReviewerCredentialStatus = {
  provider: MarketplaceReviewerProvider;
  fixtureVersion: string;
  expiresAt: string;
  revokedAt: string | null;
};

async function withReviewerAccessLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-marketplace-reviewer-access'))`;
    return work(tx);
  });
}

export async function createOrRotateMarketplaceReviewerCredentialAtomic(
  input: CreateMarketplaceReviewerCredentialInput
): Promise<{ credentialId: string; ownerUserId: string; tenantId: string } | null> {
  validateMarketplaceReviewerExpiry(input.expiresAt);
  return withReviewerAccessLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:create-or-rotate-marketplace-reviewer-credential */
      WITH target AS (
        SELECT tenant.id AS tenant_id, tenant.owner_user_id
        FROM exomem_tenants AS tenant
        JOIN users ON users.id = tenant.owner_user_id AND users.deleted_at IS NULL
        JOIN exomem_entitlements AS entitlement
          ON entitlement.tenant_id = tenant.id
         AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
        JOIN exomem_cells AS cell
          ON cell.id = tenant.bound_cell_id
         AND cell.tenant_id = tenant.id
         AND cell.routing_state = 'bound'
         AND cell.lifecycle_state IN ('provisioning', 'active')
        WHERE tenant.id = ${input.tenantId}::uuid
          AND tenant.owner_user_id = ${input.ownerUserId}::uuid
          AND tenant.status IN ('provisioning', 'active')
          AND tenant.desired_state = 'running'
          AND tenant.deleted_at IS NULL
          AND tenant.marketplace_reviewer_purpose = true
          AND NOT EXISTS (
            SELECT 1 FROM exomem_oauth_account_blocks AS block
            WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
          )
        FOR UPDATE OF tenant
      ), prior AS (
        SELECT credential.id, credential.owner_user_id, credential.tenant_id
        FROM target
        JOIN exomem_marketplace_reviewer_credentials AS credential
          ON credential.provider = ${input.provider}
         AND credential.revoked_at IS NULL
        FOR UPDATE
      ), credential_revoked AS (
        UPDATE exomem_marketplace_reviewer_credentials AS credential
        SET revoked_at = now(), revoked_by_principal_digest = ${input.operatorPrincipalDigest}
        FROM prior
        WHERE credential.id = prior.id
        RETURNING credential.id, credential.owner_user_id, credential.tenant_id
      ), sessions_revoked AS (
        UPDATE exomem_sessions AS session
        SET revoked_at = COALESCE(session.revoked_at, now())
        WHERE session.reviewer_credential_id IN (SELECT id FROM credential_revoked)
          AND session.revoked_at IS NULL
        RETURNING session.id
      ), reviewer_transactions AS (
        SELECT transaction.id
        FROM exomem_oauth_authorization_transactions AS transaction
        WHERE transaction.reviewer_credential_id IN (SELECT id FROM credential_revoked)
           OR transaction.redeemed_session_id IN (SELECT id FROM sessions_revoked)
      ), transactions_revoked AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction
        SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE transaction.id IN (SELECT id FROM reviewer_transactions)
          AND transaction.consumed_at IS NULL
        RETURNING transaction.id
      ), grants_revoked AS (
        UPDATE exomem_oauth_grants AS grant_row
        SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
        WHERE (
          grant_row.reviewer_credential_id IN (SELECT id FROM credential_revoked)
          OR grant_row.authorization_transaction_id IN (SELECT id FROM reviewer_transactions)
        )
          AND grant_row.revoked_at IS NULL
        RETURNING grant_row.id
      ), codes_consumed AS (
        UPDATE exomem_oauth_authorization_codes AS code
        SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE code.grant_id IN (SELECT id FROM grants_revoked)
          AND code.consumed_at IS NULL
        RETURNING code.id
      ), families_revoked AS (
        UPDATE exomem_oauth_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'reviewer_credential_revoked')
        WHERE family.grant_id IN (SELECT id FROM grants_revoked)
          AND family.revoked_at IS NULL
        RETURNING family.id
      ), access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM grants_revoked)
           OR token.family_id IN (SELECT id FROM families_revoked)
        RETURNING token.id
      ), revocation_complete AS (
        SELECT count(*) AS count FROM access_revoked
      ), created AS (
        INSERT INTO exomem_marketplace_reviewer_credentials (
          provider, username_digest, password_hash, owner_user_id, tenant_id,
          fixture_version, created_by_principal_digest, expires_at
        )
        SELECT ${input.provider},
               ${input.usernameDigest},
               ${input.passwordHash},
               target.owner_user_id,
               target.tenant_id,
               ${input.fixtureVersion},
               ${input.operatorPrincipalDigest},
               ${input.expiresAt.toISOString()}
        FROM target CROSS JOIN revocation_complete
        RETURNING id, owner_user_id, tenant_id
      )
      SELECT id, owner_user_id, tenant_id FROM created
    `;
    const row = rows[0] as { id?: string; owner_user_id?: string; tenant_id?: string } | undefined;
    return row?.id && row.owner_user_id && row.tenant_id
      ? { credentialId: row.id, ownerUserId: row.owner_user_id, tenantId: row.tenant_id }
      : null;
  });
}

export async function findMarketplaceReviewerCredentialForAuthentication(
  usernameDigest: Buffer
): Promise<MarketplaceReviewerAuthenticationRecord | null> {
  const { rows } = await executeExomemSql`
    /* exomem:find-marketplace-reviewer-credential */
    SELECT credential.id,
           credential.provider,
           credential.owner_user_id,
           credential.tenant_id,
           credential.fixture_version,
           credential.password_hash,
           credential.expires_at,
           credential.revoked_at
    FROM exomem_marketplace_reviewer_credentials AS credential
    JOIN users ON users.id = credential.owner_user_id AND users.deleted_at IS NULL
    JOIN exomem_tenants AS tenant
      ON tenant.id = credential.tenant_id
     AND tenant.owner_user_id = credential.owner_user_id
     AND tenant.status IN ('provisioning', 'active')
     AND tenant.desired_state = 'running'
     AND tenant.deleted_at IS NULL
     AND tenant.marketplace_reviewer_purpose = true
    JOIN exomem_entitlements AS entitlement
      ON entitlement.tenant_id = tenant.id
     AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
    JOIN exomem_cells AS cell
      ON cell.id = tenant.bound_cell_id
     AND cell.tenant_id = tenant.id
     AND cell.routing_state = 'bound'
     AND cell.lifecycle_state IN ('provisioning', 'active')
    WHERE credential.username_digest = ${usernameDigest}
      AND credential.revoked_at IS NULL
      AND credential.expires_at > now()
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
      )
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  return row &&
    typeof row.id === "string" &&
    (row.provider === "openai" || row.provider === "anthropic") &&
    typeof row.owner_user_id === "string" &&
    typeof row.tenant_id === "string" &&
    typeof row.fixture_version === "string" &&
    typeof row.password_hash === "string" &&
    typeof row.expires_at === "string"
    ? {
        credentialId: row.id,
        provider: row.provider,
        ownerUserId: row.owner_user_id,
        tenantId: row.tenant_id,
        fixtureVersion: row.fixture_version,
        passwordHash: row.password_hash,
        expiresAt: row.expires_at,
        revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
      }
    : null;
}

export async function createMarketplaceReviewerSessionAtomic(input: {
  credentialId: string;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  expiresAt: Date;
}): Promise<{ sessionId: string; ownerUserId: string; tenantId: string } | null> {
  const { rows } = await executeExomemSql`
    /* exomem:create-marketplace-reviewer-session */
    WITH credential AS (
      SELECT credential.id, credential.owner_user_id, credential.tenant_id, credential.expires_at
      FROM exomem_marketplace_reviewer_credentials AS credential
      JOIN users ON users.id = credential.owner_user_id AND users.deleted_at IS NULL
      JOIN exomem_tenants AS tenant
        ON tenant.id = credential.tenant_id
       AND tenant.owner_user_id = credential.owner_user_id
       AND tenant.status IN ('provisioning', 'active')
       AND tenant.desired_state = 'running'
       AND tenant.deleted_at IS NULL
       AND tenant.marketplace_reviewer_purpose = true
      JOIN exomem_entitlements AS entitlement
        ON entitlement.tenant_id = tenant.id
       AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
      JOIN exomem_cells AS cell
        ON cell.id = tenant.bound_cell_id
       AND cell.tenant_id = tenant.id
       AND cell.routing_state = 'bound'
       AND cell.lifecycle_state IN ('provisioning', 'active')
      WHERE credential.id = ${input.credentialId}::uuid
        AND credential.revoked_at IS NULL
        AND credential.expires_at > now()
        AND ${input.expiresAt.toISOString()}::timestamptz > now()
        AND NOT EXISTS (
          SELECT 1 FROM exomem_oauth_account_blocks AS block
          WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
        )
      FOR UPDATE OF credential
    ), session AS (
      INSERT INTO exomem_sessions (
        user_id, tenant_id, reviewer_credential_id, session_digest, csrf_digest, expires_at
      )
      SELECT owner_user_id,
             tenant_id,
             id,
             ${input.sessionDigest},
             ${input.csrfDigest},
             LEAST(${input.expiresAt.toISOString()}, credential.expires_at)
      FROM credential
      RETURNING id, user_id, tenant_id
    )
    SELECT id, user_id, tenant_id FROM session
  `;
  const row = rows[0] as { id?: string; user_id?: string; tenant_id?: string } | undefined;
  return row?.id && row.user_id && row.tenant_id
    ? { sessionId: row.id, ownerUserId: row.user_id, tenantId: row.tenant_id }
    : null;
}

export async function getMarketplaceReviewerCredentialStatus(
  provider: MarketplaceReviewerProvider
): Promise<MarketplaceReviewerCredentialStatus | null> {
  const { rows } = await executeExomemSql`
    /* exomem:reviewer-credential-status */
    SELECT provider, fixture_version, expires_at, revoked_at
    FROM exomem_marketplace_reviewer_credentials
    WHERE provider = ${provider}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  return row &&
    (row.provider === "openai" || row.provider === "anthropic") &&
    typeof row.fixture_version === "string" &&
    typeof row.expires_at === "string"
    ? {
        provider: row.provider,
        fixtureVersion: row.fixture_version,
        expiresAt: row.expires_at,
        revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
      }
    : null;
}

export async function bindMarketplaceReviewerCredentialToOAuthTransactionAtomic(input: {
  credentialId: string;
  sessionId: string;
  transactionDigest: Buffer;
}): Promise<boolean> {
  const { rows } = await executeExomemSql`
    /* exomem:bind-marketplace-reviewer-credential-to-oauth-transaction */
    UPDATE exomem_oauth_authorization_transactions AS transaction
    SET reviewer_credential_id = credential.id
    FROM exomem_marketplace_reviewer_credentials AS credential
    CROSS JOIN exomem_sessions AS session
    CROSS JOIN exomem_oauth_clients AS client
    CROSS JOIN exomem_tenants AS tenant
    WHERE transaction.transaction_digest = ${input.transactionDigest}
      AND transaction.consumed_at IS NULL
      AND transaction.expires_at > now()
      AND credential.id = ${input.credentialId}::uuid
      AND credential.revoked_at IS NULL
      AND credential.expires_at > now()
      AND session.id = ${input.sessionId}::uuid
      AND session.reviewer_credential_id = credential.id
      AND session.user_id = credential.owner_user_id
      AND session.tenant_id = credential.tenant_id
      AND session.revoked_at IS NULL
      AND session.expires_at > now()
      AND client.id = transaction.client_id
      AND client.client_platform = credential.provider
      AND tenant.id = credential.tenant_id
      AND tenant.owner_user_id = credential.owner_user_id
      AND tenant.marketplace_reviewer_purpose = true
    RETURNING transaction.id
  `;
  return rows.length === 1;
}

export async function revokeMarketplaceReviewerCredentialAtomic(input: {
  provider: MarketplaceReviewerProvider;
  operatorPrincipalDigest: Buffer;
}): Promise<number> {
  return withReviewerAccessLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:revoke-marketplace-reviewer-credential */
      WITH credential AS (
        SELECT id
        FROM exomem_marketplace_reviewer_credentials
        WHERE provider = ${input.provider} AND revoked_at IS NULL
        FOR UPDATE
      ), revoked AS (
        UPDATE exomem_marketplace_reviewer_credentials AS credential_row
        SET revoked_at = now(), revoked_by_principal_digest = ${input.operatorPrincipalDigest}
        FROM credential
        WHERE credential_row.id = credential.id
        RETURNING credential_row.id
      ), sessions_revoked AS (
        UPDATE exomem_sessions AS session
        SET revoked_at = COALESCE(session.revoked_at, now())
        WHERE session.reviewer_credential_id IN (SELECT id FROM revoked)
          AND session.revoked_at IS NULL
        RETURNING session.id
      ), reviewer_transactions AS (
        SELECT transaction.id
        FROM exomem_oauth_authorization_transactions AS transaction
        WHERE transaction.reviewer_credential_id IN (SELECT id FROM revoked)
           OR transaction.redeemed_session_id IN (SELECT id FROM sessions_revoked)
      ), transactions_revoked AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction
        SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE transaction.id IN (SELECT id FROM reviewer_transactions)
          AND transaction.consumed_at IS NULL
        RETURNING transaction.id
      ), grants_revoked AS (
        UPDATE exomem_oauth_grants AS grant_row
        SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
        WHERE (
          grant_row.reviewer_credential_id IN (SELECT id FROM revoked)
          OR grant_row.authorization_transaction_id IN (SELECT id FROM reviewer_transactions)
        )
          AND grant_row.revoked_at IS NULL
        RETURNING grant_row.id
      ), codes_consumed AS (
        UPDATE exomem_oauth_authorization_codes AS code
        SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE code.grant_id IN (SELECT id FROM grants_revoked)
          AND code.consumed_at IS NULL
        RETURNING code.id
      ), families_revoked AS (
        UPDATE exomem_oauth_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'reviewer_credential_revoked')
        WHERE family.grant_id IN (SELECT id FROM grants_revoked)
          AND family.revoked_at IS NULL
        RETURNING family.id
      ), access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM grants_revoked)
           OR token.family_id IN (SELECT id FROM families_revoked)
        RETURNING token.id
      )
      SELECT count(*)::integer AS revoked_credentials FROM revoked
    `;
    return Number(rows[0]?.revoked_credentials ?? 0);
  });
}
