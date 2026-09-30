import { exomemCloudEnabled, loadExomemCloudResource } from "./cloud-config";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import {
  marketplaceReviewerAccessEnabled,
  validateMarketplaceReviewerExpiry,
  type MarketplaceReviewerAuthenticationRecord,
  type MarketplaceReviewerProvider,
} from "./reviewer-access";
import type {
  CreateMarketplaceReviewerCredentialInput,
  MarketplaceReviewerCredentialStatus,
} from "./reviewer-access-store";

export function cloudReviewerAccessEnabled(): boolean {
  return exomemCloudEnabled() && marketplaceReviewerAccessEnabled();
}

async function lockProviderTenants(
  tx: ExomemSql,
  provider: MarketplaceReviewerProvider,
  tenantId: string | null
) {
  // Serialize provider rotations before selecting their tenant routing rows.
  await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-cloud-reviewer-' || ${provider}))`;
  await tx`
    /* exomem-cloud:lock-reviewer-tenants */
    SELECT tenant.id FROM exomem_tenants AS tenant
    WHERE tenant.id = ${tenantId}::uuid OR tenant.id IN (
      SELECT credential.tenant_id FROM exomem_marketplace_reviewer_credentials AS credential
      WHERE credential.provider = ${provider} AND credential.credential_kind = 'cloud_provider_review'
        AND credential.revoked_at IS NULL
    )
    ORDER BY tenant.id FOR UPDATE OF tenant
  `;
}

async function revokeProviderLineage(
  tx: ExomemSql,
  provider: MarketplaceReviewerProvider,
  principal: Buffer
): Promise<number> {
  const { rows } = await tx`
    /* exomem-cloud:revoke-reviewer-lineage */
    WITH revoked AS (
      UPDATE exomem_marketplace_reviewer_credentials
      SET revoked_at = now(), revoked_by_principal_digest = ${principal}
      WHERE provider = ${provider} AND credential_kind = 'cloud_provider_review' AND revoked_at IS NULL
      RETURNING id
    ), sessions AS (
      UPDATE exomem_sessions SET revoked_at = COALESCE(revoked_at, now())
      WHERE reviewer_credential_id IN (SELECT id FROM revoked) RETURNING id
    ), transactions AS (
      UPDATE exomem_oauth_authorization_transactions SET consumed_at = COALESCE(consumed_at, now())
      WHERE reviewer_credential_id IN (SELECT id FROM revoked)
        OR redeemed_session_id IN (SELECT id FROM sessions) RETURNING id
    ), grants AS (
      UPDATE exomem_oauth_grants SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE reviewer_credential_id IN (SELECT id FROM revoked) RETURNING id
    ), codes AS (
      UPDATE exomem_oauth_authorization_codes SET consumed_at = COALESCE(consumed_at, now())
      WHERE reviewer_credential_id IN (SELECT id FROM revoked) OR grant_id IN (SELECT id FROM grants) RETURNING id
    ), families AS (
      UPDATE exomem_oauth_token_families SET revoked_at = COALESCE(revoked_at, now()),
        revoked_reason = COALESCE(revoked_reason, 'reviewer_credential_revoked')
      WHERE reviewer_credential_id IN (SELECT id FROM revoked) OR grant_id IN (SELECT id FROM grants) RETURNING id
    ), refresh AS (
      UPDATE exomem_oauth_refresh_tokens SET consumed_at = COALESCE(consumed_at, now())
      WHERE reviewer_credential_id IN (SELECT id FROM revoked) OR family_id IN (SELECT id FROM families) RETURNING id
    ), access AS (
      UPDATE exomem_oauth_access_tokens SET revoked_at = COALESCE(revoked_at, now())
      WHERE reviewer_credential_id IN (SELECT id FROM revoked) OR grant_id IN (SELECT id FROM grants)
        OR family_id IN (SELECT id FROM families) RETURNING id
    ) SELECT count(*)::integer AS count FROM revoked
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function createOrRotateCloudReviewerCredentialAtomic(
  input: CreateMarketplaceReviewerCredentialInput
): Promise<{ credentialId: string; ownerUserId: string; tenantId: string } | null> {
  if (!cloudReviewerAccessEnabled()) return null;
  validateMarketplaceReviewerExpiry(input.expiresAt);
  return withExomemTransaction(async (tx) => {
    await lockProviderTenants(tx, input.provider, input.tenantId);
    const eligible = await tx`
      SELECT 1 WHERE exomem_cloud_reviewer_tenant_eligible(${input.tenantId}::uuid, ${input.ownerUserId}::uuid)
        AND EXISTS (SELECT 1 FROM exomem_cloud_cells WHERE tenant_id = ${input.tenantId}::uuid
          AND desired_state = 'running' AND observed_state = 'running' AND ready = true)
    `;
    if (!eligible.rows[0]) return null;
    await revokeProviderLineage(tx, input.provider, input.operatorPrincipalDigest);
    const { rows } = await tx`
      INSERT INTO exomem_marketplace_reviewer_credentials (
        provider, username_digest, password_hash, owner_user_id, tenant_id,
        fixture_version, fixture_payload_digest, expires_at, created_by_principal_digest, credential_kind
      ) VALUES (${input.provider}, ${input.usernameDigest}, ${input.passwordHash}, ${input.ownerUserId}::uuid,
        ${input.tenantId}::uuid, ${input.fixtureVersion}, ${input.fixturePayloadDigest},
        ${input.expiresAt.toISOString()}, ${input.operatorPrincipalDigest}, 'cloud_provider_review') RETURNING id
    `;
    return {
      credentialId: String(rows[0].id),
      ownerUserId: input.ownerUserId,
      tenantId: input.tenantId,
    };
  });
}

export async function revokeCloudReviewerCredentialAtomic(input: {
  provider: MarketplaceReviewerProvider;
  operatorPrincipalDigest: Buffer;
}): Promise<number> {
  return withExomemTransaction(async (tx) => {
    await lockProviderTenants(tx, input.provider, null);
    return revokeProviderLineage(tx, input.provider, input.operatorPrincipalDigest);
  });
}

export async function getCloudReviewerCredentialStatus(
  provider: MarketplaceReviewerProvider
): Promise<MarketplaceReviewerCredentialStatus | null> {
  const { rows } = await executeExomemSql`
    SELECT provider, fixture_version, fixture_payload_digest, expires_at, revoked_at
    FROM exomem_marketplace_reviewer_credentials WHERE provider = ${provider} AND credential_kind = 'cloud_provider_review'
    ORDER BY created_at DESC LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        provider,
        fixtureVersion: String(row.fixture_version),
        fixturePayloadDigest: String(row.fixture_payload_digest),
        expiresAt: new Date(row.expires_at as string).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
      }
    : null;
}

