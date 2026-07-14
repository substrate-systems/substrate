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
                 entitlement.source_revision,
                 entitlement.provider_environment
          FROM exomem_tenants AS tenant
          JOIN exomem_entitlements AS entitlement
            ON entitlement.tenant_id = tenant.id
          WHERE tenant.id = ${application.correlation.tenantId}::uuid
            AND tenant.owner_user_id = ${application.correlation.userId}::uuid
            AND entitlement.source = 'paddle'
            AND (
              entitlement.provider_environment = ${application.environment}
              OR (
                entitlement.provider_environment IS NULL
                AND ${application.origin}::text = 'webhook'
              )
            )
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
        decision AS (
          SELECT authoritative_target.tenant_id,
                 authoritative_target.tenant_status,
                 authoritative_target.entitlement_id,
                 authoritative_target.manual_suspended_at,
                 authoritative_target.source_occurred_at,
                 authoritative_target.source_revision,
                 authoritative_target.entitlement_id IS NOT NULL AS is_authoritative,
                 CASE
                   WHEN authoritative_target.entitlement_id IS NULL THEN 'ignored'
                   WHEN ${application.origin}::text = 'reconciliation'
                     AND authoritative_target.tenant_status IN ('deletion_pending', 'deleted')
                     THEN 'ignored'
                   WHEN ${application.sourceState}::text IS NULL THEN 'ignored'
                   WHEN authoritative_target.source_occurred_at IS NULL THEN 'applied'
                   WHEN authoritative_target.source_occurred_at
                          < ${application.revision.occurredAt}::timestamptz THEN 'applied'
                   WHEN authoritative_target.source_occurred_at
                          = ${application.revision.occurredAt}::timestamptz
                     AND COALESCE(authoritative_target.source_revision, '')
                          < ${application.revision.eventId} THEN 'applied'
                   ELSE 'stale'
                 END AS outcome
          FROM (VALUES (1)) AS singleton(seed)
          LEFT JOIN authoritative_target ON true
        ),
        claimed AS (
          INSERT INTO exomem_paddle_events (
            paddle_event_id,
            environment,
            event_type,
            tenant_id,
            source_revision,
            occurred_at,
            applied_at,
            disposition,
            error_code
          )
          SELECT ${application.eventId},
                 ${databaseEnvironment},
                 ${application.eventType},
                 decision.tenant_id,
                 ${application.revision.eventId},
                 ${application.revision.occurredAt},
                 now(),
                 CASE
                   WHEN decision.outcome = 'applied' THEN 'applied'
                   WHEN decision.outcome = 'stale' THEN 'stale'
                   WHEN decision.is_authoritative THEN 'ignored'
                   ELSE 'rejected'
                 END,
                 CASE
                   WHEN decision.is_authoritative THEN NULL
                   ELSE 'CORRELATION_INVALID'
                 END
          FROM decision
          ON CONFLICT (paddle_event_id) DO NOTHING
          RETURNING id
        ),
        projected AS (
          UPDATE exomem_entitlements AS entitlement
          SET source = 'paddle',
              source_state = ${application.sourceState},
              effective_state = CASE
                WHEN decision.tenant_status IN ('deletion_pending', 'deleted') THEN 'deleted'
                WHEN decision.tenant_status = 'provisioning' THEN 'provisioning'
                WHEN decision.manual_suspended_at IS NOT NULL THEN 'suspended'
                WHEN ${application.sourceState} IN ('active', 'trialing') THEN 'active'
                WHEN ${application.sourceState} = 'past_due' THEN 'grace'
                WHEN ${application.sourceState} = 'paused' THEN 'suspended'
                WHEN ${application.sourceState} = 'cancelled' THEN 'cancelled'
                ELSE entitlement.effective_state
              END,
              capabilities = CASE
                WHEN decision.tenant_status IN ('deletion_pending', 'deleted', 'provisioning')
                  OR decision.manual_suspended_at IS NOT NULL
                  THEN '[]'::jsonb
                WHEN ${application.sourceState} IN ('active', 'trialing')
                  THEN ${JSON.stringify(application.capabilities)}::jsonb
                ELSE ${JSON.stringify(retainedCapabilities)}::jsonb
              END,
              resource_limits = ${JSON.stringify(application.resourceLimits)}::jsonb,
              source_revision = ${application.revision.eventId},
              source_occurred_at = ${application.revision.occurredAt},
              provider_environment = ${application.environment},
              provider_provenance_unresolved_fingerprint = NULL,
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
          FROM decision
          WHERE entitlement.id = decision.entitlement_id
            AND decision.outcome = 'applied'
            AND EXISTS (SELECT 1 FROM claimed)
          RETURNING entitlement.id
        ),
        provenance_repaired AS (
          UPDATE exomem_entitlements AS entitlement
          SET provider_environment = ${application.environment},
              provider_provenance_unresolved_fingerprint = NULL,
              updated_at = now()
          FROM decision
          WHERE entitlement.id = decision.entitlement_id
            AND entitlement.provider_environment IS NULL
            AND ${application.origin}::text = 'webhook'
            AND ${application.sourceState}::text IS NULL
            AND EXISTS (SELECT 1 FROM claimed)
          RETURNING entitlement.id
        ),
        completion AS (
          SELECT count(*)::integer AS claimed_count,
                 (SELECT count(*)::integer FROM projected) AS projected_count,
                 (SELECT count(*)::integer FROM provenance_repaired) AS repaired_count
          FROM claimed
        )
        SELECT CASE
                 WHEN completion.claimed_count = 0 THEN 'duplicate'
                 ELSE decision.outcome
               END AS outcome,
               CASE
                 WHEN completion.claimed_count = 1 AND decision.outcome = 'applied'
                   THEN 1 / completion.projected_count
                 ELSE 1
               END AS projection_guard
        FROM decision
        CROSS JOIN completion
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
