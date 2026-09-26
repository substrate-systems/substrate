/**
 * The Cloud deletion finish (design D4 "Cloud deletion finish",
 * `adopt-exomem-cloud-plain-cells`).
 *
 * A Cloud tenant's confirmed account deletion never goes through the v1
 * lifecycle. Once every one of its Cloud cell rows is `deleted` (the desired
 * state, not cellctl's observed state: cellctl deletes the pod and volume from
 * the cell row alone), this cancels the provider subscription through billing
 * deletion and then scrubs the tenant in one transaction, as the v1 terminal
 * scrub did. Billing goes first because the scrub clears the references the
 * cancellation needs.
 *
 * What remains is exactly D4's receipt: the tenant row (`deleted`,
 * `deleted_at`), its entitlement without provider references, the `deleted`
 * cell rows, and the revoked OAuth grant, family and token rows. The shared
 * `users` row and its email stay.
 *
 * No OAuth account block is written, unlike the v1 local gate: Cloud
 * admission refuses a blocked owner, so a block would silently prevent the
 * re-admission D1 allows for a `deleted` tenant. Revoked consent and the
 * `deleted` tenant status already stop every token and session from being
 * reused.
 */

import { terminateExomemBillingForDeletion, type BillingDeletionTarget } from "./billing-deletion";
import { revokeCloudResourceConsent } from "./cloud-consent";
import { executeExomemSql, withExomemTransaction } from "./db";
import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import type { PaddleTransport } from "./paddle-billing";

export type CloudDeletionFinishOutcome =
  /** Billing was terminated and the tenant scrubbed by this call. */
  | "finished"
  /** Already scrubbed; nothing changed. */
  | "already_deleted"
  /** Not a Cloud tenant whose deletion is pending. */
  | "not_eligible"
  /** A Cloud cell row is not yet `deleted`; retry after the reconcile. */
  | "cell_live"
  /** Billing termination is not yet proven; nothing was scrubbed. */
  | "billing_pending"
  /** The entitlement changed after the cancellation; nothing was scrubbed. */
  | "proof_mismatch";

export type CloudDeletionFinishDependencies = {
  terminateBilling: (tenantId: string) => Promise<BillingDeletionTarget | null>;
};

