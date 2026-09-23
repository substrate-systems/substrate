/**
 * Exomem Cloud admission (design D1, `adopt-exomem-cloud-plain-cells`).
 *
 * Additive and gated: nothing here is called from any hosted code path, and
 * this module imports no hosted admission function. `redeemInviteAtomic` and
 * `admitFirstOAuthInviteAtomic` (db.ts / oauth-store.ts) keep their v2
 * contract-candidate, cohort and capacity-pool machinery entirely unchanged;
 * Cloud admission is a parallel, much smaller redemption that targets
 * `exomem_cloud_cells` instead, matching D1's replacement of the live-target
 * snapshot and cohort lock with a plain capacity check.
 */

import { randomBytes } from "node:crypto";
import { loadExomemCloudConfig } from "./cloud-config";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { ExomemHostedError, exomemErrors } from "./errors";
import {
  cancelExomemCheckoutTransaction,
  type PaddleTransport,
} from "./paddle-billing";
import {
  loadExomemPaddleTransactionConfig,
  type ExomemPaddleConfig,
  type ExomemPaddleEnvironment,
} from "./paddle-config";
import { tokenDigest } from "./security";
import { mintSessionMaterial, type SessionMaterial } from "./sessions";

// 16 lowercase base32 characters (a-z2-7), matching migration 0056's
// `exomem_cloud_cells_cell_id_check`.
const CELL_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CELL_ID_LENGTH = 16;

export function randomCloudCellId(): string {
  const bytes = randomBytes(CELL_ID_LENGTH);
  let id = "";
  for (let index = 0; index < CELL_ID_LENGTH; index += 1) {
    id += CELL_ID_ALPHABET[bytes[index]! % CELL_ID_ALPHABET.length];
  }
  return id;
}

/**
 * `HOSTED_ADMISSION_CLOSED`, 503, retryable — the same code and shape hosted
 * admission raises on cohort closure (errors.ts), so callers do not need a
 * second error code to handle. Cloud's own reason is Cloud-only, so it does
 * not extend `AdmissionClosureReason` (which is a closed hosted-cohort
 * vocabulary) — it just borrows the public contract.
 */
function cloudAdmissionClosed(): ExomemHostedError {
  return new ExomemHostedError({
    code: "HOSTED_ADMISSION_CLOSED",
    status: 503,
    message: "hosted admission is temporarily closed",
    retryable: true,
    remediation:
      "Your invitation is still valid and has not been used. Exomem Cloud is not admitting " +
      "new accounts until more capacity is published. Open the link again later, or tell " +
      "whoever invited you.",
  });
}

export type RedeemCloudInviteInput = {
  tokenDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
};

export type RedeemedCloudAccess = {
  userId: string;
  tenantId: string;
  sessionId: string;
  cellId: string;
};

type LockedCloudInvite = {
  id: string;
  email_normalized: string;
  entitlement_source: "complimentary" | "paddle";
  entitlement_capabilities: string[];
  entitlement_limits: Record<string, number>;
};

/**
 * Redeems a Cloud invite: invite validity, account-block and tenant-dedupe
 * checks are preserved from the hosted flow's shape, but the live-target
 * snapshot and cohort advisory lock are replaced with a capacity check under
 * `pg_advisory_xact_lock(hashtext('exomem-cloud-capacity'))` (D1), taken
 * before any write-bearing statement. Returns `null` for "no such invite"
 * (mirroring `redeemInviteAtomic`); throws `HOSTED_ADMISSION_CLOSED` when
 * capacity is exhausted, leaving the invite unconsumed since the whole
 * transaction rolls back.
 */
