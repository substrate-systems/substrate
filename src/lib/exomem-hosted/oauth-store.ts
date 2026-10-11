import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import {
  CIMD_DEFAULT_TTL_SECONDS,
  MAX_OAUTH_CLIENT_ID_LENGTH,
  MAX_OAUTH_CLIENT_REDIRECTS,
  documentDigest,
  fetchCimdMetadata,
  cimdRedirectsAdmissible,
  oauthClientConfigSha256,
  type CimdFetchedMetadata,
} from "./oauth-client-admission";
import type { SecretEnvelope } from "./security";
import { loadExomemCloudResource } from "./cloud-config";
import { CONNECTABLE_EFFECTIVE_STATES, FIRST_PAYMENT_SOURCE_STATES } from "./entitlements";
import { cloudReviewerAccessEnabled } from "./cloud-reviewer-access-store";

export type OAuthTokenContext = {
  grantId: string;
  familyId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  refreshAllowed?: boolean;
  refreshInserted?: boolean;
};

export type ApprovedOAuthClient = {
  id: string;
  clientId: string;
  redirectUris: string[];
  admissionMode: "pinned" | "cimd";
};

const MAX_PENDING_OAUTH_AUTHORIZATIONS = 2_000;

async function withCohortLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    return work(tx);
  });
}

/**
 * Register an unknown CIMD client at first authorization, but only when the host
 * serving its metadata document is on the operator-curated allowlist.
 *
 * This deliberately relaxes the older invariant that runtime authorization never
 * creates a client. It has to: every ChatGPT connector carries its own connectorId,
 * therefore its own client.json, therefore its own configuration digest. Waiting for
 * an operator to pre-register each one means no ChatGPT user but the operator can
 * ever connect.
 *
 * The caller's trigger is "admission returned nothing", not "no row exists".
 * Expired CIMD clients are disabled rather than deleted (see the maintenance
 * statement in `expireOAuthState`), so a returning connector whose metadata TTL
 * lapsed has a row that is present, stale and unusable. Only an upsert clears it.
 *
 * Returns null on every failure, and the caller must treat that identically to an
 * unknown client, so this path cannot be used to enumerate admitted hosts.
 */
