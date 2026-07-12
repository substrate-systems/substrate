import type {
  AtomicExomemPaddleEventStore,
  ExomemPaddleEventApplication,
  ExomemPaddleStoreResult,
} from "./paddle-webhook";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type ExomemPaddleSqlResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
};

/** Matches the foundation lane's `executeExomemSql` tagged-template shape. */
export type ExomemPaddleSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<ExomemPaddleSqlResult>;

const OUTCOMES = new Set<ExomemPaddleStoreResult["outcome"]>([
  "applied",
  "duplicate",
  "stale",
  "ignored",
]);

/**
 * Concrete PostgreSQL adapter for migration 0017.
 *
 * The single data-modifying CTE is itself one transaction: receipt claiming,
 * authoritative owner/tenant correlation, monotonic source projection and the
 * terminal applied marker either commit together or all roll back. Production
 * wiring passes the foundation module's `executeExomemSql` into this factory.
 */
export function createSqlExomemPaddleEventStore(
  sql: ExomemPaddleSql
): AtomicExomemPaddleEventStore {
  return {
    async applyVerifiedEventAndMarkProcessedAtomically(
      application: ExomemPaddleEventApplication
    ): Promise<ExomemPaddleStoreResult> {
      const databaseEnvironment = application.environment === "production" ? "live" : "sandbox";
      const retainedCapabilities = application.capabilities.filter(
        (capability) => capability === "recall" || capability === "export"
      );
      const isSubscriptionEvent = application.eventType.startsWith("subscription.");
      const isTransactionEvent = application.eventType.startsWith("transaction.");
      const isSubscriptionCreated = application.eventType === "subscription.created";

      const { rows } = await sql`
        /* exomem:paddle-event-atomic-apply */
        WITH authoritative_target AS (
          SELECT tenant.id AS tenant_id,
                 tenant.status AS tenant_status,
                 entitlement.id AS entitlement_id,
                 entitlement.manual_suspended_at,
                 entitlement.source_occurred_at,
                 entitlement.source_revision
          FROM exomem_tenants AS tenant
          JOIN exomem_entitlements AS entitlement
            ON entitlement.tenant_id = tenant.id
          WHERE tenant.id = ${application.correlation.tenantId}::uuid
            AND tenant.owner_user_id = ${application.correlation.userId}::uuid
            AND entitlement.source = 'paddle'
            AND (
              (
                ${application.origin}::text = 'reconciliation'
                AND ${application.providerReferences.subscriptionId}::text IS NOT NULL
                AND entitlement.provider_subscription_ref = ${application.providerReferences.subscriptionId}
              )
              OR (
                ${isTransactionEvent}
                AND ${application.providerReferences.transactionId}::text IS NOT NULL
                AND entitlement.provider_transaction_ref = ${application.providerReferences.transactionId}
              )
              OR (
                ${isSubscriptionEvent}
                AND ${application.providerReferences.subscriptionId}::text IS NOT NULL
                AND (
                  entitlement.provider_subscription_ref = ${application.providerReferences.subscriptionId}
                  OR (
                    ${isSubscriptionCreated}
                    AND ${application.providerReferences.transactionId}::text IS NOT NULL
                    AND entitlement.provider_transaction_ref = ${application.providerReferences.transactionId}
                  )
                )
              )
            )
          FOR UPDATE OF tenant, entitlement
        ),
        claimed AS (
          INSERT INTO exomem_paddle_events (
            paddle_event_id,
            environment,
            event_type,
            tenant_id,
            source_revision,
            occurred_at
          ) VALUES (
            ${application.eventId},
            ${databaseEnvironment},
            ${application.eventType},
            (SELECT tenant_id FROM authoritative_target),
            ${application.revision.eventId},
            ${application.revision.occurredAt}
          )
          ON CONFLICT (paddle_event_id) DO UPDATE
          SET paddle_event_id = exomem_paddle_events.paddle_event_id
          RETURNING id, tenant_id, environment, event_type,
                    disposition, applied_at, error_code
        ),
        authoritative AS (
          SELECT claimed.id AS event_row_id,
                 claimed.applied_at,
                 authoritative_target.tenant_status,
                 authoritative_target.entitlement_id,
                 authoritative_target.manual_suspended_at,
                 authoritative_target.source_occurred_at,
                 authoritative_target.source_revision
          FROM claimed
          JOIN authoritative_target
            ON claimed.tenant_id = authoritative_target.tenant_id
          WHERE claimed.environment = ${databaseEnvironment}
            AND claimed.event_type = ${application.eventType}
        ),
        projected AS (
          UPDATE exomem_entitlements AS entitlement
          SET source = 'paddle',
              source_state = ${application.sourceState},
              effective_state = CASE
                WHEN authoritative.tenant_status = 'deleted' THEN 'deleted'
                WHEN authoritative.tenant_status = 'provisioning' THEN 'provisioning'
                WHEN authoritative.manual_suspended_at IS NOT NULL THEN 'suspended'
                WHEN ${application.sourceState} IN ('active', 'trialing') THEN 'active'
                WHEN ${application.sourceState} = 'past_due' THEN 'grace'
                WHEN ${application.sourceState} = 'paused' THEN 'suspended'
                WHEN ${application.sourceState} = 'cancelled' THEN 'cancelled'
                ELSE entitlement.effective_state
              END,
              capabilities = CASE
                WHEN authoritative.tenant_status IN ('deleted', 'provisioning')
                  OR authoritative.manual_suspended_at IS NOT NULL
                  THEN '[]'::jsonb
                WHEN ${application.sourceState} IN ('active', 'trialing')
                  THEN ${JSON.stringify(application.capabilities)}::jsonb
                ELSE ${JSON.stringify(retainedCapabilities)}::jsonb
              END,
              resource_limits = ${JSON.stringify(application.resourceLimits)}::jsonb,
              source_revision = ${application.revision.eventId},
              source_occurred_at = ${application.revision.occurredAt},
              provider_customer_ref = COALESCE(
                ${application.providerReferences.customerId},
                entitlement.provider_customer_ref
              ),
              provider_subscription_ref = COALESCE(
                ${isSubscriptionEvent ? application.providerReferences.subscriptionId : null},
                entitlement.provider_subscription_ref
              ),
              provider_transaction_ref = COALESCE(
                ${isTransactionEvent ? application.providerReferences.transactionId : null},
                entitlement.provider_transaction_ref
              ),
              updated_at = now()
          FROM authoritative
          WHERE entitlement.id = authoritative.entitlement_id
            AND authoritative.applied_at IS NULL
            AND ${application.sourceState}::text IS NOT NULL
            AND (
              authoritative.source_occurred_at IS NULL
              OR authoritative.source_occurred_at < ${application.revision.occurredAt}::timestamptz
              OR (
                authoritative.source_occurred_at = ${application.revision.occurredAt}::timestamptz
                AND COALESCE(authoritative.source_revision, '') < ${application.revision.eventId}
              )
            )
          RETURNING entitlement.id
        ),
        decision AS (
          SELECT claimed.id AS event_row_id,
                 EXISTS (SELECT 1 FROM authoritative) AS is_authoritative,
                 CASE
                   WHEN claimed.applied_at IS NOT NULL THEN 'duplicate'
                   WHEN ${application.sourceState}::text IS NULL
                     AND EXISTS (SELECT 1 FROM authoritative) THEN 'ignored'
                   WHEN EXISTS (SELECT 1 FROM projected) THEN 'applied'
                   WHEN EXISTS (SELECT 1 FROM authoritative) THEN 'stale'
                   ELSE 'ignored'
                 END AS outcome
          FROM claimed
        ),
        marked AS (
          UPDATE exomem_paddle_events AS paddle_event
          SET disposition = CASE
                WHEN decision.outcome = 'duplicate' THEN paddle_event.disposition
                WHEN decision.outcome = 'applied' THEN 'applied'
                WHEN decision.outcome = 'stale' THEN 'stale'
                WHEN decision.is_authoritative THEN 'ignored'
                ELSE 'rejected'
              END,
              applied_at = CASE
                WHEN decision.outcome = 'duplicate' THEN paddle_event.applied_at
                ELSE COALESCE(paddle_event.applied_at, now())
              END,
              error_code = CASE
                WHEN decision.outcome = 'duplicate' THEN paddle_event.error_code
                WHEN decision.is_authoritative THEN NULL
                ELSE 'CORRELATION_INVALID'
              END
          FROM decision
          WHERE paddle_event.id = decision.event_row_id
          RETURNING decision.outcome
        )
        SELECT outcome FROM marked
      `;

      const outcome = rows[0]?.outcome;
      if (typeof outcome !== "string" || !OUTCOMES.has(outcome as never)) {
        // Stable and identifier-free. A thrown statement/shape error leaves a
        // new receipt uncommitted, so the same Paddle delivery remains retryable.
        throw new Error("EXOMEM_PADDLE_ATOMIC_APPLY_FAILED");
      }
      return {
        outcome: outcome as ExomemPaddleStoreResult["outcome"],
      };
    },
  };
}

let defaultStore: AtomicExomemPaddleEventStore | null = null;

/** Lazy production wiring; importing webhook dispatch never opens a DB client. */
export function getDefaultSqlExomemPaddleEventStore(): AtomicExomemPaddleEventStore {
  if (defaultStore) return defaultStore;
  let client: NeonQueryFunction<false, true> | null = null;
  const execute: ExomemPaddleSql = (strings, ...values) => {
    if (!client) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("EXOMEM_PADDLE_STORE_UNAVAILABLE");
      client = neon(databaseUrl, { fullResults: true });
    }
    return client(strings, ...values) as Promise<ExomemPaddleSqlResult>;
  };
  defaultStore = createSqlExomemPaddleEventStore(execute);
  return defaultStore;
}