export async function redeemCloudInviteAtomic(
  input: RedeemCloudInviteInput
): Promise<RedeemedCloudAccess | null> {
  return withExomemTransaction(async (tx: ExomemSql) => {
    // Exclusive, not shared: capacity is an aggregate over many rows (a
    // COUNT against a SUM), so only a genuinely serializing lock prevents
    // two concurrent redemptions both observing the last free slot.
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-cloud-capacity'))`;

    const inviteResult = await tx`
      /* exomem-cloud:lock-invite */
      SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits
      FROM exomem_invites
      WHERE token_digest = ${input.tokenDigest}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      FOR UPDATE
    `;
    const invite = inviteResult.rows[0] as LockedCloudInvite | undefined;
    if (!invite) return null;

    // Capacity check: no write-bearing statement has run yet.
    const capacityResult = await tx`
      /* exomem-cloud:capacity-check */
      SELECT
        (SELECT COALESCE(SUM(cell_slots), 0) FROM exomem_cloud_capacity) AS total_slots,
        (SELECT COUNT(*) FROM exomem_cloud_cells WHERE desired_state <> 'deleted') AS used_slots
    `;
    const capacity = capacityResult.rows[0] as { total_slots: string; used_slots: string };
    if (Number(capacity.used_slots) >= Number(capacity.total_slots)) {
      throw cloudAdmissionClosed();
    }

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

    const blockedResult = await tx`
      SELECT 1 FROM exomem_oauth_account_blocks WHERE owner_user_id = ${owner.id}::uuid
    `;
    if (blockedResult.rows[0]) throw exomemErrors.accessTokenInvalid();

    // exomem_tenants.owner_user_id is UNIQUE, so a prior tenant for this
    // owner is the tenant-dedupe check; FOR UPDATE serializes a second
    // concurrent redemption for the same owner against this same lock.
    // Security review finding 4: the dedupe check used to reject ANY prior
    // tenant, even one whose Cloud cell was fully expired/deleted — meaning
    // an owner who never paid, or whose export window elapsed, could never
    // be re-admitted by a fresh invite. It now rejects only a tenant that
    // still has a live (non-deleted) cell; a cell-less tenant is reused
    // under this same capacity check, with its admission columns reset
    // (a fully-deleted prior cell leaves status/desired_state/deleted_at at
    // 'deleted', which a fresh admission must not inherit).
    const existingTenant = await tx`
      SELECT tenant.id,
             EXISTS (
               SELECT 1 FROM exomem_cloud_cells AS cell
               WHERE cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
             ) AS has_live_cell
      FROM exomem_tenants AS tenant
      WHERE tenant.owner_user_id = ${owner.id}::uuid
      FOR UPDATE
    `;
    const existing = existingTenant.rows[0] as { id: string; has_live_cell: boolean } | undefined;
    if (existing?.has_live_cell) throw exomemErrors.accessTokenInvalid();

    let tenantId: string;
    if (existing) {
      await tx`
        UPDATE exomem_tenants
        SET status = 'provisioning', desired_state = 'running', deleted_at = NULL
        WHERE id = ${existing.id}::uuid
      `;
      tenantId = existing.id;
    } else {
      const tenantResult = await tx`
        INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
        VALUES (${owner.id}::uuid, 'provisioning', 'running')
        RETURNING id
      `;
      const tenant = tenantResult.rows[0] as { id: string } | undefined;
      if (!tenant) throw exomemErrors.accessTokenInvalid();
      tenantId = tenant.id;
    }

    // D1/D4: a complimentary invite starts running; a paid invite is
    // awaiting_checkout and starts stopped, holding its capacity slot from
    // redemption (the row already counts against `used_slots` above).
    const isComplimentary = invite.entitlement_source === "complimentary";
    const desiredCellState = isComplimentary ? "running" : "stopped";
    const sourceState = isComplimentary ? "complimentary_active" : "awaiting_checkout";
    const effectiveState = isComplimentary ? "active" : "provisioning";

    // exomem_entitlements.tenant_id is UNIQUE: a re-admitted (existing,
    // cell-less) tenant already has a row from its prior admission cycle, so
    // a plain INSERT here would violate that constraint the moment the
    // dedupe check above starts allowing re-admission (security review
    // finding 4, caught by this round's red-first re-admission test). The
    // upsert resets every provider-provenance and suspension column, not
    // just the ones this admission sets explicitly -- a fresh admission must
    // not inherit a manual suspension, or a Paddle customer/subscription/
    // transaction ref, from a subscription cycle that already ended.
    const entitlementResult = await tx`
      INSERT INTO exomem_entitlements (
        tenant_id, source, source_state, effective_state, capabilities, resource_limits
      ) VALUES (
        ${tenantId}::uuid, ${invite.entitlement_source}, ${sourceState}, ${effectiveState},
        ${JSON.stringify(invite.entitlement_capabilities)}::jsonb,
        ${JSON.stringify(invite.entitlement_limits)}::jsonb
      )
      ON CONFLICT (tenant_id) DO UPDATE
      SET source = EXCLUDED.source,
          source_state = EXCLUDED.source_state,
          effective_state = EXCLUDED.effective_state,
          capabilities = EXCLUDED.capabilities,
          resource_limits = EXCLUDED.resource_limits,
          manual_suspended_at = NULL,
          source_revision = NULL,
          source_occurred_at = NULL,
          provider_customer_ref = NULL,
          provider_subscription_ref = NULL,
          provider_transaction_ref = NULL,
          updated_at = now()
      RETURNING tenant_id
    `;
    if (!entitlementResult.rows[0]) throw exomemErrors.accessTokenInvalid();

    const cellId = randomCloudCellId();
    const cellResult = await tx`
      INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state)
      VALUES (${cellId}, ${tenantId}::uuid, ${desiredCellState})
      RETURNING cell_id
    `;
    if (!cellResult.rows[0]) throw exomemErrors.accessTokenInvalid();

    const sessionResult = await tx`
      INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
      VALUES (
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

    return { userId: owner.id, tenantId, sessionId: session.id, cellId };
  });
}

export type RedeemedCloudBrowserAccess = {
  userId: string;
  tenantId: string;
  sessionId: string;
  /** Never present on the Cloud path -- kept only so callers that branch on
   *  the hosted `RedeemedAccess` shape (`redeemed.operationId ? ... : {}`)
   *  need no Cloud-specific special case. */
  operationId: null;
  cellId: string;
} & SessionMaterial;

/**
 * The browser-facing wrapper `/api/exomem/access/redeem`'s plain (non-OAuth-
 * continuation) branch calls under `EXOMEM_CLOUD_ENABLED` -- mints session
 * material and calls `redeemCloudInviteAtomic`, exactly mirroring what
 * `redeemInvite` (access.ts) does for the hosted path, so the route needs no
 * shape-specific branching beyond which function it calls.
 */
export async function redeemCloudInvite(token: string): Promise<RedeemedCloudBrowserAccess> {
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const session = mintSessionMaterial();
  const row = await redeemCloudInviteAtomic({
    tokenDigest: digest,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    sessionExpiresAt: session.expiresAt,
  });
  if (!row) throw exomemErrors.accessTokenInvalid();
  return { ...row, operationId: null, ...session };
}

class CloudOAuthAdmissionRejected extends Error {}

export type CloudOAuthInviteAdmission = {
  tenantId: string;
  sessionId: string;
  grantId: string;
  cellId: string;
};

/**
 * The OAuth-continuation admission `/api/exomem/access/redeem` and
 * `/api/exomem/oauth/authorize/invite` both call under `EXOMEM_CLOUD_ENABLED`
 * for a first-time invite that arrived via an OAuth client's "connect" flow.
 * Mirrors `admitFirstOAuthInviteAtomic`'s invite + OAuth-transaction + grant +
 * authorization-code shape exactly (same tables -- OAuth client/transaction
 * admission is shared infrastructure, not something C1-C1d replaces), but
 * replaces its contract-candidate / lifecycle-operation / reviewer-bootstrap
 * machinery with the same plain capacity-gated cell creation
 * `redeemCloudInviteAtomic` uses: none of that hosted-only routing exists for
 * a Cloud cell.
 */
export async function admitFirstCloudOAuthInviteAtomic(input: {
  inviteDigest: Buffer;
  transactionDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
  codeDigest: Buffer;
  codeExpiresAt: Date;
}): Promise<CloudOAuthInviteAdmission | null> {
  try {
    // Security review finding 15: without this, an OAuth transaction minted
    // for any resource (e.g. the hosted resource) could be consumed through
    // the Cloud admission path, binding the resulting grant/code to
    // whatever resource that transaction actually named. Loaded once,
    // outside the transaction, so a misconfigured Cloud deployment fails
    // this call the same way every other Cloud entry point does.
    const cloudResource = loadExomemCloudConfig().mcpUrl;
    return await withExomemTransaction(async (tx: ExomemSql) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-cloud-capacity'))`;

      const inviteResult = await tx`
        SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits
        FROM exomem_invites
        WHERE token_digest = ${input.inviteDigest}
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE
      `;
      const invite = inviteResult.rows[0] as LockedCloudInvite | undefined;
      if (!invite) throw new CloudOAuthAdmissionRejected();

      const authorizationResult = await tx`
        SELECT transaction.id, transaction.client_id, transaction.redirect_uri,
               transaction.resource, transaction.requested_scopes, transaction.pkce_challenge
        FROM exomem_oauth_authorization_transactions AS transaction
        JOIN exomem_oauth_clients AS client ON client.id = transaction.client_id
          AND client.enabled = true
          AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
        LEFT JOIN LATERAL (
          SELECT admitted.host
          FROM exomem_oauth_admitted_cimd_hosts AS admitted
          WHERE admitted.platform = client.client_platform
            AND admitted.host = client.cimd_host
          FOR KEY SHARE
        ) AS admitted_host ON true
        WHERE transaction.transaction_digest = ${input.transactionDigest}
          AND transaction.consumed_at IS NULL AND transaction.expires_at > now()
          AND transaction.resource = ${cloudResource}
          AND (client.admission_mode = 'pinned' OR (
            client.metadata_document_digest IS NOT NULL AND client.metadata_fetched_at IS NOT NULL
            AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
            AND client.metadata_expires_at > now() AND client.cimd_host IS NOT NULL
            AND admitted_host.host IS NOT NULL
          ))
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
      if (!authorization) throw new CloudOAuthAdmissionRejected();

      const capacityResult = await tx`
        SELECT
          (SELECT COALESCE(SUM(cell_slots), 0) FROM exomem_cloud_capacity) AS total_slots,
          (SELECT COUNT(*) FROM exomem_cloud_cells WHERE desired_state <> 'deleted') AS used_slots
      `;
      const capacity = capacityResult.rows[0] as { total_slots: string; used_slots: string };
      if (Number(capacity.used_slots) >= Number(capacity.total_slots)) {
        throw cloudAdmissionClosed();
      }

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
      if (!owner) throw new CloudOAuthAdmissionRejected();

      const blockedResult = await tx`
        SELECT 1 FROM exomem_oauth_account_blocks WHERE owner_user_id = ${owner.id}::uuid
      `;
      if (blockedResult.rows[0]) throw new CloudOAuthAdmissionRejected();

      // See redeemCloudInviteAtomic's matching block: security review
      // finding 4 -- reuse a cell-less tenant instead of permanently
      // refusing re-admission.
      const existingTenant = await tx`
        SELECT tenant.id,
               EXISTS (
                 SELECT 1 FROM exomem_cloud_cells AS cell
                 WHERE cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
               ) AS has_live_cell
        FROM exomem_tenants AS tenant
        WHERE tenant.owner_user_id = ${owner.id}::uuid
        FOR UPDATE
      `;
      const existing = existingTenant.rows[0] as { id: string; has_live_cell: boolean } | undefined;
      if (existing?.has_live_cell) throw new CloudOAuthAdmissionRejected();

      let tenantId: string;
      if (existing) {
        await tx`
          UPDATE exomem_tenants
          SET status = 'provisioning', desired_state = 'running', deleted_at = NULL
          WHERE id = ${existing.id}::uuid
        `;
        tenantId = existing.id;
      } else {
        const tenantResult = await tx`
          INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
          VALUES (${owner.id}::uuid, 'provisioning', 'running')
          RETURNING id
        `;
        const tenant = tenantResult.rows[0] as { id: string } | undefined;
        if (!tenant) throw new CloudOAuthAdmissionRejected();
        tenantId = tenant.id;
      }

      const isComplimentary = invite.entitlement_source === "complimentary";
      const desiredCellState = isComplimentary ? "running" : "stopped";
      const sourceState = isComplimentary ? "complimentary_active" : "awaiting_checkout";
      const effectiveState = isComplimentary ? "active" : "provisioning";

      // See redeemCloudInviteAtomic's matching upsert: exomem_entitlements.
      // tenant_id is UNIQUE, so a re-admitted (existing, cell-less) tenant's
      // prior row must be reset, not conflict with, a plain INSERT.
      const entitlementResult = await tx`
        INSERT INTO exomem_entitlements (
          tenant_id, source, source_state, effective_state, capabilities, resource_limits
        ) VALUES (
          ${tenantId}::uuid, ${invite.entitlement_source}, ${sourceState}, ${effectiveState},
          ${JSON.stringify(invite.entitlement_capabilities)}::jsonb,
          ${JSON.stringify(invite.entitlement_limits)}::jsonb
        )
        ON CONFLICT (tenant_id) DO UPDATE
        SET source = EXCLUDED.source,
            source_state = EXCLUDED.source_state,
            effective_state = EXCLUDED.effective_state,
            capabilities = EXCLUDED.capabilities,
            resource_limits = EXCLUDED.resource_limits,
            manual_suspended_at = NULL,
            source_revision = NULL,
            source_occurred_at = NULL,
            provider_customer_ref = NULL,
            provider_subscription_ref = NULL,
            provider_transaction_ref = NULL,
            updated_at = now()
        RETURNING tenant_id
      `;
      if (!entitlementResult.rows[0]) throw new CloudOAuthAdmissionRejected();

      const cellId = randomCloudCellId();
      const cellResult = await tx`
        INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state)
        VALUES (${cellId}, ${tenantId}::uuid, ${desiredCellState})
        RETURNING cell_id
      `;
      if (!cellResult.rows[0]) throw new CloudOAuthAdmissionRejected();

      const sessionResult = await tx`
        INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
        VALUES (
          ${owner.id}::uuid, ${tenantId}::uuid, ${input.sessionDigest}, ${input.csrfDigest},
          ${input.sessionExpiresAt.toISOString()}
        )
        RETURNING id
      `;
      const session = sessionResult.rows[0] as { id: string } | undefined;
      if (!session) throw new CloudOAuthAdmissionRejected();

      const grantResult = await tx`
        INSERT INTO exomem_oauth_grants (
          user_id, tenant_id, client_id, resource, scopes, refresh_allowed, authorization_transaction_id
        ) VALUES (
          ${owner.id}::uuid, ${tenantId}::uuid, ${authorization.client_id}::uuid, ${authorization.resource},
          ${authorization.requested_scopes.filter((scope) => scope !== "offline_access")},
          ${authorization.requested_scopes.includes("offline_access")}, ${authorization.id}::uuid
        )
        RETURNING id
      `;
      const grant = grantResult.rows[0] as { id: string } | undefined;
      if (!grant) throw new CloudOAuthAdmissionRejected();

      const codeResult = await tx`
        INSERT INTO exomem_oauth_authorization_codes (
          code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at
        ) VALUES (
          ${input.codeDigest}, ${grant.id}::uuid, ${authorization.client_id}::uuid,
          ${authorization.redirect_uri}, ${authorization.resource}, ${authorization.pkce_challenge},
          ${authorization.requested_scopes.includes("offline_access")},
          LEAST(${input.codeExpiresAt.toISOString()}::timestamptz, now() + interval '10 minutes')
        )
        RETURNING id
      `;
      if (!codeResult.rows[0]) throw new CloudOAuthAdmissionRejected();

      const consumedInvite = await tx`
        UPDATE exomem_invites SET consumed_at = now(), consumed_by_user_id = ${owner.id}::uuid,
          redeemed_tenant_id = ${tenantId}::uuid, redeemed_session_id = ${session.id}::uuid
        WHERE id = ${invite.id}::uuid AND consumed_at IS NULL RETURNING id
      `;
      const consumedTransaction = await tx`
        UPDATE exomem_oauth_authorization_transactions
        SET consumed_at = now(), redeemed_session_id = ${session.id}::uuid
        WHERE id = ${authorization.id}::uuid AND consumed_at IS NULL
        RETURNING id
      `;
      if (!consumedInvite.rows[0] || !consumedTransaction.rows[0]) {
        throw new CloudOAuthAdmissionRejected();
      }

      return { tenantId, sessionId: session.id, grantId: grant.id, cellId };
    });
  } catch (error) {
    if (error instanceof ExomemHostedError) throw error;
    if (error instanceof CloudOAuthAdmissionRejected) return null;
    if (typeof error === "object" && error && "code" in error && error.code === "23505") return null;
    throw error;
  }
}

export type CloudAwaitingCheckoutTenant = {
  tenantId: string;
  userId: string;
  transactionRef: string | null;
  providerEnvironment: ExomemPaddleEnvironment | null;
};

async function findExpiredCloudAwaitingCheckoutTenants(
  expiryDays: number
): Promise<CloudAwaitingCheckoutTenant[]> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:expired-awaiting-checkout */
    SELECT tenant.id AS tenant_id, tenant.owner_user_id,
           entitlement.provider_transaction_ref, entitlement.provider_environment
    FROM exomem_tenants AS tenant
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
    JOIN exomem_cloud_cells AS cell ON cell.tenant_id = tenant.id
    WHERE entitlement.source = 'paddle'
      AND entitlement.source_state = 'awaiting_checkout'
      AND cell.desired_state = 'stopped'
      AND tenant.created_at <= now() - (${expiryDays} * interval '1 day')
  `;
  return rows.map((row) => ({
    tenantId: String(row.tenant_id),
    userId: String(row.owner_user_id),
    transactionRef: row.provider_transaction_ref ? String(row.provider_transaction_ref) : null,
    providerEnvironment:
      row.provider_environment === "sandbox" || row.provider_environment === "production"
        ? row.provider_environment
        : null,
  }));
}

/** Sets a Cloud cell's row to `deleted`, releasing its capacity slot. */
async function expireCloudCellAtomic(tenantId: string): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem-cloud:expire-cell */
    UPDATE exomem_cloud_cells
    SET desired_state = 'deleted'
    WHERE tenant_id = ${tenantId}::uuid
      AND desired_state = 'stopped'
  `;
  return (rowCount ?? 0) > 0;
}

export type CloudInviteExpiryOutcome =
  | { tenantId: string; outcome: "expired" }
  | { tenantId: string; outcome: "activated" }
  | { tenantId: string; outcome: "skipped" };

export type CloudInviteExpiryDependencies = {
  cancelTransaction?: typeof cancelExomemCheckoutTransaction;
  transport?: PaddleTransport;
  expiryDays?: number;
  config?: ExomemPaddleConfig;
};

/**
 * D1's 7-day expiry: a tenant still `awaiting_checkout` after the window
 * first has its pending provider transaction cancelled. If the provider
 * reports the transaction already completed, the tenant is left alone for
 * the activation webhook to set `running` as usual — this function does
 * not activate it itself, to keep "the webhook is what activates" a single
 * code path. Otherwise the row is expired (`deleted`), releasing the slot.
 */
export async function expireCloudAwaitingCheckoutTenants(
  dependencies: CloudInviteExpiryDependencies = {}
): Promise<CloudInviteExpiryOutcome[]> {
  const cancelTransaction = dependencies.cancelTransaction ?? cancelExomemCheckoutTransaction;
  const expiryDays = dependencies.expiryDays ?? 7;
  const tenants = await findExpiredCloudAwaitingCheckoutTenants(expiryDays);
  const outcomes: CloudInviteExpiryOutcome[] = [];
  for (const tenant of tenants) {
    // Security review finding 8: one tenant's provider call throwing (e.g. a
    // transient Paddle error) used to abort this loop entirely, leaving
    // every tenant after it in the batch unprocessed. Each tenant's
    // handling is now isolated; a failure here is logged content-free and
    // simply skips that tenant for this tick — the next tick tries again,
    // since a failed tenant is never marked expired.
    try {
      if (!tenant.transactionRef || !tenant.providerEnvironment) {
        // No transaction was ever recorded (checkout never started) — expire
        // outright, there is nothing pending to cancel.
        await expireCloudCellAtomic(tenant.tenantId);
        outcomes.push({ tenantId: tenant.tenantId, outcome: "expired" });
        continue;
      }
      const config = dependencies.config ?? loadExomemPaddleTransactionConfig();
      const result = await cancelTransaction(
        {
          userId: tenant.userId,
          tenantId: tenant.tenantId,
          transactionId: tenant.transactionRef,
          environment: tenant.providerEnvironment,
        },
        { config, transport: dependencies.transport }
      );
      if (result.state === "completed") {
        // The provider already completed the transaction; leave the row for
        // the ordinary activation webhook rather than racing it here.
        outcomes.push({ tenantId: tenant.tenantId, outcome: "skipped" });
        continue;
      }
      await expireCloudCellAtomic(tenant.tenantId);
      outcomes.push({ tenantId: tenant.tenantId, outcome: "expired" });
    } catch {
      console.error("exomem-cloud: awaiting-checkout expiry failed for one tenant");
    }
  }
  return outcomes;
}
