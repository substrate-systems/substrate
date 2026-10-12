/**
 * Recovery of a paid resubscription without its subscription event (design
 * "Friend invitations, the friend price and resubscribe").
 *
 * An ended owner's bound checkout completed. Paddle's `subscription.created`
 * event normally binds the new subscription and resumes the kept cell. If
 * that event never arrives, this binds the subscription the transaction paid
 * for and reconciles it from Paddle, as checkout return does for a first
 * checkout. The checkout return, the next checkout press and the lapsed
 * window sweep call it, so a lost event never leaves a paying owner
 * read-only.
 */

import { executeExomemSql } from "./db";
import { ExomemBillingError, type PaddleTransport } from "./paddle-billing";
import {
  assertExomemPaddlePurpose,
  loadExomemPaddleConfig,
  type ExomemPaddleConfig,
  type ExomemPaddleEnvironment,
} from "./paddle-config";
import { createSqlExomemPaddleEventStore } from "./paddle-event-store";
import { readExomemPaddleSubscriptionApplication } from "./paddle-reconciliation";
import type { AtomicExomemPaddleEventStore } from "./paddle-webhook";

export type PaidResubscription = {
  userId: string;
  tenantId: string;
  environment: ExomemPaddleEnvironment;
  /** The transaction bound to the ended entitlement, which Paddle reports completed. */
  transactionId: string;
  /** The entitlement's customer and last Paddle event, read before Paddle was asked. */
  customerRef: string;
  sourceRevision: string | null;
  /** What Paddle reports the transaction paid for. */
  paid: { subscriptionId: string; customerId: string | null };
};

export type ResubscribeRecoveryDependencies = {
  config?: ExomemPaddleConfig;
  transport?: PaddleTransport;
  signal?: AbortSignal;
  store?: AtomicExomemPaddleEventStore;
};

/**
 * `ended`: Paddle reports the subscription the transaction paid for as
 * cancelled, as a renewal of the cancelled subscription is, so the
 * transaction cannot pay for the cell; nothing is stored. `resumed`: that
 * subscription is live, and it is bound and reconciled, so the entitlement
 * left `cancelled`. Throws while the binding cannot be proven or Paddle
 * cannot answer; the caller keeps the cell and asks again.
 */
export async function recoverPaidResubscription(
  input: PaidResubscription,
  dependencies: ResubscribeRecoveryDependencies = {}
): Promise<"resumed" | "ended"> {
  if (input.paid.customerId !== null && input.paid.customerId !== input.customerRef) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  const config = dependencies.config ?? loadExomemPaddleConfig();
  assertExomemPaddlePurpose(config, "reconciliation");
  // One snapshot of the paid subscription, checked in full (owner
  // correlation, Exomem item, state) before anything is bound, and then
  // applied as it was read.
  const paid = await readExomemPaddleSubscriptionApplication(
    {
      userId: input.userId,
      tenantId: input.tenantId,
      subscriptionId: input.paid.subscriptionId,
      environment: input.environment,
    },
    { config, transport: dependencies.transport, signal: dependencies.signal }
  );
  if (paid.sourceState === "cancelled") return "ended";

  // Bound only to the exact owner, environment, customer, transaction and
  // last Paddle event that were read before Paddle was asked.
  const bound = await executeExomemSql`
    /* exomem:bind-paid-resubscription */
    WITH active_tenant AS (
      SELECT tenant.id
      FROM exomem_tenants AS tenant
      WHERE tenant.id = ${input.tenantId}::uuid
        AND tenant.owner_user_id = ${input.userId}::uuid
        AND tenant.status IN ('provisioning', 'active', 'suspended')
        AND tenant.desired_state <> 'deleted'
      FOR UPDATE OF tenant
    )
    UPDATE exomem_entitlements AS entitlement
    SET provider_subscription_ref = ${input.paid.subscriptionId},
        updated_at = now()
    FROM active_tenant
    WHERE entitlement.tenant_id = active_tenant.id
      AND entitlement.source = 'paddle'
      AND entitlement.source_state = 'cancelled'
      AND entitlement.provider_environment = ${input.environment}
      AND entitlement.provider_customer_ref = ${input.customerRef}
      AND entitlement.provider_transaction_ref = ${input.transactionId}
      AND entitlement.source_revision IS NOT DISTINCT FROM ${input.sourceRevision}
    RETURNING entitlement.id
  `;
  if (bound.rows.length !== 1) {
    // The subscription event may have won the race; anything else waits.
    if ((await sourceState(input.tenantId)) === "cancelled") {
      throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
    }
    return "resumed";
  }
  await (
    dependencies.store ?? createSqlExomemPaddleEventStore(executeExomemSql)
  ).applyVerifiedEventAndMarkProcessedAtomically(paid);
  // A live subscription whose reconcile did not apply is unresolved, never ended.
  if ((await sourceState(input.tenantId)) === "cancelled") {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  return "resumed";
}

async function sourceState(tenantId: string): Promise<string | null> {
  const { rows } = await executeExomemSql`
    /* exomem:paid-resubscription-state */
    SELECT source_state FROM exomem_entitlements WHERE tenant_id = ${tenantId}::uuid
  `;
  const row = rows[0] as { source_state: string } | undefined;
  return row?.source_state ?? null;
}
