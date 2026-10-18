import type { ExomemThemeChoice } from "@/lib/exomem/theme";
import { Pool, type PoolClient } from "pg";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { sql as pgSql } from "../db/pg-sql";
import { cloudAdmissionAllows, lockCloudCapacity } from "./cloud-capacity";
import { exomemErrors } from "./errors";
import type { ExomemPaddleEnvironment } from "./paddle-config";
import type { SecretEnvelope } from "./security";
import { marketplaceReviewerAccessEnabled } from "./reviewer-access";
import type { ExomemInviteKind } from "./invitation-contract";

export type ExomemSqlResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
};

export type ExomemSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<ExomemSqlResult>;

let injectedSqlClient: ExomemSql | null = null;
let transactionPool: Pool | null = null;

export type ExomemTransactionRunner = <T>(callback: (tx: ExomemSql) => Promise<T>) => Promise<T>;

let transactionRunner: ExomemTransactionRunner | null = null;

function taggedPgSql(client: PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

export type ExomemTransaction = {
  query: (text: string, values?: unknown[]) => Promise<ExomemSqlResult>;
};

let transactionClient:
  | ((work: (transaction: ExomemTransaction) => Promise<void>) => Promise<void>)
  | null = null;

function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<ExomemSqlResult> {
  if (injectedSqlClient) return injectedSqlClient(strings, ...values);
  return pgSql(strings, ...values);
}

export function __setExomemSqlForTests(next: ExomemSql | null): void {
  injectedSqlClient = next;
}

/** Test seam for one-connection interactive transactions. */
export function __setExomemTransactionForTests(next: ExomemTransactionRunner | null): void;
export function __setExomemTransactionForTests(
  next: ((work: (transaction: ExomemTransaction) => Promise<void>) => Promise<void>) | null
): void;
export function __setExomemTransactionForTests(
  next:
    | ExomemTransactionRunner
    | ((work: (transaction: ExomemTransaction) => Promise<void>) => Promise<void>)
    | null
): void {
  transactionRunner = next as ExomemTransactionRunner | null;
  transactionClient = next as typeof transactionClient;
}

/** Run sequential authority writes over one PostgreSQL connection. */
export async function executeExomemTransaction(
  work: (transaction: ExomemTransaction) => Promise<void>
): Promise<void> {
  if (transactionClient) return transactionClient(work);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await work({
      query: async (text, values = []) => {
        const result = await client!.query(text, values);
        return {
          rows: result.rows as Array<Record<string, unknown>>,
          rowCount: result.rowCount ?? 0,
        };
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

/** Shared product-scoped SQL executor for narrowly typed store modules. */
export function executeExomemSql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<ExomemSqlResult> {
  return sql(strings, ...values);
}

/**
 * Execute dependent reads and writes on one PostgreSQL connection. The normal
 * read/write path is the shared `pg`-backed adapter's pooled one-off queries;
 * only flows that need row-lock ordering use this interactive transaction
 * boundary.
 */
export async function withExomemTransaction<T>(
  callback: (tx: ExomemSql) => Promise<T>
): Promise<T> {
  if (transactionRunner) return transactionRunner(callback);
  if (injectedSqlClient) {
    throw new Error("interactive Exomem transaction runner is not configured");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  transactionPool ??= new Pool({ connectionString: databaseUrl });
  const client = await transactionPool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await callback(taggedPgSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type EntitlementSource = "complimentary" | "paddle";

export type CreateInviteRecordInput = {
  tokenDigest: Buffer;
  emailNormalized: string;
  entitlementSource: EntitlementSource;
  capabilities: string[];
  resourceLimits: Record<string, number>;
  marketplaceReviewerPurpose?: boolean;
  operatorPrincipalDigest: Buffer;
  expiresAt: Date;
  /** Defaults from the entitlement source (migration 0065). */
  kind?: ExomemInviteKind;
  inviterName?: string | null;
  inviterEmail?: string | null;
  inviteeName?: string | null;
  note?: string | null;
  /** Runs in the creating transaction, so the invitation's emails are enqueued with it. */
  afterCreate?: (tx: ExomemSql, invite: { inviteId: string; createdAt: Date }) => Promise<void>;
};

export async function createInviteRecord(
  input: CreateInviteRecordInput
): Promise<{ inviteId: string }> {
  const create = async (tx: ExomemSql): Promise<{ inviteId: string }> => {
    const { rows } = await tx`
    /* exomem:create-invite */
    INSERT INTO exomem_invites (
      token_digest,
      email_normalized,
      entitlement_source,
      entitlement_capabilities,
      entitlement_limits,
      marketplace_reviewer_purpose,
      created_by_principal_digest,
      expires_at,
      kind,
      inviter_name,
      inviter_email,
      invitee_name,
      note
    ) SELECT
      ${input.tokenDigest},
      ${input.emailNormalized},
      ${input.entitlementSource},
      ${JSON.stringify(input.capabilities)}::jsonb,
      ${JSON.stringify(input.resourceLimits)}::jsonb,
      ${input.marketplaceReviewerPurpose === true},
      ${input.operatorPrincipalDigest},
      ${input.expiresAt.toISOString()},
      ${input.kind ?? null},
      ${input.inviterName ?? null},
      ${input.inviterEmail ?? null},
      ${input.inviteeName ?? null},
      ${input.note ?? null}
    WHERE NOT (
      ${input.marketplaceReviewerPurpose === true}
      AND EXISTS (
        SELECT 1
        FROM exomem_tenants AS tenant
        JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id
        LEFT JOIN exomem_oauth_account_blocks AS block
          ON block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
        WHERE owner.email = ${input.emailNormalized}
          AND tenant.marketplace_reviewer_purpose = true
          AND (tenant.status = 'deletion_pending'
               OR tenant.desired_state = 'deleted'
               OR tenant.deleted_at IS NOT NULL
               OR block.tenant_id IS NOT NULL)
      )
    )
    RETURNING id, created_at
  `;
    const row = rows[0] as { id: string; created_at: Date | string } | undefined;
    if (!row) throw new Error("createInviteRecord returned no row");
    await input.afterCreate?.(tx, { inviteId: row.id, createdAt: new Date(row.created_at) });
    return { inviteId: row.id };
  };
  return withExomemTransaction(async (tx) => {
    if (input.marketplaceReviewerPurpose) {
      await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    }
    // Every invitation, paid, complimentary or reviewer, promises a Cloud
    // slot and counts against the same headroom until it is used, revoked or
    // expired, so an operator cannot promise more places than Cloud has. An
    // address that already holds a live cell needs no new slot.
    await lockCloudCapacity(tx);
    if (!(await cloudAdmissionAllows(tx, { email: input.emailNormalized }))) {
      throw exomemErrors.capacityUnavailable();
    }
    return create(tx);
  });
}

export type RedeemedAccess = {
  userId: string;
  tenantId: string;
  sessionId: string;
};

export type CreateMagicAccessTokenInput = {
  emailNormalized: string;
  tokenDigest: Buffer;
  browserChallengeDigest: Buffer;
  expiresAt: Date;
  deliverySecretCiphertext: SecretEnvelope;
};

export async function createMagicAccessToken(
  input: CreateMagicAccessTokenInput
): Promise<{ tokenId: string; deliveryId: string; emailNormalized: string } | null> {
  const { rows } = await sql`
    /* exomem:create-magic-access-token */
    WITH owner AS (
      SELECT exomem_users.id AS user_id, tenant.id AS tenant_id
      FROM exomem_users
      JOIN exomem_tenants AS tenant ON tenant.owner_user_id = exomem_users.id
      WHERE exomem_users.email = ${input.emailNormalized}
        AND exomem_users.deleted_at IS NULL
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
      RETURNING id, token_id
    )
    SELECT token.id, queued.id AS delivery_id, ${input.emailNormalized}::text AS email_normalized
    FROM token
    JOIN queued ON queued.token_id = token.id
  `;
  const row = rows[0] as { id: string; delivery_id: string; email_normalized: string } | undefined;
  return row
    ? { tokenId: row.id, deliveryId: row.delivery_id, emailNormalized: row.email_normalized }
    : null;
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
  /** The owner's time zone, as their browser last reported it. */
  recipientTimeZone: string | null;
  /** The owner's email scheme, as their browser last reported it. */
  recipientEmailScheme: ExomemEmailScheme | null;
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
            FROM exomem_users
            JOIN exomem_tenants AS tenant
              ON tenant.owner_user_id = exomem_users.id
             AND tenant.id = token.tenant_id
            WHERE exomem_users.id = token.user_id
              AND exomem_users.deleted_at IS NULL
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
  deliveryId?: string;
}): Promise<ClaimedMagicLinkDelivery | null> {
  const leaseSeconds = input.leaseSeconds ?? 60;
  const { rows } = await sql`
    /* exomem:claim-magic-link-delivery */
    WITH candidate AS (
      SELECT outbox.id
      FROM exomem_access_delivery_outbox AS outbox
      JOIN exomem_access_tokens AS token ON token.id = outbox.token_id
      JOIN exomem_users ON exomem_users.id = token.user_id AND exomem_users.deleted_at IS NULL
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
        AND (${input.deliveryId ?? null}::uuid IS NULL OR outbox.id = ${input.deliveryId ?? null}::uuid)
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
           exomem_users.email::text AS email_normalized,
           tenant.time_zone,
           tenant.email_scheme,
           claimed.expires_at,
           token.token_digest,
           claimed.secret_ciphertext,
           claimed.attempts
    FROM claimed
    JOIN exomem_access_tokens AS token ON token.id = claimed.token_id
    JOIN exomem_users ON exomem_users.id = token.user_id
    JOIN exomem_tenants AS tenant ON tenant.id = token.tenant_id
  `;
  const row = rows[0] as
    | {
        delivery_id: string;
        token_id: string;
        email_normalized: string;
        time_zone: string | null;
        email_scheme: ExomemEmailScheme | null;
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
    recipientTimeZone: row.time_zone ?? null,
    recipientEmailScheme: row.email_scheme ?? null,
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

export type RedeemedMagicAccess = RedeemedAccess & { browserChallengeMatched: boolean };

export type RedeemMagicAccessTokenInput = {
  tokenDigest: Buffer;
  browserChallengeDigest: Buffer | null;
  expectedEmailNormalized?: string | null;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
  /** The signing-in browser's time zone, already normalized. */
  timeZone?: string | null;
  /** The signing-in page's email scheme, already normalized. */
  emailScheme?: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
};

export async function redeemMagicAccessTokenAtomic(
  input: RedeemMagicAccessTokenInput
): Promise<RedeemedMagicAccess | null> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await tx`
    /* exomem:redeem-magic-access-token */
    WITH locked_token AS (
      SELECT token.id, token.user_id, token.tenant_id,
             COALESCE(token.browser_challenge_digest = ${input.browserChallengeDigest}, false) AS browser_challenge_matched
      FROM exomem_access_tokens AS token
      JOIN exomem_users ON exomem_users.id = token.user_id AND exomem_users.deleted_at IS NULL
      JOIN exomem_tenants AS tenant
        ON tenant.id = token.tenant_id
       AND tenant.owner_user_id = token.user_id
       AND tenant.status IN ('provisioning', 'active', 'suspended')
       AND tenant.deleted_at IS NULL
       AND token.magic_link_generation = tenant.magic_link_generation
      WHERE token.token_digest = ${input.tokenDigest}
        AND CASE WHEN ${input.expectedEmailNormalized ?? null}::text IS NOT NULL
          THEN exomem_users.email = ${input.expectedEmailNormalized ?? null}
          ELSE token.browser_challenge_digest = ${input.browserChallengeDigest}
        END
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
                product_session.id AS session_id,
                locked_token.browser_challenge_matched
    ),
    browser_recorded AS (
      UPDATE exomem_tenants AS tenant
      SET time_zone = COALESCE(${input.timeZone ?? null}::text, tenant.time_zone)
      FROM consumed
      WHERE tenant.id = consumed.tenant_id
        AND (${input.timeZone ?? null}::text IS NOT NULL
          OR ${input.emailScheme ?? null}::text IS NOT NULL)
      RETURNING tenant.id
    )
    SELECT user_id, tenant_id, session_id, browser_challenge_matched FROM consumed
  `;
    const row = rows[0] as
      | {
          user_id: string;
          tenant_id: string;
          session_id: string;
          browser_challenge_matched: boolean;
        }
      | undefined;
    if (!row) return null;
    await initializeExomemTheme(
      tx,
      row.tenant_id,
      input.themeChoice ?? null,
      input.emailScheme ?? null
    );
    return {
      userId: row.user_id,
      tenantId: row.tenant_id,
      sessionId: row.session_id,
      browserChallengeMatched: row.browser_challenge_matched,
    };
  });
}

export type ExomemSessionRow = {
  id: string;
  userId: string;
  tenantId: string;
  csrfDigest: Buffer;
  expiresAt: string;
  themeChoice?: ExomemThemeChoice | null;
  emailScheme?: ExomemEmailScheme | null;
  reviewerCredentialId?: string | null;
  reviewerCredentialKind?: "provider_review" | "internal_canary" | "cloud_provider_review" | null;
};

export async function findExomemSessionByDigest(
  sessionDigest: Buffer,
  execute: ExomemSql = sql
): Promise<ExomemSessionRow | null> {
  const { rows } = await execute`
    /* exomem:find-session */
    SELECT session.id,
           session.user_id,
           session.tenant_id,
           session.csrf_digest,
           session.expires_at, session.reviewer_credential_id, reviewer_credential.credential_kind,
           tenant.theme_choice, tenant.email_scheme
    FROM exomem_sessions AS session
    JOIN exomem_users ON exomem_users.id = session.user_id AND exomem_users.deleted_at IS NULL
    JOIN exomem_tenants AS tenant
      ON tenant.id = session.tenant_id
     AND tenant.owner_user_id = session.user_id
     AND tenant.status IN ('provisioning', 'active', 'suspended')
     AND tenant.desired_state <> 'deleted'
     AND tenant.deleted_at IS NULL
    LEFT JOIN exomem_marketplace_reviewer_credentials AS reviewer_credential
      ON reviewer_credential.id = session.reviewer_credential_id
     AND reviewer_credential.revoked_at IS NULL
     AND reviewer_credential.expires_at > now()
    WHERE session.session_digest = ${sessionDigest}
      AND session.revoked_at IS NULL
      AND session.expires_at > now()
      AND (session.reviewer_credential_id IS NULL OR reviewer_credential.id IS NOT NULL)
      AND (reviewer_credential.credential_kind IS DISTINCT FROM 'cloud_provider_review' OR (
        ${marketplaceReviewerAccessEnabled()}
        AND exomem_cloud_reviewer_authorized(reviewer_credential.id, session.tenant_id, session.user_id, NULL)
      ))
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
      )
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        id: string;
        user_id: string;
        tenant_id: string;
        csrf_digest: Uint8Array;
        expires_at: string;
        reviewer_credential_id: string | null;
        credential_kind: ExomemSessionRow["reviewerCredentialKind"];
        theme_choice: ExomemThemeChoice | null;
        email_scheme: ExomemEmailScheme | null;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        themeChoice: row.theme_choice ?? null,
        emailScheme: row.email_scheme ?? null,
        csrfDigest: Buffer.from(row.csrf_digest),
        expiresAt: row.expires_at,
        reviewerCredentialId: row.reviewer_credential_id ?? null,
        reviewerCredentialKind: row.credential_kind ?? null,
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
}): Promise<{
  tokenId: string;
  emailNormalized: string;
  timeZone: string | null;
  emailScheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
} | null> {
  const { rows } = await sql`
    /* exomem:create-deletion-confirmation */
    WITH owner AS (
      SELECT exomem_users.id AS user_id,
             exomem_users.email,
             tenant.id AS tenant_id,
             tenant.time_zone,
             tenant.email_scheme, tenant.theme_choice
      FROM exomem_users
      JOIN exomem_tenants AS tenant ON tenant.owner_user_id = exomem_users.id
      WHERE exomem_users.id = ${input.userId}
        AND tenant.id = ${input.tenantId}
        AND exomem_users.deleted_at IS NULL
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
    SELECT created.id, owner.email, owner.time_zone, owner.email_scheme, owner.theme_choice
    FROM created
    JOIN owner ON owner.user_id = created.user_id
  `;
  const row = rows[0];
  return row
    ? {
        tokenId: String(row.id),
        emailNormalized: String(row.email).toLowerCase(),
        timeZone: row.time_zone ? String(row.time_zone) : null,
        emailScheme: (row.email_scheme as ExomemEmailScheme | null) ?? null,
        themeChoice: (row.theme_choice as ExomemThemeChoice | null) ?? null,
      }
    : null;
}

/**
 * Consumes the confirmation and gates the tenant to `deletion_pending`. The
 * Cloud sweep and the Cloud deletion finish complete the deletion (Cloud
 * design D4).
 */
export async function consumeDeletionConfirmationAtomic(input: {
  userId: string;
  tenantId: string;
  tokenDigest: Buffer;
}): Promise<boolean> {
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
      RETURNING tenant.id
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
    entitlement_gated AS (
      UPDATE exomem_entitlements AS entitlement
      SET effective_state = 'deleted',
          capabilities = '[]'::jsonb,
          updated_at = now()
      FROM consumed
      WHERE entitlement.tenant_id = consumed.tenant_id
      RETURNING entitlement.id
    )
    SELECT consumed.id FROM consumed JOIN tenant_gated ON tenant_gated.id = consumed.tenant_id
  `;
  return rows.length > 0;
}

export async function rotateExomemSessionAtomic(input: {
  sessionId: string;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  expiresAt: Date;
}): Promise<{ sessionId: string } | null> {
  return withExomemTransaction(async (tx) => {
    const locked = await tx`
      SELECT tenant.id FROM exomem_tenants AS tenant JOIN exomem_sessions AS session ON session.tenant_id = tenant.id
      WHERE session.id = ${input.sessionId}::uuid FOR UPDATE OF tenant
    `;
    if (!locked.rows[0]) return null;
    const { rows } = await tx`
    /* exomem:rotate-session */
    WITH previous AS (
      UPDATE exomem_sessions
      SET revoked_at = now()
      WHERE id = ${input.sessionId}
        AND revoked_at IS NULL
        AND expires_at > now()
        AND (reviewer_credential_id IS NULL OR EXISTS (
          SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
          WHERE credential.id = exomem_sessions.reviewer_credential_id
            AND credential.revoked_at IS NULL AND credential.expires_at > now()
            AND (credential.credential_kind <> 'cloud_provider_review' OR (
              ${marketplaceReviewerAccessEnabled()}
              AND exomem_cloud_reviewer_authorized(credential.id, exomem_sessions.tenant_id, exomem_sessions.user_id, NULL)
            ))
        ))
      RETURNING id, user_id, tenant_id, reviewer_credential_id, candidate_id, assignment_id,
        assignment_generation, staged_client_release_id, oauth_client_id
    ),
    replacement AS (
      INSERT INTO exomem_sessions (
        user_id, tenant_id, session_digest, csrf_digest,
        expires_at, rotated_from_session_id, reviewer_credential_id, candidate_id, assignment_id,
        assignment_generation, staged_client_release_id, oauth_client_id
      )
      SELECT previous.user_id,
             previous.tenant_id,
             ${input.sessionDigest},
             ${input.csrfDigest},
             LEAST(${input.expiresAt.toISOString()}, credential.expires_at),
             previous.id, previous.reviewer_credential_id, previous.candidate_id, previous.assignment_id,
             previous.assignment_generation, previous.staged_client_release_id, previous.oauth_client_id
      FROM previous
      LEFT JOIN exomem_marketplace_reviewer_credentials AS credential ON credential.id = previous.reviewer_credential_id
      RETURNING id
    )
    SELECT id FROM replacement
  `;
    const row = rows[0] as { id: string } | undefined;
    return row ? { sessionId: row.id } : null;
  });
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

/** `run` is a transaction's executor when the take must commit or roll back with it. */
export async function takeRateLimit(
  input: {
    scope: string;
    keyDigest: string;
    limit: number;
    windowSeconds: number;
  },
  run: ExomemSql = sql
): Promise<boolean> {
  const { rows } = await run`
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

// Whether the bucket would admit one more take, without taking one. A limit
// that counts only failures reads this before the attempt and takes after a
// failure, so attempts that succeed never fill the bucket.
export async function rateLimitHasRoom(input: {
  scope: string;
  keyDigest: string;
  limit: number;
  windowSeconds: number;
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:rate-limit-has-room */
    SELECT NOT EXISTS (
      SELECT 1 FROM exomem_rate_limit_buckets
      WHERE scope = ${input.scope} AND key_digest = ${input.keyDigest}
        AND window_started_at > now() - (${input.windowSeconds} * interval '1 second')
        AND admitted_count >= ${input.limit}
    ) AS has_room
  `;
  return Boolean((rows[0] as { has_room?: boolean } | undefined)?.has_room);
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

/** Authenticated redemption imports a browser choice only while the account is uninitialized. */
export async function initializeExomemTheme(
  tx: ExomemSql,
  tenantId: string,
  choice: ExomemThemeChoice | null,
  effective: ExomemEmailScheme | null
): Promise<void> {
  await tx`
    UPDATE exomem_tenants
    SET theme_choice = COALESCE(theme_choice, ${choice}, 'auto'),
        email_scheme = CASE WHEN COALESCE(theme_choice, ${choice}, 'auto') IN ('light', 'dark')
          THEN COALESCE(theme_choice, ${choice}) ELSE COALESCE(${effective}, email_scheme) END
    WHERE id = ${tenantId}::uuid
  `;
}

export async function saveExomemTheme(input: {
  tenantId: string;
  userId: string;
  themeChoice: ExomemThemeChoice;
  emailScheme: ExomemEmailScheme;
  initialize?: boolean;
  effectiveOnly?: boolean;
}): Promise<{
  themeChoice: ExomemThemeChoice | null;
  emailScheme: ExomemEmailScheme | null;
} | null> {
  const { rows } = await sql`
    UPDATE exomem_tenants
    SET theme_choice = CASE WHEN ${input.effectiveOnly ?? false}
          OR (${input.initialize ?? false} AND theme_choice IS NOT NULL)
          THEN theme_choice ELSE ${input.themeChoice} END,
        email_scheme = CASE
          WHEN ${input.effectiveOnly ?? false} AND theme_choice IS DISTINCT FROM 'auto' THEN email_scheme
          WHEN ${input.initialize ?? false} AND theme_choice IS NOT NULL THEN email_scheme
          ELSE ${input.emailScheme} END
    WHERE id = ${input.tenantId}::uuid AND owner_user_id = ${input.userId}::uuid
      AND deleted_at IS NULL AND status NOT IN ('deleted', 'deletion_pending')
    RETURNING theme_choice, email_scheme
  `;
  const row = rows[0] as
    | { theme_choice: ExomemThemeChoice | null; email_scheme: ExomemEmailScheme | null }
    | undefined;
  return row ? { themeChoice: row.theme_choice, emailScheme: row.email_scheme } : null;
}
