import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import { executeExomemSql } from "./db";
import {
  assertExomemPaddlePurpose,
  loadExomemPaddleConfig,
  type ExomemPaddleConfig,
  type ExomemPaddleEnvironment,
} from "./paddle-config";
import { cancelExomemCheckoutTransaction, type PaddleTransport } from "./paddle-billing";

export type BillingDeletionTarget = {
  tenantId: string;
  userId: string;
  source: "complimentary" | "paddle";
  sourceState: string;
  sourceRevision: string | null;
  providerEnvironment: ExomemPaddleEnvironment | null;
  customerRef: string | null;
  subscriptionRef: string | null;
  transactionRef: string | null;
};

export type BillingDeletionDependencies = {
  loadTarget: (tenantId: string) => Promise<BillingDeletionTarget | null>;
  config: ExomemPaddleConfig | null;
  transport: PaddleTransport;
};

async function loadTarget(tenantId: string): Promise<BillingDeletionTarget | null> {
  const { rows } = await executeExomemSql`
    /* exomem:billing-deletion-target */
    SELECT entitlement.tenant_id,
           tenant.owner_user_id,
           entitlement.source,
           entitlement.source_state,
           entitlement.source_revision,
           entitlement.provider_environment,
           entitlement.provider_customer_ref,
           entitlement.provider_subscription_ref,
           entitlement.provider_transaction_ref
    FROM exomem_entitlements AS entitlement
    JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
    WHERE entitlement.tenant_id = ${tenantId}
      AND tenant.status = 'deletion_pending'
      AND tenant.desired_state = 'deleted'
      AND entitlement.effective_state = 'deleted'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const environment = row.provider_environment;
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.owner_user_id),
    source: String(row.source) as "complimentary" | "paddle",
    sourceState: String(row.source_state),
    sourceRevision: row.source_revision ? String(row.source_revision) : null,
    providerEnvironment:
      environment === "sandbox" || environment === "production" ? environment : null,
    customerRef: row.provider_customer_ref ? String(row.provider_customer_ref) : null,
    subscriptionRef: row.provider_subscription_ref ? String(row.provider_subscription_ref) : null,
    transactionRef: row.provider_transaction_ref ? String(row.provider_transaction_ref) : null,
  };
}

function defaults(): BillingDeletionDependencies {
  return {
    loadTarget,
    config: null,
    transport: paddleFetch,
  };
}

async function cancelSubscription(
  subscriptionId: string,
  transport: PaddleTransport
): Promise<boolean> {
  if (!/^sub_[a-z0-9]{26}$/.test(subscriptionId)) return false;
  let response: Response;
  try {
    response = await transport(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ effective_from: "immediately" }),
    });
  } catch {
    return false;
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    // Successful immediate cancellation returns the canceled subscription.
    // A 404 can instead mean this API key belongs to another Paddle account.
    return false;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  try {
    const payload = (await response.json()) as { data?: { id?: unknown; status?: unknown } };
    return payload.data?.id === subscriptionId && payload.data.status === "canceled";
  } catch {
    return false;
  }
}

export async function terminateExomemBillingForDeletion(
  tenantId: string,
  dependencies?: Partial<BillingDeletionDependencies>
): Promise<BillingDeletionTarget | null> {
  let deps: BillingDeletionDependencies;
  try {
    deps = { ...defaults(), ...dependencies };
  } catch {
    return null;
  }
  const target = await deps.loadTarget(tenantId).catch(() => null);
  if (!target || target.tenantId !== tenantId) return null;
  if (target.source === "complimentary") {
    return target;
  }
  if (target.sourceState === "deletion_cancelled") {
    return target;
  }
  if (target.sourceState === "cancelled") {
    if (!target.providerEnvironment) return null;
    try {
      const config = deps.config ?? loadExomemPaddleConfig();
      if (config.environment !== target.providerEnvironment) return null;
      return target;
    } catch {
      return null;
    }
  }
  if (!target.subscriptionRef && !target.transactionRef) {
    if (
      !target.customerRef &&
      ["awaiting_checkout", "checkout_pending"].includes(target.sourceState)
    ) {
      return target;
    }
    return null;
  }
  if (!target.providerEnvironment) return null;

  try {
    const config = deps.config ?? loadExomemPaddleConfig();
    if (config.environment !== target.providerEnvironment) return null;

    if (target.subscriptionRef) {
      assertExomemPaddlePurpose(config, "portal");
      if (!(await cancelSubscription(target.subscriptionRef, deps.transport))) return null;
      return target;
    }

    if (!target.transactionRef) return null;
    const transaction = await cancelExomemCheckoutTransaction(
      {
        userId: target.userId,
        tenantId: target.tenantId,
        transactionId: target.transactionRef,
        environment: target.providerEnvironment,
      },
      { config, transport: deps.transport }
    );
    if (transaction.state === "completed") {
      assertExomemPaddlePurpose(config, "portal");
      if (!(await cancelSubscription(transaction.subscriptionId, deps.transport))) return null;
    }
    return target;
  } catch {
    return null;
  }
}