export async function registerAdmittedCimdClient(
  clientId: string,
  dependencies: { fetchCimd?: (clientId: string) => Promise<CimdFetchedMetadata> } = {}
): Promise<ApprovedOAuthClient | null> {
  if (clientId.length > MAX_OAUTH_CLIENT_ID_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();

  // Allowlist before network. An unlisted host must cost one indexed lookup and
  // never an outbound fetch, or this becomes a request-forgery amplifier driven
  // by an unauthenticated caller.
  const { rows: admittedRows } = await executeExomemSql`
    /* exomem:resolve-admitted-cimd-host */
    SELECT platform FROM exomem_oauth_admitted_cimd_hosts WHERE host = ${host} LIMIT 1
  `;
  const platform = (admittedRows[0] as { platform: "claude" | "openai" } | undefined)?.platform;
  if (!platform) return null;

  let fetched: CimdFetchedMetadata;
  try {
    fetched = await (dependencies.fetchCimd ?? fetchCimdMetadata)(clientId);
  } catch {
    return null;
  }
  const redirectUris = fetched.document.redirect_uris;
  if (redirectUris.length === 0 || redirectUris.length > MAX_OAUTH_CLIENT_REDIRECTS) return null;
  // `parseCimdDocument` proves the list is a list of strings; it does not judge
  // what is in it, and this path never reaches the operator normaliser that
  // would. Without this the only thing deciding where an authorization code is
  // delivered is the document itself, which is the one input an admitted host
  // controls entirely.
  if (!cimdRedirectsAdmissible(redirectUris, host)) return null;

  const configSha256 = oauthClientConfigSha256({
    platform,
    admissionMode: "cimd",
    clientId,
    redirectUris,
  });
  const redirectJson = JSON.stringify(redirectUris);
  const provenance = JSON.stringify({
    version: 1,
    mode: "cimd",
    host,
    documentDigest: documentDigest(fetched.raw).toString("hex"),
  });

  return withCohortLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:register-admitted-cimd-client */
      WITH available AS (
        SELECT exomem_oauth_client_partition_available(${clientId}, true) AS allowed
      )
      INSERT INTO exomem_oauth_clients (
        client_id, admission_mode, enabled, auto_registered, metadata_provenance,
        redirect_uris, redirect_uris_digest, metadata_document_digest,
        metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at, cimd_host,
        client_platform, oauth_client_config_sha256, authority_version
      )
      SELECT ${clientId}, 'cimd', true, true, ${provenance}::jsonb,
             ${redirectJson}::jsonb,
             digest(convert_to(${redirectJson}::jsonb::text, 'utf8'), 'sha256'),
             ${documentDigest(fetched.raw)},
             now(), ${CIMD_DEFAULT_TTL_SECONDS},
             now() + (${CIMD_DEFAULT_TTL_SECONDS} * interval '1 second'),
             ${host}, ${platform}, ${configSha256}, gen_random_uuid()
      FROM available
      WHERE available.allowed
      ON CONFLICT (client_id) DO UPDATE
      SET metadata_provenance = EXCLUDED.metadata_provenance,
          redirect_uris = EXCLUDED.redirect_uris,
          redirect_uris_digest = EXCLUDED.redirect_uris_digest,
          metadata_document_digest = EXCLUDED.metadata_document_digest,
          metadata_fetched_at = EXCLUDED.metadata_fetched_at,
          metadata_ttl_seconds = EXCLUDED.metadata_ttl_seconds,
          metadata_expires_at = EXCLUDED.metadata_expires_at,
          cimd_host = EXCLUDED.cimd_host,
          client_platform = EXCLUDED.client_platform,
          oauth_client_config_sha256 = EXCLUDED.oauth_client_config_sha256,
          enabled = true,
          authority_version = gen_random_uuid(),
          updated_at = now()
        -- Restricted to rows this path itself created. An operator-managed or
        -- bootstrap-pinned client must never be rewritten by an anonymous caller,
        -- however well its document validates.
        WHERE exomem_oauth_clients.auto_registered = true
          AND exomem_oauth_clients.reviewer_bootstrap_ever_authorized = false
      RETURNING id, client_id, redirect_uris, admission_mode
    `;
    const row = rows[0] as
      | {
          id: string;
          client_id: string;
          redirect_uris: string[];
          admission_mode: "pinned" | "cimd";
        }
      | undefined;
    return row
      ? {
          id: row.id,
          clientId: row.client_id,
          redirectUris: row.redirect_uris,
          admissionMode: row.admission_mode,
        }
      : null;
  });
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
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:create-oauth-authorization-transaction */
    WITH cutoff AS MATERIALIZED (
      SELECT clock_timestamp() AS at
    ),
    -- Retires any Hosted reviewer bootstrap authority that was left active:
    -- its pinned client was enabled only for that authority's window.
    expired_bootstraps AS (
      UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
      SET state = 'expired', expired_at = cutoff.at
      FROM cutoff
      WHERE state = 'active' AND expires_at <= cutoff.at
      RETURNING oauth_client_id
    ), disabled_bootstrap_clients AS (
      UPDATE exomem_oauth_clients AS client
      SET enabled = false, authority_version = gen_random_uuid(), updated_at = cutoff.at
      FROM cutoff
      WHERE client.id IN (SELECT oauth_client_id FROM expired_bootstraps)
      RETURNING client.id
    ), pruned AS (
      DELETE FROM exomem_oauth_authorization_transactions
      WHERE id IN (
        SELECT transaction.id
        FROM exomem_oauth_authorization_transactions AS transaction
        CROSS JOIN cutoff
        WHERE transaction.expires_at <= cutoff.at
           OR transaction.consumed_at < cutoff.at - interval '1 day'
        ORDER BY expires_at
        LIMIT 50
      )
      RETURNING id
    )
    INSERT INTO exomem_oauth_authorization_transactions (
      transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge,
       expires_at
    )
    SELECT ${input.transactionDigest}, client.id, ${input.redirectUri}, ${input.resource},
            ${input.scopes}, ${input.stateDigest}, ${JSON.stringify(input.stateEnvelope)}::jsonb,
            ${input.formNonceDigest}, ${input.continuationBinding},
           ${input.pkceChallenge}, ${input.expiresAt.toISOString()}::timestamptz
    FROM exomem_oauth_clients AS client
    CROSS JOIN cutoff
    WHERE client.client_id = ${input.clientId}
      AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
      AND NOT EXISTS (
        SELECT 1 FROM expired_bootstraps AS expired
        WHERE expired.oauth_client_id = client.id
      )
      AND (client.admission_mode = 'pinned' OR (
        client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
        AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
        AND client.metadata_expires_at > cutoff.at AND client.cimd_host IS NOT NULL
      ))
      AND client.enabled = true
      AND (
        client.admission_mode = 'pinned' OR EXISTS (
          SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
          WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
        )
      )
      AND (
        SELECT count(*) FROM exomem_oauth_authorization_transactions
        WHERE consumed_at IS NULL AND expires_at > cutoff.at
      ) < ${MAX_PENDING_OAUTH_AUTHORIZATIONS}
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
    const row = rows[0] as { id: string } | undefined;
    return row ? { id: row.id } : null;
  });
}

export type PendingOAuthAuthorization = {
  clientId: string;
  reviewerCredentialId: string | null;
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
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:find-pending-oauth-authorization */
    SELECT client.client_id, transaction.reviewer_credential_id, transaction.redirect_uri, transaction.resource,
           transaction.requested_scopes, transaction.state_envelope, transaction.state_digest,
           transaction.form_nonce_digest, transaction.continuation_binding, transaction.pkce_challenge
    FROM exomem_oauth_authorization_transactions AS transaction
    JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id
    WHERE transaction.transaction_digest = ${transactionDigest}
      AND transaction.consumed_at IS NULL
      AND transaction.expires_at > now()
      AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
      AND (client.admission_mode = 'pinned' OR (
        client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
        AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
        AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
      ))
      AND transaction.reviewer_bootstrap_authority_id IS NULL
      AND transaction.candidate_id IS NULL
      AND client.enabled = true
      AND (
        client.admission_mode = 'pinned' OR EXISTS (
          SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
          WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
        )
      )
    LIMIT 1
  `;
    const row = rows[0] as
      | {
          client_id: string;
          reviewer_credential_id: string | null;
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
          reviewerCredentialId: row.reviewer_credential_id ?? null,
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
  });
}

