import type {
  AtomicExomemPaddleEventStore,
  ExomemPaddleEventApplication,
  ExomemPaddleStoreResult,
} from "./paddle-webhook";
import { executeExomemSql } from "./db";
import { PROVISIONER_PROTOCOL_V2 } from "./provisioner";
import { provisionerWireProtocolFromEnv } from "./provisioner-wire-protocol";

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
      const provisionerWireProtocol = provisionerWireProtocolFromEnv();
      const databaseEnvironment = application.environment === "production" ? "live" : "sandbox";
      const retainedCapabilities = application.capabilities.filter(
        (capability) => capability === "recall" || capability === "export"
      );
      const isSubscriptionEvent = application.eventType.startsWith("subscription.");
      const isTransactionEvent = application.eventType.startsWith("transaction.");
      const canBindSubscriptionByTransaction =
        application.eventType === "subscription.created" ||
        application.eventType === "subscription.activated";

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
                 entitlement.source_state,
                 tenant.fence_generation
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
                 authoritative_target.fence_generation,
                 authoritative_target.entitlement_id IS NOT NULL AS is_authoritative,
                 COALESCE(
                   authoritative_target.source_state IN ('awaiting_checkout', 'checkout_pending')
                     AND ${application.sourceState} IN ('active', 'trialing'),
                   false
                 ) AS requires_provision_release,
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
        locked_allocation AS MATERIALIZED (
          SELECT allocation.id AS allocation_id,
                 allocation.tenant_id
          FROM exomem_capacity_allocations AS allocation
          JOIN decision ON decision.tenant_id = allocation.tenant_id
          WHERE decision.outcome = 'applied'
            AND decision.requires_provision_release
            AND allocation.state = 'reserved'
            AND allocation.operation_id IS NULL
          FOR UPDATE OF allocation
        ),
        live_target AS MATERIALIZED (
          SELECT candidate.id AS candidate_id,
                 NULL::uuid AS assignment_id,
                 NULL::bigint AS assignment_generation,
                 candidate.source_release,
                 candidate.protocol_version,
                 MIN(catalog_cell.observed_gateway_contract_digest) AS gateway_contract_digest,
                 candidate.command_fingerprint,
                 candidate.schema_digest,
                 candidate.compatibility_digest
          FROM exomem_agent_contract_candidates AS candidate
          JOIN exomem_cells AS catalog_cell
            ON catalog_cell.routing_state = 'bound'
           AND catalog_cell.release_version = candidate.source_release
           AND catalog_cell.protocol_version = candidate.protocol_version
           AND catalog_cell.observed_gateway_contract_digest IS NOT NULL
           AND catalog_cell.observed_command_fingerprint = candidate.command_fingerprint
           AND catalog_cell.observed_schema_digest = candidate.schema_digest
          WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
            AND candidate.state = 'live'
          GROUP BY candidate.id, candidate.source_release, candidate.protocol_version,
                   candidate.command_fingerprint, candidate.schema_digest,
                   candidate.compatibility_digest
          HAVING COUNT(DISTINCT catalog_cell.observed_gateway_contract_digest) = 1
        ),
        provision_target AS MATERIALIZED (
          SELECT candidate_id, assignment_id, assignment_generation, source_release,
                 protocol_version, gateway_contract_digest, command_fingerprint,
                 schema_digest, compatibility_digest
          FROM live_target
          WHERE ${provisionerWireProtocol} = ${PROVISIONER_PROTOCOL_V2}
          UNION ALL
          SELECT NULL::uuid, NULL::uuid, NULL::bigint, NULL::text, NULL::text,
                 NULL::text, NULL::text, NULL::text, NULL::text
          WHERE ${provisionerWireProtocol} <> ${PROVISIONER_PROTOCOL_V2}
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
        released_operation AS (
          INSERT INTO exomem_lifecycle_operations (
            tenant_id, operation_type, idempotency_key, fence_generation,
            provisioner_wire_protocol, target_candidate_id, target_assignment_id,
            target_assignment_generation, target_source_release, target_protocol_version,
            target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
            target_compatibility_digest
          )
          SELECT decision.tenant_id,
                 'provision',
                 'initial-provision',
                 decision.fence_generation,
                 ${provisionerWireProtocol},
                 provision_target.candidate_id,
                 provision_target.assignment_id,
                 provision_target.assignment_generation,
                 provision_target.source_release,
                 provision_target.protocol_version,
                 provision_target.gateway_contract_digest,
                 provision_target.command_fingerprint,
                 provision_target.schema_digest,
                 provision_target.compatibility_digest
          FROM decision
          JOIN locked_allocation ON locked_allocation.tenant_id = decision.tenant_id
          JOIN provision_target ON true
          WHERE decision.outcome = 'applied'
            AND decision.requires_provision_release
            AND EXISTS (SELECT 1 FROM claimed)
          ON CONFLICT (tenant_id, operation_type, idempotency_key) DO UPDATE
          SET updated_at = exomem_lifecycle_operations.updated_at
          RETURNING id, tenant_id
        ),
        attached_allocation AS (
          UPDATE exomem_capacity_allocations AS allocation
          SET operation_id = released_operation.id,
              updated_at = now()
          FROM locked_allocation, released_operation
          WHERE allocation.id = locked_allocation.allocation_id
            AND released_operation.tenant_id = locked_allocation.tenant_id
            AND allocation.operation_id IS NULL
          RETURNING allocation.id
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
                 (SELECT count(*)::integer FROM provenance_repaired) AS repaired_count,
                 (SELECT count(*)::integer FROM released_operation) AS operation_count,
                 (SELECT count(*)::integer FROM attached_allocation) AS attachment_count
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
               END AS projection_guard,
               CASE
                 WHEN completion.claimed_count = 1
                   AND decision.outcome = 'applied'
                   AND decision.requires_provision_release
                   THEN 1 / completion.operation_count / completion.attachment_count
                 ELSE 1
               END AS provision_release_guard
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
  defaultStore ??= createSqlExomemPaddleEventStore(executeExomemSql);
  return defaultStore;
}
