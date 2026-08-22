import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import {
  validateMarketplaceReviewerExpiry,
  type MarketplaceReviewerAuthenticationRecord,
  type MarketplaceReviewerProvider,
} from "./reviewer-access";
import { revokeCanaryOAuthLineageInTransaction } from "./agent-contract-canaries";

export type CreateMarketplaceReviewerCredentialInput = {
  provider: MarketplaceReviewerProvider;
  usernameDigest: Buffer;
  passwordHash: string;
  ownerUserId: string;
  tenantId: string;
  fixtureVersion: string;
  fixturePayloadDigest: string;
  expiresAt: Date;
  operatorPrincipalDigest: Buffer;
};

export type MarketplaceReviewerCredentialStatus = {
  provider: MarketplaceReviewerProvider;
  fixtureVersion: string;
  fixturePayloadDigest: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type InternalCanaryReviewerCredentialStatus = {
  credentialKind: "internal_canary";
  platform: "claude" | "openai";
  fixtureVersion: string;
  fixturePayloadDigest: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type CreateInternalCanaryReviewerCredentialInput = {
  platform: "claude" | "openai";
  usernameDigest: Buffer;
  passwordHash: string;
  tenantId: string;
  candidateId: string;
  assignmentId: string;
  assignmentGeneration: number;
  stagedClientReleaseId: string;
  oauthClientId: string;
  fixtureVersion: string;
  fixturePayloadDigest: string;
  expiresAt: Date;
  operatorPrincipalDigest: Buffer;
};

function canonicalTimestamp(value: unknown): string | null {
  const timestamp =
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

async function withReviewerAccessLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-marketplace-reviewer-access'))`;
    return work(tx);
  });
}

async function withReviewerAccessSharedLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-marketplace-reviewer-access'))`;
    return work(tx);
  });
}

async function withCanaryReviewerAccessLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
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
          AND EXISTS (
            SELECT 1
            FROM exomem_oauth_clients AS client
            JOIN exomem_client_artifacts AS artifact
              ON artifact.platform = client.client_platform
             AND artifact.state = 'live'
             AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
            WHERE client.enabled = true
              AND ((client.client_platform = 'claude' AND ${input.provider} = 'anthropic')
                OR (client.client_platform = 'openai' AND ${input.provider} = 'openai'))
          )
        FOR UPDATE OF tenant
      ), prior AS (
        SELECT credential.id, credential.owner_user_id, credential.tenant_id
        FROM target
        JOIN exomem_marketplace_reviewer_credentials AS credential
          ON credential.provider = ${input.provider}
         AND credential.credential_kind = 'provider_review'
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
      ), refresh_consumed AS (
        UPDATE exomem_oauth_refresh_tokens AS token
        SET consumed_at = COALESCE(token.consumed_at, now())
        WHERE token.family_id IN (SELECT id FROM families_revoked)
          AND token.consumed_at IS NULL
        RETURNING token.id
      ), access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM grants_revoked)
           OR token.family_id IN (SELECT id FROM families_revoked)
        RETURNING token.id
      ), setup_sessions_revoked AS (
        UPDATE exomem_sessions AS session
        SET revoked_at = COALESCE(session.revoked_at, now())
        WHERE session.tenant_id IN (SELECT tenant_id FROM target)
          AND session.reviewer_credential_id IS NULL
          AND session.revoked_at IS NULL
        RETURNING session.id
      ), setup_transactions AS (
        SELECT transaction.id
        FROM exomem_oauth_authorization_transactions AS transaction
        WHERE transaction.redeemed_session_id IN (SELECT id FROM setup_sessions_revoked)
      ), setup_transactions_consumed AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction
        SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE transaction.id IN (SELECT id FROM setup_transactions)
          AND transaction.consumed_at IS NULL
        RETURNING transaction.id
      ), setup_grants_revoked AS (
        UPDATE exomem_oauth_grants AS grant_row
        SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
        WHERE grant_row.tenant_id IN (SELECT tenant_id FROM target)
          AND grant_row.reviewer_credential_id IS NULL
          AND grant_row.revoked_at IS NULL
        RETURNING grant_row.id
      ), setup_codes_consumed AS (
        UPDATE exomem_oauth_authorization_codes AS code
        SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE code.grant_id IN (SELECT id FROM setup_grants_revoked)
          AND code.consumed_at IS NULL
        RETURNING code.id
      ), setup_families_revoked AS (
        UPDATE exomem_oauth_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'reviewer_setup_sealed')
        WHERE family.grant_id IN (SELECT id FROM setup_grants_revoked)
          AND family.revoked_at IS NULL
        RETURNING family.id
      ), setup_refresh_consumed AS (
        UPDATE exomem_oauth_refresh_tokens AS token
        SET consumed_at = COALESCE(token.consumed_at, now())
        WHERE token.family_id IN (SELECT id FROM setup_families_revoked)
          AND token.consumed_at IS NULL
        RETURNING token.id
      ), setup_access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM setup_grants_revoked)
           OR token.family_id IN (SELECT id FROM setup_families_revoked)
        RETURNING token.id
      ), revocation_complete AS (
        SELECT (
          (SELECT count(*) FROM access_revoked)
          + (SELECT count(*) FROM setup_transactions_consumed)
          + (SELECT count(*) FROM setup_codes_consumed)
          + (SELECT count(*) FROM setup_refresh_consumed)
          + (SELECT count(*) FROM setup_access_revoked)
        ) AS count
      ), created AS (
        INSERT INTO exomem_marketplace_reviewer_credentials (
          provider, username_digest, password_hash, owner_user_id, tenant_id,
          fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at
        )
        SELECT ${input.provider},
               ${input.usernameDigest},
               ${input.passwordHash},
               target.owner_user_id,
               target.tenant_id,
               ${input.fixtureVersion},
               ${input.fixturePayloadDigest},
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

/** A pending candidate is reachable only through this short-lived, exact reviewer binding. */
export async function createInternalCanaryReviewerCredentialAtomic(
  input: CreateInternalCanaryReviewerCredentialInput
): Promise<{
  credentialId: string;
  ownerUserId: string;
  tenantId: string;
  expiresAt: string;
} | null> {
  validateMarketplaceReviewerExpiry(input.expiresAt);
  const provider: MarketplaceReviewerProvider =
    input.platform === "claude" ? "anthropic" : "openai";
  return withCanaryReviewerAccessLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:create-internal-canary-reviewer-credential */
      WITH target AS (
        SELECT tenant.id AS tenant_id, tenant.owner_user_id, assignment.id AS assignment_id,
               assignment.generation AS assignment_generation, assignment.candidate_id,
               stage.id AS staged_client_release_id, client.id AS oauth_client_id
        FROM exomem_tenants AS tenant
        JOIN exomem_agent_contract_rollout_assignments AS assignment
          ON assignment.id = ${input.assignmentId}::uuid
         AND assignment.tenant_id = tenant.id
         AND assignment.candidate_id = ${input.candidateId}::uuid
         AND assignment.generation = ${input.assignmentGeneration}
         AND assignment.marketplace_reviewer_purpose = true
         AND assignment.state IN ('preparing', 'active')
         AND assignment.expires_at > now()
        JOIN exomem_staged_client_releases AS stage
          ON stage.id = ${input.stagedClientReleaseId}::uuid
         AND stage.candidate_id = assignment.candidate_id
         AND stage.platform = ${input.platform}
         AND stage.state IN ('staged', 'evidenced')
         AND stage.expires_at > now()
        JOIN exomem_oauth_clients AS client
         ON client.id = ${input.oauthClientId}::uuid
         AND client.client_platform = stage.platform
         AND client.oauth_client_config_sha256 = stage.oauth_client_config_sha256
        JOIN users ON users.id = tenant.owner_user_id AND users.deleted_at IS NULL
        WHERE tenant.id = ${input.tenantId}::uuid
          AND tenant.marketplace_reviewer_purpose = true
          AND tenant.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
            WHERE bootstrap.state = 'active'
          )
          AND (
            NOT EXISTS (
              SELECT 1
              FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
              WHERE bootstrap.state = 'consumed'
            ) OR EXISTS (
              SELECT 1
              FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
              WHERE bootstrap.state = 'consumed'
                AND bootstrap.outcome_tenant_id = tenant.id
                AND bootstrap.outcome_assignment_id = assignment.id
                AND bootstrap.outcome_assignment_generation = assignment.generation
                AND bootstrap.candidate_id = assignment.candidate_id
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
            WHERE bootstrap.staged_client_release_id = stage.id
               OR bootstrap.oauth_client_id = client.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_oauth_account_blocks AS block
            WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
          )
        FOR UPDATE OF tenant, assignment, stage, client
      ), prior AS (
        SELECT credential.id
        FROM exomem_marketplace_reviewer_credentials AS credential
        JOIN target ON target.tenant_id = credential.tenant_id
          AND target.candidate_id = credential.candidate_id
          AND target.assignment_id = credential.assignment_id
          AND target.assignment_generation = credential.assignment_generation
          AND target.staged_client_release_id = credential.staged_client_release_id
          AND target.oauth_client_id = credential.oauth_client_id
        WHERE credential.credential_kind = 'internal_canary' AND credential.revoked_at IS NULL
        FOR UPDATE
      ), prior_revoked AS (
        UPDATE exomem_marketplace_reviewer_credentials AS credential
        SET revoked_at = now(), revoked_by_principal_digest = ${input.operatorPrincipalDigest}
        WHERE credential.id IN (SELECT id FROM prior)
        RETURNING credential.id
      ), prior_sessions_revoked AS (
        UPDATE exomem_sessions AS session
        SET revoked_at = COALESCE(session.revoked_at, now())
        WHERE session.reviewer_credential_id IN (SELECT id FROM prior_revoked)
          AND session.revoked_at IS NULL
        RETURNING session.id
      ), prior_transactions AS (
        SELECT transaction.id FROM exomem_oauth_authorization_transactions AS transaction
        WHERE transaction.reviewer_credential_id IN (SELECT id FROM prior_revoked)
           OR transaction.redeemed_session_id IN (SELECT id FROM prior_sessions_revoked)
      ), prior_transactions_consumed AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction
        SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE transaction.id IN (SELECT id FROM prior_transactions) AND transaction.consumed_at IS NULL
        RETURNING transaction.id
      ), prior_grants_revoked AS (
        UPDATE exomem_oauth_grants AS grant_row
        SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
        WHERE (grant_row.reviewer_credential_id IN (SELECT id FROM prior_revoked)
            OR grant_row.authorization_transaction_id IN (SELECT id FROM prior_transactions))
          AND grant_row.revoked_at IS NULL
        RETURNING grant_row.id
      ), prior_codes_consumed AS (
        UPDATE exomem_oauth_authorization_codes AS code
        SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE code.grant_id IN (SELECT id FROM prior_grants_revoked) AND code.consumed_at IS NULL
        RETURNING code.id
      ), prior_families_revoked AS (
        UPDATE exomem_oauth_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'reviewer_credential_rotated')
        WHERE family.grant_id IN (SELECT id FROM prior_grants_revoked) AND family.revoked_at IS NULL
        RETURNING family.id
      ), prior_refresh_consumed AS (
        UPDATE exomem_oauth_refresh_tokens AS token
        SET consumed_at = COALESCE(token.consumed_at, now())
        WHERE token.family_id IN (SELECT id FROM prior_families_revoked) AND token.consumed_at IS NULL
        RETURNING token.id
      ), prior_access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM prior_grants_revoked)
           OR token.family_id IN (SELECT id FROM prior_families_revoked)
        RETURNING token.id
      ), setup_sessions_revoked AS (
        UPDATE exomem_sessions AS session
        SET revoked_at = COALESCE(session.revoked_at, now())
        WHERE session.id IN (
          SELECT invite.redeemed_session_id
          FROM exomem_invites AS invite
          JOIN target ON target.tenant_id = invite.redeemed_tenant_id
            AND target.owner_user_id = invite.consumed_by_user_id
          WHERE invite.marketplace_reviewer_purpose = true
            AND invite.redeemed_session_id IS NOT NULL
        )
          AND session.revoked_at IS NULL
        RETURNING session.id
      ), setup_transactions AS (
        SELECT transaction.id
        FROM exomem_oauth_authorization_transactions AS transaction
        WHERE transaction.redeemed_session_id IN (SELECT id FROM setup_sessions_revoked)
      ), setup_transactions_consumed AS (
        UPDATE exomem_oauth_authorization_transactions AS transaction
        SET consumed_at = COALESCE(transaction.consumed_at, now())
        WHERE transaction.id IN (SELECT id FROM setup_transactions)
          AND transaction.consumed_at IS NULL
        RETURNING transaction.id
      ), setup_grants_revoked AS (
        UPDATE exomem_oauth_grants AS grant_row
        SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
        WHERE grant_row.authorization_transaction_id IN (SELECT id FROM setup_transactions)
          AND grant_row.reviewer_credential_id IS NULL
          AND grant_row.revoked_at IS NULL
        RETURNING grant_row.id
      ), setup_codes_consumed AS (
        UPDATE exomem_oauth_authorization_codes AS code
        SET consumed_at = COALESCE(code.consumed_at, now())
        WHERE code.grant_id IN (SELECT id FROM setup_grants_revoked) AND code.consumed_at IS NULL
        RETURNING code.id
      ), setup_families_revoked AS (
        UPDATE exomem_oauth_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'reviewer_setup_sealed')
        WHERE family.grant_id IN (SELECT id FROM setup_grants_revoked) AND family.revoked_at IS NULL
        RETURNING family.id
      ), setup_refresh_consumed AS (
        UPDATE exomem_oauth_refresh_tokens AS token
        SET consumed_at = COALESCE(token.consumed_at, now())
        WHERE token.family_id IN (SELECT id FROM setup_families_revoked) AND token.consumed_at IS NULL
        RETURNING token.id
      ), setup_access_revoked AS (
        UPDATE exomem_oauth_access_tokens AS token
        SET revoked_at = COALESCE(token.revoked_at, now())
        WHERE token.grant_id IN (SELECT id FROM setup_grants_revoked)
           OR token.family_id IN (SELECT id FROM setup_families_revoked)
        RETURNING token.id
      ), created AS (
        INSERT INTO exomem_marketplace_reviewer_credentials (
          provider, credential_kind, username_digest, password_hash, owner_user_id, tenant_id,
          candidate_id, assignment_id, assignment_generation, staged_client_release_id, oauth_client_id,
          fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at
        )
        SELECT ${provider}, 'internal_canary', ${input.usernameDigest}, ${input.passwordHash},
               target.owner_user_id, target.tenant_id, target.candidate_id, target.assignment_id,
               target.assignment_generation, target.staged_client_release_id, target.oauth_client_id,
               ${input.fixtureVersion}, ${input.fixturePayloadDigest}, ${input.operatorPrincipalDigest},
               LEAST(${input.expiresAt.toISOString()}::timestamptz, (SELECT expires_at FROM exomem_agent_contract_rollout_assignments WHERE id = target.assignment_id), (SELECT expires_at FROM exomem_staged_client_releases WHERE id = target.staged_client_release_id))
        FROM target
        RETURNING id, owner_user_id, tenant_id, expires_at
      )
      SELECT id, owner_user_id, tenant_id, expires_at FROM created
    `;
    const row = rows[0] as
      | { id?: string; owner_user_id?: string; tenant_id?: string; expires_at?: unknown }
      | undefined;
    const expiresAt = canonicalTimestamp(row?.expires_at);
    return row?.id && row.owner_user_id && row.tenant_id && expiresAt
      ? { credentialId: row.id, ownerUserId: row.owner_user_id, tenantId: row.tenant_id, expiresAt }
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
  const expiresAt = canonicalTimestamp(row?.expires_at);
  const revokedAt = row?.revoked_at === null ? null : canonicalTimestamp(row?.revoked_at);
  return row &&
    typeof row.id === "string" &&
    (row.provider === "openai" || row.provider === "anthropic") &&
    typeof row.owner_user_id === "string" &&
    typeof row.tenant_id === "string" &&
    typeof row.fixture_version === "string" &&
    typeof row.password_hash === "string" &&
    expiresAt &&
    (row.revoked_at === null || revokedAt)
    ? {
        credentialId: row.id,
        provider: row.provider,
        ownerUserId: row.owner_user_id,
        tenantId: row.tenant_id,
        fixtureVersion: row.fixture_version,
        passwordHash: row.password_hash,
        expiresAt,
        revokedAt,
      }
    : null;
}

export async function createMarketplaceReviewerSessionAtomic(input: {
  credentialId: string;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  expiresAt: Date;
}): Promise<{ sessionId: string; ownerUserId: string; tenantId: string } | null> {
  return withReviewerAccessSharedLock(async (tx) => {
    const { rows } = await tx`
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
  });
}

