import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { Pool, type PoolClient } from "pg";
import { exomemErrors } from "./errors";
// Type-only in the other direction, so this pair does not form a runtime cycle.
import { hasLiveHostedCohortTarget } from "./hosted-cohort-target";
import { EXOMEM_ALPHA_CAPACITY } from "./oauth-admission";
import type { ExomemPaddleEnvironment } from "./paddle-config";
import { PROVISIONER_PROTOCOL_V2 } from "./provisioner";
import { provisionerWireProtocolFromEnv } from "./provisioner-wire-protocol";
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
let injectedSqlClient: ExomemSql | null = null;
let transactionPool: Pool | null = null;

export type ExomemTransactionRunner = <T>(callback: (tx: ExomemSql) => Promise<T>) => Promise<T>;

let transactionRunner: ExomemTransactionRunner | null = null;

type PgQueryable = Pick<PoolClient, "query">;

function taggedPgSql(client: PgQueryable): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

/** Neon HTTP does not apply PostgreSQL startup `options`, including `search_path`. */
export function databaseUrlRequiresSessionSql(databaseUrl: string): boolean {
  try {
    const options = new URL(databaseUrl).searchParams.get("options");
    return options !== null && /(?:^|\s)(?:-c\s*)?search_path\s*=/.test(options);
  } catch {
    return false;
  }
}

export type ExomemTransaction = {
  query: (text: string, values?: unknown[]) => Promise<ExomemSqlResult>;
};

let transactionClient:
  | ((work: (transaction: ExomemTransaction) => Promise<void>) => Promise<void>)
  | null = null;

