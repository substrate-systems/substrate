import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import type { PaddleTransport } from "./paddle-billing";
import { EXOMEM_ALPHA_BUNDLE } from "./entitlements";
import {
  assertExomemPaddlePurpose,
  EXOMEM_PADDLE_PRODUCT_KEY,
  type ExomemPaddleConfig,
} from "./paddle-config";
import {
  mapPaddleSubscriptionState,
  type AtomicExomemPaddleEventStore,
  type ExomemPaddleEventApplication,
  type ExomemPaddleStoreResult,
} from "./paddle-webhook";

export type PaddleReconciliationTarget = Readonly<{
  userId: string;
  tenantId: string;
  subscriptionId: string;
}>;

type ReconciliationDependencies = {
  config: ExomemPaddleConfig;
  store: AtomicExomemPaddleEventStore;
  transport?: PaddleTransport;
  now?: () => Date;
};

function invalid(): Error {
  // Stable, content-free error. Provider responses and identifiers are omitted.
  return new Error("EXOMEM_PADDLE_RECONCILIATION_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function reconcileExomemPaddleSubscription(
  target: PaddleReconciliationTarget,
  dependencies: ReconciliationDependencies
): Promise<ExomemPaddleStoreResult> {
  assertExomemPaddlePurpose(dependencies.config, "reconciliation");
  const transport = dependencies.transport ?? paddleFetch;
  let response: Response;
  try {
    response = await transport(`/subscriptions/${encodeURIComponent(target.subscriptionId)}`, {
      method: "GET",
    });
  } catch {
    throw invalid();
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw invalid();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalid();
  }
  if (!isRecord(payload) || !isRecord(payload.data)) throw invalid();
  const data = payload.data;
  const subscriptionId = stringValue(data.id);
  if (subscriptionId !== target.subscriptionId) throw invalid();
  const state = mapPaddleSubscriptionState(data.status);
  if (!state) throw invalid();

  const items = Array.isArray(data.items) ? data.items : [];
  const catalogMatch = items.some(
    (item) =>
      isRecord(item) &&
      isRecord(item.price) &&
      item.price.product_id === dependencies.config.productId
  );
  if (!catalogMatch) throw invalid();

  const customData = isRecord(data.custom_data) ? data.custom_data : null;
  if (customData) {
    const productKey = stringValue(customData.product_key);
    const userId = stringValue(customData.user_id);
    const tenantId = stringValue(customData.tenant_id);
    if (
      (productKey && productKey !== EXOMEM_PADDLE_PRODUCT_KEY) ||
      (userId && userId !== target.userId) ||
      (tenantId && tenantId !== target.tenantId)
    ) {
      throw invalid();
    }
  }

  const observedAt = (dependencies.now ?? (() => new Date()))();
  const sourceTime = stringValue(data.updated_at) ?? observedAt.toISOString();
  if (!Number.isFinite(Date.parse(sourceTime))) throw invalid();
  const occurredAt = new Date(sourceTime).toISOString();
  const application: ExomemPaddleEventApplication = {
    eventId: `reconcile:${target.tenantId}:${occurredAt}`,
    eventType: "subscription.reconciled",
    environment: dependencies.config.environment,
    origin: "reconciliation",
    revision: {
      occurredAt,
      eventId: `reconcile:${target.tenantId}:${occurredAt}`,
    },
    correlation: {
      productKey: EXOMEM_PADDLE_PRODUCT_KEY,
      userId: target.userId,
      tenantId: target.tenantId,
    },
    sourceState: state,
    capabilities: EXOMEM_ALPHA_BUNDLE.capabilities,
    resourceLimits: { ...EXOMEM_ALPHA_BUNDLE.resourceLimits },
    providerReferences: {
      customerId: stringValue(data.customer_id),
      subscriptionId,
      transactionId: null,
      productId: dependencies.config.productId,
      priceId: null,
    },
  };
  return dependencies.store.applyVerifiedEventAndMarkProcessedAtomically(application);
}
