/**
 * Exomem Cloud admission (design D1, `adopt-exomem-cloud-plain-cells`).
 *
 * An invite redemption creates the tenant, its entitlement and one
 * `exomem_cloud_cells` row under a plain capacity check.
 */

import { randomBytes } from "node:crypto";
import { cloudAdmissionAllows, lockCloudCapacity } from "./cloud-capacity";
import { CLOUD_SWEEP_PADDLE_BUDGET_MS, loadExomemCloudResource } from "./cloud-config";
import { revokeCloudResourceConsent } from "./cloud-consent";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { enqueueExomemEmail } from "./email-outbox";
import { FIRST_PAYMENT_SOURCE_STATES, LIVE_SUBSCRIPTION_SOURCE_STATES } from "./entitlements";
import { ExomemHostedError, exomemErrors } from "./errors";
import { recordInvitationUse } from "./invites";
import {
  cancelExomemCheckoutTransaction,
  paddleTransportUntil,
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
 * `HOSTED_ADMISSION_CLOSED`, 503, retryable: the public code clients already
 * handle for closed admission.
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

/**
 * A redemption fits when Cloud has a free slot once this address's own
 * invitations are left out (the invitation turns into the cell it creates),
 * counting only invitations issued before this one.
 */
async function requireCloudAdmissionCapacity(
  tx: ExomemSql,
  invite: { email_normalized: string }
): Promise<void> {
  const allowed = await cloudAdmissionAllows(tx, {
    email: invite.email_normalized,
    yieldOnlyToOlderInvitations: true,
  });
  if (!allowed) throw cloudAdmissionClosed();
}

/**
 * A repeat start request leaves the person's earlier start links valid, so
 * using one of them revokes the others: the address now owns its cell and
 * holds no further promise.
 */
async function revokeSiblingStartLinks(
  tx: ExomemSql,
  email: string,
  consumedInviteId: string
): Promise<void> {
  await tx`
    /* exomem-cloud:revoke-sibling-start-links */
    UPDATE exomem_invites SET revoked_at = now()
    WHERE email_normalized = ${email}
      AND self_serve
      AND id <> ${consumedInviteId}::uuid
      AND consumed_at IS NULL
      AND revoked_at IS NULL
  `;
}

/**
 * The unpaid hold (design D1): a paid admission that has not paid keeps its
 * stopped cell, and its slot, for this many days from the cell's creation.
 * Measured from the cell, not the tenant, because a re-admitted tenant keeps
 * its first `created_at`.
 */
const CLOUD_UNPAID_HOLD_DAYS = 7;
// Email 18 goes out this many days before the hold ends.
const HOLD_REMINDER_LEAD_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Inserts the tenant's new Cloud cell. A paid admission's cell starts
 * stopped, and its hold reminder is enqueued in the same transaction: it is
 * sent once, and only if the cell is still stopped and unpaid when it is due.
 */
async function createCloudCell(
  tx: ExomemSql,
  input: {
    tenantId: string;
    desiredState: "running" | "stopped";
    recipient: string;
    recipientTimeZone: string | null;
    /** Who invited them, for email 18; `null` for a self-serve start. */
    inviterName: string | null;
  }
): Promise<string | null> {
  const cellResult = await tx`
    INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state)
    VALUES (${randomCloudCellId()}, ${input.tenantId}::uuid, ${input.desiredState})
    RETURNING cell_id, created_at
  `;
  const cell = cellResult.rows[0] as { cell_id: string; created_at: Date } | undefined;
  if (!cell) return null;
  if (input.desiredState === "stopped") {
    const createdAt = new Date(cell.created_at).getTime();
    const holdEndsAt = new Date(createdAt + CLOUD_UNPAID_HOLD_DAYS * DAY_MS);
    await enqueueExomemEmail(tx, {
      kind: "hold_reminder",
      dedupeKey: `hold-reminder:${cell.cell_id}`,
      recipient: input.recipient,
      recipientTimeZone: input.recipientTimeZone,
      payload: {
        version: 1,
        cellId: cell.cell_id,
        holdEndsAt: holdEndsAt.toISOString(),
        inviterName: input.inviterName,
      },
      notBefore: new Date(holdEndsAt.getTime() - HOLD_REMINDER_LEAD_DAYS * DAY_MS),
      expiresAt: holdEndsAt,
    });
  }
  return cell.cell_id;
}

export type RedeemCloudInviteInput = {
  tokenDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
  /** The redeeming browser's time zone, already normalized. */
  timeZone?: string | null;
};

export type RedeemedCloudAccess = {
  userId: string;
  tenantId: string;
  sessionId: string;
  cellId: string;
  /** A paid admission still has to subscribe before its cell starts. */
  paid: boolean;
};

type LockedCloudInvite = {
  id: string;
  email_normalized: string;
  entitlement_source: "complimentary" | "paddle";
  entitlement_capabilities: string[];
  entitlement_limits: Record<string, number>;
  marketplace_reviewer_purpose: boolean;
  recipient_time_zone: string | null;
};

/**
 * Redeems a Cloud invite: invite validity, account-block and tenant-dedupe
 * checks, then a capacity check under
 * `pg_advisory_xact_lock(hashtext('exomem-cloud-capacity'))` (D1), taken
 * before any write-bearing statement. Returns `null` for "no such invite";
 * throws `HOSTED_ADMISSION_CLOSED` when capacity is exhausted, leaving the
 * invite unconsumed since the whole transaction rolls back.
 */
export async function redeemCloudInviteAtomic(
  input: RedeemCloudInviteInput
): Promise<RedeemedCloudAccess | null> {
  return withExomemTransaction(async (tx: ExomemSql) => {
    await lockCloudCapacity(tx);

    const inviteResult = await tx`
      /* exomem-cloud:lock-invite */
      SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits, marketplace_reviewer_purpose,
             recipient_time_zone
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
    await requireCloudAdmissionCapacity(tx, invite);
    const timeZone = input.timeZone ?? invite.recipient_time_zone;

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

    if (await ownerHasAdmissionBlock(tx, owner.id)) throw exomemErrors.accessTokenInvalid();

    // Security review finding 4: a cell-less tenant within the re-admission
    // scope is reused under this same capacity check, with its admission
    // columns reset (a fully-deleted prior cell leaves status/desired_state/
    // deleted_at at 'deleted', which a fresh admission must not inherit).
    const existing = await lockExistingCloudTenant(
      tx,
      owner.id,
      invite.marketplace_reviewer_purpose
    );
    if (existing === REFUSED) throw exomemErrors.accessTokenInvalid();

    let tenantId: string;
    if (existing) {
      await tx`
        UPDATE exomem_tenants
        SET status = 'provisioning', desired_state = 'running', deleted_at = NULL,
            time_zone = COALESCE(${timeZone}, time_zone)
        WHERE id = ${existing.id}::uuid
      `;
      await clearLifecycleDeletionBlock(tx, existing.id);
      tenantId = existing.id;
    } else {
      const tenantResult = await tx`
        INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose, time_zone)
        VALUES (${owner.id}::uuid, 'provisioning', 'running', ${invite.marketplace_reviewer_purpose}, ${timeZone})
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
          provider_environment = NULL,
          provider_price_id = NULL,
          provider_price_name = NULL,
          provider_next_billed_at = NULL,
          provider_discount_id = NULL,
          provider_scheduled_change_at = NULL,
          grace_started_at = NULL,
          updated_at = now()
      RETURNING tenant_id
    `;
    if (!entitlementResult.rows[0]) throw exomemErrors.accessTokenInvalid();

    const cellId = await createCloudCell(tx, {
      tenantId,
      desiredState: desiredCellState,
      recipient: invite.email_normalized,
      recipientTimeZone: timeZone,
      // The hold reminder reads the inviter's name from this invitation when
      // it is sent, so deleting the inviter's account also removes it there.
      inviterName: null,
    });
    if (!cellId) throw exomemErrors.accessTokenInvalid();

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
    await revokeSiblingStartLinks(tx, invite.email_normalized, invite.id);
    await recordInvitationUse(tx, { inviteId: invite.id, tenantId });

    return { userId: owner.id, tenantId, sessionId: session.id, cellId, paid: !isComplimentary };
  });
}

const REFUSED = Symbol("cloud-readmission-refused");

/**
 * Every account block bars Cloud admission except the one the hosted alpha's
 * lifecycle deletion wrote (`lifecycle_deleted`). That block guards the
 * deleted tenant's old credentials, not the person: Cloud re-admits deleted
 * tenants (design D1), and those credentials are already revoked. Any other
 * reason, including one added later, refuses.
 */
async function ownerHasAdmissionBlock(tx: ExomemSql, ownerUserId: string): Promise<boolean> {
  const { rows } = await tx`
    SELECT 1 FROM exomem_oauth_account_blocks
    WHERE owner_user_id = ${ownerUserId}::uuid AND blocked_reason <> 'lifecycle_deleted'
  `;
  return rows.length > 0;
}

/**
 * A re-admitted tenant reuses its row, and the Cloud OAuth checks refuse any
 * tenant that still carries a block, so the lifecycle block goes with the
 * admission. Any other block has already refused admission.
 */
async function clearLifecycleDeletionBlock(tx: ExomemSql, tenantId: string): Promise<void> {
  await tx`
    DELETE FROM exomem_oauth_account_blocks
    WHERE tenant_id = ${tenantId}::uuid AND blocked_reason = 'lifecycle_deleted'
  `;
}

/**
 * Locks the owner's prior tenant, if any, and decides whether a fresh invite
 * may reuse it (Cloud design D1 "Re-admission scope"). Returns `undefined`
 * for an owner with no tenant, the tenant for one that may be re-admitted,
 * and `REFUSED` otherwise, which the caller turns into its own refusal so the
 * invite is left unconsumed.
 *
 * Re-admission applies only to a tenant with no live cell whose status is
 * `deleted`, or to a pre-payment tenant (`awaiting_checkout` or
 * `checkout_pending`). A `deletion_pending` tenant, or one with a live
 * provider subscription, is never re-admitted: its deletion or its billing
 * is still in flight. exomem_tenants.owner_user_id is UNIQUE, so this row is
 * the tenant-dedupe check, and FOR UPDATE serializes a concurrent redemption
 * for the same owner against the same lock.
 */
async function lockExistingCloudTenant(
  tx: ExomemSql,
  ownerUserId: string,
  reviewerPurpose: boolean
): Promise<{ id: string } | undefined | typeof REFUSED> {
  const { rows } = await tx`
    SELECT tenant.id, tenant.status, tenant.marketplace_reviewer_purpose,
           entitlement.source_state, entitlement.provider_subscription_ref,
           EXISTS (
             SELECT 1 FROM exomem_cloud_cells AS cell
             WHERE cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
           ) AS has_live_cell
    FROM exomem_tenants AS tenant
    LEFT JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
    WHERE tenant.owner_user_id = ${ownerUserId}::uuid
    FOR UPDATE OF tenant
  `;
  const row = rows[0] as
    | {
        id: string;
        status: string;
        marketplace_reviewer_purpose: boolean;
        source_state: string | null;
        provider_subscription_ref: string | null;
        has_live_cell: boolean;
      }
    | undefined;
  if (!row) return undefined;
  if (row.marketplace_reviewer_purpose !== reviewerPurpose) return REFUSED;
  if (row.has_live_cell || row.status === "deletion_pending") return REFUSED;
  const liveSubscription =
    row.provider_subscription_ref !== null &&
    (LIVE_SUBSCRIPTION_SOURCE_STATES as readonly string[]).includes(row.source_state ?? "");
  if (liveSubscription) return REFUSED;
  const prePayment =
    row.source_state === "awaiting_checkout" || row.source_state === "checkout_pending";
  if (row.status === "deleted" || prePayment) return { id: row.id };
  return REFUSED;
}

export type RedeemedCloudBrowserAccess = RedeemedCloudAccess & SessionMaterial;

/**
 * The browser-facing wrapper `/api/exomem/access/redeem`'s plain (non-OAuth-
 * continuation) branch calls: mints session material and calls
 * `redeemCloudInviteAtomic`.
 */
export async function redeemCloudInvite(
  token: string,
  options: { timeZone?: string | null } = {}
): Promise<RedeemedCloudBrowserAccess> {
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const session = mintSessionMaterial();
  const row = await redeemCloudInviteAtomic({
    tokenDigest: digest,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    sessionExpiresAt: session.expiresAt,
    timeZone: options.timeZone ?? null,
  });
  if (!row) throw exomemErrors.accessTokenInvalid();
  return { ...row, ...session };
}

class CloudOAuthAdmissionRejected extends Error {}

export type CloudOAuthInviteAdmission = {
  tenantId: string;
  sessionId: string;
  /** Null for a paid invite: it is admitted and signed in, but gets no grant or code
   *  and leaves the OAuth transaction open until its first payment settles. */
  grantId: string | null;
  cellId: string;
};

/**
 * The OAuth-continuation admission `/api/exomem/access/redeem` and
 * `/api/exomem/oauth/authorize/invite` both call for a first-time invite that
 * arrived via an OAuth client's "connect" flow. It consumes the invite, binds
 * the OAuth transaction, and issues the grant and authorization code, with the
 * same plain capacity-gated cell creation `redeemCloudInviteAtomic` uses.
 *
 * A paid invite pays before its first grant. It is admitted with the same
 * tenant, cell and session, but no grant or code is written and the OAuth
 * transaction stays unconsumed, so the consent page can continue at checkout
 * and connect once the payment settles.
 */
export async function admitFirstCloudOAuthInviteAtomic(input: {
  inviteDigest: Buffer;
  transactionDigest: Buffer;
  sessionDigest: Buffer;
  csrfDigest: Buffer;
  sessionExpiresAt: Date;
  codeDigest: Buffer;
  codeExpiresAt: Date;
  /** The redeeming browser's time zone, already normalized. */
  timeZone?: string | null;
}): Promise<CloudOAuthInviteAdmission | null> {
  try {
    // Security review finding 15: without this, an OAuth transaction minted
    // for any resource (e.g. the hosted resource) could be consumed through
    // the Cloud admission path, binding the resulting grant/code to
    // whatever resource that transaction actually named. Loaded once,
    // outside the transaction, so a misconfigured Cloud deployment fails
    // this call the same way every other Cloud entry point does.
    const cloudResource = loadExomemCloudResource().mcpUrl;
    return await withExomemTransaction(async (tx: ExomemSql) => {
      await lockCloudCapacity(tx);

      const inviteResult = await tx`
        SELECT id, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits, marketplace_reviewer_purpose,
               recipient_time_zone
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
          AND (client.admission_mode = 'pinned' OR exomem_oauth_generic_client_admitted(client.admission_mode) OR (
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

      await requireCloudAdmissionCapacity(tx, invite);
      const timeZone = input.timeZone ?? invite.recipient_time_zone;

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

      if (await ownerHasAdmissionBlock(tx, owner.id)) throw new CloudOAuthAdmissionRejected();

      // See redeemCloudInviteAtomic's matching block.
      const existing = await lockExistingCloudTenant(
        tx,
        owner.id,
        invite.marketplace_reviewer_purpose
      );
      if (existing === REFUSED) throw new CloudOAuthAdmissionRejected();

      let tenantId: string;
      if (existing) {
        await tx`
          UPDATE exomem_tenants
          SET status = 'provisioning', desired_state = 'running', deleted_at = NULL,
              time_zone = COALESCE(${timeZone}, time_zone)
          WHERE id = ${existing.id}::uuid
        `;
        await clearLifecycleDeletionBlock(tx, existing.id);
        tenantId = existing.id;
      } else {
        const tenantResult = await tx`
          INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose, time_zone)
          VALUES (${owner.id}::uuid, 'provisioning', 'running', ${invite.marketplace_reviewer_purpose}, ${timeZone})
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
            provider_environment = NULL,
            provider_price_id = NULL,
            provider_price_name = NULL,
            provider_next_billed_at = NULL,
            provider_discount_id = NULL,
            provider_scheduled_change_at = NULL,
            grace_started_at = NULL,
            updated_at = now()
        RETURNING tenant_id
      `;
      if (!entitlementResult.rows[0]) throw new CloudOAuthAdmissionRejected();

      const cellId = await createCloudCell(tx, {
        tenantId,
        desiredState: desiredCellState,
        recipient: invite.email_normalized,
        recipientTimeZone: timeZone,
        // See redeemCloudInviteAtomic's matching call.
        inviterName: null,
      });
      if (!cellId) throw new CloudOAuthAdmissionRejected();

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

      if (!isComplimentary) {
        await consumeCloudOAuthInvite(tx, invite, owner.id, tenantId, session.id);
        return { tenantId, sessionId: session.id, grantId: null, cellId };
      }

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

      await consumeCloudOAuthInvite(tx, invite, owner.id, tenantId, session.id);
      const consumedTransaction = await tx`
        UPDATE exomem_oauth_authorization_transactions
        SET consumed_at = now(), redeemed_session_id = ${session.id}::uuid
        WHERE id = ${authorization.id}::uuid AND consumed_at IS NULL
        RETURNING id
      `;
      if (!consumedTransaction.rows[0]) throw new CloudOAuthAdmissionRejected();

      return { tenantId, sessionId: session.id, grantId: grant.id, cellId };
    });
  } catch (error) {
    if (error instanceof ExomemHostedError) throw error;
    if (error instanceof CloudOAuthAdmissionRejected) return null;
    if (typeof error === "object" && error && "code" in error && error.code === "23505") return null;
    throw error;
  }
}

async function consumeCloudOAuthInvite(
  tx: ExomemSql,
  invite: LockedCloudInvite,
  ownerUserId: string,
  tenantId: string,
  sessionId: string
): Promise<void> {
  const consumed = await tx`
    UPDATE exomem_invites SET consumed_at = now(), consumed_by_user_id = ${ownerUserId}::uuid,
      redeemed_tenant_id = ${tenantId}::uuid, redeemed_session_id = ${sessionId}::uuid
    WHERE id = ${invite.id}::uuid AND consumed_at IS NULL RETURNING id
  `;
  if (!consumed.rows[0]) throw new CloudOAuthAdmissionRejected();
  await revokeSiblingStartLinks(tx, invite.email_normalized, invite.id);
  await recordInvitationUse(tx, { inviteId: invite.id, tenantId });
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
      AND entitlement.source_state = ANY(${[...FIRST_PAYMENT_SOURCE_STATES]}::text[])
      AND cell.desired_state = 'stopped'
      AND cell.created_at <= now() - (${expiryDays} * interval '1 day')
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

/**
 * Sets a Cloud cell's row to `deleted`, releasing its capacity slot, and
 * revokes the tenant's Cloud consent in the same transaction (D2).
 */
async function expireCloudCellAtomic(tenantId: string): Promise<boolean> {
  return withExomemTransaction(async (tx) => {
    const { rowCount } = await tx`
      /* exomem-cloud:expire-cell */
      UPDATE exomem_cloud_cells
      SET desired_state = 'deleted'
      WHERE tenant_id = ${tenantId}::uuid
        AND desired_state = 'stopped'
    `;
    if ((rowCount ?? 0) === 0) return false;
    await revokeCloudResourceConsent(tx, tenantId);
    return true;
  });
}

export type CloudInviteExpiryOutcome =
  | { tenantId: string; outcome: "expired" }
  | { tenantId: string; outcome: "activated" }
  | { tenantId: string; outcome: "skipped" }
  /** Paddle time ran out before this tenant's checkout was settled; the next tick tries again. */
  | { tenantId: string; outcome: "deferred" };

export type CloudInviteExpiryDependencies = {
  cancelTransaction?: typeof cancelExomemCheckoutTransaction;
  transport?: PaddleTransport;
  expiryDays?: number;
  config?: ExomemPaddleConfig;
  /** Paddle time for the whole batch. */
  budgetMs?: number;
};

/**
 * D1's 7-day expiry, counted from the stopped cell's creation: a tenant that
 * has still not paid for the first time after the window (no checkout, or a
 * checkout opened and abandoned) first has its pending provider transaction
 * cancelled. If the provider
 * reports the transaction already completed, the tenant is left alone for
 * the activation webhook to set `running` as usual — this function does
 * not activate it itself, to keep "the webhook is what activates" a single
 * code path. Otherwise the row is expired (`deleted`), releasing the slot.
 *
 * Every Paddle call of the batch shares one deadline, so a slow Paddle costs
 * the cron at most the budget. A tenant whose checkout the budget does not
 * settle stays stopped, holding its slot, until the next tick.
 */
export async function expireCloudAwaitingCheckoutTenants(
  dependencies: CloudInviteExpiryDependencies = {}
): Promise<CloudInviteExpiryOutcome[]> {
  const cancelTransaction = dependencies.cancelTransaction ?? cancelExomemCheckoutTransaction;
  const expiryDays = dependencies.expiryDays ?? CLOUD_UNPAID_HOLD_DAYS;
  const tenants = await findExpiredCloudAwaitingCheckoutTenants(expiryDays);
  const outcomes: CloudInviteExpiryOutcome[] = [];
  const deadline = AbortSignal.timeout(dependencies.budgetMs ?? CLOUD_SWEEP_PADDLE_BUDGET_MS);
  const transport = paddleTransportUntil(deadline, dependencies.transport);
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
      if (deadline.aborted) {
        outcomes.push({ tenantId: tenant.tenantId, outcome: "deferred" });
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
        { config, transport }
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
      if (deadline.aborted) {
        outcomes.push({ tenantId: tenant.tenantId, outcome: "deferred" });
        continue;
      }
      console.error("exomem-cloud: awaiting-checkout expiry failed for one tenant");
    }
  }
  return outcomes;
}
