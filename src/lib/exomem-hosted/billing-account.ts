import { cloudCancelledKeptUntil } from "./cloud-lifecycle";
import { assertPrincipalOwnsCloudCell, CloudPrincipalHasNoCellError } from "./cloud-oauth";
import {
  clearExomemCheckoutTransaction,
  executeExomemSql,
  promoteExomemCheckoutSubscription,
} from "./db";
import { ExomemHostedError, exomemErrors } from "./errors";
import {
  cancelExomemCheckoutTransaction,
  createExomemCheckout,
  createExomemCustomerPortal,
  ExomemBillingError,
  resumeExomemCheckout,
  type ExomemCheckoutOptions,
} from "./paddle-billing";
import {
  assertExomemPaddlePurpose,
  exomemPaddleFriendDiscountId,
  loadExomemPaddleConfig,
  type ExomemPaddleEnvironment,
} from "./paddle-config";
import { getDefaultSqlExomemPaddleEventStore } from "./paddle-event-store";
import { reconcileExomemPaddleSubscription } from "./paddle-reconciliation";

export type OwnerBillingAccount = {
  userId: string;
  tenantId: string;
  source: "complimentary" | "paddle";
  sourceState: string;
  effectiveState: string;
  providerEnvironment: ExomemPaddleEnvironment | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  transactionRef: string | null;
  /** When Paddle last changed the subscription (the cancellation, for an ended one). */
  sourceOccurredAt: Date | null;
  /** The Paddle event that last changed it. */
  sourceRevision: string | null;
  manuallySuspended: boolean;
  /** The tenant accepted a friend invitation, so its checkouts carry the friend discount. */
  friendOffer: boolean;
};

export type OwnerBillingSummary = {
  source: "complimentary" | "paddle";
  state: string;
  checkoutAvailable: boolean;
  portalAvailable: boolean;
};