export async function createMarketplaceReviewerOAuthSessionAtomic(input: {
  credentialId: string;
  transactionDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  expiresAt: Date;
}): Promise<{ sessionId: string } | null> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await tx`
    /* exomem:create-marketplace-reviewer-oauth-session */
    WITH credential AS (
      SELECT credential.id, credential.owner_user_id, credential.tenant_id, credential.expires_at, credential.provider,
             credential.credential_kind, credential.candidate_id, credential.assignment_id,
             credential.assignment_generation, credential.staged_client_release_id, credential.oauth_client_id
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
        AND NOT EXISTS (
          SELECT 1 FROM exomem_oauth_account_blocks AS block
          WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
        )
      FOR UPDATE OF credential
    ), transaction AS (
      SELECT transaction.id
      FROM exomem_oauth_authorization_transactions AS transaction
      JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id
       AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
       AND (client.admission_mode = 'pinned' OR (
         client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
        AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
        AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
       ))
      CROSS JOIN credential
      WHERE transaction.transaction_digest = ${input.transactionDigest}
        AND transaction.consumed_at IS NULL
        AND transaction.expires_at > now()
        AND (
          (credential.credential_kind = 'provider_review' AND client.enabled = true AND EXISTS (
          SELECT 1 FROM exomem_hosted_alpha_platform_cohort AS cohort
          WHERE cohort.platform = client.client_platform
            AND client.oauth_client_config_sha256 = cohort.oauth_client_config_sha256
          )) OR (
            credential.credential_kind = 'internal_canary'
            -- Unbound, or already bound to THIS credential. Re-authenticating as
            -- yourself on a transaction you already bound must be idempotent: the
            -- first success binds these columns, so requiring them to be NULL made
            -- every retry a guaranteed failure reported as "check the credentials",
            -- which cost the 2026-08-16 promotion window. Binding to a DIFFERENT
            -- credential is still refused -- that would be taking someone else's
            -- authorization transaction.
            AND (transaction.candidate_id IS NULL
                 OR transaction.candidate_id = credential.candidate_id)
            AND (transaction.assignment_id IS NULL
                 OR transaction.assignment_id = credential.assignment_id)
            AND (transaction.assignment_generation IS NULL
                 OR transaction.assignment_generation = credential.assignment_generation)
            AND (transaction.staged_client_release_id IS NULL
                 OR transaction.staged_client_release_id = credential.staged_client_release_id)
            AND (transaction.reviewer_credential_id IS NULL
                 OR transaction.reviewer_credential_id = credential.id)
            AND credential.oauth_client_id = client.id
            AND EXISTS (
              SELECT 1
              FROM exomem_agent_contract_rollout_assignments AS assignment
              JOIN exomem_staged_client_releases AS stage
                ON stage.id = credential.staged_client_release_id
               AND stage.candidate_id = credential.candidate_id
               AND stage.platform = client.client_platform
               AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
               AND stage.state IN ('staged', 'evidenced') AND stage.expires_at > now()
              JOIN exomem_agent_contract_candidates AS candidate
                ON candidate.id = credential.candidate_id
               AND candidate.profile_id = 'hosted-alpha-agent-v1'
               AND candidate.state IN ('pending', 'live')
              WHERE assignment.id = credential.assignment_id
                AND assignment.tenant_id = credential.tenant_id
                AND assignment.candidate_id = credential.candidate_id
                AND assignment.generation = credential.assignment_generation
                AND assignment.marketplace_reviewer_purpose = true
                AND assignment.state IN ('preparing', 'active') AND assignment.expires_at > now()
            )
          )
        )
        AND (credential.credential_kind = 'internal_canary' OR (
          (credential.provider = 'anthropic' AND client.client_platform = 'claude')
          OR (credential.provider = 'openai' AND client.client_platform = 'openai')
        ))
      FOR UPDATE OF transaction
    ), session AS (
      INSERT INTO exomem_sessions (
        user_id, tenant_id, reviewer_credential_id, session_digest, csrf_digest, expires_at,
        candidate_id, assignment_id, assignment_generation, staged_client_release_id, oauth_client_id
      )
      SELECT credential.owner_user_id,
             credential.tenant_id,
             credential.id,
             ${input.sessionDigest},
             ${input.csrfDigest},
             LEAST(${input.expiresAt.toISOString()}, credential.expires_at),
             credential.candidate_id, credential.assignment_id, credential.assignment_generation,
             credential.staged_client_release_id, credential.oauth_client_id
      FROM credential CROSS JOIN transaction
      RETURNING id
    ), bound AS (
      UPDATE exomem_oauth_authorization_transactions AS transaction_row
      SET reviewer_credential_id = credential.id,
          candidate_id = CASE WHEN credential.credential_kind = 'internal_canary' THEN credential.candidate_id ELSE NULL END,
          assignment_id = CASE WHEN credential.credential_kind = 'internal_canary' THEN credential.assignment_id ELSE NULL END,
          assignment_generation = CASE WHEN credential.credential_kind = 'internal_canary' THEN credential.assignment_generation ELSE NULL END,
          staged_client_release_id = CASE WHEN credential.credential_kind = 'internal_canary' THEN credential.staged_client_release_id ELSE NULL END
      FROM transaction CROSS JOIN credential CROSS JOIN session
      WHERE transaction_row.id = transaction.id
      RETURNING transaction_row.id
    )
    SELECT session.id FROM session CROSS JOIN bound
    `;
    const row = rows[0] as { id?: string } | undefined;
    return row?.id ? { sessionId: row.id } : null;
  });
}

