import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { exomemErrors } from "./errors";
import { hasLiveHostedCohortTarget } from "./hosted-cohort-target";
import { EXOMEM_ALPHA_CAPACITY } from "./oauth-admission";
import {
  CIMD_DEFAULT_TTL_SECONDS,
  MAX_OAUTH_CLIENT_ID_LENGTH,
  MAX_OAUTH_CLIENT_REDIRECTS,
  documentDigest,
  fetchCimdMetadata,
  oauthClientConfigSha256,
  type CimdFetchedMetadata,
} from "./oauth-client-admission";
import { PROVISIONER_PROTOCOL_V2, type ProvisionerWireProtocol } from "./provisioner";
import { provisionerWireProtocolFromEnv } from "./provisioner-wire-protocol";
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
  candidateId?: string;
  assignmentId?: string;
  assignmentGeneration?: bigint;
  stagedClientReleaseId?: string;
  oauthClientRecordId?: string;
  reviewerCredentialId?: string;
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

export async function resolveApprovedOAuthClient(
  clientId: string
): Promise<ApprovedOAuthClient | null> {
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:resolve-approved-oauth-client */
    SELECT id, client_id, redirect_uris, admission_mode
    FROM exomem_oauth_clients AS client
    WHERE client.client_id = ${clientId}
      AND redirect_uris_digest = digest(convert_to(redirect_uris::text, 'utf8'), 'sha256')
      AND admission_mode IN ('pinned', 'cimd')
      AND (admission_mode = 'pinned' OR (
        metadata_document_digest IS NOT NULL AND metadata_fetched_at IS NOT NULL
        AND metadata_ttl_seconds BETWEEN 300 AND 604800
        AND metadata_expires_at > now() AND cimd_host IS NOT NULL
      ))
      AND (
        (client.enabled = true AND EXISTS (
          SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
          WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
             OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
             OR (client.admission_mode = 'cimd'
                 AND client.metadata_expires_at > now()
                 AND EXISTS (
                   SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                   WHERE admitted.host = client.cimd_host
                     AND admitted.platform = client.client_platform
                 ))
        )) OR EXISTS (
          SELECT 1
          FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
          WHERE bootstrap.state = 'active' AND bootstrap.expires_at > now()
            AND bootstrap.oauth_client_id = client.id
            AND bootstrap.oauth_client_authority_version = client.authority_version
            AND bootstrap.oauth_client_config_sha256 = client.oauth_client_config_sha256
            AND bootstrap.redirect_uri_digest = client.redirect_uris_digest
        ) OR EXISTS (
          SELECT 1
          FROM exomem_marketplace_reviewer_credentials AS credential
          JOIN exomem_agent_contract_rollout_assignments AS assignment
            ON assignment.id = credential.assignment_id
           AND assignment.tenant_id = credential.tenant_id
           AND assignment.candidate_id = credential.candidate_id
           AND assignment.generation = credential.assignment_generation
           AND assignment.marketplace_reviewer_purpose = true
           AND assignment.state IN ('preparing', 'active')
           AND assignment.expires_at > now()
          JOIN exomem_staged_client_releases AS stage
            ON stage.id = credential.staged_client_release_id
           AND stage.candidate_id = credential.candidate_id
           AND stage.platform = client.client_platform
           AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
           AND stage.state IN ('staged', 'evidenced')
           AND stage.expires_at > now()
          JOIN exomem_agent_contract_candidates AS candidate
            ON candidate.id = credential.candidate_id
           AND candidate.profile_id = 'hosted-alpha-agent-v1'
           AND candidate.state IN ('pending', 'live')
          WHERE credential.credential_kind = 'internal_canary'
            AND credential.oauth_client_id = client.id
            AND credential.revoked_at IS NULL
            AND credential.expires_at > now()
        )
      )
    LIMIT 1
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
    WITH expired_bootstraps AS (
      UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
      SET state = 'expired', expired_at = now()
      WHERE state = 'active' AND expires_at <= now()
      RETURNING oauth_client_id
    ), disabled_bootstrap_clients AS (
      UPDATE exomem_oauth_clients AS client
      SET enabled = false, authority_version = gen_random_uuid(), updated_at = now()
      WHERE client.id IN (SELECT oauth_client_id FROM expired_bootstraps)
      RETURNING client.id
    ), pruned AS (
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
       state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge,
       reviewer_bootstrap_authority_id, expires_at
    )
    SELECT ${input.transactionDigest}, client.id, ${input.redirectUri}, ${input.resource},
            ${input.scopes}, ${input.stateDigest}, ${JSON.stringify(input.stateEnvelope)}::jsonb,
            ${input.formNonceDigest}, ${input.continuationBinding},
           ${input.pkceChallenge}, bootstrap.id,
           LEAST(${input.expiresAt.toISOString()}::timestamptz, COALESCE(bootstrap.expires_at, ${input.expiresAt.toISOString()}::timestamptz))
    FROM exomem_oauth_clients AS client
    LEFT JOIN LATERAL (
      SELECT authority.id, authority.expires_at
      FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
      JOIN exomem_invites AS invite ON invite.id = authority.invite_id
      WHERE authority.state = 'active' AND authority.expires_at > now()
        AND authority.oauth_client_id = client.id
        AND authority.oauth_client_authority_version = client.authority_version
        AND authority.oauth_client_config_sha256 = client.oauth_client_config_sha256
        AND authority.redirect_uri_digest = client.redirect_uris_digest
        AND invite.consumed_at IS NULL AND invite.revoked_at IS NULL AND invite.expires_at > now()
      LIMIT 1
    ) AS bootstrap ON true
    WHERE client.client_id = ${input.clientId}
      AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
      AND (client.admission_mode = 'pinned' OR (
        client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
        AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
        AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
      ))
      AND (
        (client.enabled = true AND EXISTS (
          SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
          WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
             OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
             OR (client.admission_mode = 'cimd'
                 AND client.metadata_expires_at > now()
                 AND EXISTS (
                   SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                   WHERE admitted.host = client.cimd_host
                     AND admitted.platform = client.client_platform
                 ))
        )) OR EXISTS (
          SELECT 1
          FROM exomem_marketplace_reviewer_credentials AS credential
          JOIN exomem_agent_contract_rollout_assignments AS assignment
            ON assignment.id = credential.assignment_id
           AND assignment.tenant_id = credential.tenant_id
           AND assignment.candidate_id = credential.candidate_id
           AND assignment.generation = credential.assignment_generation
           AND assignment.marketplace_reviewer_purpose = true
           AND assignment.state IN ('preparing', 'active') AND assignment.expires_at > now()
          JOIN exomem_staged_client_releases AS stage
            ON stage.id = credential.staged_client_release_id
           AND stage.candidate_id = credential.candidate_id
           AND stage.platform = client.client_platform
           AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
           AND stage.state IN ('staged', 'evidenced') AND stage.expires_at > now()
          WHERE credential.credential_kind = 'internal_canary'
            AND credential.oauth_client_id = client.id
            AND credential.revoked_at IS NULL AND credential.expires_at > now()
      ) OR bootstrap.id IS NOT NULL
      )
      AND (bootstrap.id IS NULL OR NOT EXISTS (
        SELECT 1 FROM exomem_oauth_authorization_transactions AS pending
        WHERE pending.reviewer_bootstrap_authority_id = bootstrap.id
      ))
      AND (
        SELECT count(*) FROM exomem_oauth_authorization_transactions
        WHERE consumed_at IS NULL AND expires_at > now()
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
    SELECT client.client_id, transaction.redirect_uri, transaction.resource,
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
      AND (
        EXISTS (
          SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS bootstrap
          WHERE bootstrap.id = transaction.reviewer_bootstrap_authority_id
            AND bootstrap.state = 'active' AND bootstrap.expires_at > now()
            AND bootstrap.oauth_client_id = client.id
            AND bootstrap.oauth_client_authority_version = client.authority_version
            AND bootstrap.oauth_client_config_sha256 = client.oauth_client_config_sha256
            AND bootstrap.redirect_uri_digest = client.redirect_uris_digest
        ) OR (transaction.reviewer_bootstrap_authority_id IS NULL AND
        (transaction.candidate_id IS NULL AND (
          (client.enabled = true AND EXISTS (
          SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
          WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
             OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
             OR (client.admission_mode = 'cimd'
                 AND client.metadata_expires_at > now()
                 AND EXISTS (
                   SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                   WHERE admitted.host = client.cimd_host
                     AND admitted.platform = client.client_platform
                 ))
          )) OR EXISTS (
            SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
            JOIN exomem_staged_client_releases AS stage
              ON stage.id = credential.staged_client_release_id
             AND stage.candidate_id = credential.candidate_id
             AND stage.platform = client.client_platform
             AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
             AND stage.state IN ('staged', 'evidenced') AND stage.expires_at > now()
            JOIN exomem_agent_contract_rollout_assignments AS assignment
              ON assignment.id = credential.assignment_id
             AND assignment.candidate_id = credential.candidate_id
             AND assignment.generation = credential.assignment_generation
             AND assignment.tenant_id = credential.tenant_id
             AND assignment.state IN ('preparing', 'active') AND assignment.expires_at > now()
            WHERE credential.credential_kind = 'internal_canary'
              AND credential.oauth_client_id = client.id
              AND credential.revoked_at IS NULL AND credential.expires_at > now()
          )
        )) OR EXISTS (
          SELECT 1
          FROM exomem_marketplace_reviewer_credentials AS credential
          JOIN exomem_agent_contract_rollout_assignments AS assignment
            ON assignment.id = credential.assignment_id
           AND assignment.tenant_id = credential.tenant_id
           AND assignment.candidate_id = credential.candidate_id
           AND assignment.generation = credential.assignment_generation
           AND assignment.marketplace_reviewer_purpose = true
           AND assignment.state IN ('preparing', 'active') AND assignment.expires_at > now()
          JOIN exomem_staged_client_releases AS stage
            ON stage.id = credential.staged_client_release_id
           AND stage.candidate_id = credential.candidate_id
           AND stage.platform = client.client_platform
           AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
           AND stage.state IN ('staged', 'evidenced') AND stage.expires_at > now()
          WHERE transaction.candidate_id = credential.candidate_id
            AND transaction.assignment_id = credential.assignment_id
            AND transaction.assignment_generation = credential.assignment_generation
            AND transaction.staged_client_release_id = credential.staged_client_release_id
            AND transaction.reviewer_credential_id = credential.id
            AND credential.oauth_client_id = client.id
            AND credential.credential_kind = 'internal_canary'
            AND credential.revoked_at IS NULL AND credential.expires_at > now()
        ))
      )
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
  });
}

