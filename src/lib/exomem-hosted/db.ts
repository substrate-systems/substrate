import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { exomemErrors } from "./errors";
import type { ExomemPaddleEnvironment } from "./paddle-config";
import type { SecretEnvelope } from "./security";

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

export async function inspectValidInvite(
  tokenDigest: Buffer
): Promise<{ emailNormalized: string; expiresAt: string } | null> {
  const { rows } = await sql`
    /* exomem:inspect-invite */
    SELECT email_normalized, expires_at
    FROM exomem_invites
    WHERE token_digest = ${tokenDigest}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        emailNormalized: String(row.email_normalized),
        expiresAt: new Date(String(row.expires_at)).toISOString(),
      }
    : null;
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
        tenant_id, operation_type, idempotency_key, fence_generation
      )
      SELECT tenant.id, 'provision', 'initial-provision', tenant.fence_generation
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
  browserChallengeDigest: Buffer;
  expiresAt: Date;
  deliverySecretCiphertext: SecretEnvelope;
};

export async function createMagicAccessToken(
  input: CreateMagicAccessTokenInput
): Promise<{ tokenId: string; emailNormalized: string } | null> {
  const { rows } = await sql`
    /* exomem:create-magic-access-token */
    WITH owner AS (
      SELECT users.id AS user_id, tenant.id AS tenant_id
      FROM users
      JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
      WHERE users.email = ${input.emailNormalized}
        AND users.deleted_at IS NULL
        AND tenant.status IN ('provisioning', 'active', 'suspended')
        AND tenant.deleted_at IS NULL
    ), generation AS (
      UPDATE exomem_tenants AS tenant
      SET magic_link_generation = tenant.magic_link_generation + 1,
          updated_at = now()
      FROM owner
      WHERE tenant.id = owner.tenant_id
        AND tenant.owner_user_id = owner.user_id
      RETURNING tenant.owner_user_id AS user_id,
                tenant.id AS tenant_id,
                tenant.magic_link_generation
    ), prior_tokens AS (
      UPDATE exomem_access_tokens AS prior
      SET revoked_at = COALESCE(prior.revoked_at, now()),
          delivery_state = 'failed',
          delivery_error_code = 'SUPERSEDED_MAGIC_LINK'
      FROM generation
      WHERE prior.user_id = generation.user_id
        AND prior.tenant_id = generation.tenant_id
        AND prior.purpose = 'magic_link'
        AND prior.consumed_at IS NULL
        AND prior.revoked_at IS NULL
      RETURNING prior.id
    ), prior_outbox AS (
      UPDATE exomem_access_delivery_outbox AS outbox
      SET state = 'failed',
          secret_ciphertext = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = 'SUPERSEDED_MAGIC_LINK',
          updated_at = now()
      FROM prior_tokens
      WHERE outbox.token_id = prior_tokens.id
      RETURNING outbox.id
    ), token AS (
      INSERT INTO exomem_access_tokens (
        purpose, token_digest, browser_challenge_digest, magic_link_generation,
        user_id, tenant_id, expires_at
      )
      SELECT 'magic_link',
             ${input.tokenDigest},
             ${input.browserChallengeDigest},
             generation.magic_link_generation,
             generation.user_id,
             generation.tenant_id,
             ${input.expiresAt.toISOString()}
      FROM generation
      CROSS JOIN (SELECT count(*) FROM prior_outbox) AS invalidated
      ON CONFLICT (token_digest) DO NOTHING
      RETURNING id, user_id, tenant_id
    ), queued AS (
      INSERT INTO exomem_access_delivery_outbox (
        token_id, secret_ciphertext, expires_at, next_attempt_at
      )
      SELECT token.id,
             ${JSON.stringify(input.deliverySecretCiphertext)}::jsonb,
             ${input.expiresAt.toISOString()},
             now()
      FROM token
      RETURNING token_id
    )
    SELECT token.id, ${input.emailNormalized}::text AS email_normalized
    FROM token
    JOIN queued ON queued.token_id = token.id
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

export type ClaimedMagicLinkDelivery = {
  deliveryId: string;
  tokenId: string;
  emailNormalized: string;
  expiresAt: string;
  tokenDigest: Buffer;
  secretCiphertext: SecretEnvelope;
  attempts: number;
};

export async function expireInvalidMagicLinkDeliveries(limit = 100): Promise<number> {
  const { rows } = await sql`
    /* exomem:expire-invalid-magic-link-deliveries */
    WITH invalid AS (
      SELECT outbox.id, outbox.token_id
      FROM exomem_access_delivery_outbox AS outbox
      JOIN exomem_access_tokens AS token ON token.id = outbox.token_id
      WHERE outbox.state IN ('pending', 'leased')
        AND (
          outbox.expires_at <= now()
          OR token.expires_at <= now()
          OR token.consumed_at IS NOT NULL
          OR token.revoked_at IS NOT NULL
          OR NOT EXISTS (
            SELECT 1
            FROM users
            JOIN exomem_tenants AS tenant
              ON tenant.owner_user_id = users.id
             AND tenant.id = token.tenant_id
            WHERE users.id = token.user_id
              AND users.deleted_at IS NULL
              AND tenant.status IN ('provisioning', 'active', 'suspended')
              AND tenant.deleted_at IS NULL
              AND token.magic_link_generation = tenant.magic_link_generation
          )
        )
      ORDER BY outbox.created_at
      FOR UPDATE OF outbox SKIP LOCKED
      LIMIT ${limit}
    ), failed AS (
      UPDATE exomem_access_delivery_outbox AS outbox
      SET state = 'failed',
          secret_ciphertext = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = 'ACCESS_TOKEN_UNAVAILABLE',
          updated_at = now()
      FROM invalid
      WHERE outbox.id = invalid.id
      RETURNING outbox.token_id
    )
    UPDATE exomem_access_tokens AS token
    SET delivery_state = 'failed',
        delivery_error_code = 'ACCESS_TOKEN_UNAVAILABLE',
        revoked_at = CASE
          WHEN token.consumed_at IS NULL THEN COALESCE(token.revoked_at, now())
          ELSE token.revoked_at
        END
    FROM failed
    WHERE token.id = failed.token_id
    RETURNING token.id
  `;
  return rows.length;
}

export async function claimMagicLinkDelivery(input: {
  leaseOwner: string;
  leaseSeconds?: number;
}): Promise<ClaimedMagicLinkDelivery | null> {
  const leaseSeconds = input.leaseSeconds ?? 60;
  const { rows } = await sql`
    /* exomem:claim-magic-link-delivery */
    WITH candidate AS (
      SELECT outbox.id
      FROM exomem_access_delivery_outbox AS outbox
      JOIN exomem_access_tokens AS token ON token.id = outbox.token_id
      JOIN users ON users.id = token.user_id AND users.deleted_at IS NULL
      JOIN exomem_tenants AS tenant
        ON tenant.id = token.tenant_id
       AND tenant.owner_user_id = token.user_id
       AND tenant.status IN ('provisioning', 'active', 'suspended')
       AND tenant.deleted_at IS NULL
       AND token.magic_link_generation = tenant.magic_link_generation
      WHERE (
          (outbox.state = 'pending' AND outbox.next_attempt_at <= now())
          OR (outbox.state = 'leased' AND outbox.lease_expires_at <= now())
        )
        AND outbox.expires_at > now()
        AND outbox.secret_ciphertext IS NOT NULL
        AND token.purpose = 'magic_link'
        AND token.delivery_state = 'pending'
        AND token.consumed_at IS NULL
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
      ORDER BY outbox.next_attempt_at, outbox.created_at
      FOR UPDATE OF outbox SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE exomem_access_delivery_outbox AS outbox
      SET state = 'leased',
          attempts = outbox.attempts + 1,
          lease_owner = ${input.leaseOwner}::uuid,
          lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
          updated_at = now()
      FROM candidate
      WHERE outbox.id = candidate.id
      RETURNING outbox.id,
                outbox.token_id,
                outbox.secret_ciphertext,
                outbox.expires_at,
                outbox.attempts
    )
    SELECT claimed.id AS delivery_id,
           claimed.token_id,
           users.email::text AS email_normalized,
           claimed.expires_at,
           token.token_digest,
           claimed.secret_ciphertext,
           claimed.attempts
    FROM claimed
    JOIN exomem_access_tokens AS token ON token.id = claimed.token_id
    JOIN users ON users.id = token.user_id
  `;
  const row = rows[0] as
    | {
        delivery_id: string;
        token_id: string;
        email_normalized: string;
        expires_at: string | Date;
        token_digest: Buffer;
        secret_ciphertext: SecretEnvelope | string;
        attempts: number;
      }
    | undefined;
  if (!row) return null;
  return {
    deliveryId: row.delivery_id,
    tokenId: row.token_id,
    emailNormalized: row.email_normalized,
    expiresAt:
      row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    tokenDigest: Buffer.from(row.token_digest),
    secretCiphertext:
      typeof row.secret_ciphertext === "string"
        ? (JSON.parse(row.secret_ciphertext) as SecretEnvelope)
        : row.secret_ciphertext,
    attempts: Number(row.attempts),
  };
}

export async function markMagicLinkDeliverySent(input: {
  deliveryId: string;
  leaseOwner: string;
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:mark-magic-link-delivery-sent */
    WITH delivered AS (
      UPDATE exomem_access_delivery_outbox AS outbox
      SET state = 'sent',
          secret_ciphertext = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          sent_at = now(),
          updated_at = now()
      WHERE outbox.id = ${input.deliveryId}
        AND outbox.state = 'leased'
        AND outbox.lease_owner = ${input.leaseOwner}::uuid
        AND outbox.lease_expires_at > now()
      RETURNING outbox.token_id
    )
    UPDATE exomem_access_tokens AS token
    SET delivery_state = 'sent',
        delivered_at = now(),
        delivery_error_code = NULL
    FROM delivered
    WHERE token.id = delivered.token_id
    RETURNING token.id
  `;
  return rows.length === 1;
}

export async function releaseMagicLinkDelivery(input: {
  deliveryId: string;
  leaseOwner: string;
  errorCode: string;
  terminal: boolean;
}): Promise<"retry" | "failed" | "lost"> {
  const { rows } = await sql`
    /* exomem:release-magic-link-delivery */
    WITH released AS (
      UPDATE exomem_access_delivery_outbox AS outbox
      SET state = CASE
            WHEN ${input.terminal}
              OR outbox.attempts >= 5
              OR outbox.expires_at <= now() + interval '1 minute'
            THEN 'failed'
            ELSE 'pending'
          END,
          secret_ciphertext = CASE
            WHEN ${input.terminal}
              OR outbox.attempts >= 5
              OR outbox.expires_at <= now() + interval '1 minute'
            THEN NULL
            ELSE outbox.secret_ciphertext
          END,
          next_attempt_at = now() + (LEAST(outbox.attempts * 30, 120) * interval '1 second'),
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = ${input.errorCode},
          updated_at = now()
      WHERE outbox.id = ${input.deliveryId}
        AND outbox.state = 'leased'
        AND outbox.lease_owner = ${input.leaseOwner}::uuid
      RETURNING outbox.token_id, outbox.state
    ), token_updated AS (
      UPDATE exomem_access_tokens AS token
      SET delivery_state = CASE WHEN released.state = 'failed' THEN 'failed' ELSE 'pending' END,
          delivery_error_code = ${input.errorCode},
          revoked_at = CASE
            WHEN released.state = 'failed' AND token.consumed_at IS NULL
              THEN COALESCE(token.revoked_at, now())
            ELSE token.revoked_at
          END
      FROM released
      WHERE token.id = released.token_id
      RETURNING token.id, released.state
    )
    SELECT state FROM token_updated
  `;
  const state = (rows[0] as { state?: string } | undefined)?.state;
  if (state === "pending") return "retry";
  if (state === "failed") return "failed";
  return "lost";
}

export type RedeemMagicAccessTokenInput = {
  tokenDigest: Buffer;
  browserChallengeDigest: Buffer;
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
       AND tenant.status IN ('provisioning', 'active', 'suspended')
       AND tenant.deleted_at IS NULL
       AND token.magic_link_generation = tenant.magic_link_generation
      WHERE token.token_digest = ${input.tokenDigest}
        AND token.browser_challenge_digest = ${input.browserChallengeDigest}
        AND token.purpose = 'magic_link'
        AND token.delivery_state = 'sent'
        AND token.consumed_at IS NULL
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
      FOR UPDATE OF token, tenant
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

export async function createDeletionConfirmationToken(input: {
  userId: string;
  tenantId: string;
  tokenDigest: Buffer;
  expiresAt: Date;
}): Promise<{ tokenId: string; emailNormalized: string } | null> {
  const { rows } = await sql`
    /* exomem:create-deletion-confirmation */
    WITH owner AS (
      SELECT users.id AS user_id,
             users.email,
             tenant.id AS tenant_id
      FROM users
      JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
      WHERE users.id = ${input.userId}
        AND tenant.id = ${input.tenantId}
        AND users.deleted_at IS NULL
        AND tenant.status IN ('provisioning', 'active', 'suspended')
      FOR UPDATE OF tenant
    ),
    prior_revoked AS (
      UPDATE exomem_access_tokens AS token
      SET revoked_at = COALESCE(token.revoked_at, now())
      FROM owner
      WHERE token.user_id = owner.user_id
        AND token.tenant_id = owner.tenant_id
        AND token.purpose = 'deletion_confirmation'
        AND token.consumed_at IS NULL
        AND token.revoked_at IS NULL
      RETURNING token.id
    ),
    created AS (
      INSERT INTO exomem_access_tokens (
        purpose, token_digest, user_id, tenant_id, expires_at
      )
      SELECT 'deletion_confirmation',
             ${input.tokenDigest},
             owner.user_id,
             owner.tenant_id,
             ${input.expiresAt.toISOString()}
      FROM owner
      ON CONFLICT (token_digest) DO NOTHING
      RETURNING id, user_id
    )
    SELECT created.id, owner.email
    FROM created
    JOIN owner ON owner.user_id = created.user_id
  `;
  const row = rows[0];
  return row ? { tokenId: String(row.id), emailNormalized: String(row.email).toLowerCase() } : null;
}

export async function consumeDeletionConfirmationAtomic(input: {
  userId: string;
  tenantId: string;
  tokenDigest: Buffer;
}): Promise<{ operationId: string; requestId: string } | null> {
  const { rows } = await sql`
    /* exomem:consume-deletion-confirmation */
    WITH locked_token AS (
      SELECT token.id, token.user_id, token.tenant_id
      FROM exomem_access_tokens AS token
      JOIN exomem_tenants AS tenant
        ON tenant.id = token.tenant_id
       AND tenant.owner_user_id = token.user_id
      WHERE token.token_digest = ${input.tokenDigest}
        AND token.purpose = 'deletion_confirmation'
        AND token.user_id = ${input.userId}
        AND token.tenant_id = ${input.tenantId}
        AND token.consumed_at IS NULL
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
        AND tenant.status IN ('provisioning', 'active', 'suspended')
      FOR UPDATE OF token, tenant
    ),
    consumed AS (
      UPDATE exomem_access_tokens AS token
      SET consumed_at = now()
      FROM locked_token
      WHERE token.id = locked_token.id
      RETURNING locked_token.id, locked_token.user_id, locked_token.tenant_id
    ),
    tenant_gated AS (
      UPDATE exomem_tenants AS tenant
      SET status = 'deletion_pending',
          desired_state = 'deleted',
          fence_generation = tenant.fence_generation + 1,
          updated_at = now()
      FROM consumed
      WHERE tenant.id = consumed.tenant_id
        AND tenant.owner_user_id = consumed.user_id
      RETURNING tenant.id, tenant.bound_cell_id, tenant.fence_generation
    ),
    sessions_revoked AS (
      UPDATE exomem_sessions AS session
      SET revoked_at = COALESCE(session.revoked_at, now())
      FROM consumed
      WHERE session.tenant_id = consumed.tenant_id
        AND session.revoked_at IS NULL
      RETURNING session.id
    ),
    tokens_revoked AS (
      UPDATE exomem_access_tokens AS token
      SET revoked_at = COALESCE(token.revoked_at, now())
      FROM consumed
      WHERE token.tenant_id = consumed.tenant_id
        AND token.id <> consumed.id
        AND token.consumed_at IS NULL
        AND token.revoked_at IS NULL
      RETURNING token.id
    ),
    transfers_revoked AS (
      UPDATE exomem_transfer_grants AS grant_row
      SET revoked_at = COALESCE(grant_row.revoked_at, now()),
          outcome_code = COALESCE(grant_row.outcome_code, 'DELETION_REVOKED')
      FROM consumed
      WHERE grant_row.tenant_id = consumed.tenant_id
        AND grant_row.revoked_at IS NULL
      RETURNING grant_row.id
    ),
    entitlement_gated AS (
      UPDATE exomem_entitlements AS entitlement
      SET effective_state = 'deleted',
          capabilities = '[]'::jsonb,
          updated_at = now()
      FROM consumed
      WHERE entitlement.tenant_id = consumed.tenant_id
      RETURNING entitlement.id
    ),
    exports_gated AS (
      UPDATE exomem_exports AS export_row
      SET state = 'deleting'
      FROM consumed
      WHERE export_row.tenant_id = consumed.tenant_id
        AND export_row.state <> 'deleted'
      RETURNING export_row.id
    ),
    operations_cancelled AS (
      UPDATE exomem_lifecycle_operations AS pending
      SET state = 'failed_terminal',
          error_code = 'DELETION_SUPERSEDED',
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = now(),
          updated_at = now()
      FROM tenant_gated
      WHERE pending.tenant_id = tenant_gated.id
        AND pending.fence_generation < tenant_gated.fence_generation
        AND pending.state NOT IN ('succeeded', 'failed_terminal')
        AND NOT (
          pending.state = 'running'
          AND pending.lease_expires_at > now()
        )
      RETURNING pending.id
    ),
    operation AS (
      INSERT INTO exomem_lifecycle_operations (
        tenant_id, cell_id, operation_type, idempotency_key,
        resume_after_operation, fence_generation
      )
      SELECT tenant_gated.id,
             tenant_gated.bound_cell_id,
             'delete',
             'confirmed-deletion-' || consumed.id::text,
             false,
             tenant_gated.fence_generation
      FROM tenant_gated
      JOIN consumed ON consumed.tenant_id = tenant_gated.id
      ON CONFLICT (tenant_id, operation_type, idempotency_key) DO UPDATE
      SET updated_at = exomem_lifecycle_operations.updated_at
      RETURNING id, request_id
    )
    SELECT operation.id, operation.request_id
    FROM operation
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { operationId: String(row.id), requestId: String(row.request_id) } : null;
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
  credentialVersion: number;
  credentialCiphertext: Record<string, unknown> | null;
  endpointCiphertext: Record<string, unknown> | null;
};

export type GatewayTarget = ActiveCellBinding & {
  userId: string;
  tenantStatus: string;
  tenantDesiredState: string;
  cellLifecycleState: string;
  cellRoutingState: string;
  entitlementSource: EntitlementSource;
  entitlementSourceState: string;
  entitlementEffectiveState: string;
  capabilities: string[];
  resourceLimits: Record<string, number>;
  manuallySuspended: boolean;
};

/** Resolve all routing and authorization state from one authoritative snapshot. */
export async function resolveGatewayTarget(input: {
  userId: string;
  tenantId: string;
}): Promise<GatewayTarget | null> {
  const { rows } = await sql`
    /* exomem:resolve-gateway-target */
    SELECT tenant.owner_user_id,
           tenant.status AS tenant_status,
           tenant.desired_state AS tenant_desired_state,
           cell.id AS cell_id,
           cell.tenant_id,
           cell.lifecycle_state,
           cell.routing_state,
           cell.protocol_version,
           cell.release_version,
           cell.credential_version,
           cell.service_credential_ciphertext,
           cell.private_endpoint_ciphertext,
           entitlement.source AS entitlement_source,
           entitlement.source_state AS entitlement_source_state,
           entitlement.effective_state AS entitlement_effective_state,
           entitlement.capabilities,
           entitlement.resource_limits,
           entitlement.manual_suspended_at
    FROM exomem_tenants AS tenant
    JOIN exomem_cells AS cell
      ON cell.id = tenant.bound_cell_id
     AND cell.tenant_id = tenant.id
    JOIN exomem_entitlements AS entitlement
      ON entitlement.tenant_id = tenant.id
    WHERE tenant.id = ${input.tenantId}
      AND tenant.owner_user_id = ${input.userId}
    LIMIT 2
  `;
  if (rows.length > 1) throw exomemErrors.cellMappingAmbiguous();
  const row = rows[0];
  if (!row) return null;
  const capabilities = Array.isArray(row.capabilities)
    ? row.capabilities.filter((value): value is string => typeof value === "string")
    : [];
  const limits =
    row.resource_limits && typeof row.resource_limits === "object"
      ? (row.resource_limits as Record<string, unknown>)
      : {};
  const resourceLimits = Object.fromEntries(
    Object.entries(limits).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0
    )
  );
  return {
    userId: String(row.owner_user_id),
    tenantId: String(row.tenant_id),
    tenantStatus: String(row.tenant_status),
    tenantDesiredState: String(row.tenant_desired_state),
    cellId: String(row.cell_id),
    cellLifecycleState: String(row.lifecycle_state),
    cellRoutingState: String(row.routing_state),
    protocolVersion: String(row.protocol_version),
    releaseVersion: String(row.release_version),
    credentialVersion: Number(row.credential_version),
    credentialCiphertext:
      row.service_credential_ciphertext && typeof row.service_credential_ciphertext === "object"
        ? (row.service_credential_ciphertext as Record<string, unknown>)
        : null,
    endpointCiphertext:
      row.private_endpoint_ciphertext && typeof row.private_endpoint_ciphertext === "object"
        ? (row.private_endpoint_ciphertext as Record<string, unknown>)
        : null,
    entitlementSource: String(row.entitlement_source) as EntitlementSource,
    entitlementSourceState: String(row.entitlement_source_state),
    entitlementEffectiveState: String(row.entitlement_effective_state),
    capabilities,
    resourceLimits,
    manuallySuspended: row.manual_suspended_at != null,
  };
}

export async function resolveActiveCellBinding(
  tenantId: string
): Promise<ActiveCellBinding | null> {
  const { rows } = await sql`
    /* exomem:resolve-active-cell */
    SELECT cell.id,
           cell.tenant_id,
           cell.protocol_version,
           cell.release_version,
           cell.credential_version,
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
        credential_version?: number;
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
        credentialVersion: Number(row.credential_version ?? 0),
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
        AND desired_state <> 'deleted'
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

/**
 * Bind a server-created Paddle transaction to the authoritative Exomem owner
 * before its checkout URL is returned. Webhook custom_data is then only a
 * lookup hint; a paid event cannot select a tenant by metadata alone.
 */
export async function recordExomemCheckoutTransaction(input: {
  userId: string;
  tenantId: string;
  transactionId: string;
  environment: ExomemPaddleEnvironment;
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:record-checkout-transaction */
    WITH active_tenant AS (
      SELECT tenant.id
      FROM exomem_tenants AS tenant
      WHERE tenant.id = ${input.tenantId}
        AND tenant.owner_user_id = ${input.userId}
        AND tenant.status IN ('provisioning', 'active', 'suspended')
        AND tenant.desired_state <> 'deleted'
      FOR UPDATE OF tenant
    )
    UPDATE exomem_entitlements AS entitlement
    SET provider_environment = ${input.environment},
        provider_transaction_ref = ${input.transactionId},
        provider_provenance_unresolved_fingerprint = NULL,
        source_state = 'checkout_pending',
        updated_at = now()
    FROM active_tenant
    WHERE entitlement.tenant_id = active_tenant.id
      AND entitlement.source = 'paddle'
      AND entitlement.source_state IN ('awaiting_checkout', 'checkout_pending')
      AND entitlement.effective_state <> 'deleted'
      AND entitlement.provider_customer_ref IS NULL
      AND entitlement.provider_subscription_ref IS NULL
      AND (
        entitlement.provider_environment IS NULL
        OR entitlement.provider_environment = ${input.environment}
      )
      AND (
        entitlement.provider_transaction_ref IS NULL
        OR entitlement.provider_transaction_ref = ${input.transactionId}
      )
    RETURNING entitlement.id
  `;
  return rows.length === 1;
}

export async function clearExomemCheckoutTransaction(input: {
  userId: string;
  tenantId: string;
  transactionId: string;
  environment: ExomemPaddleEnvironment;
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:clear-terminal-checkout-transaction */
    WITH active_tenant AS (
      SELECT tenant.id
      FROM exomem_tenants AS tenant
      WHERE tenant.id = ${input.tenantId}
        AND tenant.owner_user_id = ${input.userId}
        AND tenant.status IN ('provisioning', 'active', 'suspended')
        AND tenant.desired_state <> 'deleted'
      FOR UPDATE OF tenant
    )
    UPDATE exomem_entitlements AS entitlement
    SET provider_transaction_ref = NULL,
        provider_provenance_unresolved_fingerprint = NULL,
        source_state = 'awaiting_checkout',
        provider_environment = CASE
          WHEN entitlement.provider_customer_ref IS NULL
            AND entitlement.provider_subscription_ref IS NULL THEN NULL
          ELSE entitlement.provider_environment
        END,
        updated_at = now()
    FROM active_tenant
    WHERE entitlement.tenant_id = active_tenant.id
      AND entitlement.source = 'paddle'
      AND entitlement.provider_environment = ${input.environment}
      AND entitlement.provider_transaction_ref = ${input.transactionId}
      AND entitlement.provider_customer_ref IS NULL
      AND entitlement.provider_subscription_ref IS NULL
    RETURNING entitlement.id
  `;
  return rows.length === 1;
}

export async function promoteExomemCheckoutSubscription(input: {
  userId: string;
  tenantId: string;
  transactionId: string;
  subscriptionId: string;
  customerId: string | null;
  environment: ExomemPaddleEnvironment;
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:promote-checkout-subscription */
    WITH active_tenant AS (
      SELECT tenant.id
      FROM exomem_tenants AS tenant
      WHERE tenant.id = ${input.tenantId}
        AND tenant.owner_user_id = ${input.userId}
        AND tenant.status IN ('provisioning', 'active', 'suspended')
        AND tenant.desired_state <> 'deleted'
      FOR UPDATE OF tenant
    )
    UPDATE exomem_entitlements AS entitlement
    SET provider_customer_ref = COALESCE(
          ${input.customerId},
          entitlement.provider_customer_ref
        ),
        provider_subscription_ref = ${input.subscriptionId},
        provider_provenance_unresolved_fingerprint = NULL,
        provider_reconcile_after = now(),
        updated_at = now()
    FROM active_tenant
    WHERE entitlement.tenant_id = active_tenant.id
      AND entitlement.source = 'paddle'
      AND entitlement.source_state <> 'cancelled'
      AND entitlement.provider_environment = ${input.environment}
      AND entitlement.provider_transaction_ref = ${input.transactionId}
      AND (
        entitlement.provider_subscription_ref IS NULL
        OR entitlement.provider_subscription_ref = ${input.subscriptionId}
      )
    RETURNING entitlement.id
  `;
  return rows.length === 1;
}

export async function createTransferGrantRecord(input: {
  grantDigest: Buffer;
  tenantId: string;
  cellId: string;
  userId: string;
  principalScopeDigest: Buffer;
  operation: "upload" | "download";
  issuedAt: Date;
  expiresAt: Date;
  byteLimit: number;
}): Promise<{ grantId: string } | null> {
  const { rows } = await sql`
    /* exomem:create-transfer-grant */
    WITH expired_ids AS MATERIALIZED (
      SELECT grant_row.id
      FROM exomem_transfer_grants AS grant_row
      WHERE grant_row.tenant_id = ${input.tenantId}
        AND grant_row.expires_at <= now()
      ORDER BY grant_row.expires_at
      LIMIT 1000
    ),
    expired AS MATERIALIZED (
      DELETE FROM exomem_transfer_grants AS grant_row
      USING expired_ids
      WHERE grant_row.id = expired_ids.id
      RETURNING grant_row.id
    )
    INSERT INTO exomem_transfer_grants (
      grant_digest, tenant_id, cell_id, user_id,
      principal_scope_digest, operation, audience,
      issued_at, expires_at, byte_limit
    )
    SELECT ${input.grantDigest},
           tenant.id,
           cell.id,
           ${input.userId},
           ${input.principalScopeDigest},
           ${input.operation},
           'exomem-hosted-transfer',
           ${input.issuedAt.toISOString()},
           ${input.expiresAt.toISOString()},
           ${input.byteLimit}
    FROM exomem_tenants AS tenant
    CROSS JOIN (SELECT count(*) AS pruned FROM expired) AS expiry_cleanup
    JOIN exomem_cells AS cell
      ON cell.id = tenant.bound_cell_id
     AND cell.tenant_id = tenant.id
    WHERE tenant.id = ${input.tenantId}
      AND tenant.owner_user_id = ${input.userId}
      AND cell.id = ${input.cellId}
      AND tenant.status = 'active'
      AND cell.lifecycle_state = 'active'
      AND cell.routing_state = 'bound'
    ON CONFLICT (grant_digest) DO NOTHING
    RETURNING id
  `;
  const row = rows[0];
  return row ? { grantId: String(row.id) } : null;
}

export async function consumeTransferGrantRecord(input: {
  grantId: string;
  tenantId: string;
  cellId: string;
  operation: "upload" | "download";
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:consume-transfer-grant */
    UPDATE exomem_transfer_grants
    SET consumed_at = now()
    WHERE id = ${input.grantId}
      AND tenant_id = ${input.tenantId}
      AND cell_id = ${input.cellId}
      AND operation = ${input.operation}
      AND audience = 'exomem-hosted-transfer'
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    RETURNING id
  `;
  return rows.length === 1;
}

export async function finishTransferGrantRecord(input: {
  grantId: string;
  outcomeCode: string;
}): Promise<void> {
  await sql`
    /* exomem:finish-transfer-grant */
    UPDATE exomem_transfer_grants
    SET outcome_code = ${input.outcomeCode}
    WHERE id = ${input.grantId}
      AND consumed_at IS NOT NULL
      AND outcome_code IS NULL
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
    INSERT INTO exomem_rate_limit_buckets (
      scope, key_digest, window_started_at, admitted_count, updated_at
    )
    VALUES (${input.scope}, ${input.keyDigest}, now(), 1, now())
    ON CONFLICT (scope, key_digest) DO UPDATE
    SET window_started_at = CASE
          WHEN exomem_rate_limit_buckets.window_started_at
                 <= now() - (${input.windowSeconds} * interval '1 second')
            THEN now()
          ELSE exomem_rate_limit_buckets.window_started_at
        END,
        admitted_count = CASE
          WHEN exomem_rate_limit_buckets.window_started_at
                 <= now() - (${input.windowSeconds} * interval '1 second')
            THEN 1
          ELSE exomem_rate_limit_buckets.admitted_count + 1
        END,
        updated_at = now()
    WHERE exomem_rate_limit_buckets.window_started_at
            <= now() - (${input.windowSeconds} * interval '1 second')
       OR exomem_rate_limit_buckets.admitted_count < ${input.limit}
    RETURNING true AS allowed
  `;
  return Boolean((rows[0] as { allowed?: boolean } | undefined)?.allowed);
}

export async function pruneStaleRateLimitBuckets(
  retentionSeconds: number,
  limit = 1_000
): Promise<number> {
  const boundedRetention = Math.max(1, Math.floor(retentionSeconds));
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 10_000));
  const { rows } = await sql`
    /* exomem:prune-stale-rate-limit-buckets */
    WITH stale AS (
      SELECT scope, key_digest
      FROM exomem_rate_limit_buckets
      WHERE updated_at <= now() - (${boundedRetention} * interval '1 second')
      ORDER BY updated_at
      LIMIT ${boundedLimit}
    )
    DELETE FROM exomem_rate_limit_buckets AS bucket
    USING stale
    WHERE bucket.scope = stale.scope
      AND bucket.key_digest = stale.key_digest
    RETURNING bucket.key_digest
  `;
  return rows.length;
}