export async function getMarketplaceReviewerCredentialStatus(
  provider: MarketplaceReviewerProvider
): Promise<MarketplaceReviewerCredentialStatus | null> {
  const { rows } = await executeExomemSql`
    /* exomem:reviewer-credential-status */
    SELECT provider, fixture_version, fixture_payload_digest, expires_at, revoked_at
    FROM exomem_marketplace_reviewer_credentials
    WHERE provider = ${provider} AND credential_kind = 'provider_review'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  const expiresAt = canonicalTimestamp(row?.expires_at);
  const revokedAt = row?.revoked_at === null ? null : canonicalTimestamp(row?.revoked_at);
  return row &&
    (row.provider === "openai" || row.provider === "anthropic") &&
    typeof row.fixture_version === "string" &&
    typeof row.fixture_payload_digest === "string" &&
    expiresAt &&
    (row.revoked_at === null || revokedAt)
    ? {
        provider: row.provider,
        fixtureVersion: row.fixture_version,
        fixturePayloadDigest: row.fixture_payload_digest,
        expiresAt,
        revokedAt,
      }
    : null;
}

export async function getInternalCanaryReviewerCredentialStatus(input: {
  platform: "claude" | "openai";
  tenantId: string;
  candidateId: string;
  assignmentId: string;
  assignmentGeneration: number;
  stagedClientReleaseId: string;
  oauthClientId: string;
}): Promise<InternalCanaryReviewerCredentialStatus | null> {
  const { rows } = await executeExomemSql`
    /* exomem:internal-canary-reviewer-credential-status */
    SELECT credential.fixture_version, credential.fixture_payload_digest, credential.expires_at,
           credential.revoked_at, client.client_platform
    FROM exomem_marketplace_reviewer_credentials AS credential
    JOIN exomem_oauth_clients AS client ON client.id = credential.oauth_client_id
    WHERE credential.credential_kind = 'internal_canary'
      AND credential.tenant_id = ${input.tenantId}::uuid
      AND credential.candidate_id = ${input.candidateId}::uuid
      AND credential.assignment_id = ${input.assignmentId}::uuid
      AND credential.assignment_generation = ${input.assignmentGeneration}::bigint
      AND credential.staged_client_release_id = ${input.stagedClientReleaseId}::uuid
      AND credential.oauth_client_id = ${input.oauthClientId}::uuid
      AND client.client_platform = ${input.platform}
    ORDER BY credential.created_at DESC
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  const expiresAt = canonicalTimestamp(row?.expires_at);
  const revokedAt = row?.revoked_at === null ? null : canonicalTimestamp(row?.revoked_at);
  return row &&
    (row.client_platform === "claude" || row.client_platform === "openai") &&
    typeof row.fixture_version === "string" &&
    typeof row.fixture_payload_digest === "string" &&
    expiresAt &&
    (row.revoked_at === null || revokedAt)
    ? {
        credentialKind: "internal_canary",
        platform: row.client_platform,
        fixtureVersion: row.fixture_version,
        fixturePayloadDigest: row.fixture_payload_digest,
        expiresAt,
        revokedAt,
      }
    : null;
}