/** Attaches a client grant/code to an already entitled browser-session owner; no capacity or lifecycle row is touched. */
export async function attachExistingOwnerAuthorizationAtomic(input: {
  sessionId: string;
  transactionDigest: Buffer;
  codeDigest: Buffer;
  codeExpiresAt: Date;
}): Promise<{ grantId: string; tenantId: string } | null> {
  return withCohortLock(async (tx) => {
    const locked = await tx`
    SELECT tenant.id
    FROM exomem_sessions AS session
    JOIN exomem_tenants AS tenant ON tenant.id = session.tenant_id AND tenant.owner_user_id = session.user_id
    WHERE session.id = ${input.sessionId}::uuid
      AND session.revoked_at IS NULL AND session.expires_at > now()
    FOR UPDATE OF session, tenant
  `;
    if (!locked.rows[0]) return null;
    const { rows } = await tx`
    /* exomem:attach-existing-owner-oauth */
    WITH session AS (
      SELECT session.id, session.user_id, session.tenant_id, session.reviewer_credential_id,
             session.candidate_id, session.assignment_id, session.assignment_generation,
             session.staged_client_release_id, session.oauth_client_id
      FROM exomem_sessions AS session
      JOIN exomem_tenants AS tenant ON tenant.id = session.tenant_id AND tenant.owner_user_id = session.user_id
      LEFT JOIN exomem_marketplace_reviewer_credentials AS credential
        ON credential.id = session.reviewer_credential_id
       AND credential.revoked_at IS NULL
       AND credential.expires_at > now()
      JOIN exomem_entitlements AS entitlement
        ON entitlement.tenant_id = session.tenant_id
       AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
      WHERE session.id = ${input.sessionId}::uuid
        AND session.revoked_at IS NULL AND session.expires_at > now()
        AND (session.reviewer_credential_id IS NULL OR credential.id IS NOT NULL)
        AND (
          (
            tenant.marketplace_reviewer_purpose = false
            AND session.reviewer_credential_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM exomem_agent_contract_rollout_assignments AS assignment
              WHERE assignment.tenant_id = session.tenant_id
                AND assignment.marketplace_reviewer_purpose = false
                AND assignment.state = 'active'
                AND assignment.expires_at > now()
            )
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
             transaction.reviewer_credential_id, transaction.candidate_id, transaction.assignment_id,
             transaction.assignment_generation, transaction.staged_client_release_id
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
        AND (
          transaction.reviewer_credential_id IS NULL
          OR (credential.provider = 'anthropic' AND client.client_platform = 'claude')
          OR (credential.provider = 'openai' AND client.client_platform = 'openai')
        )
        AND (
          (transaction.candidate_id IS NULL AND client.enabled = true AND EXISTS (
          SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
          WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
             OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
             OR (client.admission_mode = 'cimd'
                 AND client.metadata_expires_at > now()
                 AND EXISTS (
                   SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                   WHERE admitted.host = client.cimd_host
                     AND admitted.platform = client.client_platform
                 ))
          )) OR (
            transaction.candidate_id IS NOT NULL
            AND credential.credential_kind = 'internal_canary'
            AND credential.id = transaction.reviewer_credential_id
            AND credential.id = session.reviewer_credential_id
            AND credential.candidate_id = transaction.candidate_id
            AND credential.assignment_id = transaction.assignment_id
            AND credential.assignment_generation = transaction.assignment_generation
            AND credential.staged_client_release_id = transaction.staged_client_release_id
            AND credential.oauth_client_id = client.id
            AND session.candidate_id = credential.candidate_id
            AND session.assignment_id = credential.assignment_id
            AND session.assignment_generation = credential.assignment_generation
            AND session.staged_client_release_id = credential.staged_client_release_id
            AND session.oauth_client_id = credential.oauth_client_id
            AND EXISTS (
              SELECT 1
              FROM exomem_agent_contract_rollout_assignments AS assignment
              JOIN exomem_staged_client_releases AS stage
                ON stage.id = credential.staged_client_release_id
               AND stage.candidate_id = credential.candidate_id
               AND stage.platform = client.client_platform
               AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
               AND (
                 (stage.state IN ('staged', 'evidenced') AND stage.expires_at > now())
                 OR EXISTS (
                   SELECT 1 FROM exomem_client_artifacts AS artifact
                   WHERE artifact.staged_client_release_id = stage.id AND artifact.contract_candidate_id = credential.candidate_id
                     AND artifact.state = 'live'
                 )
               )
              JOIN exomem_agent_contract_candidates AS candidate
                ON candidate.id = credential.candidate_id
               AND candidate.profile_id = 'hosted-alpha-agent-v1'
              WHERE assignment.id = credential.assignment_id
                AND assignment.tenant_id = credential.tenant_id
                AND assignment.candidate_id = credential.candidate_id
                AND assignment.generation = credential.assignment_generation
                AND assignment.marketplace_reviewer_purpose = true
                AND ((assignment.state = 'active' AND assignment.expires_at > now()) OR candidate.state = 'live')
            )
          )
        )
      FOR UPDATE OF transaction
    ),
    oauth_grant AS (
      INSERT INTO exomem_oauth_grants (
        user_id, tenant_id, client_id, resource, scopes, refresh_allowed,
        authorization_transaction_id, reviewer_credential_id, candidate_id, assignment_id,
        assignment_generation, staged_client_release_id
      )
      SELECT session.user_id, session.tenant_id, transaction.client_id, transaction.resource,
             array_remove(transaction.requested_scopes, 'offline_access'),
             'offline_access' = ANY(transaction.requested_scopes), transaction.id,
             transaction.reviewer_credential_id, transaction.candidate_id, transaction.assignment_id,
             transaction.assignment_generation, transaction.staged_client_release_id
      FROM session CROSS JOIN transaction
      WHERE session.reviewer_credential_id IS NOT DISTINCT FROM transaction.reviewer_credential_id
      ON CONFLICT (user_id, tenant_id, client_id, resource) WHERE revoked_at IS NULL
      DO UPDATE SET scopes = EXCLUDED.scopes,
                    refresh_allowed = EXCLUDED.refresh_allowed,
                    authorization_transaction_id = EXCLUDED.authorization_transaction_id,
                    candidate_id = EXCLUDED.candidate_id,
                    assignment_id = EXCLUDED.assignment_id,
                    assignment_generation = EXCLUDED.assignment_generation,
                    staged_client_release_id = EXCLUDED.staged_client_release_id,
                    updated_at = now()
      WHERE exomem_oauth_grants.reviewer_credential_id
            IS NOT DISTINCT FROM EXCLUDED.reviewer_credential_id
        AND exomem_oauth_grants.candidate_id IS NOT DISTINCT FROM EXCLUDED.candidate_id
        AND exomem_oauth_grants.assignment_id IS NOT DISTINCT FROM EXCLUDED.assignment_id
        AND exomem_oauth_grants.assignment_generation IS NOT DISTINCT FROM EXCLUDED.assignment_generation
        AND exomem_oauth_grants.staged_client_release_id IS NOT DISTINCT FROM EXCLUDED.staged_client_release_id
      RETURNING id, tenant_id, reviewer_credential_id
    ),
    code AS (
      INSERT INTO exomem_oauth_authorization_codes (
        code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at,
        candidate_id, assignment_id, assignment_generation, staged_client_release_id, reviewer_credential_id
      )
      SELECT ${input.codeDigest}, oauth_grant.id, transaction.client_id, transaction.redirect_uri,
             transaction.resource, transaction.pkce_challenge,
             'offline_access' = ANY(transaction.requested_scopes),
             LEAST(${input.codeExpiresAt.toISOString()}, credential.expires_at),
             transaction.candidate_id, transaction.assignment_id, transaction.assignment_generation,
             transaction.staged_client_release_id, transaction.reviewer_credential_id
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

class OAuthAdmissionRejected extends Error {}
export class OAuthAdmissionCapacityUnavailable extends Error {}
/**
 * No live Hosted contract cohort, so a v2 provision has no exact contract to
 * pin. Distinguished from `OAuthAdmissionRejected` because that one surfaces as
 * "the access link is invalid or unavailable", which would be false: the
 * invitation is valid and unconsumed, and it is admission that is shut.
 */
export class OAuthAdmissionCohortClosed extends Error {}

type OAuthInviteAdmission = {
  tenantId: string;
  sessionId: string;
  operationId: string | null;
  grantId: string;
};

/**
 * Lock order for the bootstrap branch is authority, invite, OAuth
 * transaction/client, candidate/stage, user/tenant, then capacity. Keeping the
 * construction in this transaction makes the initial operation immediately
 * claimable without a later assignment step.
 */
async function admitReviewerOAuthBootstrapInTransaction(
  tx: ExomemSql,
  input: {
    inviteDigest: Buffer;
    transactionDigest: Buffer;
    sessionDigest: Buffer;
    csrfDigest: Buffer;
    sessionExpiresAt: Date;
    codeDigest: Buffer;
    codeExpiresAt: Date;
  },
  authorityId: string,
  provisionerWireProtocol: ProvisionerWireProtocol
): Promise<OAuthInviteAdmission> {
  const inviteResult = await tx`
    SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits
    FROM exomem_invites
    WHERE token_digest = ${input.inviteDigest} AND consumed_at IS NULL AND revoked_at IS NULL
      AND expires_at > clock_timestamp() AND marketplace_reviewer_purpose = true
      AND delivery_state = 'sent' AND delivered_at IS NOT NULL
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
    SELECT transaction.id, transaction.client_id, transaction.redirect_uri, transaction.resource,
           transaction.requested_scopes, transaction.pkce_challenge, authority.candidate_id,
           authority.staged_client_release_id, authority.oauth_client_id,
           authority.oauth_client_authority_version, authority.oauth_client_config_sha256,
           authority.redirect_uri_digest, authority.expires_at
    FROM exomem_oauth_authorization_transactions AS transaction
    JOIN exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
      ON authority.id = transaction.reviewer_bootstrap_authority_id
     AND authority.id = ${authorityId}::uuid
     AND authority.state = 'active' AND authority.expires_at > clock_timestamp()
     AND authority.invite_id = ${invite.id}::uuid
    JOIN exomem_oauth_clients AS client
      ON client.id = transaction.client_id
     AND client.id = authority.oauth_client_id
     AND client.authority_version = authority.oauth_client_authority_version
     AND client.oauth_client_config_sha256 = authority.oauth_client_config_sha256
     AND client.redirect_uris_digest = authority.redirect_uri_digest
     AND client.enabled = true
    WHERE transaction.transaction_digest = ${input.transactionDigest}
      AND transaction.consumed_at IS NULL AND transaction.expires_at > clock_timestamp()
    FOR UPDATE OF transaction, client
  `;
  const authorization = authorizationResult.rows[0] as
    | {
        id: string;
        client_id: string;
        redirect_uri: string;
        resource: string;
        requested_scopes: string[];
        pkce_challenge: string;
        candidate_id: string;
        staged_client_release_id: string;
        oauth_client_id: string;
        expires_at: Date;
      }
    | undefined;
  if (!authorization) throw new OAuthAdmissionRejected();

  const targetResult = await tx`
    SELECT candidate.id, authority.candidate_source_release AS source_release,
           authority.candidate_protocol_version AS protocol_version,
           authority.candidate_gateway_contract_digest AS gateway_contract_digest,
           authority.candidate_command_fingerprint AS command_fingerprint,
           authority.candidate_schema_digest AS schema_digest,
           authority.candidate_compatibility_digest AS compatibility_digest,
           stage.id AS stage_id
    FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
    JOIN exomem_agent_contract_candidates AS candidate
      ON candidate.id = authority.candidate_id
     AND candidate.profile_id = 'hosted-alpha-agent-v1'
     AND candidate.state = 'pending'
     AND candidate.source_release = authority.candidate_source_release
     AND candidate.protocol_version = authority.candidate_protocol_version
     AND candidate.command_fingerprint = authority.candidate_command_fingerprint
     AND candidate.schema_digest = authority.candidate_schema_digest
     AND candidate.compatibility_digest = authority.candidate_compatibility_digest
    JOIN exomem_staged_client_releases AS stage
      ON stage.id = authority.staged_client_release_id
     AND stage.candidate_id = candidate.id
     AND stage.platform = authority.stage_platform
     AND stage.state = 'staged' AND stage.expires_at > clock_timestamp()
     AND stage.contract_sha256 = authority.candidate_schema_digest
     AND stage.compatibility_sha256 = authority.candidate_compatibility_digest
     AND stage.oauth_client_config_sha256 = authority.stage_config_sha256
     AND stage.oauth_client_config_sha256 = authority.oauth_client_config_sha256
    WHERE authority.id = ${authorityId}::uuid
      AND authority.candidate_id = ${authorization.candidate_id}::uuid
      AND authority.staged_client_release_id = ${authorization.staged_client_release_id}::uuid
      AND authority.oauth_client_id = ${authorization.oauth_client_id}::uuid
      AND authority.expires_at > clock_timestamp()
    FOR UPDATE OF candidate, stage
  `;
  const target = targetResult.rows[0] as
    | {
        id: string;
        source_release: string;
        protocol_version: string;
        gateway_contract_digest: string;
        command_fingerprint: string;
        schema_digest: string;
        compatibility_digest: string;
        stage_id: string;
      }
    | undefined;
  if (!target) throw new OAuthAdmissionRejected();

  const blocked = await tx`
    SELECT 1
    WHERE EXISTS (SELECT 1 FROM exomem_hosted_alpha_cohort)
       OR EXISTS (
         SELECT 1 FROM exomem_agent_contract_rollout_assignments AS assignment
         WHERE assignment.marketplace_reviewer_purpose = true
           AND assignment.state = 'active' AND assignment.expires_at > clock_timestamp()
       )
       OR EXISTS (
         SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
         WHERE credential.credential_kind = 'internal_canary'
           AND credential.revoked_at IS NULL AND credential.expires_at > clock_timestamp()
       )
       OR EXISTS (
         SELECT 1 FROM exomem_tenants AS tenant
         JOIN exomem_cells AS cell ON cell.id = tenant.bound_cell_id
         WHERE tenant.marketplace_reviewer_purpose = true AND tenant.deleted_at IS NULL
           AND (cell.routing_state = 'bound' OR cell.readiness_code = 'CELL_READY')
       )
  `;
  if (blocked.rows[0]) throw new OAuthAdmissionRejected();

  const ownerResult = await tx`
    INSERT INTO users (email, email_verified_at)
    VALUES (${invite.email_normalized}, now())
    ON CONFLICT (email) DO UPDATE
    SET email_verified_at = COALESCE(users.email_verified_at, now())
    WHERE users.deleted_at IS NULL
    RETURNING id
  `;
  const owner = ownerResult.rows[0] as { id: string } | undefined;
  if (!owner) throw new OAuthAdmissionRejected();
  const priorTenant = await tx`
    SELECT id FROM exomem_tenants WHERE owner_user_id = ${owner.id}::uuid FOR UPDATE
  `;
  if (priorTenant.rows[0]) throw new OAuthAdmissionRejected();

  const reservationResult = await tx`
    UPDATE exomem_capacity_pools AS pool
    SET reserved_storage_bytes = reserved_storage_bytes + ${EXOMEM_ALPHA_CAPACITY.storageBytes},
        reserved_runtime_slots = reserved_runtime_slots + ${EXOMEM_ALPHA_CAPACITY.runtimeSlots},
        reserved_provision_slots = reserved_provision_slots + ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots},
        updated_at = now()
    WHERE pool.pool_key = 'exomem-hosted-alpha' AND pool.configured_at IS NOT NULL
      AND pool.storage_capacity_bytes >= pool.reserved_storage_bytes + ${EXOMEM_ALPHA_CAPACITY.storageBytes}
      AND pool.runtime_capacity_slots >= pool.reserved_runtime_slots + ${EXOMEM_ALPHA_CAPACITY.runtimeSlots}
      AND pool.provision_reservation_capacity >= pool.reserved_provision_slots + ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots}
    RETURNING id
  `;
  const pool = reservationResult.rows[0] as { id: string } | undefined;
  if (!pool) throw new OAuthAdmissionCapacityUnavailable();
  const tenantResult = await tx`
    INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose)
    VALUES (${owner.id}::uuid, 'provisioning', 'running', true)
    RETURNING id, fence_generation
  `;
  const tenant = tenantResult.rows[0] as { id: string; fence_generation: number } | undefined;
  if (!tenant) throw new OAuthAdmissionRejected();
  const entitlementResult = await tx`
    INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state, capabilities, resource_limits)
    VALUES (${tenant.id}::uuid, ${invite.entitlement_source},
      ${invite.entitlement_source === "complimentary" ? "complimentary_active" : "awaiting_checkout"},
      ${invite.entitlement_source === "complimentary" ? "active" : "provisioning"},
      ${JSON.stringify(invite.entitlement_capabilities)}::jsonb, ${JSON.stringify(invite.entitlement_limits)}::jsonb)
    RETURNING tenant_id
  `;
  if (!entitlementResult.rows[0]) throw new OAuthAdmissionRejected();
  const assignmentResult = await tx`
    INSERT INTO exomem_agent_contract_rollout_assignments (
      tenant_id, candidate_id, generation, state, source_release, protocol_version,
      command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
      marketplace_reviewer_purpose, created_by_principal_digest, expires_at
    ) VALUES (${tenant.id}::uuid, ${target.id}::uuid, 1, 'preparing', ${target.source_release},
      ${target.protocol_version}, ${target.command_fingerprint}, ${target.schema_digest},
      ${target.compatibility_digest}, ${target.gateway_contract_digest}, true,
      encode((SELECT operator_principal_digest FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities WHERE id = ${authorityId}::uuid), 'hex'),
      LEAST((SELECT expires_at FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities WHERE id = ${authorityId}::uuid),
            (SELECT expires_at FROM exomem_staged_client_releases WHERE id = ${target.stage_id}::uuid)))
    RETURNING id, generation
  `;
  const assignment = assignmentResult.rows[0] as { id: string; generation: number } | undefined;
  if (!assignment) throw new OAuthAdmissionRejected();
  const operationResult = await tx`
    INSERT INTO exomem_lifecycle_operations (
      tenant_id, operation_type, idempotency_key, fence_generation, provisioner_wire_protocol,
      target_candidate_id, target_assignment_id, target_assignment_generation, target_source_release,
      target_protocol_version, target_gateway_contract_digest, target_command_fingerprint,
      target_schema_digest, target_compatibility_digest
    ) VALUES (${tenant.id}::uuid, 'provision', 'initial-provision', ${tenant.fence_generation},
      ${provisionerWireProtocol}, ${target.id}::uuid, ${assignment.id}::uuid, ${assignment.generation},
      ${target.source_release}, ${target.protocol_version}, ${target.gateway_contract_digest},
      ${target.command_fingerprint}, ${target.schema_digest}, ${target.compatibility_digest})
    RETURNING id
  `;
  const operation = operationResult.rows[0] as { id: string } | undefined;
  if (!operation) throw new OAuthAdmissionRejected();
  const allocationResult = await tx`
    INSERT INTO exomem_capacity_allocations (
      pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state, operation_id
    ) VALUES (${pool.id}::uuid, ${tenant.id}::uuid, ${EXOMEM_ALPHA_CAPACITY.storageBytes},
      ${EXOMEM_ALPHA_CAPACITY.runtimeSlots}, ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots}, 'reserved', ${operation.id}::uuid)
    RETURNING id
  `;
  if (!allocationResult.rows[0]) throw new OAuthAdmissionRejected();
  const sessionResult = await tx`
    INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
    VALUES (${owner.id}::uuid, ${tenant.id}::uuid, ${input.sessionDigest}, ${input.csrfDigest}, ${input.sessionExpiresAt.toISOString()})
    RETURNING id
  `;
  const session = sessionResult.rows[0] as { id: string } | undefined;
  if (!session) throw new OAuthAdmissionRejected();
  const grantResult = await tx`
    INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed, authorization_transaction_id)
    VALUES (${owner.id}::uuid, ${tenant.id}::uuid, ${authorization.client_id}::uuid, ${authorization.resource},
      ${authorization.requested_scopes.filter((scope) => scope !== "offline_access")}, false, ${authorization.id}::uuid)
    RETURNING id
  `;
  const grant = grantResult.rows[0] as { id: string } | undefined;
  if (!grant) throw new OAuthAdmissionRejected();
  const codeResult = await tx`
    INSERT INTO exomem_oauth_authorization_codes (
      code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at
    ) VALUES (${input.codeDigest}, ${grant.id}::uuid, ${authorization.client_id}::uuid,
      ${authorization.redirect_uri}, ${authorization.resource}, ${authorization.pkce_challenge}, false,
      LEAST(${input.codeExpiresAt.toISOString()}::timestamptz, ${authorization.expires_at.toISOString()}::timestamptz))
    RETURNING id
  `;
  if (!codeResult.rows[0]) throw new OAuthAdmissionRejected();
  const consumedInvite = await tx`
    UPDATE exomem_invites SET consumed_at = now(), consumed_by_user_id = ${owner.id}::uuid,
      redeemed_tenant_id = ${tenant.id}::uuid, redeemed_session_id = ${session.id}::uuid
    WHERE id = ${invite.id}::uuid AND consumed_at IS NULL RETURNING id
  `;
  const consumedTransaction = await tx`
    UPDATE exomem_oauth_authorization_transactions SET consumed_at = now(), redeemed_session_id = ${session.id}::uuid
    WHERE id = ${authorization.id}::uuid AND consumed_at IS NULL RETURNING id
  `;
  const consumedAuthority = await tx`
    WITH consumed AS (
      UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
      SET state = 'consumed', consumed_at = now(), outcome_tenant_id = ${tenant.id}::uuid,
          outcome_assignment_id = ${assignment.id}::uuid, outcome_assignment_generation = ${assignment.generation},
          outcome_operation_id = ${operation.id}::uuid, outcome_session_id = ${session.id}::uuid,
          outcome_grant_id = ${grant.id}::uuid
      WHERE id = ${authorityId}::uuid AND state = 'active' AND expires_at > clock_timestamp()
      RETURNING oauth_client_id, staged_client_release_id
    ), consumed_stage AS (
      UPDATE exomem_staged_client_releases AS stage
      SET state = 'failed', ended_at = now(), version = version + 1, updated_at = now()
      WHERE stage.id IN (SELECT staged_client_release_id FROM consumed)
        AND stage.state IN ('staged', 'evidenced')
      RETURNING stage.id
    ), disabled_client AS (
      UPDATE exomem_oauth_clients AS client
      SET enabled = false, authority_version = gen_random_uuid(), updated_at = now()
      WHERE client.id IN (SELECT oauth_client_id FROM consumed)
      RETURNING client.id
    )
    SELECT disabled_client.id
    FROM disabled_client CROSS JOIN consumed_stage
  `;
  if (!consumedInvite.rows[0] || !consumedTransaction.rows[0] || !consumedAuthority.rows[0]) {
    throw new OAuthAdmissionRejected();
  }
  return {
    tenantId: tenant.id,
    sessionId: session.id,
    operationId: operation.id,
    grantId: grant.id,
  };
}

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
  const provisionerWireProtocol = provisionerWireProtocolFromEnv();
  try {
    return await withExomemTransaction(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
      // PostgreSQL now() is fixed at transaction start, but this lock wait may
      // cross the authority's expiry. Retire against wall time before rechecks.
      const expiredBootstrapResult = await tx`
        WITH expired AS (
          UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
          SET state = 'expired', expired_at = clock_timestamp()
          FROM exomem_oauth_authorization_transactions AS transaction
          WHERE transaction.transaction_digest = ${input.transactionDigest}
            AND transaction.reviewer_bootstrap_authority_id = authority.id
            AND authority.state = 'active'
            AND authority.expires_at <= clock_timestamp()
          RETURNING authority.oauth_client_id
        )
        UPDATE exomem_oauth_clients AS client
        SET enabled = false, authority_version = gen_random_uuid(), updated_at = clock_timestamp()
        WHERE client.id IN (SELECT oauth_client_id FROM expired)
        RETURNING client.id
      `;
      if (expiredBootstrapResult.rows[0]) return null;
      const bootstrapResult = await tx`
        /* exomem:lock-reviewer-oauth-bootstrap-authority */
        SELECT authority.id
        FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
        JOIN exomem_oauth_authorization_transactions AS transaction
          ON transaction.reviewer_bootstrap_authority_id = authority.id
        WHERE transaction.transaction_digest = ${input.transactionDigest}
          AND authority.state = 'active' AND authority.expires_at > clock_timestamp()
        FOR UPDATE OF authority
      `;
      const bootstrap = bootstrapResult.rows[0] as { id?: string } | undefined;
      if (bootstrap?.id) {
        return admitReviewerOAuthBootstrapInTransaction(
          tx,
          input,
          bootstrap.id,
          provisionerWireProtocol
        );
      }
      const inviteResult = await tx`
        SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits,
               marketplace_reviewer_purpose
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
            marketplace_reviewer_purpose: boolean;
          }
        | undefined;
      if (!invite) throw new OAuthAdmissionRejected();

      const authorizationResult = await tx`
        SELECT transaction.id, transaction.client_id, transaction.redirect_uri,
               transaction.resource, transaction.requested_scopes, transaction.pkce_challenge
        FROM exomem_oauth_authorization_transactions AS transaction
        JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id
          AND client.enabled = true
          AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
          AND (client.admission_mode = 'pinned' OR (
            client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
            AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
            AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
          ))
        WHERE transaction.transaction_digest = ${input.transactionDigest}
          AND transaction.consumed_at IS NULL AND transaction.expires_at > now()
          AND EXISTS (
            SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
            WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
               OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
               OR (client.admission_mode = 'cimd'
                   AND client.metadata_expires_at > now()
                   AND EXISTS (
                     SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                     WHERE admitted.host = client.cimd_host
                       AND admitted.platform = client.client_platform
                   ))
          )
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

      await tx`
        SELECT tenant.id
        FROM exomem_tenants AS tenant
        WHERE tenant.owner_user_id = ${owner.id}::uuid
        FOR UPDATE
      `;
      const blockedResult = await tx`
        SELECT tenant.id
        FROM exomem_oauth_account_blocks AS block
        JOIN exomem_tenants AS tenant
          ON block.owner_user_id = ${owner.id}::uuid
         AND tenant.id = block.tenant_id
        WHERE tenant.owner_user_id = ${owner.id}::uuid
      `;
      if (blockedResult.rows[0]) throw new OAuthAdmissionRejected();

      const existingResult = await tx`
        SELECT tenant.id, tenant.owner_user_id
        FROM exomem_tenants AS tenant
        JOIN exomem_entitlements AS entitlement
          ON entitlement.tenant_id = tenant.id
         AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
        WHERE tenant.owner_user_id = ${owner.id}::uuid
          AND tenant.status <> 'deleted'
          AND tenant.deleted_at IS NULL
          AND tenant.marketplace_reviewer_purpose = ${invite.marketplace_reviewer_purpose}
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
        if (!pool) throw new OAuthAdmissionCapacityUnavailable();

        const tenantResult = await tx`
          INSERT INTO exomem_tenants (
            owner_user_id, status, desired_state, marketplace_reviewer_purpose
          ) VALUES (
            ${owner.id}::uuid, 'provisioning', 'running', ${invite.marketplace_reviewer_purpose}
          )
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
          WITH live_target AS MATERIALIZED (
            SELECT candidate.id AS candidate_id,
                   NULL::uuid AS assignment_id,
                   NULL::bigint AS assignment_generation,
                   candidate.source_release,
                   candidate.protocol_version,
                   MIN(catalog_cell.observed_gateway_contract_digest) AS gateway_contract_digest,
                   candidate.command_fingerprint,
                   candidate.schema_digest,
                   candidate.compatibility_digest
            FROM exomem_agent_contract_candidates AS candidate
            JOIN exomem_cells AS catalog_cell
              ON catalog_cell.routing_state = 'bound'
             AND catalog_cell.release_version = candidate.source_release
             AND catalog_cell.protocol_version = candidate.protocol_version
             AND catalog_cell.observed_gateway_contract_digest IS NOT NULL
             AND catalog_cell.observed_command_fingerprint = candidate.command_fingerprint
             AND catalog_cell.observed_schema_digest = candidate.schema_digest
            WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
              AND candidate.state = 'live'
            GROUP BY candidate.id, candidate.source_release, candidate.protocol_version,
                     candidate.command_fingerprint, candidate.schema_digest, candidate.compatibility_digest
            HAVING COUNT(DISTINCT catalog_cell.observed_gateway_contract_digest) = 1
          ),
          target AS MATERIALIZED (
            SELECT candidate_id, assignment_id, assignment_generation, source_release, protocol_version,
                   gateway_contract_digest, command_fingerprint, schema_digest, compatibility_digest
            FROM live_target
            WHERE ${provisionerWireProtocol} = ${PROVISIONER_PROTOCOL_V2}
            UNION ALL
            SELECT NULL::uuid, NULL::uuid, NULL::bigint, NULL::text, NULL::text, NULL::text,
                   NULL::text, NULL::text, NULL::text
            WHERE ${provisionerWireProtocol} <> ${PROVISIONER_PROTOCOL_V2}
          )
          INSERT INTO exomem_lifecycle_operations (
            tenant_id, operation_type, idempotency_key, fence_generation, provisioner_wire_protocol,
            target_candidate_id, target_assignment_id, target_assignment_generation,
            target_source_release, target_protocol_version, target_gateway_contract_digest,
            target_command_fingerprint, target_schema_digest, target_compatibility_digest
          ) SELECT
            ${tenant.id}::uuid, 'provision', 'initial-provision', ${tenant.fence_generation}::bigint,
            ${provisionerWireProtocol}, target.candidate_id, target.assignment_id,
            target.assignment_generation, target.source_release, target.protocol_version,
            target.gateway_contract_digest, target.command_fingerprint, target.schema_digest,
            target.compatibility_digest
          FROM target
          RETURNING id
        `;
        const operation = operationResult.rows[0] as { id: string } | undefined;
        if (!operation) {
          // Under v2 the only way `target` is empty is that no cohort is live.
          // Say that, rather than blaming the invitation.
          if (
            provisionerWireProtocol === PROVISIONER_PROTOCOL_V2 &&
            !(await hasLiveHostedCohortTarget(tx))
          ) {
            throw new OAuthAdmissionCohortClosed();
          }
          throw new OAuthAdmissionRejected();
        }
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
    if (error instanceof OAuthAdmissionCapacityUnavailable)
      throw exomemErrors.capacityUnavailable();
    if (error instanceof OAuthAdmissionCohortClosed) throw exomemErrors.admissionClosed();
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
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:find-active-oauth-access-token */
    SELECT token.family_id,
           token.grant_id,
           oauth_grant.user_id,
           oauth_grant.tenant_id,
           client.client_id,
           token.resource,
           token.scopes,
           token.candidate_id, token.assignment_id, token.assignment_generation,
           token.staged_client_release_id, token.client_id AS oauth_client_record_id,
           token.reviewer_credential_id
    FROM exomem_oauth_access_tokens AS token
    JOIN exomem_oauth_token_families AS family
      ON family.id = token.family_id
     AND family.revoked_at IS NULL
     AND family.expires_at > now()
    JOIN exomem_oauth_grants AS oauth_grant
      ON oauth_grant.id = token.grant_id
     AND oauth_grant.revoked_at IS NULL
    LEFT JOIN exomem_marketplace_reviewer_credentials AS reviewer_credential
      ON reviewer_credential.id = COALESCE(token.reviewer_credential_id, oauth_grant.reviewer_credential_id)
     AND reviewer_credential.revoked_at IS NULL
     AND reviewer_credential.expires_at > now()
    JOIN exomem_oauth_clients AS client
      ON client.id = token.client_id
     AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
     AND (client.admission_mode = 'pinned' OR (
       client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
       AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
       AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
     ))
    JOIN exomem_tenants AS tenant
      ON tenant.id = oauth_grant.tenant_id
     AND tenant.owner_user_id = oauth_grant.user_id
     AND tenant.status IN ('provisioning', 'active')
     AND tenant.desired_state = 'running'
    JOIN exomem_entitlements AS entitlement
      ON entitlement.tenant_id = tenant.id
     AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
    WHERE token.access_digest = ${accessDigest}
      AND token.revoked_at IS NULL
      AND token.expires_at > now()
      AND (
        (token.candidate_id IS NULL
          AND client.enabled = true
          AND (oauth_grant.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
            WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
               OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
               OR (client.admission_mode = 'cimd'
                   AND client.metadata_expires_at > now()
                   AND EXISTS (
                     SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                     WHERE admitted.host = client.cimd_host
                       AND admitted.platform = client.client_platform
                   ))
          )
        ) OR (
          token.candidate_id IS NOT NULL
          AND token.candidate_id = family.candidate_id AND token.candidate_id = oauth_grant.candidate_id
          AND token.assignment_id = family.assignment_id AND token.assignment_id = oauth_grant.assignment_id
          AND token.assignment_generation = family.assignment_generation AND token.assignment_generation = oauth_grant.assignment_generation
          AND token.staged_client_release_id = family.staged_client_release_id AND token.staged_client_release_id = oauth_grant.staged_client_release_id
          AND token.reviewer_credential_id = family.reviewer_credential_id AND token.reviewer_credential_id = oauth_grant.reviewer_credential_id
          AND reviewer_credential.id = token.reviewer_credential_id
          AND reviewer_credential.credential_kind = 'internal_canary'
          AND reviewer_credential.candidate_id = token.candidate_id
          AND reviewer_credential.assignment_id = token.assignment_id
          AND reviewer_credential.assignment_generation = token.assignment_generation
          AND reviewer_credential.staged_client_release_id = token.staged_client_release_id
          AND reviewer_credential.oauth_client_id = token.client_id
          AND EXISTS (
            SELECT 1
            FROM exomem_agent_contract_rollout_assignments AS assignment
            JOIN exomem_staged_client_releases AS stage
              ON stage.id = token.staged_client_release_id
             AND stage.candidate_id = token.candidate_id
             AND stage.platform = client.client_platform
             AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
            JOIN exomem_agent_contract_candidates AS candidate
              ON candidate.id = token.candidate_id AND candidate.profile_id = 'hosted-alpha-agent-v1'
            WHERE assignment.id = token.assignment_id
              AND assignment.tenant_id = oauth_grant.tenant_id
              AND assignment.candidate_id = token.candidate_id
              AND assignment.generation = token.assignment_generation
              AND assignment.marketplace_reviewer_purpose = true
              AND ((assignment.state = 'active' AND assignment.expires_at > now()
                    AND stage.state = 'evidenced' AND stage.expires_at > now())
                OR (candidate.state = 'live' AND EXISTS (
                  SELECT 1 FROM exomem_client_artifacts AS artifact
                  WHERE artifact.staged_client_release_id = stage.id
                    AND artifact.contract_candidate_id = token.candidate_id
                    AND artifact.state = 'live'
                    AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
                )))
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = oauth_grant.tenant_id AND block.owner_user_id = oauth_grant.user_id
      )
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
          candidate_id: string | null;
          assignment_id: string | null;
          assignment_generation: string | number | null;
          staged_client_release_id: string | null;
          oauth_client_record_id: string | null;
          reviewer_credential_id: string | null;
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
          ...(row.candidate_id
            ? {
                candidateId: row.candidate_id,
                assignmentId: row.assignment_id ?? undefined,
                assignmentGeneration:
                  row.assignment_generation === null
                    ? undefined
                    : BigInt(row.assignment_generation),
                stagedClientReleaseId: row.staged_client_release_id ?? undefined,
                oauthClientRecordId: row.oauth_client_record_id ?? undefined,
                reviewerCredentialId: row.reviewer_credential_id ?? undefined,
              }
            : {}),
        }
      : null;
  });
}

