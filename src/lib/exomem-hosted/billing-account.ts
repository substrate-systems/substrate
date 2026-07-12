import { executeExomemSql } from "./db";
import { ExomemHostedError, exomemErrors } from "./errors";
import {
  createExomemCheckout,
  createExomemCustomerPortal,
  ExomemBillingError,
  resumeExomemCheckout,
} from "./paddle-billing";

export type OwnerBillingAccount = {
  userId: string;
  tenantId: string;
  source: "complimentary" | "paddle";
  sourceState: string;
  effectiveState: string;
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
      ["awaiting_checkout", "checkout_pending"].includes(account.sourceState),
    portalAvailable: account.source === "paddle" && Boolean(account.customerRef),
  };
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
    resume?: typeof resumeExomemCheckout;
  } = {}
): Promise<{ checkoutUrl: string }> {
  const account = await (dependencies.load ?? loadOwnerBillingAccount)(userId, tenantId);
  if (!account || account.source !== "paddle" || account.customerRef) {
    throw exomemErrors.entitlementDenied();
  }
  try {
    if (account.transactionRef) {
      return await (dependencies.resume ?? resumeExomemCheckout)({
        userId,
        tenantId,
        transactionId: account.transactionRef,
      });
    }
    return await (dependencies.checkout ?? createExomemCheckout)({ userId, tenantId });
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
  if (!account || account.source !== "paddle" || !account.customerRef) {
    throw exomemErrors.entitlementDenied();
  }
  try {
    return await (dependencies.portal ?? createExomemCustomerPortal)({
      userId,
      tenantId,
      customerId: account.customerRef,
      ...(account.subscriptionRef ? { subscriptionId: account.subscriptionRef } : {}),
    });
  } catch (error) {
    throw safeBillingError(error);
  }
}
