import { executeExomemSql } from "./db";

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
           token.client_id,
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
           family.client_id, consumed_code.resource
    FROM consumed_code
    JOIN family ON family.grant_id = consumed_code.grant_id
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
}): Promise<OAuthTokenContext | null> {
  const { rows } = await executeExomemSql`
    /* exomem:oauth-refresh-rotate */
    WITH known_token AS (
      SELECT token.id, token.family_id, family.grant_id, family.client_id
      FROM exomem_oauth_refresh_tokens AS token
      JOIN exomem_oauth_token_families AS family ON family.id = token.family_id
      WHERE token.refresh_digest = ${input.refreshDigest}
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
    SELECT consumed.grant_id, consumed.family_id, consumed.client_id, grant.resource
    FROM consumed
    JOIN replacement ON replacement.family_id = consumed.family_id
    JOIN access ON true
    JOIN exomem_oauth_grants AS grant ON grant.id = consumed.grant_id
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