export async function revokeInternalCanaryReviewerCredentialAtomic(input: {
  platform: "claude" | "openai";
  tenantId: string;
  candidateId: string;
  assignmentId: string;
  assignmentGeneration: number;
  stagedClientReleaseId: string;
  oauthClientId: string;
  operatorPrincipalDigest: Buffer;
}): Promise<number> {
  return withCanaryReviewerAccessLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:lock-internal-canary-reviewer-credential */
      SELECT credential.id
      FROM exomem_marketplace_reviewer_credentials AS credential
      JOIN exomem_oauth_clients AS client ON client.id = credential.oauth_client_id
      WHERE credential.credential_kind = 'internal_canary'
        AND credential.tenant_id = ${input.tenantId}::uuid
        AND credential.candidate_id = ${input.candidateId}::uuid
        AND credential.assignment_id = ${input.assignmentId}::uuid
        AND credential.assignment_generation = ${input.assignmentGeneration}::bigint
        AND credential.staged_client_release_id = ${input.stagedClientReleaseId}::uuid
        AND credential.oauth_client_id = ${input.oauthClientId}::uuid
        AND client.client_platform = ${input.platform}
        AND credential.revoked_at IS NULL
      FOR UPDATE OF credential
    `;
    if (rows.length !== 1) return 0;
    return revokeCanaryOAuthLineageInTransaction(tx, {
      tenantId: input.tenantId,
      candidateId: input.candidateId,
      assignmentId: input.assignmentId,
      assignmentGeneration: input.assignmentGeneration,
      stagedClientReleaseId: input.stagedClientReleaseId,
      oauthClientId: input.oauthClientId,
      revokedByPrincipalDigest: input.operatorPrincipalDigest,
    });
  });
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
      AND (
        (credential.provider = 'anthropic' AND client.client_platform = 'claude')
        OR (credential.provider = 'openai' AND client.client_platform = 'openai')
      )
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
        WHERE provider = ${input.provider} AND credential_kind = 'provider_review' AND revoked_at IS NULL
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
      ), refresh_consumed AS (
        UPDATE exomem_oauth_refresh_tokens AS token
        SET consumed_at = COALESCE(token.consumed_at, now())
        WHERE token.family_id IN (SELECT id FROM families_revoked)
          AND token.consumed_at IS NULL
        RETURNING token.id
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
