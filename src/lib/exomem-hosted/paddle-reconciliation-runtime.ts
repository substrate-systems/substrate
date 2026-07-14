import { randomUUID } from "node:crypto";
import { executeExomemSql } from "./db";
import { getDefaultSqlExomemPaddleEventStore, type ExomemPaddleSql } from "./paddle-event-store";
import { assertExomemPaddlePurpose, loadExomemPaddleConfig } from "./paddle-config";
import type { ExomemPaddleEnvironment } from "./paddle-config";
import {
  reconcileExomemPaddleSubscription,
  type PaddleReconciliationTarget,
} from "./paddle-reconciliation";
import type { ExomemPaddleStoreResult } from "./paddle-webhook";

const RECONCILIATION_LEASE_MS = 30_000;
const RECONCILIATION_MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const RECONCILIATION_FAILURE_CODE = "PADDLE_RECONCILIATION_FAILED";

export type ClaimedPaddleReconciliationTarget = PaddleReconciliationTarget &
  Readonly<{ attempts: number }>;

export type PaddleReconciliationSummary = {
  configured: boolean;
  attempted: number;
  applied: number;
  duplicate: number;
  stale: number;
  ignored: number;
  failed: number;
};

type ClaimInput = Readonly<{
  limit: number;
  leaseOwner: string;
  leaseMs: number;
  environment: ExomemPaddleEnvironment;
}>;

type LeaseInput = Readonly<{
  target: ClaimedPaddleReconciliationTarget;
  leaseOwner: string;
}>;

type FailureInput = LeaseInput &
  Readonly<{
    nextAttemptAt: string;
    errorCode: string;
  }>;

export type PaddleReconciliationRuntimeDependencies = {
  env?: Record<string, string | undefined>;
  now?: () => number;
  randomUUID?: () => string;
  createAbortSignal?: (timeoutMs: number) => AbortSignal;
  hasPersistedTargets?: () => Promise<boolean>;
  hasUnprovenReferences?: () => Promise<boolean>;
  hasEnvironmentConflict?: (environment: ExomemPaddleEnvironment) => Promise<boolean>;
  claimTargets?: (input: ClaimInput) => Promise<ClaimedPaddleReconciliationTarget[]>;
  markSucceeded?: (input: LeaseInput) => Promise<boolean>;
  markFailed?: (input: FailureInput) => Promise<boolean>;
  releaseLease?: (input: LeaseInput) => Promise<boolean>;
  reconcileTarget?: (
    target: PaddleReconciliationTarget,
    options: Readonly<{ signal: AbortSignal }>
  ) => Promise<ExomemPaddleStoreResult>;
};

function emptySummary(configured: boolean): PaddleReconciliationSummary {
  return {
    configured,
    attempted: 0,
    applied: 0,
    duplicate: 0,
    stale: 0,
    ignored: 0,
    failed: 0,
  };
}

function configurationRequired(): Error {
  return new Error("EXOMEM_PADDLE_RECONCILIATION_CONFIGURATION_REQUIRED");
}

function parseClaimedTarget(row: Record<string, unknown>): ClaimedPaddleReconciliationTarget {
  const userId = typeof row.owner_user_id === "string" ? row.owner_user_id : "";
  const tenantId = typeof row.tenant_id === "string" ? row.tenant_id : "";
  const subscriptionId =
    typeof row.provider_subscription_ref === "string" ? row.provider_subscription_ref : "";
  const attempts = Number(row.provider_reconcile_attempts);
  const environment = row.provider_environment;
  if (
    !userId ||
    !tenantId ||
    !subscriptionId ||
    (environment !== "sandbox" && environment !== "production") ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0
  ) {
    throw new Error("EXOMEM_PADDLE_RECONCILIATION_ROW_INVALID");
  }
  return { userId, tenantId, subscriptionId, environment, attempts };
}

function retryDelayMs(attempts: number): number {
  return Math.min(RECONCILIATION_MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(10, Math.max(0, attempts)));
}

export async function hasPersistedPaddleReconciliationTargets(
  sql: ExomemPaddleSql = executeExomemSql
): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:paddle-reconciliation-present */
    SELECT EXISTS (
      SELECT 1
      FROM exomem_entitlements AS entitlement
      JOIN exomem_tenants AS tenant
        ON tenant.id = entitlement.tenant_id
      WHERE entitlement.source = 'paddle'
        AND entitlement.provider_subscription_ref IS NOT NULL
        AND entitlement.source_state <> 'cancelled'
        AND tenant.status NOT IN ('deletion_pending', 'deleted')
        AND tenant.desired_state <> 'deleted'
    ) AS present
  `;
  return rows[0]?.present === true;
}

export async function hasPaddleReconciliationEnvironmentConflict(
  environment: ExomemPaddleEnvironment,
  sql: ExomemPaddleSql = executeExomemSql
): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:paddle-reconciliation-environment-conflict */
    SELECT EXISTS (
      SELECT 1
      FROM exomem_entitlements AS entitlement
      JOIN exomem_tenants AS tenant
        ON tenant.id = entitlement.tenant_id
      WHERE entitlement.source = 'paddle'
        AND entitlement.provider_subscription_ref IS NOT NULL
        AND entitlement.source_state <> 'cancelled'
        AND tenant.status NOT IN ('deletion_pending', 'deleted')
        AND tenant.desired_state <> 'deleted'
        AND entitlement.provider_environment IS NOT NULL
        AND entitlement.provider_environment <> ${environment}
    ) AS present
  `;
  return rows[0]?.present === true;
}