// The cron lane's Paddle calls carry no timeout of their own otherwise: a
// stalled provider connection would hold the finish (and the lane's own time
// budget below) open indefinitely. `paddleFetch` itself stays untouched --
// every other Paddle caller keeps its own timeout policy -- this wraps only
// the transport this lane's billing termination uses.
export function timeoutTransport(transport: PaddleTransport, timeoutMs: number): PaddleTransport {
  return (path, init) => transport(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function defaults(): CloudDeletionFinishDependencies {
  return {
    terminateBilling: (tenantId) =>
      terminateExomemBillingForDeletion(tenantId, {
        transport: timeoutTransport(paddleFetch, 5_000),
      }),
  };
}

async function readEligibility(
  tenantId: string
): Promise<"not_eligible" | "already_deleted" | "cell_live" | "eligible"> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:deletion-finish-eligibility */
    SELECT tenant.status,
           count(cell.cell_id)::int AS cells,
           count(cell.cell_id) FILTER (WHERE cell.desired_state <> 'deleted')::int AS live_cells
    FROM exomem_tenants AS tenant
    LEFT JOIN exomem_cloud_cells AS cell ON cell.tenant_id = tenant.id
    WHERE tenant.id = ${tenantId}::uuid
    GROUP BY tenant.id, tenant.status
  `;
  const row = rows[0];
  if (!row || Number(row.cells) === 0) return "not_eligible";
  if (row.status === "deleted") return "already_deleted";
  if (row.status !== "deletion_pending") return "not_eligible";
  if (Number(row.live_cells) > 0) return "cell_live";
  return "eligible";
}

/**
 * One transaction. The tenant and its entitlement are locked, and the billing
 * proof must still match them exactly, as the v1 billing-terminated advance
 * requires: a webhook that changed the entitlement after the cancellation
 * makes this a no-op, and the next sweep retries with a fresh proof.
 */
async function scrubCloudTenant(proof: BillingDeletionTarget): Promise<boolean> {
  const scrubbed = await withExomemTransaction(async (tx) => {
    const locked = await tx`
      /* exomem-cloud:deletion-finish-lock */
      SELECT tenant.id
      FROM exomem_tenants AS tenant
      JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
      WHERE tenant.id = ${proof.tenantId}::uuid
        AND tenant.owner_user_id = ${proof.userId}::uuid
        AND tenant.status = 'deletion_pending'
        AND tenant.desired_state = 'deleted'
        AND entitlement.effective_state = 'deleted'
        AND entitlement.source IS NOT DISTINCT FROM ${proof.source}
        AND entitlement.source_state IS NOT DISTINCT FROM ${proof.sourceState}
        AND entitlement.source_revision IS NOT DISTINCT FROM ${proof.sourceRevision}
        AND entitlement.provider_environment IS NOT DISTINCT FROM ${proof.providerEnvironment}
        AND entitlement.provider_customer_ref IS NOT DISTINCT FROM ${proof.customerRef}
        AND entitlement.provider_subscription_ref IS NOT DISTINCT FROM ${proof.subscriptionRef}
        AND entitlement.provider_transaction_ref IS NOT DISTINCT FROM ${proof.transactionRef}
        AND EXISTS (SELECT 1 FROM exomem_cloud_cells AS cell WHERE cell.tenant_id = tenant.id)
        AND NOT EXISTS (
          SELECT 1 FROM exomem_cloud_cells AS cell
          WHERE cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
        )
      FOR UPDATE OF tenant, entitlement
    `;
    if (!locked.rows[0]) return false;
    const tenantId = proof.tenantId;

    await tx`
      UPDATE exomem_tenants
      SET status = 'deleted',
          desired_state = 'deleted',
          deleted_at = now(),
          bound_cell_id = NULL,
          updated_at = now()
      WHERE id = ${tenantId}::uuid
    `;
    await tx`
      UPDATE exomem_entitlements
      SET source_state = CASE WHEN source = 'paddle' THEN 'deletion_cancelled' ELSE source_state END,
          provider_environment = NULL,
          provider_provenance_unresolved_fingerprint = NULL,
          provider_customer_ref = NULL,
          provider_subscription_ref = NULL,
          provider_transaction_ref = NULL,
          effective_state = 'deleted',
          capabilities = '[]'::jsonb,
          updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid
    `;
    await tx`
      UPDATE exomem_exports
      SET state = 'deleted',
          storage_reference_ciphertext = NULL,
          storage_reference_digest = NULL,
          archive_sha256 = NULL,
          manifest_sha256 = NULL,
          archive_size = NULL,
          encryption_scheme = NULL,
          integrity_verified = NULL,
          provider_deleted_at = COALESCE(provider_deleted_at, now()),
          deleted_at = COALESCE(deleted_at, now())
      WHERE tenant_id = ${tenantId}::uuid
    `;
    // Every grant, family and token was revoked when the cell row was
    // deleted (D2); revoking again here keeps the receipt's "revoked" true
    // whichever path deleted the cell.
    await revokeCloudResourceConsent(tx, tenantId);
    // Authorization codes are not part of the receipt.
    await tx`
      DELETE FROM exomem_oauth_authorization_codes AS code
      USING exomem_oauth_grants AS grant_row
      WHERE code.grant_id = grant_row.id
        AND grant_row.tenant_id = ${tenantId}::uuid
    `;
    // A waitlist entry admitted through one of the tenant's invites must go
    // first: its admitted_invite_id would otherwise be set to NULL, which its
    // admitted-pair CHECK refuses. The entry holds only the owner's email.
    await tx`
      DELETE FROM exomem_waitlist_entries AS entry
      USING exomem_invites AS invite
      WHERE entry.admitted_invite_id = invite.id
        AND invite.redeemed_tenant_id = ${tenantId}::uuid
    `;
    // Invites before sessions: an invite's redeemed_session_id is set to NULL
    // on session delete, which its all-or-nothing consumption CHECK refuses.
    await tx`DELETE FROM exomem_invites WHERE redeemed_tenant_id = ${tenantId}::uuid`;
    // L2: rows keyed by the owner's email but never redeemed/admitted through
    // this tenant. An unconsumed invite to the deleted owner's email must not
    // stay redeemable, and an unadmitted waitlist entry must not later send
    // an admission email to someone who has deleted their account. The
    // tenant's own invite and waitlist entry are already gone above, so this
    // only ever removes rows outside the receipt.
    //
    // An invite a reviewer bootstrap authority holds (ON DELETE RESTRICT) is
    // left in place, so it can never block the scrub; it is counted and
    // logged content-free after commit. A waitlist entry admitted through a
    // purged invite goes first, in the same transaction: deleting the invite
    // under it would SET NULL its admitted_invite_id, which its admitted-pair
    // CHECK refuses.
    const owner = await tx`
      /* exomem-cloud:deletion-finish-owner-email */
      SELECT email FROM users WHERE id = ${proof.userId}
    `;
    const ownerEmail = owner.rows[0]?.email as string | undefined;
    let heldInvites = 0;
    if (ownerEmail) {
      const held = await tx`
        SELECT count(*)::int AS held
        FROM exomem_invites AS invite
        WHERE invite.email_normalized = ${ownerEmail}
          AND invite.consumed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
            WHERE authority.invite_id = invite.id
          )
      `;
      heldInvites = Number(held.rows[0]?.held ?? 0);
      await tx`
        DELETE FROM exomem_waitlist_entries AS entry
        WHERE entry.email_normalized = ${ownerEmail}
          AND (
            entry.admitted_at IS NULL
            OR EXISTS (
              SELECT 1 FROM exomem_invites AS invite
              WHERE invite.id = entry.admitted_invite_id
                AND invite.email_normalized = ${ownerEmail}
                AND invite.consumed_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
                  WHERE authority.invite_id = invite.id
                )
            )
          )
      `;
      await tx`
        DELETE FROM exomem_invites AS invite
        WHERE invite.email_normalized = ${ownerEmail}
          AND invite.consumed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
            WHERE authority.invite_id = invite.id
          )
      `;
    }
    await tx`DELETE FROM exomem_sessions WHERE tenant_id = ${tenantId}::uuid`;
    await tx`DELETE FROM exomem_access_tokens WHERE tenant_id = ${tenantId}::uuid`;
    await tx`DELETE FROM exomem_transfer_grants WHERE tenant_id = ${tenantId}::uuid`;
    // The webhook ledger keeps each event's dedupe row, unlinked from the
    // tenant, exactly as its ON DELETE SET NULL would leave it.
    await tx`UPDATE exomem_paddle_events SET tenant_id = NULL WHERE tenant_id = ${tenantId}::uuid`;
    return { heldInvites };
  });
  if (!scrubbed) return false;
  if (scrubbed.heldInvites > 0) {
    console.warn(
      `exomem-cloud: account deletion finish left ${scrubbed.heldInvites} invite(s) held by a restricting reference`
    );
  }
  return true;
}

/**
 * Finish one Cloud tenant's account deletion. Safe to call at any time and
 * from several places at once (the confirmation and every sweep tick): at
 * most one scrub applies, and a `deleted` tenant is a no-op.
 */
export async function finishCloudAccountDeletion(
  tenantId: string,
  dependencies?: Partial<CloudDeletionFinishDependencies>
): Promise<CloudDeletionFinishOutcome> {
  const deps = { ...defaults(), ...dependencies };
  const eligibility = await readEligibility(tenantId);
  if (eligibility !== "eligible") return eligibility;

  // Another finish may scrub the tenant at any point from here on; a step
  // that then finds nothing to do reports the tenant as already deleted.
  const scrubbedMeanwhile = async () => (await readEligibility(tenantId)) === "already_deleted";

  const proof = await deps.terminateBilling(tenantId);
  if (!proof || proof.tenantId !== tenantId) {
    return (await scrubbedMeanwhile()) ? "already_deleted" : "billing_pending";
  }

  if (await scrubCloudTenant(proof)) return "finished";
  return (await scrubbedMeanwhile()) ? "already_deleted" : "proof_mismatch";
}

/**
 * Every `deletion_pending` tenant owning any Cloud cell row, deleted rows
 * included, so a cell deleted before the owner confirmed (an expired unpaid
 * invite) is still finished. Sampled at random, as the reconcile sweep is, so
 * no tenant is starved once the population exceeds `limit`.
 */
async function findPendingCloudDeletionTenantIds(limit: number): Promise<string[]> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:deletion-finish-population */
    SELECT tenant.id
    FROM exomem_tenants AS tenant
    WHERE tenant.status = 'deletion_pending'
      AND EXISTS (SELECT 1 FROM exomem_cloud_cells AS cell WHERE cell.tenant_id = tenant.id)
    ORDER BY random()
    LIMIT ${limit}
  `;
  return rows.map((row) => String(row.id));
}

