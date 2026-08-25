import {
  EXOMEM_PADDLE_PRODUCT_KEY,
  ExomemPaddleConfigurationError,
  loadExomemPaddleConfig,
} from "./paddle-config";
import {
  EXOMEM_ALPHA_BUNDLE,
  type ExomemCapability,
  type ExomemResourceLimits,
  type ExomemSourceProjection,
} from "./entitlements";

export type PaddleSourceState = Extract<ExomemSourceProjection, { source: "paddle" }>["state"];

export type PaddleRevision = Readonly<{
  occurredAt: string;
  eventId: string;
}>;

export type ExomemPaddleEventApplication = Readonly<{
  eventId: string;
  eventType: string;
  environment: "sandbox" | "production";
  origin: "webhook" | "reconciliation";
  revision: PaddleRevision;
  correlation: {
    productKey: typeof EXOMEM_PADDLE_PRODUCT_KEY;
    userId: string;
    tenantId: string;
  };
  sourceState: PaddleSourceState | null;
  capabilities: readonly ExomemCapability[];
  resourceLimits: ExomemResourceLimits;
  providerReferences: {
    customerId: string | null;
    subscriptionId: string | null;
    transactionId: string | null;
    productId: string | null;
    priceId: string | null;
  };
}>;

export type ExomemPaddleStoreResult = Readonly<{
  outcome: "applied" | "duplicate" | "stale" | "ignored";
}>;

/**
 * Foundation adapter seam.
 *
 * A production implementation MUST execute receipt insertion/claim,
 * monotonic source projection, audit retention, and processed marking in one
 * database transaction. If the callback throws, no processed receipt may be
 * committed. It MUST update source state/revision only and must never clear or
 * overwrite `manual_suspended_at`; effective-state evaluation happens later.
 * A begin/apply pair exposed as separate methods does not satisfy this contract.
 */
export interface AtomicExomemPaddleEventStore {
  applyVerifiedEventAndMarkProcessedAtomically(
    application: ExomemPaddleEventApplication
  ): Promise<ExomemPaddleStoreResult>;
}

export type ExomemPaddleDispatchResult =
  | { kind: "not_exomem" }
  | {
      kind: "handled";
      outcome: ExomemPaddleStoreResult["outcome"];
    }
  | {
      kind: "rejected";
      code:
        | "EXOMEM_PADDLE_CONFIGURATION_INVALID"
        | "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
        | "EXOMEM_PADDLE_PRODUCT_CONFLICT"
        | "EXOMEM_PADDLE_CORRELATION_INVALID"
        | "EXOMEM_PADDLE_EVENT_INVALID"
        | "EXOMEM_PADDLE_STORE_UNAVAILABLE"
        | "EXOMEM_PADDLE_TRANSIENT_FAILURE";
      status: 400 | 503;
    };

type DispatchDependencies = {
  env?: Record<string, string | undefined>;
  store?: AtomicExomemPaddleEventStore;
};

const INTERNAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function internalUuid(value: unknown): string | null {
  const candidate = nonEmptyString(value);
  return candidate && INTERNAL_UUID.test(candidate) ? candidate.toLowerCase() : null;
}

function itemReferences(data: Record<string, unknown>): Array<{
  productId: string | null;
  priceId: string | null;
}> {
  if (!Array.isArray(data.items)) return [];
  return data.items.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item.price)) return [];
    return [
      {
        productId: nonEmptyString(item.price.product_id),
        priceId: nonEmptyString(item.price.id),
      },
    ];
  });
}

