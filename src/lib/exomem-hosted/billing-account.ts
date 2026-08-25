import {
  clearExomemCheckoutTransaction,
  executeExomemSql,
  promoteExomemCheckoutSubscription,
} from "./db";
import { ExomemHostedError, exomemErrors } from "./errors";
import {
  createExomemCheckout,
  createExomemCustomerPortal,
  ExomemBillingError,
  resumeExomemCheckout,
} from "./paddle-billing";
import {
  assertExomemPaddlePurpose,
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
           entitlement.provider_transaction_ref
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
      }
    : null;
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

export function billingSummary(account: OwnerBillingAccount): OwnerBillingSummary {
  return {
    source: account.source,
    state: account.effectiveState,
    checkoutAvailable:
      account.source === "paddle" &&
      !account.customerRef &&
      (!account.transactionRef || Boolean(account.providerEnvironment)) &&
      ["awaiting_checkout", "checkout_pending"].includes(account.sourceState),
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
  | { state: "open"; checkoutUrl: string }
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

export async function startOwnerCheckout(
  userId: string,
  tenantId: string,
  dependencies: {
    load?: typeof loadOwnerBillingAccount;
    checkout?: typeof createExomemCheckout;
  } & CheckoutRecoveryDependencies = {}
): Promise<{ checkoutUrl: string }> {
  const account = await (dependencies.load ?? loadOwnerBillingAccount)(userId, tenantId);
  if (
    !account ||
    account.source !== "paddle" ||
    account.customerRef ||
    (account.transactionRef && !account.providerEnvironment)
  ) {
    throw exomemErrors.entitlementDenied();
  }
  try {
    if (account.transactionRef) {
      const recovery = await recoverBoundCheckout(userId, tenantId, account, dependencies);
      if (recovery.state === "open") return { checkoutUrl: recovery.checkoutUrl };
      if (recovery.state === "canceled") {
        return await (dependencies.checkout ?? createExomemCheckout)({ userId, tenantId });
      }
      throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
    }
    return await (dependencies.checkout ?? createExomemCheckout)({ userId, tenantId });
  } catch (error) {
    throw safeBillingError(error);
  }
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
    account.customerRef ||
    account.transactionRef !== transactionId ||
    !account.providerEnvironment
  ) {
    throw exomemErrors.entitlementDenied();
  }
  try {
    const recovery = await recoverBoundCheckout(userId, tenantId, account, dependencies);
    return recovery.state === "open" ? recovery : { state: "settled" };
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