export type CloudDeletionFinishSweepResult = {
  finished: number;
  pending: number;
  failed: number;
};

/**
 * The periodic retry of the finish, run after the reconcile sweep has deleted
 * the cell rows of confirmed deletions. Each tenant is isolated: one that
 * throws is logged content-free and counted, and the rest still run.
 *
 * The lane carries its own time budget, checked between tenants (never
 * mid-tenant): the cron caller has a client-side timeout tighter than the
 * platform's `maxDuration`, matching the other reconcile lanes'
 * `timeBudgetMs`. Any tenant this tick never reaches is reported pending, not
 * silently dropped -- the next tick retries it.
 */
export async function runBoundedCloudDeletionFinish(
  options: {
    maxTenants?: number;
    timeBudgetMs?: number;
    now?: () => number;
    finishTenant?: (tenantId: string) => Promise<CloudDeletionFinishOutcome>;
  } = {}
): Promise<CloudDeletionFinishSweepResult> {
  const finishTenant = options.finishTenant ?? ((tenantId) => finishCloudAccountDeletion(tenantId));
  const now = options.now ?? Date.now;
  const timeBudgetMs = Math.min(30_000, Math.max(250, options.timeBudgetMs ?? 8_000));
  const startedAt = now();
  const tenantIds = await findPendingCloudDeletionTenantIds(options.maxTenants ?? 25);
  const result: CloudDeletionFinishSweepResult = { finished: 0, pending: 0, failed: 0 };
  for (let index = 0; index < tenantIds.length; index += 1) {
    if (now() - startedAt >= timeBudgetMs) {
      result.pending += tenantIds.length - index;
      break;
    }
    const tenantId = tenantIds[index]!;
    try {
      const outcome = await finishTenant(tenantId);
      if (outcome === "finished") result.finished += 1;
      else if (
        outcome === "cell_live" ||
        outcome === "billing_pending" ||
        outcome === "proof_mismatch"
      ) {
        result.pending += 1;
      }
    } catch {
      result.failed += 1;
      console.error("exomem-cloud: account deletion finish failed for one tenant");
    }
  }
  return result;
}