export function mapPaddleSubscriptionState(state: unknown): PaddleSourceState | null {
  switch (state) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

function eventSourceState(
  eventType: string,
  data: Record<string, unknown>
): PaddleSourceState | null {
  switch (eventType) {
    case "subscription.created":
    case "subscription.activated":
    case "subscription.resumed":
      return data.status === "trialing" ? "trialing" : "active";
    case "subscription.trialing":
      return "trialing";
    case "subscription.past_due":
      return "past_due";
    case "subscription.paused":
      return "paused";
    case "subscription.canceled":
    case "subscription.cancelled":
      return "cancelled";
    case "subscription.updated":
      return mapPaddleSubscriptionState(data.status);
    default:
      return null;
  }
}

export function comparePaddleRevisions(left: PaddleRevision, right: PaddleRevision): number {
  const timeDifference = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
  if (timeDifference !== 0) return timeDifference;
  return left.eventId.localeCompare(right.eventId);
}

function rejectedConfiguration(_error: ExomemPaddleConfigurationError): ExomemPaddleDispatchResult {
  return {
    kind: "rejected",
    code: "EXOMEM_PADDLE_CONFIGURATION_INVALID",
    status: 503,
  };
}

/**
 * Dispatches an event only after the shared route has verified its signature.
 * It intentionally performs no signature verification and has no import-time
 * configuration or database side effects.
 */
export async function dispatchVerifiedExomemPaddleEvent(
  rawEvent: unknown,
  dependencies: DispatchDependencies = {}
): Promise<ExomemPaddleDispatchResult> {
  if (!isRecord(rawEvent) || !isRecord(rawEvent.data)) {
    return { kind: "not_exomem" };
  }
  const env = dependencies.env ?? process.env;
  const data = rawEvent.data;
  const customData = isRecord(data.custom_data) ? data.custom_data : {};
  const explicitProductKey = nonEmptyString(customData.product_key);
  const configuredProductId = nonEmptyString(env.EXOMEM_PADDLE_PRODUCT_ID);
  const references = itemReferences(data);
  const catalogMatch = Boolean(
    configuredProductId && references.some((item) => item.productId === configuredProductId)
  );
  const keyMatch = explicitProductKey === EXOMEM_PADDLE_PRODUCT_KEY;

  if (!keyMatch && !catalogMatch) return { kind: "not_exomem" };
  if (
    (catalogMatch && explicitProductKey && explicitProductKey !== EXOMEM_PADDLE_PRODUCT_KEY) ||
    (keyMatch && configuredProductId && references.some((item) => item.productId) && !catalogMatch)
  ) {
    return {
      kind: "rejected",
      code: "EXOMEM_PADDLE_PRODUCT_CONFLICT",
      status: 400,
    };
  }

  let config;
  try {
    config = loadExomemPaddleConfig(env);
  } catch (error) {
    return rejectedConfiguration(error as ExomemPaddleConfigurationError);
  }
  const eventEnvironment = nonEmptyString(rawEvent.environment);
  // Paddle endpoint/secret + configured catalog are authoritative. Some Paddle
  // payloads omit environment; an explicit contradictory value is rejected.
  if (eventEnvironment && eventEnvironment !== config.environment) {
    return {
      kind: "rejected",
      code: "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH",
      status: 400,
    };
  }

  const eventId = nonEmptyString(rawEvent.event_id);
  const eventType = nonEmptyString(rawEvent.event_type);
  const occurredAt = nonEmptyString(rawEvent.occurred_at);
  if (!eventId || !eventType || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
    return {
      kind: "rejected",
      code: "EXOMEM_PADDLE_EVENT_INVALID",
      status: 400,
    };
  }
  const userId = internalUuid(customData.user_id);
  const tenantId = internalUuid(customData.tenant_id);
  if (!userId || !tenantId) {
    return {
      kind: "rejected",
      code: "EXOMEM_PADDLE_CORRELATION_INVALID",
      status: 400,
    };
  }
  let store = dependencies.store;
  if (!store) {
    try {
      // Lazy import keeps ordinary Endstate webhook module loading free of
      // Exomem database configuration and connection side effects.
      const { getDefaultSqlExomemPaddleEventStore } = await import("./paddle-event-store");
      store = getDefaultSqlExomemPaddleEventStore();
    } catch {
      return {
        kind: "rejected",
        code: "EXOMEM_PADDLE_STORE_UNAVAILABLE",
        status: 503,
      };
    }
  }

  const matchingReference =
    references.find((item) => item.productId === config.productId) ?? references[0];
  const application: ExomemPaddleEventApplication = {
    eventId,
    eventType,
    environment: config.environment,
    origin: "webhook",
    revision: {
      occurredAt: new Date(occurredAt).toISOString(),
      eventId,
    },
    correlation: {
      productKey: EXOMEM_PADDLE_PRODUCT_KEY,
      userId,
      tenantId,
    },
    sourceState: eventSourceState(eventType, data),
    capabilities: EXOMEM_ALPHA_BUNDLE.capabilities,
    resourceLimits: { ...EXOMEM_ALPHA_BUNDLE.resourceLimits },
    providerReferences: {
      customerId: nonEmptyString(data.customer_id),
      subscriptionId: eventType.startsWith("subscription.") ? nonEmptyString(data.id) : null,
      transactionId: eventType.startsWith("transaction.")
        ? nonEmptyString(data.id)
        : eventType === "subscription.created" || eventType === "subscription.activated"
          ? nonEmptyString(data.transaction_id)
          : null,
      productId: matchingReference?.productId ?? null,
      priceId: matchingReference?.priceId ?? null,
    },
  };

  try {
    const result = await store.applyVerifiedEventAndMarkProcessedAtomically(application);
    return { kind: "handled", outcome: result.outcome };
  } catch {
    return {
      kind: "rejected",
      code: "EXOMEM_PADDLE_TRANSIENT_FAILURE",
      status: 503,
    };
  }
}