function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<ExomemSqlResult> {
  if (injectedSqlClient) return injectedSqlClient(strings, ...values);
  if (!sqlClient) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is not set");
    if (databaseUrlRequiresSessionSql(databaseUrl)) {
      transactionPool ??= new Pool({ connectionString: databaseUrl });
      sqlClient = taggedPgSql(transactionPool);
    } else {
      const client: NeonQueryFunction<false, true> = neon(databaseUrl, {
        fullResults: true,
      });
      sqlClient = (queryStrings, ...queryValues) =>
        client(queryStrings, ...queryValues) as Promise<ExomemSqlResult>;
    }
  }
  return sqlClient(strings, ...values);
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
 * read/write path remains Neon HTTP; only flows that need row-lock ordering use
 * this interactive transaction boundary.
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
      expires_at
    ) SELECT
      ${input.tokenDigest},
      ${input.emailNormalized},
      ${input.entitlementSource},
      ${JSON.stringify(input.capabilities)}::jsonb,
      ${JSON.stringify(input.resourceLimits)}::jsonb,
      ${input.marketplaceReviewerPurpose === true},
      ${input.operatorPrincipalDigest},
      ${input.expiresAt.toISOString()}
    WHERE NOT (
      ${input.marketplaceReviewerPurpose === true}
      AND EXISTS (
        SELECT 1
        FROM exomem_tenants AS tenant
        JOIN users AS owner ON owner.id = tenant.owner_user_id
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
    RETURNING id
  `;
    const row = rows[0] as { id: string } | undefined;
    if (!row) throw new Error("createInviteRecord returned no row");
    return { inviteId: row.id };
  };
  const isPaidOperatorInvite = input.entitlementSource === "paddle";
  if (!input.marketplaceReviewerPurpose && !isPaidOperatorInvite) return create(sql);
  return withExomemTransaction(async (tx) => {
    if (input.marketplaceReviewerPurpose) {
      await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    }
    if (isPaidOperatorInvite) {
      const poolResult = await tx`
        /* exomem:paid-operator-invite-pool */
        SELECT storage_capacity_bytes, reserved_storage_bytes,
               runtime_capacity_slots, reserved_runtime_slots,
               provision_reservation_capacity, reserved_provision_slots
        FROM exomem_capacity_pools
        WHERE pool_key = 'exomem-hosted-alpha'
          AND configured_at IS NOT NULL
        FOR UPDATE
      `;
      const pool = poolResult.rows[0] as Record<string, unknown> | undefined;
      if (!pool) throw exomemErrors.capacityUnavailable();

      const outstandingResult = await tx`
        /* exomem:paid-operator-invite-outstanding */
        SELECT count(*)::integer AS outstanding
        FROM exomem_invites
        WHERE entitlement_source = 'paddle'
          AND NOT self_serve
          AND delivery_state IN ('pending', 'sent')
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
      `;
      const outstanding = Number(
        (outstandingResult.rows[0] as { outstanding?: number } | undefined)?.outstanding ?? 0
      );
      const promised = outstanding + 1;
      const fits = (capacity: unknown, reserved: unknown, perTenant: number): boolean =>
        Number(capacity) >= Number(reserved) + perTenant * promised;
      if (
        !fits(
          pool.storage_capacity_bytes,
          pool.reserved_storage_bytes,
          EXOMEM_ALPHA_CAPACITY.storageBytes
        ) ||
        !fits(
          pool.runtime_capacity_slots,
          pool.reserved_runtime_slots,
          EXOMEM_ALPHA_CAPACITY.runtimeSlots
        ) ||
        !fits(
          pool.provision_reservation_capacity,
          pool.reserved_provision_slots,
          EXOMEM_ALPHA_CAPACITY.provisionReservationSlots
        )
      ) {
        throw exomemErrors.capacityUnavailable();
      }
    }
    return create(tx);
  });
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

export type SelfServeAdmissionInput = {
  tokenDigest: Buffer;
  emailNormalized: string;
  capabilities: string[];
  resourceLimits: Record<string, number>;
  principalDigest: Buffer;
  expiresAt: Date;
  storageBytes: number;
  runtimeSlots: number;
  provisionSlots: number;
};

export type SelfServeAdmissionResult =
  | { outcome: "admitted"; inviteId: string }
  | { outcome: "waitlisted"; position: number };

/**
 * Decides admission before any payment surface is offered, in one serialized
 * transaction against the capacity pool row.
 *
 * An outstanding self-serve invite is a *soft* reservation: admission has been
 * promised, but the hard reservation in `exomem_capacity_pools` only happens
 * when the invite is redeemed through OAuth admission. Counting outstanding
 * invites against headroom is what stops us admitting more visitors than the
 * pool can ever provision — the hard reservation alone would admit everybody and
 * then fail them one by one after they had already paid.
 *
 * Fails closed: an absent or unconfigured pool waitlists rather than admits.
 */
export async function admitSelfServeOrWaitlistAtomic(
  input: SelfServeAdmissionInput
): Promise<SelfServeAdmissionResult> {
  return withExomemTransaction(async (tx) => {
    const poolResult = await tx`
      /* exomem:self-serve-admission-pool */
      SELECT id,
             storage_capacity_bytes,
             reserved_storage_bytes,
             runtime_capacity_slots,
             reserved_runtime_slots,
             provision_reservation_capacity,
             reserved_provision_slots
      FROM exomem_capacity_pools
      WHERE pool_key = 'exomem-hosted-alpha'
        AND configured_at IS NOT NULL
      FOR UPDATE
    `;
    const pool = poolResult.rows[0] as Record<string, unknown> | undefined;

    // Repeat requests must not each consume a soft slot. Revoking the previous
    // outstanding invite first keeps one visitor to one reservation, and the
    // freshly minted token supersedes any older link they were emailed.
    await tx`
      /* exomem:self-serve-supersede-outstanding */
      UPDATE exomem_invites
      SET revoked_at = now()
      WHERE email_normalized = ${input.emailNormalized}
        AND self_serve
        AND consumed_at IS NULL
        AND revoked_at IS NULL
    `;

    let admitted = false;
    if (pool) {
      const outstandingResult = await tx`
        /* exomem:self-serve-outstanding */
        SELECT count(*)::integer AS outstanding
        FROM exomem_invites
        WHERE self_serve
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
      `;
      const outstanding = Number(
        (outstandingResult.rows[0] as { outstanding: number } | undefined)?.outstanding ?? 0
      );
      // The +1 is this visitor: admit only if the pool could still honour every
      // promise already made plus this one.
      const claimed = outstanding + 1;
      const fits = (capacity: unknown, reserved: unknown, perTenant: number): boolean =>
        Number(capacity) >= Number(reserved) + perTenant * claimed;
      admitted =
        fits(pool.storage_capacity_bytes, pool.reserved_storage_bytes, input.storageBytes) &&
        fits(pool.runtime_capacity_slots, pool.reserved_runtime_slots, input.runtimeSlots) &&
        fits(
          pool.provision_reservation_capacity,
          pool.reserved_provision_slots,
          input.provisionSlots
        );
    }

    if (!admitted) {
      // Position is counted server-side against the row's own `created_at`.
      // Round-tripping that timestamp through JS would silently truncate
      // Postgres microseconds to milliseconds, so a row could fail to compare
      // against itself and every visitor would be told they were next.
      //
      // The count is strictly-before plus one: a freshly inserted row is not
      // visible to a subquery in the same statement, and an upserted row is —
      // strict `<` makes both paths agree.
      const waitlistResult = await tx`
        /* exomem:self-serve-waitlist */
        WITH upserted AS (
          INSERT INTO exomem_waitlist_entries (email_normalized)
          VALUES (${input.emailNormalized})
          ON CONFLICT (email_normalized) DO UPDATE
          SET updated_at = now(),
              -- Re-queue someone who was admitted before. Their previous
              -- self-serve invite was just revoked above, so they hold nothing;
              -- leaving admitted_at set would tell them a queue position while
              -- making their row invisible to every "admitted_at IS NULL" sweep,
              -- so they would wait forever for an email nobody would send.
              -- created_at is deliberately untouched: they asked first and keep
              -- their place.
              admitted_at = NULL,
              admitted_invite_id = NULL
          RETURNING id, created_at
        )
        SELECT upserted.id,
               (
                 SELECT count(*)
                 FROM exomem_waitlist_entries AS queued
                 WHERE queued.admitted_at IS NULL
                   AND queued.created_at < upserted.created_at
               )::integer + 1 AS position
        FROM upserted
      `;
      const entry = waitlistResult.rows[0] as { id: string; position: number } | undefined;
      if (!entry) throw new Error("self-serve waitlist insert returned no row");
      return { outcome: "waitlisted", position: Number(entry.position) };
    }

    const inviteResult = await tx`
      /* exomem:self-serve-invite */
      INSERT INTO exomem_invites (
        token_digest,
        email_normalized,
        entitlement_source,
        entitlement_capabilities,
        entitlement_limits,
        marketplace_reviewer_purpose,
        created_by_principal_digest,
        expires_at,
        self_serve
      ) VALUES (
        ${input.tokenDigest},
        ${input.emailNormalized},
        'paddle',
        ${JSON.stringify(input.capabilities)}::jsonb,
        ${JSON.stringify(input.resourceLimits)}::jsonb,
        false,
        ${input.principalDigest},
        ${input.expiresAt.toISOString()},
        true
      )
      RETURNING id
    `;
    const invite = inviteResult.rows[0] as { id: string } | undefined;
    if (!invite) throw new Error("self-serve invite insert returned no row");

    // A visitor who waited and is now admitted stops being queued.
    await tx`
      /* exomem:self-serve-waitlist-admitted */
      UPDATE exomem_waitlist_entries
      SET admitted_at = now(),
          admitted_invite_id = ${invite.id}::uuid,
          updated_at = now()
      WHERE email_normalized = ${input.emailNormalized}
        AND admitted_at IS NULL
    `;

    return { outcome: "admitted", inviteId: invite.id };
  });
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
  operationId: string | null;
};

/**
 * Pre-MCP compatibility only: consume an invite through the legacy unmetered
 * path. OAuth/MCP first-owner admission never calls this function; it uses the
 * capacity-aware transaction in oauth-store instead.
 */
export async function redeemInviteAtomic(
  input: RedeemInviteAtomicInput
): Promise<RedeemedAccess | null> {
  const provisionerWireProtocol = provisionerWireProtocolFromEnv();
  const pinsAnExactContract = provisionerWireProtocol === PROVISIONER_PROTOCOL_V2;
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    const inviteResult = await tx`
      SELECT id, email_normalized, entitlement_source,
             entitlement_capabilities, entitlement_limits, marketplace_reviewer_purpose
      FROM exomem_invites
      WHERE token_digest = ${input.tokenDigest}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      FOR UPDATE
    `;
    const invite = inviteResult.rows[0] as
      | {
          id: string;
          email_normalized: string;
          entitlement_source: EntitlementSource;
          entitlement_capabilities: string[];
          entitlement_limits: Record<string, number>;
          marketplace_reviewer_purpose: boolean;
        }
      | undefined;
    if (!invite) return null;

    if (invite.entitlement_source === "paddle") {
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
      if (!owner) throw exomemErrors.accessTokenInvalid();

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
      if (blockedResult.rows[0]) throw exomemErrors.accessTokenInvalid();

      const existingResult = await tx`
        SELECT tenant.id
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
      const existing = existingResult.rows[0] as { id: string } | undefined;
      let tenantId = existing?.id;

      if (!tenantId) {
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
        const capacityPool = reservationResult.rows[0] as { id: string } | undefined;
        if (!capacityPool) throw exomemErrors.capacityUnavailable();

        const tenantResult = await tx`
          INSERT INTO exomem_tenants (
            owner_user_id, status, desired_state, legacy_unmetered, marketplace_reviewer_purpose
          ) VALUES (
            ${owner.id}::uuid, 'provisioning', 'running', false,
            ${invite.marketplace_reviewer_purpose}
          )
          RETURNING id
        `;
        const tenant = tenantResult.rows[0] as { id: string } | undefined;
        if (!tenant) throw exomemErrors.accessTokenInvalid();
        tenantId = tenant.id;

        const entitlementResult = await tx`
          INSERT INTO exomem_entitlements (
            tenant_id, source, source_state, effective_state, capabilities, resource_limits
          ) VALUES (
            ${tenantId}::uuid, 'paddle', 'awaiting_checkout', 'provisioning',
            ${JSON.stringify(invite.entitlement_capabilities)}::jsonb,
            ${JSON.stringify(invite.entitlement_limits)}::jsonb
          )
          RETURNING tenant_id
        `;
        if (!entitlementResult.rows[0]) throw exomemErrors.accessTokenInvalid();

        const allocationResult = await tx`
          INSERT INTO exomem_capacity_allocations (
            pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state, operation_id
          ) VALUES (
            ${capacityPool.id}::uuid, ${tenantId}::uuid,
            ${EXOMEM_ALPHA_CAPACITY.storageBytes}, ${EXOMEM_ALPHA_CAPACITY.runtimeSlots},
            ${EXOMEM_ALPHA_CAPACITY.provisionReservationSlots}, 'reserved', NULL
          )
          RETURNING id
        `;
        if (!allocationResult.rows[0]) throw exomemErrors.accessTokenInvalid();
      }

      const sessionResult = await tx`
        INSERT INTO exomem_sessions (
          user_id, tenant_id, session_digest, csrf_digest, expires_at
        ) VALUES (
          ${owner.id}::uuid, ${tenantId}::uuid, ${input.sessionDigest}, ${input.csrfDigest},
          ${input.sessionExpiresAt.toISOString()}
        )
        RETURNING id
      `;
      const session = sessionResult.rows[0] as { id: string } | undefined;
      if (!session) throw exomemErrors.accessTokenInvalid();

      const consumedResult = await tx`
        UPDATE exomem_invites
        SET consumed_at = now(),
            consumed_by_user_id = ${owner.id}::uuid,
            redeemed_tenant_id = ${tenantId}::uuid,
            redeemed_session_id = ${session.id}::uuid
        WHERE id = ${invite.id}::uuid
          AND consumed_at IS NULL
        RETURNING id
      `;
      if (!consumedResult.rows[0]) throw exomemErrors.accessTokenInvalid();
      return {
        userId: owner.id,
        tenantId,
        sessionId: session.id,
        operationId: null,
      };
    }

    // Under v2 a provision must name an exact live contract, and this has to be
    // settled before the statement below rather than inside it: its owner,
    // tenant, entitlement and session CTEs all modify data, and PostgreSQL runs
    // every data-modifying CTE exactly once whether or not the primary query
    // reads it. So a target discovered missing mid-statement can only be
    // expressed as an abort. It used to be spelled `1 / (COUNT(*) - COUNT(*))`
    // — a deliberate division by zero, which did roll the transaction back but
    // reached the invited person as a bare 500 INTERNAL_ERROR. Refuse in the
    // open instead: the invitation is untouched, admission is shut.
    if (pinsAnExactContract && !(await hasLiveHostedCohortTarget(tx))) {
      throw exomemErrors.admissionClosed();
    }
    const { rows } = await tx`
    /* exomem:redeem-invite */
    WITH locked_invite AS (
      SELECT id, email_normalized, entitlement_source,
             entitlement_capabilities, entitlement_limits, marketplace_reviewer_purpose
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
      INSERT INTO exomem_tenants (
        owner_user_id, status, desired_state, legacy_unmetered, marketplace_reviewer_purpose
      )
      SELECT owner.id, 'provisioning', 'running', true, locked_invite.marketplace_reviewer_purpose
      FROM owner CROSS JOIN locked_invite
      ON CONFLICT (owner_user_id) DO UPDATE
      SET updated_at = exomem_tenants.updated_at
      WHERE exomem_tenants.status <> 'deleted'
        AND exomem_tenants.status <> 'deletion_pending'
        AND exomem_tenants.desired_state <> 'deleted'
        AND exomem_tenants.deleted_at IS NULL
        AND exomem_tenants.marketplace_reviewer_purpose = EXCLUDED.marketplace_reviewer_purpose
        AND NOT EXISTS (
          SELECT 1 FROM exomem_oauth_account_blocks AS block
          WHERE block.tenant_id = exomem_tenants.id
            AND block.owner_user_id = exomem_tenants.owner_user_id
        )
      RETURNING id, owner_user_id, fence_generation
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
    live_target AS MATERIALIZED (
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
    ),
    operation AS (
      INSERT INTO exomem_lifecycle_operations (
        tenant_id, operation_type, idempotency_key, fence_generation,
        provisioner_wire_protocol, target_candidate_id, target_assignment_id,
        target_assignment_generation, target_source_release, target_protocol_version,
        target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
        target_compatibility_digest
      )
      SELECT tenant.id, 'provision', 'initial-provision', tenant.fence_generation,
             ${provisionerWireProtocol}, target.candidate_id, target.assignment_id,
             target.assignment_generation, target.source_release, target.protocol_version,
             target.gateway_contract_digest, target.command_fingerprint, target.schema_digest,
             target.compatibility_digest
      FROM tenant
      JOIN target ON TRUE
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
    if (!row) {
      // Normally this is "no redeemable invite", and the modifying CTEs above
      // selected from an empty `locked_invite`, so nothing was written. But if
      // the live target were lost after the pre-check, the owner, tenant and
      // session rows would exist with no provision pinned to them, and
      // returning would commit them. Re-ask, and abort rather than admit a
      // tenant that nothing will ever provision.
      if (pinsAnExactContract && !(await hasLiveHostedCohortTarget(tx))) {
        throw exomemErrors.admissionClosed();
      }
      return null;
    }
    return {
      userId: row.user_id,
      tenantId: row.tenant_id,
      sessionId: row.session_id,
      operationId: row.operation_id,
    };
  });
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

export type ClaimedDeletionCompletionDelivery = {
  deliveryId: string;
  tenantId: string;
  emailNormalized: string;
  attempts: number;
};

export async function claimDeletionCompletionDelivery(input: {
  leaseOwner: string;
  leaseSeconds?: number;
}): Promise<ClaimedDeletionCompletionDelivery | null> {
  const leaseSeconds = input.leaseSeconds ?? 60;
  const { rows } = await sql`
    /* exomem:claim-deletion-completion-delivery */
    WITH candidate AS (
      SELECT outbox.id
      FROM exomem_deletion_completion_outbox AS outbox
      JOIN exomem_tenants AS tenant
        ON tenant.id = outbox.tenant_id
       AND tenant.status = 'deleted'
       AND tenant.deleted_at IS NOT NULL
      JOIN users ON users.id = tenant.owner_user_id AND users.deleted_at IS NULL
      WHERE (
          (outbox.state = 'pending' AND outbox.next_attempt_at <= now())
          OR (outbox.state = 'leased' AND outbox.lease_expires_at <= now())
        )
      ORDER BY outbox.next_attempt_at, outbox.created_at
      FOR UPDATE OF outbox SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE exomem_deletion_completion_outbox AS outbox
      SET state = 'leased',
          attempts = outbox.attempts + 1,
          lease_owner = ${input.leaseOwner}::uuid,
          lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
          updated_at = now()
      FROM candidate
      WHERE outbox.id = candidate.id
      RETURNING outbox.id, outbox.tenant_id, outbox.attempts
    )
    SELECT claimed.id AS delivery_id,
           claimed.tenant_id,
           users.email::text AS email_normalized,
           claimed.attempts
    FROM claimed
    JOIN exomem_tenants AS tenant ON tenant.id = claimed.tenant_id
    JOIN users ON users.id = tenant.owner_user_id
  `;
  const row = rows[0] as
    | {
        delivery_id: string;
        tenant_id: string;
        email_normalized: string;
        attempts: number;
      }
    | undefined;
  if (!row) return null;
  return {
    deliveryId: row.delivery_id,
    tenantId: row.tenant_id,
    emailNormalized: row.email_normalized,
    attempts: Number(row.attempts),
  };
}

export async function markDeletionCompletionDeliverySent(input: {
  deliveryId: string;
  leaseOwner: string;
}): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:mark-deletion-completion-delivery-sent */
    UPDATE exomem_deletion_completion_outbox
    SET state = 'sent',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        sent_at = now(),
        updated_at = now()
    WHERE id = ${input.deliveryId}
      AND state = 'leased'
      AND lease_owner = ${input.leaseOwner}::uuid
      AND lease_expires_at > now()
    RETURNING id
  `;
  return rows.length === 1;
}