export async function loadOwnerBillingAccount(
  userId: string,
  tenantId: string
): Promise<OwnerBillingAccount | null> {
  const { rows } = await executeExomemSql`
    /* exomem:owner-billing-account */
    SELECT tenant.owner_user_id,
           entitlement.tenant_id,
           entitlement.source,
           entitlement.source_state,
           entitlement.effective_state,
           entitlement.provider_environment,
           entitlement.provider_customer_ref,
           entitlement.provider_subscription_ref,
           entitlement.provider_transaction_ref,
           entitlement.source_occurred_at,
           entitlement.source_revision,
           entitlement.manual_suspended_at IS NOT NULL AS manually_suspended,
           tenant.friend_offer_invite_id IS NOT NULL AS friend_offer
    FROM exomem_entitlements AS entitlement
    JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
    WHERE tenant.owner_user_id = ${userId}
      AND tenant.id = ${tenantId}
      AND tenant.status <> 'deleted'
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        userId: String(row.owner_user_id),
        tenantId: String(row.tenant_id),
        source: String(row.source) as "complimentary" | "paddle",
        sourceState: String(row.source_state),
        effectiveState: String(row.effective_state),
        providerEnvironment:
          row.provider_environment === "sandbox" || row.provider_environment === "production"
            ? row.provider_environment
            : null,
        customerRef: row.provider_customer_ref ? String(row.provider_customer_ref) : null,
        subscriptionRef: row.provider_subscription_ref
          ? String(row.provider_subscription_ref)
          : null,
        transactionRef: row.provider_transaction_ref ? String(row.provider_transaction_ref) : null,
        sourceOccurredAt: row.source_occurred_at
          ? new Date(row.source_occurred_at as string | Date)
          : null,
        sourceRevision: row.source_revision ? String(row.source_revision) : null,
        manuallySuspended: row.manually_suspended === true,
        friendOffer: row.friend_offer === true,
      }
    : null;
}

/**
 * An owner whose Paddle subscription ended may subscribe again while their
 * memory is still kept: the same rule that keeps the cell read-only
 * (`cloudCancelledKeptUntil`), and never while an operator suspension holds.
 */
export function resubscribeAllowed(account: OwnerBillingAccount, now: Date = new Date()): boolean {
  return (
    account.source === "paddle" &&
    account.sourceState === "cancelled" &&
    account.customerRef !== null &&
    account.providerEnvironment !== null &&
    account.sourceOccurredAt !== null &&
    !account.manuallySuspended &&
    cloudCancelledKeptUntil(account.sourceOccurredAt).getTime() > now.getTime()
  );
}

function firstCheckoutAllowed(account: OwnerBillingAccount): boolean {
  return (
    account.source === "paddle" &&
    !account.customerRef &&
    (!account.transactionRef || Boolean(account.providerEnvironment)) &&
    ["awaiting_checkout", "checkout_pending"].includes(account.sourceState)
  );
}

/**
 * Binds a resubscription's new transaction to the ended entitlement. It
 * keeps the `cancelled` state, so the cell stays read-only until Paddle's
 * subscription event activates it, and it holds only if nothing changed
 * since the checks: the same last Paddle event (its revision, compared as
 * text because a timestamp read into JavaScript loses its microseconds),
 * customer and earlier transaction, inside the kept window, with a live cell.
 */
export async function recordExomemResubscribeTransaction(input: {
  userId: string;
  tenantId: string;
  transactionId: string;
  environment: ExomemPaddleEnvironment;
  customerId: string;
  previousTransactionRef: string | null;
  sourceOccurredAt: Date;
  sourceRevision: string | null;
}): Promise<boolean> {
  const keptUntil = cloudCancelledKeptUntil(input.sourceOccurredAt);
  const { rows } = await executeExomemSql`
    /* exomem:record-resubscribe-transaction */
    WITH active_tenant AS (
      SELECT tenant.id
      FROM exomem_tenants AS tenant
      WHERE tenant.id = ${input.tenantId}::uuid
        AND tenant.owner_user_id = ${input.userId}::uuid
        AND tenant.status IN ('provisioning', 'active', 'suspended')
        AND tenant.desired_state <> 'deleted'
        AND EXISTS (
          SELECT 1 FROM exomem_cloud_cells AS cell
          WHERE cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
        )
      FOR UPDATE OF tenant
    )
    UPDATE exomem_entitlements AS entitlement
    SET provider_transaction_ref = ${input.transactionId},
        provider_provenance_unresolved_fingerprint = NULL,
        updated_at = now()
    FROM active_tenant
    WHERE entitlement.tenant_id = active_tenant.id
      AND entitlement.source = 'paddle'
      AND entitlement.source_state = 'cancelled'
      AND entitlement.manual_suspended_at IS NULL
      AND entitlement.provider_environment = ${input.environment}
      AND entitlement.provider_customer_ref = ${input.customerId}
      AND entitlement.source_revision IS NOT DISTINCT FROM ${input.sourceRevision}
      AND entitlement.provider_transaction_ref IS NOT DISTINCT FROM ${input.previousTransactionRef}
      AND ${keptUntil.toISOString()}::timestamptz > now()
    RETURNING entitlement.id
  `;
  return rows.length === 1;
}

function safeBillingError(error: unknown): ExomemHostedError {
  if (!(error instanceof ExomemBillingError)) {
    return new ExomemHostedError({
      code: "EXOMEM_BILLING_UNAVAILABLE",
      status: 503,
      message: "Exomem billing is temporarily unavailable",
      retryable: true,
    });
  }
  return new ExomemHostedError({
    code: error.code,
    status: error.status,
    message:
      error.code === "EXOMEM_PAID_CHECKOUT_DISABLED"
        ? "paid Exomem checkout is not enabled"
        : "Exomem billing is temporarily unavailable",
    retryable: error.status >= 500,
  });
}

export function billingSummary(
  account: OwnerBillingAccount,
  now: Date = new Date()
): OwnerBillingSummary {
  return {
    source: account.source,
    state: account.effectiveState,
    checkoutAvailable: firstCheckoutAllowed(account) || resubscribeAllowed(account, now),
    portalAvailable:
      account.source === "paddle" &&
      Boolean(account.providerEnvironment) &&
      Boolean(account.customerRef),
  };
}

type RecoveredSubscriptionInput = {
  userId: string;
  tenantId: string;
  subscriptionId: string;
  environment: ExomemPaddleEnvironment;
};

type CheckoutRecoveryDependencies = {
  resume?: typeof resumeExomemCheckout;
  clearTransaction?: typeof clearExomemCheckoutTransaction;
  promoteSubscription?: typeof promoteExomemCheckoutSubscription;
  reconcileSubscription?: typeof reconcileRecoveredSubscription;
};

type BoundCheckoutRecovery =
  | { state: "open"; checkoutUrl: string; discountId: string | null }
  | { state: "canceled" }
  | { state: "completed" };

export type ReturnedOwnerCheckoutResult =
  | { state: "open"; checkoutUrl: string }
  | { state: "settled" };

async function reconcileRecoveredSubscription(input: RecoveredSubscriptionInput): Promise<void> {
  const config = loadExomemPaddleConfig();
  assertExomemPaddlePurpose(config, "reconciliation");
  if (config.environment !== input.environment) {
    throw new Error("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH");
  }
  await reconcileExomemPaddleSubscription(
    {
      userId: input.userId,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      environment: input.environment,
    },
    {
      config,
      store: getDefaultSqlExomemPaddleEventStore(),
    }
  );
}

async function recoverBoundCheckout(
  userId: string,
  tenantId: string,
  account: OwnerBillingAccount,
  dependencies: CheckoutRecoveryDependencies
): Promise<BoundCheckoutRecovery> {
  if (!account.transactionRef || !account.providerEnvironment) {
    throw exomemErrors.entitlementDenied();
  }
  const transaction = await (dependencies.resume ?? resumeExomemCheckout)({
    userId,
    tenantId,
    transactionId: account.transactionRef,
    environment: account.providerEnvironment,
  });
  if (transaction.state === "open") return transaction;
  if (transaction.state === "canceled") {
    const cleared = await (dependencies.clearTransaction ?? clearExomemCheckoutTransaction)({
      userId,
      tenantId,
      transactionId: account.transactionRef,
      environment: account.providerEnvironment,
    });
    if (!cleared) throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
    return { state: "canceled" };
  }
  const recovered = await (dependencies.promoteSubscription ?? promoteExomemCheckoutSubscription)({
    userId,
    tenantId,
    transactionId: account.transactionRef,
    subscriptionId: transaction.subscriptionId,
    customerId: transaction.customerId,
    environment: account.providerEnvironment,
  });
  if (!recovered) throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  try {
    await (dependencies.reconcileSubscription ?? reconcileRecoveredSubscription)({
      userId,
      tenantId,
      subscriptionId: transaction.subscriptionId,
      environment: account.providerEnvironment,
    });
  } catch {
    // Promotion atomically schedules durable reconciliation. The immediate
    // attempt is only a latency optimization, so a provider outage must not
    // turn an already-promoted checkout return into an unretryable failure.
  }
  return { state: "completed" };
}

export async function ownerBillingSummary(
  userId: string,
  tenantId: string,
  load: typeof loadOwnerBillingAccount = loadOwnerBillingAccount
): Promise<OwnerBillingSummary> {
  const account = await load(userId, tenantId);
  if (!account) throw exomemErrors.sessionInvalid();
  return billingSummary(account);
}

export type CloudCheckoutGateDependencies = {
  assertCloudCellOwnership?: (tenantId: string) => Promise<void>;
};

export type OwnerCheckoutDependencies = {
  load?: typeof loadOwnerBillingAccount;
  checkout?: typeof createExomemCheckout;
  cancelTransaction?: typeof cancelExomemCheckoutTransaction;
  recordResubscribe?: typeof recordExomemResubscribeTransaction;
  /** The configured friend discount, which an open transaction must carry. */
  friendDiscountId?: () => string | null;
  now?: () => Date;
} & CheckoutRecoveryDependencies &
  CloudCheckoutGateDependencies;

/**
 * Starts or resumes the owner's checkout. A first checkout and a
 * resubscription (an ended subscription inside the kept window) are the
 * two cases; any other owner, a live subscription included, is refused.
 * The friend discount is attached only when the tenant accepted a friend
 * offer, and an open transaction that does not carry exactly the discount
 * the tenant is owed is cancelled and replaced, never reused.
 */
export async function startOwnerCheckout(
  userId: string,
  tenantId: string,
  dependencies: OwnerCheckoutDependencies = {}
): Promise<{ checkoutUrl: string; transactionId: string }> {
  const account = await (dependencies.load ?? loadOwnerBillingAccount)(userId, tenantId);
  const now = (dependencies.now ?? (() => new Date()))();
  if (
    !account ||
    account.source !== "paddle" ||
    (account.transactionRef && !account.providerEnvironment) ||
    (account.customerRef ? !resubscribeAllowed(account, now) : !firstCheckoutAllowed(account))
  ) {
    throw exomemErrors.entitlementDenied();
  }
  // Security review finding 4: checkout is refused while this tenant has no
  // non-deleted Cloud cell row -- the same ownership guard token issuance
  // enforces (assertPrincipalOwnsCloudCell in cloud-oauth.ts), so a tenant
  // whose only cell was fully deleted can't buy a subscription that reconcile
  // will never have a cell to apply to. A fresh invite re-admits the tenant
  // instead (redeemCloudInviteAtomic: same capacity check, a new cell row) --
  // checkout itself never creates one.
  try {
    await (dependencies.assertCloudCellOwnership ?? assertPrincipalOwnsCloudCell)(tenantId);
  } catch (error) {
    if (error instanceof CloudPrincipalHasNoCellError) throw exomemErrors.entitlementDenied();
    throw error;
  }
  const expectedDiscountId = account.friendOffer
    ? (dependencies.friendDiscountId ?? exomemPaddleFriendDiscountId)()
    : null;
  const options: ExomemCheckoutOptions = {
    friendPrice: account.friendOffer,
    customerId: account.customerRef,
  };
  try {
    if (account.customerRef) {
      return await startResubscribeCheckout(account, expectedDiscountId, options, dependencies);
    }
    if (account.transactionRef) {
      const recovery = await recoverBoundCheckout(userId, tenantId, account, dependencies);
      if (recovery.state === "open" && recovery.discountId === expectedDiscountId) {
        return { checkoutUrl: recovery.checkoutUrl, transactionId: account.transactionRef };
      }
      if (recovery.state === "open") {
        await cancelAndClearFirstCheckout(account, dependencies);
      } else if (recovery.state !== "canceled") {
        throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
      }
    }
    return await (dependencies.checkout ?? createExomemCheckout)({ userId, tenantId }, {}, options);
  } catch (error) {
    throw safeBillingError(error);
  }
}

/** An open first checkout without the discount the tenant is owed goes, then a new one opens. */
async function cancelAndClearFirstCheckout(
  account: OwnerBillingAccount,
  dependencies: OwnerCheckoutDependencies
): Promise<void> {
  const bound = {
    userId: account.userId,
    tenantId: account.tenantId,
    transactionId: account.transactionRef!,
    environment: account.providerEnvironment!,
  };
  const cancelled = await (dependencies.cancelTransaction ?? cancelExomemCheckoutTransaction)(
    bound
  );
  if (cancelled.state !== "canceled") {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  if (!(await (dependencies.clearTransaction ?? clearExomemCheckoutTransaction)(bound))) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
}

/**
 * A resubscription opens a new transaction for the owner's existing Paddle
 * customer. A transaction they already opened for it is reused, so a
 * second click never opens a second checkout; one already paid for a new
 * subscription refuses, because that subscription is on its way.
 */
async function startResubscribeCheckout(
  account: OwnerBillingAccount,
  expectedDiscountId: string | null,
  options: ExomemCheckoutOptions,
  dependencies: OwnerCheckoutDependencies
): Promise<{ checkoutUrl: string; transactionId: string }> {
  const { userId, tenantId } = account;
  const previousTransactionRef = account.transactionRef;
  if (previousTransactionRef) {
    const bound = {
      userId,
      tenantId,
      transactionId: previousTransactionRef,
      environment: account.providerEnvironment!,
    };
    let previous: Awaited<ReturnType<typeof resumeExomemCheckout>> | null;
    try {
      previous = await (dependencies.resume ?? resumeExomemCheckout)(bound);
    } catch (error) {
      // The stored reference can be a renewal of the ended subscription,
      // which is not a checkout this owner opened; it is left alone.
      if (
        !(error instanceof ExomemBillingError && error.code === "EXOMEM_BILLING_STATE_CONFLICT")
      ) {
        throw error;
      }
      previous = null;
    }
    if (previous?.state === "open" && previous.discountId === expectedDiscountId) {
      return { checkoutUrl: previous.checkoutUrl, transactionId: previousTransactionRef };
    }
    if (previous?.state === "open") {
      const cancelled = await (dependencies.cancelTransaction ?? cancelExomemCheckoutTransaction)(
        bound
      );
      if (cancelled.state !== "canceled") {
        throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
      }
    }
    if (previous?.state === "completed" && previous.subscriptionId !== account.subscriptionRef) {
      throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
    }
  }
  const sourceOccurredAt = account.sourceOccurredAt!;
  const sourceRevision = account.sourceRevision;
  const customerId = account.customerRef!;
  return (dependencies.checkout ?? createExomemCheckout)(
    { userId, tenantId },
    {
      recordCheckoutTransaction: (input) =>
        (dependencies.recordResubscribe ?? recordExomemResubscribeTransaction)({
          ...input,
          customerId,
          previousTransactionRef,
          sourceOccurredAt,
          sourceRevision,
        }),
    },
    options
  );
}

export async function resumeReturnedOwnerCheckout(
  userId: string,
  tenantId: string,
  transactionId: string,
  dependencies: {
    load?: typeof loadOwnerBillingAccount;
  } & CheckoutRecoveryDependencies = {}
): Promise<ReturnedOwnerCheckoutResult> {
  const account = await (dependencies.load ?? loadOwnerBillingAccount)(userId, tenantId);
  if (
    !account ||
    account.source !== "paddle" ||
    account.transactionRef !== transactionId ||
    !account.providerEnvironment
  ) {
    throw exomemErrors.entitlementDenied();
  }
  try {
    if (account.customerRef) {
      // A resubscription: Paddle's subscription event binds the new
      // subscription and resumes the cell, so the return only reports
      // whether the checkout is still open.
      const transaction = await (dependencies.resume ?? resumeExomemCheckout)({
        userId,
        tenantId,
        transactionId,
        environment: account.providerEnvironment,
      });
      return transaction.state === "open"
        ? { state: "open", checkoutUrl: transaction.checkoutUrl }
        : { state: "settled" };
    }
    const recovery = await recoverBoundCheckout(userId, tenantId, account, dependencies);
    return recovery.state === "open"
      ? { state: "open", checkoutUrl: recovery.checkoutUrl }
      : { state: "settled" };
  } catch (error) {
    throw safeBillingError(error);
  }
}

export async function startOwnerPortal(
  userId: string,
  tenantId: string,
  dependencies: {
    load?: typeof loadOwnerBillingAccount;
    portal?: typeof createExomemCustomerPortal;
  } = {}
): Promise<{ portalUrl: string }> {
  const account = await (dependencies.load ?? loadOwnerBillingAccount)(userId, tenantId);
  if (
    !account ||
    account.source !== "paddle" ||
    !account.providerEnvironment ||
    !account.customerRef
  ) {
    throw exomemErrors.entitlementDenied();
  }
  try {
    return await (dependencies.portal ?? createExomemCustomerPortal)({
      userId,
      tenantId,
      customerId: account.customerRef,
      environment: account.providerEnvironment,
      ...(account.subscriptionRef ? { subscriptionId: account.subscriptionRef } : {}),
    });
  } catch (error) {
    throw safeBillingError(error);
  }
}
