import type {
  AtomicExomemPaddleEventStore,
  ExomemPaddleEventApplication,
  ExomemPaddleStoreResult,
} from "./paddle-webhook";
import { sql as pgSql } from "../db/pg-sql";
import { sealExomemEmailPayload } from "./email-outbox";

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
      const canBindSubscriptionByTransaction =
        application.eventType === "subscription.created" ||
        application.eventType === "subscription.activated";
      // Email 04 announces the move into past due that this statement may
      // apply. The statement enqueues it only if it applies that move.
      const graceStartedAt = application.revision.occurredAt;
      const mayStartGrace = isSubscriptionEvent && application.sourceState === "past_due";
      const paymentFailedPayload = mayStartGrace
        ? sealExomemEmailPayload("payment_failed", {
            version: 1,
            tenantId: application.correlation.tenantId,
            graceStartedAt,
          })
        : null;

      const { rows } = await sql`
        /* exomem:paddle-event-atomic-apply */
        WITH authoritative_target AS (
          SELECT tenant.id AS tenant_id,
                 tenant.status AS tenant_status,
                 entitlement.id AS entitlement_id,
                 entitlement.manual_suspended_at,
                 entitlement.source_occurred_at,
                 entitlement.source_revision,
                 entitlement.provider_environment,
                 entitlement.source_state
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
                    ${canBindSubscriptionByTransaction}
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
                 authoritative_target.source_state AS prior_source_state,
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
              -- A subscription event carries the whole subscription, so NULL
              -- is what Paddle reports (no discount, no next payment).
              provider_price_id = CASE WHEN ${isSubscriptionEvent}::boolean
                THEN ${application.providerReferences.priceId}::text
                ELSE entitlement.provider_price_id END,
              provider_price_name = CASE WHEN ${isSubscriptionEvent}::boolean
                THEN ${application.subscriptionFacts.priceName}::text
                ELSE entitlement.provider_price_name END,
              provider_next_billed_at = CASE WHEN ${isSubscriptionEvent}::boolean
                THEN ${application.subscriptionFacts.nextBilledAt}::timestamptz
                ELSE entitlement.provider_next_billed_at END,
              provider_discount_id = CASE WHEN ${isSubscriptionEvent}::boolean
                THEN ${application.subscriptionFacts.discountId}::text
                ELSE entitlement.provider_discount_id END,
              provider_scheduled_change_at = CASE WHEN ${isSubscriptionEvent}::boolean
                THEN ${application.subscriptionFacts.scheduledChangeAt}::timestamptz
                ELSE entitlement.provider_scheduled_change_at END,
              -- Only a transition into past_due starts the period. A past_due
              -- row keeps its stored start, unknown included; any other state
              -- ends it. SET expressions read the row before this update.
              grace_started_at = CASE
                WHEN NOT ${isSubscriptionEvent}::boolean THEN entitlement.grace_started_at
                WHEN ${application.sourceState}::text <> 'past_due' THEN NULL
                WHEN entitlement.source_state = 'past_due' THEN entitlement.grace_started_at
                ELSE ${application.revision.occurredAt}::timestamptz
              END,
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
        payment_failed_email AS (
          INSERT INTO exomem_email_outbox (
            kind, dedupe_key, recipient, recipient_time_zone, tenant_id, payload_ciphertext
          )
          SELECT 'payment_failed',
                 'payment-failed:' || decision.tenant_id::text || ':' || ${graceStartedAt}::text,
                 owner.email,
                 tenant.time_zone,
                 tenant.id,
                 ${paymentFailedPayload}::jsonb
          FROM projected
          JOIN decision ON decision.entitlement_id = projected.id
          JOIN exomem_tenants AS tenant ON tenant.id = decision.tenant_id
          JOIN users AS owner ON owner.id = tenant.owner_user_id
          WHERE ${mayStartGrace}::boolean
            AND decision.prior_source_state IS DISTINCT FROM 'past_due'
            AND decision.tenant_status NOT IN ('deletion_pending', 'deleted')
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING id
        ),
        -- Paddle is the source of truth for the friend price. The newest
        -- applied subscription event that carries the friend discount gives a
        -- tenant without a friend offer the offer of a friend invitation
        -- addressed to its owner, in this transaction: an older event is
        -- stale and records nothing, and no later step can lose the write.
        friend_offer AS (
          UPDATE exomem_tenants AS tenant
          SET friend_offer_invite_id = offer.invite_id,
              updated_at = now()
          FROM decision
          JOIN LATERAL (
            SELECT invite.id AS invite_id
            FROM exomem_tenants AS owned
            JOIN users AS owner ON owner.id = owned.owner_user_id
            JOIN exomem_invites AS invite ON invite.email_normalized = owner.email
            WHERE owned.id = decision.tenant_id
              AND invite.kind = 'friend'
              AND invite.revoked_at IS NULL
              AND (
                invite.consumed_by_user_id = owner.id
                OR (invite.consumed_at IS NULL AND invite.expires_at > now())
              )
            -- Every friend invitation carries the same discount; the newest
            -- names the inviter the owner heard from last.
            ORDER BY invite.created_at DESC
            LIMIT 1
          ) AS offer ON true
          WHERE tenant.id = decision.tenant_id
            AND decision.outcome = 'applied'
            AND decision.tenant_status NOT IN ('deletion_pending', 'deleted')
            AND ${isSubscriptionEvent && application.subscriptionCarriesFriendDiscount}::boolean
            AND tenant.friend_offer_invite_id IS NULL
            AND EXISTS (SELECT 1 FROM claimed)
          RETURNING tenant.id
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
  const execute: ExomemPaddleSql = (strings, ...values) => {
    if (!process.env.DATABASE_URL) throw new Error("EXOMEM_PADDLE_STORE_UNAVAILABLE");
    return pgSql(strings, ...values);
  };
  defaultStore = createSqlExomemPaddleEventStore(execute);
  return defaultStore;
}