/** MCP may report a durable lifecycle state, but token issuance/refresh remains fail-closed above. */
export async function findMcpOAuthAccessToken(
  accessDigest: Buffer
): Promise<ActiveOAuthAccessToken | null> {
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:find-mcp-oauth-access-token */
    SELECT token.family_id, token.grant_id, oauth_grant.user_id, oauth_grant.tenant_id,
           client.client_id, token.resource, token.scopes,
           token.candidate_id, token.assignment_id, token.assignment_generation,
           token.staged_client_release_id, token.client_id AS oauth_client_record_id,
           token.reviewer_credential_id
    FROM exomem_oauth_access_tokens AS token
    JOIN exomem_oauth_token_families AS family
     ON family.id = token.family_id
     AND family.grant_id = token.grant_id
     AND family.client_id = token.client_id
     AND family.revoked_at IS NULL
     AND family.expires_at > now()
    JOIN exomem_oauth_grants AS oauth_grant
      ON oauth_grant.id = token.grant_id
     AND oauth_grant.client_id = token.client_id
     AND oauth_grant.resource = token.resource
     AND oauth_grant.revoked_at IS NULL
    LEFT JOIN exomem_marketplace_reviewer_credentials AS reviewer_credential
      ON reviewer_credential.id = COALESCE(token.reviewer_credential_id, oauth_grant.reviewer_credential_id)
     AND reviewer_credential.revoked_at IS NULL
     AND reviewer_credential.expires_at > now()
    JOIN exomem_oauth_clients AS client ON client.id = token.client_id
      AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
      AND (client.admission_mode = 'pinned' OR (
        client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
        AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
        AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
      ))
    JOIN exomem_tenants AS tenant
      ON tenant.id = oauth_grant.tenant_id
     AND tenant.owner_user_id = oauth_grant.user_id
     AND tenant.status <> 'deleted'
     AND tenant.deleted_at IS NULL
    JOIN exomem_entitlements AS entitlement
      ON entitlement.tenant_id = tenant.id
     AND entitlement.effective_state <> 'cancelled'
    WHERE token.access_digest = ${accessDigest}
      AND token.revoked_at IS NULL
      AND token.expires_at > now()
      AND token.scopes <@ oauth_grant.scopes
      AND (
        (token.candidate_id IS NULL
          AND client.enabled = true
          AND (oauth_grant.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
            WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
               OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
               OR (client.admission_mode = 'cimd'
                   AND client.metadata_expires_at > now()
                   AND EXISTS (
                     SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                     WHERE admitted.host = client.cimd_host
                       AND admitted.platform = client.client_platform
                   ))
          )
        ) OR (
          token.candidate_id IS NOT NULL
          AND token.candidate_id = family.candidate_id AND token.candidate_id = oauth_grant.candidate_id
          AND token.assignment_id = family.assignment_id AND token.assignment_id = oauth_grant.assignment_id
          AND token.assignment_generation = family.assignment_generation AND token.assignment_generation = oauth_grant.assignment_generation
          AND token.staged_client_release_id = family.staged_client_release_id AND token.staged_client_release_id = oauth_grant.staged_client_release_id
          AND token.reviewer_credential_id = family.reviewer_credential_id AND token.reviewer_credential_id = oauth_grant.reviewer_credential_id
          AND reviewer_credential.id = token.reviewer_credential_id
          AND reviewer_credential.credential_kind = 'internal_canary'
          AND reviewer_credential.candidate_id = token.candidate_id
          AND reviewer_credential.assignment_id = token.assignment_id
          AND reviewer_credential.assignment_generation = token.assignment_generation
          AND reviewer_credential.staged_client_release_id = token.staged_client_release_id
          AND reviewer_credential.oauth_client_id = token.client_id
          AND EXISTS (
            SELECT 1
            FROM exomem_agent_contract_rollout_assignments AS assignment
            JOIN exomem_staged_client_releases AS stage
              ON stage.id = token.staged_client_release_id
             AND stage.candidate_id = token.candidate_id
             AND stage.platform = client.client_platform
             AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
            JOIN exomem_agent_contract_candidates AS candidate
              ON candidate.id = token.candidate_id AND candidate.profile_id = 'hosted-alpha-agent-v1'
            WHERE assignment.id = token.assignment_id
              AND assignment.tenant_id = oauth_grant.tenant_id
              AND assignment.candidate_id = token.candidate_id
              AND assignment.generation = token.assignment_generation
              AND assignment.marketplace_reviewer_purpose = true
              AND ((assignment.state = 'active' AND assignment.expires_at > now()
                    AND stage.state = 'evidenced' AND stage.expires_at > now())
                OR (candidate.state = 'live' AND EXISTS (
                  SELECT 1 FROM exomem_client_artifacts AS artifact
                  WHERE artifact.staged_client_release_id = stage.id
                    AND artifact.contract_candidate_id = token.candidate_id
                    AND artifact.state = 'live'
                    AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
                )))
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = oauth_grant.tenant_id AND block.owner_user_id = oauth_grant.user_id
      )
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
          ...(typeof row.candidate_id === "string"
            ? {
                candidateId: row.candidate_id,
                assignmentId: typeof row.assignment_id === "string" ? row.assignment_id : undefined,
                assignmentGeneration:
                  typeof row.assignment_generation === "string" ||
                  typeof row.assignment_generation === "number"
                    ? BigInt(row.assignment_generation)
                    : undefined,
                stagedClientReleaseId:
                  typeof row.staged_client_release_id === "string"
                    ? row.staged_client_release_id
                    : undefined,
                oauthClientRecordId:
                  typeof row.oauth_client_record_id === "string"
                    ? row.oauth_client_record_id
                    : undefined,
                reviewerCredentialId:
                  typeof row.reviewer_credential_id === "string"
                    ? row.reviewer_credential_id
                    : undefined,
              }
            : {}),
        }
      : null;
  });
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
    FROM exomem_oauth_grants AS oauth_grant
    JOIN exomem_tenants AS tenant ON tenant.id = oauth_grant.tenant_id
    WHERE oauth_grant.id = family.grant_id
      AND oauth_grant.user_id = ${input.ownerUserId}::uuid
      AND oauth_grant.tenant_id = ${input.tenantId}::uuid
      AND tenant.owner_user_id = oauth_grant.user_id
    RETURNING family.id
  `;
  return rows.length;
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
        SET owner_user_id = EXCLUDED.owner_user_id
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
        AND code.candidate_id IS NOT DISTINCT FROM oauth_grant.candidate_id
        AND code.assignment_id IS NOT DISTINCT FROM oauth_grant.assignment_id
        AND code.assignment_generation IS NOT DISTINCT FROM oauth_grant.assignment_generation
        AND code.staged_client_release_id IS NOT DISTINCT FROM oauth_grant.staged_client_release_id
        AND code.reviewer_credential_id IS NOT DISTINCT FROM oauth_grant.reviewer_credential_id
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
        AND (
          (code.candidate_id IS NULL
            AND client.enabled = true
            AND (oauth_grant.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL)
            AND EXISTS (
              SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
              WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
                 OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
                 OR (client.admission_mode = 'cimd'
                     AND client.metadata_expires_at > now()
                     AND EXISTS (
                       SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                       WHERE admitted.host = client.cimd_host
                         AND admitted.platform = client.client_platform
                     ))
            )
          ) OR (
            code.candidate_id IS NOT NULL
            AND reviewer_credential.id IS NOT NULL
            AND reviewer_credential.credential_kind = 'internal_canary'
            AND reviewer_credential.candidate_id = code.candidate_id
            AND reviewer_credential.assignment_id = code.assignment_id
            AND reviewer_credential.assignment_generation = code.assignment_generation
            AND reviewer_credential.staged_client_release_id = code.staged_client_release_id
            AND reviewer_credential.oauth_client_id = client.id
            AND EXISTS (
              SELECT 1
              FROM exomem_agent_contract_rollout_assignments AS assignment
              JOIN exomem_staged_client_releases AS stage
                ON stage.id = code.staged_client_release_id
               AND stage.candidate_id = code.candidate_id
               AND stage.platform = client.client_platform
               AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
              JOIN exomem_agent_contract_candidates AS candidate
                ON candidate.id = code.candidate_id
               AND candidate.profile_id = 'hosted-alpha-agent-v1'
              WHERE assignment.id = code.assignment_id
                AND assignment.tenant_id = oauth_grant.tenant_id
                AND assignment.candidate_id = code.candidate_id
                AND assignment.generation = code.assignment_generation
                AND assignment.marketplace_reviewer_purpose = true
                AND (
                  (assignment.state = 'active' AND assignment.expires_at > now()
                    AND stage.state = 'evidenced' AND stage.expires_at > now())
                  OR (candidate.state = 'live' AND EXISTS (
                    SELECT 1 FROM exomem_client_artifacts AS artifact
                    WHERE artifact.staged_client_release_id = stage.id
                      AND artifact.contract_candidate_id = code.candidate_id
                      AND artifact.state = 'live'
                      AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
                  ))
                )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM exomem_oauth_account_blocks AS block
          WHERE block.tenant_id = tenant.id AND block.owner_user_id = oauth_grant.user_id
        )
      RETURNING code.grant_id, code.client_id, code.resource, code.refresh_allowed,
                code.candidate_id, code.assignment_id, code.assignment_generation,
                code.staged_client_release_id, code.reviewer_credential_id,
                reviewer_credential.expires_at AS reviewer_expires_at
    ),
    family AS (
      INSERT INTO exomem_oauth_token_families (
        grant_id, client_id, expires_at, candidate_id, assignment_id, assignment_generation,
        staged_client_release_id, reviewer_credential_id
      )
      SELECT grant_id, client_id, LEAST(now() + interval '30 days', reviewer_expires_at),
             candidate_id, assignment_id, assignment_generation, staged_client_release_id,
             reviewer_credential_id
      FROM consumed_code
      RETURNING id, grant_id, client_id, expires_at
    ),
    refresh AS (
      INSERT INTO exomem_oauth_refresh_tokens (
        refresh_digest, family_id, expires_at, candidate_id, assignment_id, assignment_generation,
        staged_client_release_id, oauth_client_id, reviewer_credential_id
      )
      SELECT ${input.refreshDigest}, id, LEAST(${input.refreshExpiresAt.toISOString()}, family.expires_at),
             consumed_code.candidate_id, consumed_code.assignment_id,
             consumed_code.assignment_generation, consumed_code.staged_client_release_id,
             CASE WHEN consumed_code.candidate_id IS NULL THEN NULL ELSE family.client_id END,
             consumed_code.reviewer_credential_id
      FROM family
      JOIN consumed_code ON consumed_code.grant_id = family.grant_id
      WHERE consumed_code.refresh_allowed
      RETURNING family_id
    ),
    access AS (
      INSERT INTO exomem_oauth_access_tokens (
        access_digest, grant_id, family_id, client_id, resource, scopes, expires_at,
        candidate_id, assignment_id, assignment_generation, staged_client_release_id,
        reviewer_credential_id
      )
      SELECT ${input.accessDigest}, consumed_code.grant_id, family.id, consumed_code.client_id,
             consumed_code.resource, oauth_grant.scopes,
             LEAST(${input.accessExpiresAt.toISOString()}, family.expires_at),
             consumed_code.candidate_id, consumed_code.assignment_id,
             consumed_code.assignment_generation, consumed_code.staged_client_release_id,
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
             token.candidate_id, token.assignment_id, token.assignment_generation,
             token.staged_client_release_id, token.oauth_client_id, token.reviewer_credential_id
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
      WHERE credential.candidate_id IS NULL
        OR (
          credential.candidate_id = family.candidate_id AND credential.candidate_id = oauth_grant.candidate_id
          AND credential.assignment_id = family.assignment_id AND credential.assignment_id = oauth_grant.assignment_id
          AND credential.assignment_generation = family.assignment_generation AND credential.assignment_generation = oauth_grant.assignment_generation
          AND credential.staged_client_release_id = family.staged_client_release_id AND credential.staged_client_release_id = oauth_grant.staged_client_release_id
          AND credential.reviewer_credential_id = family.reviewer_credential_id AND credential.reviewer_credential_id = oauth_grant.reviewer_credential_id
          AND credential.oauth_client_id = family.client_id
        )
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
      WHERE (
        (credential.candidate_id IS NULL
          AND client.enabled = true
          AND (oauth_grant.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
            WHERE (client.client_platform = 'claude' AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
               OR (client.client_platform = 'openai' AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
               OR (client.admission_mode = 'cimd'
                   AND client.metadata_expires_at > now()
                   AND EXISTS (
                     SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
                     WHERE admitted.host = client.cimd_host
                       AND admitted.platform = client.client_platform
                   ))
          )
        ) OR (
          credential.candidate_id IS NOT NULL
          AND reviewer_credential.id = credential.reviewer_credential_id
          AND reviewer_credential.credential_kind = 'internal_canary'
          AND reviewer_credential.candidate_id = credential.candidate_id
          AND reviewer_credential.assignment_id = credential.assignment_id
          AND reviewer_credential.assignment_generation = credential.assignment_generation
          AND reviewer_credential.staged_client_release_id = credential.staged_client_release_id
          AND reviewer_credential.oauth_client_id = credential.client_id
          AND EXISTS (
            SELECT 1
            FROM exomem_agent_contract_rollout_assignments AS assignment
            JOIN exomem_staged_client_releases AS stage
              ON stage.id = credential.staged_client_release_id
             AND stage.candidate_id = credential.candidate_id
             AND stage.platform = client.client_platform
             AND stage.oauth_client_config_sha256 = client.oauth_client_config_sha256
            JOIN exomem_agent_contract_candidates AS candidate
              ON candidate.id = credential.candidate_id AND candidate.profile_id = 'hosted-alpha-agent-v1'
            WHERE assignment.id = credential.assignment_id
              AND assignment.tenant_id = oauth_grant.tenant_id
              AND assignment.candidate_id = credential.candidate_id
              AND assignment.generation = credential.assignment_generation
              AND assignment.marketplace_reviewer_purpose = true
              AND ((assignment.state = 'active' AND assignment.expires_at > now()
                    AND stage.state = 'evidenced' AND stage.expires_at > now())
                OR (candidate.state = 'live' AND EXISTS (
                  SELECT 1 FROM exomem_client_artifacts AS artifact
                  WHERE artifact.staged_client_release_id = stage.id
                    AND artifact.contract_candidate_id = credential.candidate_id
                    AND artifact.state = 'live'
                    AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
                )))
          )
        )
      )
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
        AND (
          credential.consumed_at IS NOT NULL
          OR (credential.candidate_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM lineage_matches WHERE lineage_matches.id = credential.id
          ))
        )
        AND family.revoked_at IS NULL
      RETURNING family.id
    ),
    policy_revocation AS (
      UPDATE exomem_oauth_token_families AS family
      SET revoked_at = now(), revoked_reason = 'candidate_authority_invalid'
      FROM credential
      WHERE family.id = credential.family_id
        AND credential.candidate_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM current_policy WHERE current_policy.id = credential.id)
        AND family.revoked_at IS NULL
      RETURNING family.id
    ),
    policy_access_revoked AS (
      UPDATE exomem_oauth_access_tokens AS token
      SET revoked_at = COALESCE(token.revoked_at, now())
      WHERE token.family_id IN (SELECT id FROM policy_revocation)
        AND token.revoked_at IS NULL
      RETURNING token.id
    ),
    policy_refresh_consumed AS (
      UPDATE exomem_oauth_refresh_tokens AS token
      SET consumed_at = COALESCE(token.consumed_at, now())
      WHERE token.family_id IN (SELECT id FROM policy_revocation)
        AND token.consumed_at IS NULL
      RETURNING token.id
    ),
    replacement AS (
      INSERT INTO exomem_oauth_refresh_tokens (
        refresh_digest, family_id, parent_refresh_token_id, expires_at,
        candidate_id, assignment_id, assignment_generation, staged_client_release_id,
        oauth_client_id, reviewer_credential_id
      )
      SELECT ${input.replacementRefreshDigest}, consumed.family_id, credential.id,
             LEAST(family.expires_at, reviewer_credential.expires_at),
             credential.candidate_id, credential.assignment_id,
             credential.assignment_generation, credential.staged_client_release_id,
             CASE WHEN credential.candidate_id IS NULL THEN NULL ELSE credential.client_id END,
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
        candidate_id, assignment_id, assignment_generation, staged_client_release_id,
        reviewer_credential_id
      )
      SELECT ${input.accessDigest}, consumed.grant_id, consumed.family_id,
             consumed.client_id, oauth_grant.resource, oauth_grant.scopes,
             LEAST(${input.accessExpiresAt.toISOString()}, family.expires_at),
             credential.candidate_id, credential.assignment_id,
             credential.assignment_generation, credential.staged_client_release_id,
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