export async function hasUnprovenPaddleReconciliationReferences(
  sql: ExomemPaddleSql = executeExomemSql
): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:paddle-reconciliation-provenance-missing */
    SELECT EXISTS (
      SELECT 1
      FROM exomem_entitlements AS entitlement
      JOIN exomem_tenants AS tenant
        ON tenant.id = entitlement.tenant_id
      WHERE entitlement.source = 'paddle'
        AND entitlement.provider_subscription_ref IS NOT NULL
        AND entitlement.provider_environment IS NULL
        AND entitlement.source_state <> 'cancelled'
        AND tenant.status NOT IN ('deletion_pending', 'deleted')
        AND tenant.desired_state <> 'deleted'
    ) AS present
  `;
  return rows[0]?.present === true;
}

/** Atomically claim a bounded due batch so overlapping cron invocations cannot duplicate work. */
export async function claimPaddleReconciliationTargets(
  input: ClaimInput,
  sql: ExomemPaddleSql = executeExomemSql
): Promise<ClaimedPaddleReconciliationTarget[]> {
  const { rows } = await sql`
    /* exomem:paddle-reconciliation-claim */
    WITH candidate AS (
      SELECT entitlement.id
      FROM exomem_entitlements AS entitlement
      JOIN exomem_tenants AS tenant
        ON tenant.id = entitlement.tenant_id
      WHERE entitlement.source = 'paddle'
        AND entitlement.provider_subscription_ref IS NOT NULL
        AND entitlement.provider_environment = ${input.environment}
        AND entitlement.source_state <> 'cancelled'
        AND entitlement.provider_reconcile_after <= now()
        AND (
          entitlement.provider_reconcile_lease_expires_at IS NULL
          OR entitlement.provider_reconcile_lease_expires_at <= now()
        )
        AND tenant.status NOT IN ('deletion_pending', 'deleted')
        AND tenant.desired_state <> 'deleted'
      ORDER BY entitlement.provider_reconcile_after, entitlement.tenant_id
      FOR UPDATE OF entitlement SKIP LOCKED
      LIMIT ${input.limit}
    ), claimed AS (
      UPDATE exomem_entitlements AS entitlement
      SET provider_reconcile_lease_owner = ${input.leaseOwner}::uuid,
          provider_reconcile_lease_expires_at =
            now() + (${input.leaseMs}::bigint * interval '1 millisecond')
      FROM candidate
      WHERE entitlement.id = candidate.id
      RETURNING entitlement.tenant_id,
                entitlement.provider_environment,
                entitlement.provider_subscription_ref,
                entitlement.provider_reconcile_attempts
    )
    SELECT tenant.owner_user_id,
           claimed.tenant_id,
           claimed.provider_environment,
           claimed.provider_subscription_ref,
           claimed.provider_reconcile_attempts
    FROM claimed
    JOIN exomem_tenants AS tenant
      ON tenant.id = claimed.tenant_id
  `;
  return rows.map(parseClaimedTarget);
}

export async function markPaddleReconciliationSucceeded(
  input: LeaseInput,
  sql: ExomemPaddleSql = executeExomemSql
): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:paddle-reconciliation-succeeded */
    UPDATE exomem_entitlements
    SET provider_reconciled_at = now(),
        provider_reconcile_after = now() + interval '6 hours',
        provider_reconcile_lease_owner = NULL,
        provider_reconcile_lease_expires_at = NULL,
        provider_reconcile_attempts = 0,
        provider_reconcile_error_code = NULL
    WHERE tenant_id = ${input.target.tenantId}::uuid
      AND provider_subscription_ref = ${input.target.subscriptionId}
      AND provider_environment = ${input.target.environment}
      AND provider_reconcile_lease_owner = ${input.leaseOwner}::uuid
    RETURNING true AS updated
  `;
  return rows[0]?.updated === true;
}