/** Attaches a client grant/code to an already entitled browser-session owner; no capacity or lifecycle row is touched. */
export async function attachExistingOwnerAuthorizationAtomic(input: {
  sessionId: string;
  transactionDigest: Buffer;
  codeDigest: Buffer;
  codeExpiresAt: Date;
}): Promise<{ grantId: string; tenantId: string } | null> {
  const cloudResource = loadExomemCloudResource().mcpUrl;
  const cloudReviewersEnabled = cloudReviewerAccessEnabled();
  return withCohortLock(async (tx) => {
    const locked = await tx`
    SELECT tenant.id
    FROM exomem_sessions AS session
    JOIN exomem_tenants AS tenant ON tenant.id = session.tenant_id AND tenant.owner_user_id = session.user_id
    WHERE session.id = ${input.sessionId}::uuid
      AND session.revoked_at IS NULL AND session.expires_at > now()
    FOR UPDATE OF tenant
  `;
    if (!locked.rows[0]) return null;
    // The entitlement join is `canConnect` (entitlements.ts) in SQL. A tenant that awaits
    // its first payment is also `provisioning`, so its source state is what refuses it.
    const { rows } = await tx`
    /* exomem:attach-existing-owner-oauth */
    WITH session AS (
      SELECT session.id, session.user_id, session.tenant_id, session.reviewer_credential_id
      FROM exomem_sessions AS session
      JOIN exomem_tenants AS tenant ON tenant.id = session.tenant_id AND tenant.owner_user_id = session.user_id
      LEFT JOIN exomem_marketplace_reviewer_credentials AS credential
        ON credential.id = session.reviewer_credential_id
       AND credential.revoked_at IS NULL
       AND credential.expires_at > now()
      JOIN exomem_entitlements AS entitlement
        ON entitlement.tenant_id = session.tenant_id
       AND entitlement.effective_state = ANY(${[...CONNECTABLE_EFFECTIVE_STATES]}::text[])
       AND NOT (entitlement.source_state = ANY(${[...FIRST_PAYMENT_SOURCE_STATES]}::text[]))
      WHERE session.id = ${input.sessionId}::uuid
        AND session.revoked_at IS NULL AND session.expires_at > now()
        AND (session.reviewer_credential_id IS NULL OR credential.id IS NOT NULL)
        AND (credential.credential_kind IS DISTINCT FROM 'cloud_provider_review' OR (
          ${cloudReviewersEnabled} AND exomem_cloud_reviewer_authorized(credential.id, session.tenant_id, session.user_id, NULL)
        ))
        AND (
          (
            tenant.marketplace_reviewer_purpose = false
            AND session.reviewer_credential_id IS NULL
          )
          OR (
            tenant.marketplace_reviewer_purpose = true
            AND credential.id IS NOT NULL
            AND credential.owner_user_id = session.user_id
            AND credential.tenant_id = session.tenant_id
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM exomem_oauth_account_blocks AS block
          WHERE block.tenant_id = session.tenant_id AND block.owner_user_id = session.user_id
        )
      FOR UPDATE OF session, tenant
    ),
    transaction AS (
      SELECT transaction.id, transaction.client_id, transaction.redirect_uri,
             transaction.resource, transaction.requested_scopes, transaction.pkce_challenge,
             transaction.reviewer_credential_id
      FROM exomem_oauth_authorization_transactions AS transaction
      JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id
        AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
        AND (client.admission_mode = 'pinned' OR (
          client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
          AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
          AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
        ))
      CROSS JOIN session
      LEFT JOIN exomem_marketplace_reviewer_credentials AS credential
        ON credential.id = transaction.reviewer_credential_id
       AND credential.revoked_at IS NULL
       AND credential.expires_at > now()
      WHERE transaction.transaction_digest = ${input.transactionDigest}
        AND transaction.consumed_at IS NULL AND transaction.expires_at > now()
        AND (transaction.reviewer_credential_id IS NULL OR credential.id IS NOT NULL)
        AND (transaction.reviewer_credential_id IS NULL OR (
          transaction.resource = ${cloudResource}::text AND ${cloudReviewersEnabled}
            AND exomem_cloud_reviewer_authorized(credential.id, session.tenant_id, session.user_id, client.client_platform)
        ))
        AND (
          transaction.reviewer_credential_id IS NULL
          OR (credential.provider = 'anthropic' AND client.client_platform = 'claude')
          OR (credential.provider = 'openai' AND client.client_platform = 'openai')
        )
        AND transaction.candidate_id IS NULL
        AND client.enabled = true
        AND (
          client.admission_mode = 'pinned' OR EXISTS (
            SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
            WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
          )
        )
      FOR UPDATE OF transaction
    ),
    oauth_grant AS (
      INSERT INTO exomem_oauth_grants (
        user_id, tenant_id, client_id, resource, scopes, refresh_allowed,
        authorization_transaction_id, reviewer_credential_id
      )
      SELECT session.user_id, session.tenant_id, transaction.client_id, transaction.resource,
             array_remove(transaction.requested_scopes, 'offline_access'),
             'offline_access' = ANY(transaction.requested_scopes), transaction.id,
             transaction.reviewer_credential_id
      FROM session CROSS JOIN transaction
      WHERE session.reviewer_credential_id IS NOT DISTINCT FROM transaction.reviewer_credential_id
      ON CONFLICT (user_id, tenant_id, client_id, resource) WHERE revoked_at IS NULL
      DO UPDATE SET scopes = EXCLUDED.scopes,
                    refresh_allowed = EXCLUDED.refresh_allowed,
                    authorization_transaction_id = EXCLUDED.authorization_transaction_id,
                    updated_at = now()
      WHERE exomem_oauth_grants.reviewer_credential_id
            IS NOT DISTINCT FROM EXCLUDED.reviewer_credential_id
        AND exomem_oauth_grants.candidate_id IS NULL
      RETURNING id, tenant_id, reviewer_credential_id
    ),
    code AS (
      INSERT INTO exomem_oauth_authorization_codes (
        code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at,
        reviewer_credential_id
      )
      SELECT ${input.codeDigest}, oauth_grant.id, transaction.client_id, transaction.redirect_uri,
             transaction.resource, transaction.pkce_challenge,
             'offline_access' = ANY(transaction.requested_scopes),
             LEAST(${input.codeExpiresAt.toISOString()}, credential.expires_at),
             transaction.reviewer_credential_id
      FROM oauth_grant CROSS JOIN transaction
      LEFT JOIN exomem_marketplace_reviewer_credentials AS credential
        ON credential.id = oauth_grant.reviewer_credential_id
       AND credential.revoked_at IS NULL
       AND credential.expires_at > now()
      WHERE oauth_grant.reviewer_credential_id IS NULL OR credential.id IS NOT NULL
      RETURNING grant_id
    ),
    consumed AS (
      UPDATE exomem_oauth_authorization_transactions AS transaction_row
      SET consumed_at = now(), redeemed_session_id = session.id
      FROM transaction CROSS JOIN session CROSS JOIN code
      WHERE transaction_row.id = transaction.id
      RETURNING transaction_row.id
    )
    SELECT oauth_grant.id AS grant_id, oauth_grant.tenant_id FROM oauth_grant CROSS JOIN consumed
  `;
    const row = rows[0] as { grant_id: string; tenant_id: string } | undefined;
    return row ? { grantId: row.grant_id, tenantId: row.tenant_id } : null;
  });
}