export async function findCloudReviewerCredentialForAuthentication(
  usernameDigest: Buffer
): Promise<MarketplaceReviewerAuthenticationRecord | null> {
  if (!cloudReviewerAccessEnabled()) return null;
  const { rows } = await executeExomemSql`
    SELECT id, provider, owner_user_id, tenant_id, fixture_version, password_hash, expires_at, revoked_at
    FROM exomem_marketplace_reviewer_credentials AS credential
    WHERE username_digest = ${usernameDigest}
      AND exomem_cloud_reviewer_authorized(credential.id, credential.tenant_id, credential.owner_user_id, NULL)
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        credentialId: String(row.id),
        provider: row.provider as MarketplaceReviewerProvider,
        ownerUserId: String(row.owner_user_id),
        tenantId: String(row.tenant_id),
        fixtureVersion: String(row.fixture_version),
        passwordHash: String(row.password_hash),
        expiresAt: new Date(row.expires_at as string).toISOString(),
        revokedAt: null,
      }
    : null;
}

export async function createCloudReviewerOAuthSessionAtomic(input: {
  credentialId: string;
  transactionDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  expiresAt: Date;
}): Promise<{ sessionId: string } | null> {
  if (!cloudReviewerAccessEnabled()) return null;
  const resource = loadExomemCloudResource().mcpUrl;
  return withExomemTransaction(async (tx) => {
    const locked = await tx`
      SELECT tenant.id FROM exomem_tenants AS tenant
      JOIN exomem_marketplace_reviewer_credentials AS credential ON credential.tenant_id = tenant.id
      WHERE credential.id = ${input.credentialId}::uuid FOR UPDATE OF tenant
    `;
    if (!locked.rows[0]) return null;
    const { rows } = await tx`
      /* exomem-cloud:redeem-reviewer */
      WITH credential AS (
        SELECT * FROM exomem_marketplace_reviewer_credentials AS credential
        WHERE id = ${input.credentialId}::uuid
          AND exomem_cloud_reviewer_authorized(id, tenant_id, owner_user_id, NULL)
        FOR UPDATE
      ), transaction AS (
        SELECT transaction.id FROM exomem_oauth_authorization_transactions AS transaction
        JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id
        CROSS JOIN credential
        WHERE transaction.transaction_digest = ${input.transactionDigest}
          AND transaction.resource = ${resource} AND transaction.consumed_at IS NULL AND transaction.expires_at > now()
          AND transaction.candidate_id IS NULL AND transaction.reviewer_bootstrap_authority_id IS NULL
          AND (transaction.reviewer_credential_id IS NULL OR transaction.reviewer_credential_id = credential.id)
          AND client.enabled = true
          AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
          AND transaction.redirect_uri IN (SELECT jsonb_array_elements_text(client.redirect_uris))
          AND (client.admission_mode = 'pinned' OR (
            client.admission_mode = 'cimd' AND client.metadata_document_digest IS NOT NULL
            AND client.metadata_fetched_at IS NOT NULL AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
            AND client.metadata_expires_at > now() AND EXISTS (
              SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
              WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
            )
          ))
          AND exomem_cloud_reviewer_authorized(credential.id, credential.tenant_id, credential.owner_user_id, client.client_platform)
        FOR UPDATE OF transaction
      ), created AS (
        INSERT INTO exomem_sessions (user_id, tenant_id, reviewer_credential_id, session_digest, csrf_digest, expires_at)
        SELECT owner_user_id, tenant_id, credential.id, ${input.sessionDigest}, ${input.csrfDigest},
          LEAST(${input.expiresAt.toISOString()}, credential.expires_at) FROM credential CROSS JOIN transaction
        ON CONFLICT (session_digest) DO NOTHING RETURNING id
      ), session AS (
        SELECT id FROM created UNION ALL
        SELECT session.id FROM exomem_sessions AS session CROSS JOIN credential CROSS JOIN transaction
        WHERE session.session_digest = ${input.sessionDigest} AND session.csrf_digest = ${input.csrfDigest}
          AND session.reviewer_credential_id = credential.id AND session.tenant_id = credential.tenant_id
          AND session.user_id = credential.owner_user_id AND session.revoked_at IS NULL AND session.expires_at > now()
      ), bound AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction_row
        SET reviewer_credential_id = credential.id, redeemed_session_id = session.id,
          expires_at = LEAST(transaction_row.expires_at, credential.expires_at)
        FROM transaction CROSS JOIN credential CROSS JOIN session WHERE transaction_row.id = transaction.id
        RETURNING transaction_row.id
      ) SELECT session.id FROM session CROSS JOIN bound
    `;
    return rows[0] ? { sessionId: String(rows[0].id) } : null;
  });
}