export async function releaseDeletionCompletionDelivery(input: {
  deliveryId: string;
  leaseOwner: string;
  errorCode: string;
}): Promise<"retry" | "failed" | "lost"> {
  const { rows } = await sql`
    /* exomem:release-deletion-completion-delivery */
    UPDATE exomem_deletion_completion_outbox
    SET state = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
        next_attempt_at = now() + (LEAST(attempts * 30, 120) * interval '1 second'),
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = ${input.errorCode},
        updated_at = now()
    WHERE id = ${input.deliveryId}
      AND state = 'leased'
      AND lease_owner = ${input.leaseOwner}::uuid
    RETURNING state
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
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await tx`
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
  });
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
  const provisionerWireProtocol = provisionerWireProtocolFromEnv();
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
      RETURNING tenant.id, tenant.bound_cell_id, tenant.fence_generation,
                tenant.marketplace_reviewer_purpose
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
    bound_assignment_target AS MATERIALIZED (
      SELECT assignment.candidate_id,
             assignment.id AS assignment_id,
             assignment.generation AS assignment_generation,
             assignment.source_release,
             assignment.protocol_version,
             assignment.gateway_contract_digest,
             assignment.command_fingerprint,
             assignment.schema_digest,
             assignment.compatibility_digest
      FROM tenant_gated
      JOIN exomem_cells AS bound_cell
        ON bound_cell.id = tenant_gated.bound_cell_id
       AND bound_cell.tenant_id = tenant_gated.id
       AND bound_cell.routing_state IN ('bound', 'retiring')
       AND bound_cell.observed_gateway_contract_digest IS NOT NULL
      JOIN exomem_agent_contract_rollout_assignments AS assignment
        ON assignment.tenant_id = tenant_gated.id
       AND assignment.state = 'active'
       AND assignment.expires_at > now()
       AND assignment.source_release = bound_cell.release_version
       AND assignment.protocol_version = bound_cell.protocol_version
       AND assignment.gateway_contract_digest = bound_cell.observed_gateway_contract_digest
       AND assignment.command_fingerprint = bound_cell.observed_command_fingerprint
       AND assignment.schema_digest = bound_cell.observed_schema_digest
      JOIN exomem_agent_contract_candidates AS candidate
        ON candidate.id = assignment.candidate_id
       AND candidate.state IN ('pending', 'live')
       AND candidate.source_release = assignment.source_release
       AND candidate.protocol_version = assignment.protocol_version
       AND candidate.command_fingerprint = assignment.command_fingerprint
       AND candidate.schema_digest = assignment.schema_digest
       AND candidate.compatibility_digest = assignment.compatibility_digest
    ),
    strict_v1_reviewer_target AS MATERIALIZED (
      SELECT operation.target_candidate_id AS candidate_id,
             operation.target_assignment_id AS assignment_id,
             operation.target_assignment_generation AS assignment_generation,
             operation.target_source_release AS source_release,
             operation.target_protocol_version AS protocol_version,
             operation.target_gateway_contract_digest AS gateway_contract_digest,
             operation.target_command_fingerprint AS command_fingerprint,
             operation.target_schema_digest AS schema_digest,
             operation.target_compatibility_digest AS compatibility_digest
      FROM tenant_gated
      JOIN exomem_cells AS bound_cell
        ON bound_cell.id = tenant_gated.bound_cell_id
       AND bound_cell.tenant_id = tenant_gated.id
       AND bound_cell.routing_state IN ('bound', 'retiring')
      JOIN exomem_lifecycle_operations AS operation
        ON operation.tenant_id = tenant_gated.id
       AND operation.cell_id = bound_cell.id
       AND operation.operation_type IN ('provision', 'restore')
       AND operation.state = 'succeeded'
       AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
       AND operation.target_candidate_id IS NOT NULL
       AND operation.target_assignment_id IS NOT NULL
      JOIN exomem_agent_contract_rollout_assignments AS assignment
        ON assignment.id = operation.target_assignment_id
       AND assignment.tenant_id = tenant_gated.id
       AND assignment.marketplace_reviewer_purpose = true
       AND assignment.generation = operation.target_assignment_generation
       AND assignment.source_release = operation.target_source_release
       AND assignment.protocol_version = operation.target_protocol_version
       AND assignment.gateway_contract_digest = operation.target_gateway_contract_digest
       AND assignment.command_fingerprint = operation.target_command_fingerprint
       AND assignment.schema_digest = operation.target_schema_digest
       AND assignment.compatibility_digest = operation.target_compatibility_digest
      JOIN exomem_agent_contract_candidates AS candidate
        ON candidate.id = operation.target_candidate_id
       AND candidate.profile_id = 'hosted-alpha-agent-v1'
       AND candidate.source_release = operation.target_source_release
       AND candidate.protocol_version = operation.target_protocol_version
       AND candidate.command_fingerprint = operation.target_command_fingerprint
       AND candidate.schema_digest = operation.target_schema_digest
       AND candidate.compatibility_digest = operation.target_compatibility_digest
      WHERE tenant_gated.marketplace_reviewer_purpose = true
        AND operation.target_source_release = bound_cell.release_version
        AND operation.target_protocol_version = bound_cell.protocol_version
      GROUP BY operation.target_candidate_id, operation.target_assignment_id,
               operation.target_assignment_generation, operation.target_source_release,
               operation.target_protocol_version, operation.target_gateway_contract_digest,
               operation.target_command_fingerprint, operation.target_schema_digest,
               operation.target_compatibility_digest
    ),
    origin_target_identities AS MATERIALIZED (
      SELECT operation.target_candidate_id AS candidate_id,
             operation.target_assignment_id AS assignment_id,
             operation.target_assignment_generation AS assignment_generation,
             operation.target_source_release AS source_release,
             operation.target_protocol_version AS protocol_version,
             operation.target_gateway_contract_digest AS gateway_contract_digest,
             operation.target_command_fingerprint AS command_fingerprint,
             operation.target_schema_digest AS schema_digest,
             operation.target_compatibility_digest AS compatibility_digest,
             MAX(operation.completed_at) AS installed_at
      FROM tenant_gated
      JOIN exomem_cells AS bound_cell
        ON bound_cell.id = tenant_gated.bound_cell_id
       AND bound_cell.tenant_id = tenant_gated.id
       AND bound_cell.routing_state IN ('bound', 'retiring')
      JOIN exomem_lifecycle_operations AS operation
        ON operation.tenant_id = tenant_gated.id
       AND operation.cell_id = bound_cell.id
       AND operation.operation_type IN ('provision', 'restore')
       AND operation.state = 'succeeded'
       AND operation.target_candidate_id IS NOT NULL
      JOIN exomem_agent_contract_candidates AS candidate
        ON candidate.id = operation.target_candidate_id
       AND candidate.profile_id = 'hosted-alpha-agent-v1'
       AND candidate.source_release = operation.target_source_release
       AND candidate.protocol_version = operation.target_protocol_version
       AND candidate.command_fingerprint = operation.target_command_fingerprint
       AND candidate.schema_digest = operation.target_schema_digest
       AND candidate.compatibility_digest = operation.target_compatibility_digest
      WHERE operation.target_source_release = bound_cell.release_version
        AND operation.target_protocol_version = bound_cell.protocol_version
        AND operation.target_gateway_contract_digest = bound_cell.observed_gateway_contract_digest
        AND operation.target_command_fingerprint = bound_cell.observed_command_fingerprint
        AND operation.target_schema_digest = bound_cell.observed_schema_digest
        AND operation.target_compatibility_digest = bound_cell.observed_compatibility_digest
        AND candidate.compatibility_digest = bound_cell.observed_compatibility_digest
      GROUP BY operation.target_candidate_id, operation.target_assignment_id,
               operation.target_assignment_generation, operation.target_source_release,
               operation.target_protocol_version, operation.target_gateway_contract_digest,
               operation.target_command_fingerprint, operation.target_schema_digest,
               operation.target_compatibility_digest
    ),
    latest_origin_target AS MATERIALIZED (
      SELECT identity.*
      FROM origin_target_identities AS identity
      WHERE identity.installed_at = (SELECT MAX(installed_at) FROM origin_target_identities)
        AND 1 = (
          SELECT COUNT(*)
          FROM origin_target_identities AS current_identity
          WHERE current_identity.installed_at = identity.installed_at
        )
    ),
    has_cell_target_history AS MATERIALIZED (
      SELECT 1
      FROM tenant_gated
      JOIN exomem_cells AS bound_cell
        ON bound_cell.id = tenant_gated.bound_cell_id
       AND bound_cell.tenant_id = tenant_gated.id
      JOIN exomem_lifecycle_operations AS operation
        ON operation.tenant_id = tenant_gated.id
       AND operation.cell_id = bound_cell.id
       AND operation.operation_type IN ('provision', 'restore')
       AND operation.state = 'succeeded'
       AND operation.target_candidate_id IS NOT NULL
    ),
    legacy_cell_target_candidates AS MATERIALIZED (
      SELECT candidate.id AS candidate_id,
             NULL::uuid AS assignment_id,
             NULL::bigint AS assignment_generation,
             candidate.source_release,
             candidate.protocol_version,
             bound_cell.observed_gateway_contract_digest AS gateway_contract_digest,
             candidate.command_fingerprint,
             candidate.schema_digest,
             candidate.compatibility_digest
      FROM tenant_gated
      JOIN exomem_cells AS bound_cell
        ON bound_cell.id = tenant_gated.bound_cell_id
       AND bound_cell.tenant_id = tenant_gated.id
       AND bound_cell.routing_state IN ('bound', 'retiring')
       AND bound_cell.observed_gateway_contract_digest IS NOT NULL
      JOIN exomem_routable_cell_contracts AS authority
        ON authority.cell_id = bound_cell.id
       AND authority.profile_id = 'hosted-alpha-agent-v1'
       AND authority.routable
       AND authority.source_release = bound_cell.release_version
       AND authority.protocol_version = bound_cell.protocol_version
       AND authority.command_fingerprint = bound_cell.observed_command_fingerprint
       AND authority.contract_digest = bound_cell.observed_schema_digest
       AND authority.compatibility_digest = bound_cell.observed_compatibility_digest
      JOIN exomem_agent_contract_candidates AS candidate
        ON candidate.profile_id = 'hosted-alpha-agent-v1'
       AND candidate.state = 'live'
       AND candidate.source_release = bound_cell.release_version
       AND candidate.protocol_version = bound_cell.protocol_version
       AND candidate.command_fingerprint = bound_cell.observed_command_fingerprint
       AND candidate.schema_digest = bound_cell.observed_schema_digest
       AND candidate.compatibility_digest = bound_cell.observed_compatibility_digest
      WHERE NOT EXISTS (SELECT 1 FROM has_cell_target_history)
    ),
    legacy_cell_target AS MATERIALIZED (
      SELECT candidate_id, assignment_id, assignment_generation, source_release,
             protocol_version, gateway_contract_digest, command_fingerprint,
             schema_digest, compatibility_digest
      FROM legacy_cell_target_candidates
      WHERE 1 = (SELECT COUNT(DISTINCT candidate_id) FROM legacy_cell_target_candidates)
    ),
    target AS MATERIALIZED (
      SELECT * FROM bound_assignment_target
      UNION ALL
      SELECT * FROM strict_v1_reviewer_target
      WHERE NOT EXISTS (SELECT 1 FROM bound_assignment_target)
      UNION ALL
      SELECT candidate_id, assignment_id, assignment_generation, source_release,
             protocol_version, gateway_contract_digest, command_fingerprint,
             schema_digest, compatibility_digest
      FROM latest_origin_target
      WHERE NOT EXISTS (SELECT 1 FROM bound_assignment_target)
        AND NOT EXISTS (SELECT 1 FROM strict_v1_reviewer_target)
      UNION ALL
      SELECT * FROM legacy_cell_target
      WHERE NOT EXISTS (SELECT 1 FROM bound_assignment_target)
        AND NOT EXISTS (SELECT 1 FROM strict_v1_reviewer_target)
        AND NOT EXISTS (SELECT 1 FROM latest_origin_target)
    ),
    operation AS (
      INSERT INTO exomem_lifecycle_operations (
        tenant_id, cell_id, operation_type, idempotency_key,
        resume_after_operation, fence_generation, provisioner_wire_protocol,
        target_candidate_id, target_assignment_id, target_assignment_generation,
        target_source_release, target_protocol_version, target_gateway_contract_digest,
        target_command_fingerprint, target_schema_digest, target_compatibility_digest
      )
      SELECT tenant_gated.id,
             tenant_gated.bound_cell_id,
             'delete',
             'confirmed-deletion-' || consumed.id::text,
             false,
             tenant_gated.fence_generation,
             ${provisionerWireProtocol},
             target.candidate_id, target.assignment_id, target.assignment_generation,
             target.source_release, target.protocol_version, target.gateway_contract_digest,
             target.command_fingerprint, target.schema_digest, target.compatibility_digest
      FROM tenant_gated
      JOIN consumed ON consumed.tenant_id = tenant_gated.id
      LEFT JOIN target ON TRUE
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
  hostedProfile?: string | null;
  hostedSourceRelease?: string | null;
  hostedProtocolVersion?: string | null;
  hostedCommandFingerprint?: string | null;
  hostedContractDigest?: string | null;
  hostedCompatibilityDigest?: string | null;
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
           entitlement.manual_suspended_at,
           hosted_contract.profile_id AS hosted_profile,
           hosted_contract.source_release AS hosted_source_release,
           hosted_contract.protocol_version AS hosted_protocol_version,
           hosted_contract.command_fingerprint AS hosted_command_fingerprint,
           hosted_contract.contract_digest AS hosted_contract_digest,
           hosted_contract.compatibility_digest AS hosted_compatibility_digest
    FROM exomem_tenants AS tenant
    JOIN exomem_cells AS cell
      ON cell.id = tenant.bound_cell_id
     AND cell.tenant_id = tenant.id
    JOIN exomem_entitlements AS entitlement
      ON entitlement.tenant_id = tenant.id
    LEFT JOIN exomem_routable_cell_contracts AS hosted_contract
      ON hosted_contract.cell_id = cell.id
     AND hosted_contract.profile_id = 'hosted-alpha-agent-v1'
     AND hosted_contract.routable = true
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
    hostedProfile: row.hosted_profile == null ? null : String(row.hosted_profile),
    hostedSourceRelease:
      row.hosted_source_release == null ? null : String(row.hosted_source_release),
    hostedProtocolVersion:
      row.hosted_protocol_version == null ? null : String(row.hosted_protocol_version),
    hostedCommandFingerprint:
      row.hosted_command_fingerprint == null ? null : String(row.hosted_command_fingerprint),
    hostedContractDigest:
      row.hosted_contract_digest == null ? null : String(row.hosted_contract_digest),
    hostedCompatibilityDigest:
      row.hosted_compatibility_digest == null ? null : String(row.hosted_compatibility_digest),
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
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await tx`
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
  });
}

export async function consumeTransferGrantRecord(input: {
  grantId: string;
  tenantId: string;
  cellId: string;
  operation: "upload" | "download";
}): Promise<boolean> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await tx`
    /* exomem:consume-transfer-grant */
    UPDATE exomem_transfer_grants AS grant_row
    SET consumed_at = now()
    FROM exomem_tenants AS tenant
    JOIN exomem_cells AS cell
      ON cell.id = tenant.bound_cell_id AND cell.tenant_id = tenant.id
    WHERE grant_row.id = ${input.grantId}
      AND grant_row.tenant_id = ${input.tenantId}
      AND grant_row.cell_id = ${input.cellId}
      AND grant_row.operation = ${input.operation}
      AND grant_row.audience = 'exomem-hosted-transfer'
      AND grant_row.consumed_at IS NULL
      AND grant_row.revoked_at IS NULL
      AND grant_row.expires_at > now()
      AND tenant.id = grant_row.tenant_id
      AND tenant.owner_user_id = grant_row.user_id
      AND tenant.status = 'active'
      AND tenant.desired_state = 'running'
      AND tenant.deleted_at IS NULL
      AND cell.id = grant_row.cell_id
      AND cell.lifecycle_state = 'active'
      AND cell.routing_state = 'bound'
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = tenant.id AND block.owner_user_id = tenant.owner_user_id
      )
    RETURNING grant_row.id
  `;
    return rows.length === 1;
  });
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