export async function markPaddleReconciliationFailed(
  input: FailureInput,
  sql: ExomemPaddleSql = executeExomemSql
): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:paddle-reconciliation-failed */
    UPDATE exomem_entitlements
    SET provider_reconcile_after = ${input.nextAttemptAt}::timestamptz,
        provider_reconcile_lease_owner = NULL,
        provider_reconcile_lease_expires_at = NULL,
        provider_reconcile_attempts = provider_reconcile_attempts + 1,
        provider_reconcile_error_code = ${input.errorCode}
    WHERE tenant_id = ${input.target.tenantId}::uuid
      AND provider_subscription_ref = ${input.target.subscriptionId}
      AND provider_environment = ${input.target.environment}
      AND provider_reconcile_lease_owner = ${input.leaseOwner}::uuid
    RETURNING true AS updated
  `;
  return rows[0]?.updated === true;
}

export async function releasePaddleReconciliationLease(
  input: LeaseInput,
  sql: ExomemPaddleSql = executeExomemSql
): Promise<boolean> {
  const { rows } = await sql`
    /* exomem:paddle-reconciliation-release */
    UPDATE exomem_entitlements
    SET provider_reconcile_lease_owner = NULL,
        provider_reconcile_lease_expires_at = NULL
    WHERE tenant_id = ${input.target.tenantId}::uuid
      AND provider_subscription_ref = ${input.target.subscriptionId}
      AND provider_environment = ${input.target.environment}
      AND provider_reconcile_lease_owner = ${input.leaseOwner}::uuid
    RETURNING true AS updated
  `;
  return rows[0]?.updated === true;
}

export async function runBoundedPaddleReconcile(
  input: { maxSubscriptions?: number; timeBudgetMs?: number } = {},
  dependencies: PaddleReconciliationRuntimeDependencies = {}
): Promise<PaddleReconciliationSummary> {
  const env = dependencies.env ?? process.env;
  const hasPersistedTargets =
    dependencies.hasPersistedTargets ?? (() => hasPersistedPaddleReconciliationTargets());
  if (!env.EXOMEM_PADDLE_PRODUCT_ID?.trim()) {
    if (await hasPersistedTargets()) throw configurationRequired();
    return emptySummary(false);
  }

  const config = loadExomemPaddleConfig(env);
  assertExomemPaddlePurpose(config, "reconciliation");
  const hasUnprovenReferences =
    dependencies.hasUnprovenReferences ?? hasUnprovenPaddleReconciliationReferences;
  if (await hasUnprovenReferences()) {
    throw new Error("EXOMEM_PADDLE_RECONCILIATION_PROVENANCE_REQUIRED");
  }
  const hasEnvironmentConflict =
    dependencies.hasEnvironmentConflict ?? hasPaddleReconciliationEnvironmentConflict;
  if (await hasEnvironmentConflict(config.environment)) {
    throw new Error("EXOMEM_PADDLE_RECONCILIATION_ENVIRONMENT_MISMATCH");
  }
  const maxSubscriptions = Math.min(20, Math.max(1, input.maxSubscriptions ?? 5));
  const timeBudgetMs = Math.min(10_000, Math.max(250, input.timeBudgetMs ?? 3_000));
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const leaseOwner = (dependencies.randomUUID ?? randomUUID)();
  const claimTargets = dependencies.claimTargets ?? claimPaddleReconciliationTargets;
  const markSucceeded = dependencies.markSucceeded ?? markPaddleReconciliationSucceeded;
  const markFailed = dependencies.markFailed ?? markPaddleReconciliationFailed;
  const releaseLease = dependencies.releaseLease ?? releasePaddleReconciliationLease;
  const createAbortSignal = dependencies.createAbortSignal ?? AbortSignal.timeout;
  const targets = (
    await claimTargets({
      limit: maxSubscriptions,
      leaseOwner,
      leaseMs: RECONCILIATION_LEASE_MS,
      environment: config.environment,
    })
  ).slice(0, maxSubscriptions);
  const reconcileTarget =
    dependencies.reconcileTarget ??
    ((target: PaddleReconciliationTarget, options: Readonly<{ signal: AbortSignal }>) => {
      const store = getDefaultSqlExomemPaddleEventStore();
      return reconcileExomemPaddleSubscription(target, {
        config,
        store,
        signal: options.signal,
      });
    });
  const summary = emptySummary(true);

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const remainingMs = timeBudgetMs - (now() - startedAt);
    if (remainingMs <= 0) {
      for (const unstarted of targets.slice(index)) {
        await releaseLease({ target: unstarted, leaseOwner });
      }
      break;
    }

    summary.attempted += 1;
    let result: ExomemPaddleStoreResult;
    try {
      result = await reconcileTarget(target, {
        signal: createAbortSignal(Math.max(1, Math.ceil(remainingMs))),
      });
    } catch {
      summary.failed += 1;
      await markFailed({
        target,
        leaseOwner,
        nextAttemptAt: new Date(now() + retryDelayMs(target.attempts)).toISOString(),
        errorCode: RECONCILIATION_FAILURE_CODE,
      });
      continue;
    }

    const completed = await markSucceeded({ target, leaseOwner });
    if (!completed) {
      // A webhook can rebind the subscription while the provider request is in
      // flight. Do not mark the new reference reconciled using the old claim.
      await releaseLease({ target, leaseOwner });
      summary.ignored += 1;
      continue;
    }
    summary[result.outcome] += 1;
  }
  return summary;
}
