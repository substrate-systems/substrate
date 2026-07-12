import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import { executeExomemSql } from "./db";
import {
  assertExomemPaddlePurpose,
  loadExomemPaddleConfig,
  type ExomemPaddleConfig,
} from "./paddle-config";
import type { PaddleTransport } from "./paddle-billing";

type BillingDeletionTarget = {
  source: "complimentary" | "paddle";
  sourceState: string;
  subscriptionRef: string | null;
};

export type BillingDeletionDependencies = {
  loadTarget: (tenantId: string) => Promise<BillingDeletionTarget | null>;
  markTerminated: (tenantId: string) => Promise<void>;
  config: ExomemPaddleConfig | null;
  transport: PaddleTransport;
};

async function loadTarget(tenantId: string): Promise<BillingDeletionTarget | null> {
  const { rows } = await executeExomemSql`
    /* exomem:billing-deletion-target */
    SELECT entitlement.source,
           entitlement.source_state,
           entitlement.provider_subscription_ref
    FROM exomem_entitlements AS entitlement
    JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
    WHERE entitlement.tenant_id = ${tenantId}
      AND tenant.status = 'deletion_pending'
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        source: String(row.source) as "complimentary" | "paddle",
        sourceState: String(row.source_state),
        subscriptionRef: row.provider_subscription_ref
          ? String(row.provider_subscription_ref)
          : null,
      }
    : null;
}

async function markTerminated(tenantId: string): Promise<void> {
  await executeExomemSql`
    /* exomem:billing-deletion-terminated */
    UPDATE exomem_entitlements
    SET source_state = CASE
          WHEN source = 'paddle' THEN 'deletion_cancelled'
          ELSE source_state
        END,
        updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND effective_state = 'deleted'
  `;
}

function defaults(): BillingDeletionDependencies {
  return {
    loadTarget,
    markTerminated,
    config: null,
    transport: paddleFetch,
  };
}

export async function terminateExomemBillingForDeletion(
  tenantId: string,
  dependencies?: Partial<BillingDeletionDependencies>
): Promise<boolean> {
  let deps: BillingDeletionDependencies;
  try {
    deps = { ...defaults(), ...dependencies };
  } catch {
    return false;
  }
  const target = await deps.loadTarget(tenantId).catch(() => null);
  if (!target) return false;
  if (target.source === "complimentary") {
    return deps.markTerminated(tenantId).then(
      () => true,
      () => false
    );
  }
  if (["cancelled", "deletion_cancelled"].includes(target.sourceState)) {
    return deps.markTerminated(tenantId).then(
      () => true,
      () => false
    );
  }
  if (!target.subscriptionRef) {
    if (target.sourceState !== "awaiting_checkout") {
      return false;
    }
    return deps.markTerminated(tenantId).then(
      () => true,
      () => false
    );
  }
  if (!/^sub_[a-z0-9]{26}$/.test(target.subscriptionRef)) return false;
  try {
    const config = deps.config ?? loadExomemPaddleConfig();
    assertExomemPaddlePurpose(config, "portal");
    const response = await deps.transport(
      `/subscriptions/${encodeURIComponent(target.subscriptionRef)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ effective_from: "immediately" }),
      }
    );
    if (!response.ok && response.status !== 404) {
      await response.arrayBuffer().catch(() => undefined);
      return false;
    }
    await deps.markTerminated(tenantId);
    return true;
  } catch {
    return false;
  }
}