export async function pruneExpiredOAuthState(): Promise<void> {
  await withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    await tx`
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
  });
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
    FROM exomem_oauth_grants AS oauth_grant
    JOIN exomem_tenants AS tenant ON tenant.id = oauth_grant.tenant_id
    WHERE family.id = ${input.familyId}::uuid
      AND oauth_grant.id = family.grant_id
      AND oauth_grant.user_id = ${input.ownerUserId}::uuid
      AND oauth_grant.tenant_id = ${input.tenantId}::uuid
      AND tenant.owner_user_id = oauth_grant.user_id
    RETURNING family.id
  `;
  return rows.length === 1;
}

/** Lock the authoritative tenant, persist the denial, and revoke all OAuth credentials together. */
export async function revokeOAuthAccountForOwnerTenantAtomic(input: {
  ownerUserId: string;
  tenantId: string;
  reason?: "operator_revoked" | "lifecycle_deleted";
}): Promise<number> {
  const reason = input.reason ?? "operator_revoked";
  return withExomemTransaction(async (tx) => {
    const { rows } = await tx`
      /* exomem:revoke-oauth-account-for-owner-tenant */
      WITH owner AS (
        SELECT tenant.id, tenant.owner_user_id
        FROM exomem_tenants AS tenant
        WHERE tenant.id = ${input.tenantId}::uuid
          AND tenant.owner_user_id = ${input.ownerUserId}::uuid
        FOR UPDATE
      ), blocked AS (
        INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason)
        SELECT id, owner_user_id, ${reason} FROM owner
        ON CONFLICT (tenant_id) DO UPDATE
        SET owner_user_id = EXCLUDED.owner_user_id,
            -- An operator revocation outranks a lifecycle block and is never
            -- downgraded: Cloud admission clears lifecycle blocks, so a ban
            -- left recorded as lifecycle_deleted would be re-admitted.
            blocked_reason = CASE
              WHEN EXCLUDED.blocked_reason = 'operator_revoked' THEN 'operator_revoked'
              ELSE exomem_oauth_account_blocks.blocked_reason
            END
        RETURNING tenant_id
      ), grants AS (
        UPDATE exomem_oauth_grants AS oauth_grant
        SET revoked_at = COALESCE(oauth_grant.revoked_at, now()), updated_at = now()
        FROM owner
        WHERE oauth_grant.tenant_id = owner.id AND oauth_grant.user_id = owner.owner_user_id
        RETURNING oauth_grant.id, oauth_grant.authorization_transaction_id
      ), codes AS (
        UPDATE exomem_oauth_authorization_codes AS code
        SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE code.grant_id IN (SELECT id FROM grants)
        RETURNING code.id
      ), transactions AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction
        SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE transaction.id IN (SELECT authorization_transaction_id FROM grants WHERE authorization_transaction_id IS NOT NULL)
           OR EXISTS (
             SELECT 1 FROM exomem_sessions AS session
             JOIN owner ON owner.id = session.tenant_id AND owner.owner_user_id = session.user_id
             WHERE session.id = transaction.redeemed_session_id
           )
        RETURNING transaction.id
      ), families AS (
        UPDATE exomem_oauth_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, ${reason})
        WHERE family.grant_id IN (SELECT id FROM grants)
        RETURNING family.id
      ), access AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM grants) OR token.family_id IN (SELECT id FROM families)
        RETURNING token.id
      )
      SELECT (SELECT count(*)::integer FROM families) AS revoked_families
      FROM blocked
    `;
    return Number(rows[0]?.revoked_families ?? 0);
  });
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
  const cloudResource = loadExomemCloudResource().mcpUrl;
  const cloudReviewersEnabled = cloudReviewerAccessEnabled();
  return withCohortLock(async (tx) => {
    const tenantLock = await tx`
    SELECT tenant.id
    FROM exomem_tenants AS tenant
    JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.tenant_id = tenant.id
    JOIN exomem_oauth_authorization_codes AS code ON code.grant_id = oauth_grant.id
    WHERE code.code_digest = ${input.codeDigest}
      AND tenant.owner_user_id = oauth_grant.user_id
    FOR UPDATE OF tenant
  `;
    if (!tenantLock.rows[0]) return null;
    const { rows } = await tx`
    /* exomem:oauth-code-exchange */
    WITH consumed_code AS (
      UPDATE exomem_oauth_authorization_codes AS code
      SET consumed_at = now()
      FROM exomem_oauth_grants AS oauth_grant
      JOIN exomem_oauth_clients AS client
        ON client.client_id = ${input.clientId}
       AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
       AND (client.admission_mode = 'pinned' OR (
         client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
         AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
         AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
       ))
      LEFT JOIN exomem_marketplace_reviewer_credentials AS reviewer_credential
        ON reviewer_credential.id = oauth_grant.reviewer_credential_id
       AND reviewer_credential.revoked_at IS NULL
       AND reviewer_credential.expires_at > now()
      JOIN exomem_tenants AS tenant
        ON tenant.id = oauth_grant.tenant_id
       AND tenant.owner_user_id = oauth_grant.user_id
       AND tenant.status IN ('provisioning', 'active') AND tenant.desired_state = 'running'
      JOIN exomem_entitlements AS entitlement
        ON entitlement.tenant_id = tenant.id
       AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
      WHERE code.code_digest = ${input.codeDigest}
        AND code.grant_id = oauth_grant.id
        AND code.client_id = client.id
        AND oauth_grant.client_id = code.client_id
        AND oauth_grant.resource = code.resource
        AND code.candidate_id IS NULL
        AND oauth_grant.candidate_id IS NULL
        AND code.reviewer_credential_id IS NOT DISTINCT FROM oauth_grant.reviewer_credential_id
        AND (oauth_grant.reviewer_credential_id IS NULL OR (
          code.resource = ${cloudResource}::text AND ${cloudReviewersEnabled}
            AND exomem_cloud_reviewer_authorized(reviewer_credential.id, oauth_grant.tenant_id, oauth_grant.user_id, client.client_platform)
        ))
        AND code.redirect_uri = ${input.redirectUri}
        AND code.resource = ${input.resource}
        AND code.pkce_challenge = ${input.pkceChallenge}
        AND code.consumed_at IS NULL
        AND code.expires_at > now()
        AND oauth_grant.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_authorization_transactions AS bootstrap_transaction
          WHERE bootstrap_transaction.id = oauth_grant.authorization_transaction_id
            AND bootstrap_transaction.reviewer_bootstrap_authority_id IS NOT NULL
        )
        AND client.enabled = true
        AND (client.admission_mode = 'pinned' OR EXISTS (
          SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
          WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
        ))
        AND (oauth_grant.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM exomem_oauth_account_blocks AS block
          WHERE block.tenant_id = tenant.id AND block.owner_user_id = oauth_grant.user_id
        )
      RETURNING code.grant_id, code.client_id, code.resource, code.refresh_allowed,
                code.reviewer_credential_id,
                reviewer_credential.expires_at AS reviewer_expires_at
    ),
    family AS (
      INSERT INTO exomem_oauth_token_families (
        grant_id, client_id, expires_at, reviewer_credential_id
      )
      SELECT grant_id, client_id, LEAST(now() + interval '30 days', reviewer_expires_at),
             reviewer_credential_id
      FROM consumed_code
      RETURNING id, grant_id, client_id, expires_at
    ),
    refresh AS (
      INSERT INTO exomem_oauth_refresh_tokens (
        refresh_digest, family_id, expires_at, reviewer_credential_id
      )
      SELECT ${input.refreshDigest}, id, LEAST(${input.refreshExpiresAt.toISOString()}, family.expires_at),
             consumed_code.reviewer_credential_id
      FROM family
      JOIN consumed_code ON consumed_code.grant_id = family.grant_id
      WHERE consumed_code.refresh_allowed
      RETURNING family_id
    ),
    access AS (
      INSERT INTO exomem_oauth_access_tokens (
        access_digest, grant_id, family_id, client_id, resource, scopes, expires_at,
        reviewer_credential_id
      )
      SELECT ${input.accessDigest}, consumed_code.grant_id, family.id, consumed_code.client_id,
             consumed_code.resource, oauth_grant.scopes,
             LEAST(${input.accessExpiresAt.toISOString()}, family.expires_at),
             consumed_code.reviewer_credential_id
      FROM consumed_code
      JOIN family ON family.grant_id = consumed_code.grant_id
      JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = consumed_code.grant_id
      RETURNING id
    )
    SELECT consumed_code.grant_id, family.id AS family_id, client.client_id,
           consumed_code.resource, oauth_grant.scopes, consumed_code.refresh_allowed,
           (refresh.family_id IS NOT NULL) AS refresh_inserted
    FROM consumed_code
    JOIN family ON family.grant_id = consumed_code.grant_id
    JOIN exomem_oauth_clients AS client ON client.id = consumed_code.client_id
    JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = consumed_code.grant_id
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
  });
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
  const cloudResource = loadExomemCloudResource().mcpUrl;
  const cloudReviewersEnabled = cloudReviewerAccessEnabled();
  return withCohortLock(async (tx) => {
    const tenantLock = await tx`
    SELECT tenant.id
    FROM exomem_oauth_refresh_tokens AS token
    JOIN exomem_oauth_token_families AS family ON family.id = token.family_id
    JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = family.grant_id
    JOIN exomem_oauth_clients AS client ON client.id = family.client_id
    JOIN exomem_tenants AS tenant ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
    WHERE token.refresh_digest = ${input.refreshDigest}
      AND client.client_id = ${input.clientId}
      AND oauth_grant.resource = ${input.resource}
    FOR UPDATE OF tenant
  `;
    if (!tenantLock.rows[0]) return null;
    const { rows } = await tx`
    /* exomem:oauth-refresh-rotate */
    WITH credential AS (
      SELECT token.id, token.consumed_at, token.expires_at, token.family_id, family.grant_id, family.client_id,
             family.revoked_at, family.expires_at AS family_expires_at,
             token.candidate_id, token.reviewer_credential_id
      FROM exomem_oauth_refresh_tokens AS token
      JOIN exomem_oauth_token_families AS family ON family.id = token.family_id
      JOIN exomem_oauth_clients AS client ON client.id = family.client_id
      JOIN exomem_oauth_grants AS oauth_grant
        ON oauth_grant.id = family.grant_id
       AND oauth_grant.resource = ${input.resource}
      LEFT JOIN exomem_marketplace_reviewer_credentials AS reviewer_credential
        ON reviewer_credential.id = COALESCE(token.reviewer_credential_id, oauth_grant.reviewer_credential_id)
       AND reviewer_credential.revoked_at IS NULL
       AND reviewer_credential.expires_at > now()
      WHERE token.refresh_digest = ${input.refreshDigest}
        AND client.client_id = ${input.clientId}
        AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
        AND (client.admission_mode = 'pinned' OR (
          client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
          AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
          AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
        ))
      FOR UPDATE OF token, family
    ),
    lineage_matches AS (
      SELECT credential.id
      FROM credential
      JOIN exomem_oauth_token_families AS family ON family.id = credential.family_id
      JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = credential.grant_id
      WHERE credential.reviewer_credential_id IS NOT DISTINCT FROM family.reviewer_credential_id
        AND credential.reviewer_credential_id IS NOT DISTINCT FROM oauth_grant.reviewer_credential_id
        AND credential.candidate_id IS NULL
    ),
    current_policy AS (
      SELECT credential.id
      FROM credential
      JOIN lineage_matches ON lineage_matches.id = credential.id
      JOIN exomem_oauth_clients AS client ON client.id = credential.client_id
      JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = credential.grant_id AND oauth_grant.revoked_at IS NULL
      LEFT JOIN exomem_marketplace_reviewer_credentials AS reviewer_credential
        ON reviewer_credential.id = oauth_grant.reviewer_credential_id
       AND reviewer_credential.revoked_at IS NULL
       AND reviewer_credential.expires_at > now()
      JOIN exomem_tenants AS tenant ON tenant.id = oauth_grant.tenant_id
        AND tenant.owner_user_id = oauth_grant.user_id AND tenant.status IN ('provisioning', 'active')
        AND tenant.desired_state = 'running'
      JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
        AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
      WHERE client.enabled = true
        AND (client.admission_mode = 'pinned' OR EXISTS (
          SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
          WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
        ))
        AND (oauth_grant.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL)
        AND (oauth_grant.reviewer_credential_id IS NULL OR (
          oauth_grant.resource = ${cloudResource}::text AND ${cloudReviewersEnabled}
            AND exomem_cloud_reviewer_authorized(reviewer_credential.id, oauth_grant.tenant_id, oauth_grant.user_id, client.client_platform)
        ))
        AND NOT EXISTS (
          SELECT 1 FROM exomem_oauth_account_blocks AS block
          WHERE block.tenant_id = tenant.id AND block.owner_user_id = oauth_grant.user_id
        )
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
        refresh_digest, family_id, parent_refresh_token_id, expires_at, reviewer_credential_id
      )
      SELECT ${input.replacementRefreshDigest}, consumed.family_id, credential.id,
             LEAST(family.expires_at, reviewer_credential.expires_at),
             credential.reviewer_credential_id
      FROM consumed
      JOIN credential ON credential.family_id = consumed.family_id
      JOIN exomem_oauth_token_families AS family ON family.id = consumed.family_id
      JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = consumed.grant_id
      LEFT JOIN exomem_marketplace_reviewer_credentials AS reviewer_credential
        ON reviewer_credential.id = oauth_grant.reviewer_credential_id
       AND reviewer_credential.revoked_at IS NULL
       AND reviewer_credential.expires_at > now()
      WHERE oauth_grant.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL
      RETURNING family_id
    ),
    access AS (
      INSERT INTO exomem_oauth_access_tokens (
        access_digest, grant_id, family_id, client_id, resource, scopes, expires_at,
        reviewer_credential_id
      )
      SELECT ${input.accessDigest}, consumed.grant_id, consumed.family_id,
             consumed.client_id, oauth_grant.resource, oauth_grant.scopes,
             LEAST(${input.accessExpiresAt.toISOString()}, family.expires_at),
             credential.reviewer_credential_id
      FROM consumed
      JOIN credential ON credential.family_id = consumed.family_id
      JOIN exomem_oauth_token_families AS family ON family.id = consumed.family_id
      JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = consumed.grant_id
      RETURNING id
    )
    SELECT consumed.grant_id, consumed.family_id, client.client_id, oauth_grant.resource, oauth_grant.scopes
    FROM consumed
    JOIN replacement ON replacement.family_id = consumed.family_id
    JOIN access ON true
    JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = consumed.grant_id
    JOIN exomem_oauth_clients AS client ON client.id = consumed.client_id
  `;
    const row = rows[0] as
      | {
          grant_id: string;
          family_id: string;
          client_id: string;
          resource: string;
          scopes: string[];
        }
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
  });
}
