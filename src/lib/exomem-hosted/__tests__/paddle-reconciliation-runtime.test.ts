import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimPaddleReconciliationTargets,
  hasPaddleReconciliationEnvironmentConflict,
  hasPersistedPaddleReconciliationTargets,
  hasUnprovenPaddleReconciliationReferences,
  markPaddleReconciliationFailed,
  markPaddleReconciliationSucceeded,
  releasePaddleReconciliationLease,
  runBoundedPaddleReconcile,
  type ClaimedPaddleReconciliationTarget,
  type PaddleReconciliationRuntimeDependencies,
} from "../paddle-reconciliation-runtime";
import type { ExomemPaddleSql } from "../paddle-event-store";

const ENV = {
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_API_KEY: "pdl_sdbx_runtime_test",
  EXOMEM_PADDLE_CATALOG_ENVIRONMENT: "sandbox",
  EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem",
};

const TARGETS: ClaimedPaddleReconciliationTarget[] = [
  {
    userId: "user-a",
    tenantId: "tenant-a",
    subscriptionId: "sub-a",
    environment: "sandbox",
    attempts: 0,
  },
  {
    userId: "user-b",
    tenantId: "tenant-b",
    subscriptionId: "sub-b",
    environment: "sandbox",
    attempts: 2,
  },
  {
    userId: "user-c",
    tenantId: "tenant-c",
    subscriptionId: "sub-c",
    environment: "sandbox",
    attempts: 0,
  },
];

describe("bounded Paddle reconciliation runtime", () => {
  it("is a clean no-op only when neither catalog config nor eligible paid rows exist", async () => {
    let claimed = false;
    const result = await runBoundedPaddleReconcile(
      {},
      {
        env: {},
        hasPersistedTargets: async () => false,
        claimTargets: async () => {
          claimed = true;
          return TARGETS;
        },
      }
    );
    assert.equal(claimed, false);
    assert.deepEqual(result, {
      configured: false,
      attempted: 0,
      applied: 0,
      duplicate: 0,
      stale: 0,
      ignored: 0,
      failed: 0,
    });
  });

  it("fails visibly when paid rows outlive required catalog configuration", async () => {
    await assert.rejects(
      runBoundedPaddleReconcile(
        {},
        {
          env: {},
          hasPersistedTargets: async () => true,
          claimTargets: async () => {
            throw new Error("must not claim without validated config");
          },
        }
      ),
      /EXOMEM_PADDLE_RECONCILIATION_CONFIGURATION_REQUIRED/
    );
  });

  it("fails before claiming when a subscription has no provider provenance", async () => {
    let claimed = false;
    await assert.rejects(
      runBoundedPaddleReconcile(
        {},
        {
          env: ENV,
          hasUnprovenReferences: async () => true,
          hasEnvironmentConflict: async () => false,
          claimTargets: async () => {
            claimed = true;
            return TARGETS;
          },
        }
      ),
      /EXOMEM_PADDLE_RECONCILIATION_PROVENANCE_REQUIRED/
    );
    assert.equal(claimed, false);
  });

  it("fails before claiming when retained refs belong to another environment", async () => {
    let claimed = false;
    await assert.rejects(
      runBoundedPaddleReconcile(
        {},
        {
          env: ENV,
          hasUnprovenReferences: async () => false,
          hasEnvironmentConflict: async (environment) => {
            assert.equal(environment, "sandbox");
            return true;
          },
          claimTargets: async () => {
            claimed = true;
            return TARGETS;
          },
        }
      ),
      /EXOMEM_PADDLE_RECONCILIATION_ENVIRONMENT_MISMATCH/
    );
    assert.equal(claimed, false);
  });

  it("leases a bounded batch, persists success cadence, and isolates provider failure", async () => {
    const reconciled: string[] = [];
    const succeeded: string[] = [];
    const failed: Array<{ subscriptionId: string; nextAttemptAt: string; errorCode: string }> = [];
    const signalBudgets: number[] = [];
    const dependencies: PaddleReconciliationRuntimeDependencies = {
      env: ENV,
      hasUnprovenReferences: async () => false,
      hasEnvironmentConflict: async () => false,
      randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      claimTargets: async (input) => {
        assert.deepEqual(input, {
          limit: 3,
          leaseOwner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          leaseMs: 30_000,
          environment: "sandbox",
        });
        return TARGETS;
      },
      createAbortSignal: (timeoutMs) => {
        signalBudgets.push(timeoutMs);
        return new AbortController().signal;
      },
      reconcileTarget: async (target, { signal }) => {
        assert.equal(signal.aborted, false);
        reconciled.push(target.subscriptionId);
        if (target.subscriptionId === "sub-b") throw new Error("private provider detail");
        return { outcome: target.subscriptionId === "sub-c" ? "stale" : "applied" };
      },
      markSucceeded: async ({ target, leaseOwner }) => {
        assert.equal(leaseOwner, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        succeeded.push(target.subscriptionId);
        return true;
      },
      markFailed: async ({ target, leaseOwner, nextAttemptAt, errorCode }) => {
        assert.equal(leaseOwner, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        failed.push({ subscriptionId: target.subscriptionId, nextAttemptAt, errorCode });
        return true;
      },
      releaseLease: async () => true,
      now: () => 0,
    };
    const result = await runBoundedPaddleReconcile(
      { maxSubscriptions: 3, timeBudgetMs: 4_000 },
      dependencies
    );
    assert.deepEqual(reconciled, ["sub-a", "sub-b", "sub-c"]);
    assert.deepEqual(succeeded, ["sub-a", "sub-c"]);
    assert.deepEqual(signalBudgets, [4_000, 4_000, 4_000]);
    assert.deepEqual(failed, [
      {
        subscriptionId: "sub-b",
        nextAttemptAt: "1970-01-01T00:04:00.000Z",
        errorCode: "PADDLE_RECONCILIATION_FAILED",
      },
    ]);
    assert.deepEqual(result, {
      configured: true,
      attempted: 3,
      applied: 1,
      duplicate: 0,
      stale: 1,
      ignored: 0,
      failed: 1,
    });
  });

  it("uses only the remaining deadline and releases claims it cannot start", async () => {
    const times = [0, 0, 501];
    const released: string[] = [];
    const signalBudgets: number[] = [];
    const result = await runBoundedPaddleReconcile(
      { maxSubscriptions: 3, timeBudgetMs: 500 },
      {
        env: ENV,
        hasUnprovenReferences: async () => false,
        hasEnvironmentConflict: async () => false,
        now: () => times.shift() ?? 501,
        randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        claimTargets: async () => TARGETS,
        createAbortSignal: (timeoutMs) => {
          signalBudgets.push(timeoutMs);
          return new AbortController().signal;
        },
        reconcileTarget: async () => ({ outcome: "duplicate" }),
        markSucceeded: async () => true,
        markFailed: async () => true,
        releaseLease: async ({ target }) => {
          released.push(target.subscriptionId);
          return true;
        },
      }
    );
    assert.deepEqual(signalBudgets, [500]);
    assert.deepEqual(released, ["sub-b", "sub-c"]);
    assert.equal(result.attempted, 1);
    assert.equal(result.duplicate, 1);
  });
});

describe("durable Paddle reconciliation SQL", () => {
  it("detects eligible paid rows even before catalog config is loaded", async () => {
    let query = "";
    const sql: ExomemPaddleSql = async (strings) => {
      query = strings.join("?");
      return { rows: [{ present: true }] };
    };
    assert.equal(await hasPersistedPaddleReconciliationTargets(sql), true);
    assert.match(query, /exomem:paddle-reconciliation-present/);
    assert.match(query, /source = 'paddle'/);
    assert.match(query, /source_state <> 'cancelled'/);
    assert.match(query, /status NOT IN \('deletion_pending', 'deleted'\)/);
  });

  it("detects unproven and cross-environment subscriptions without provider calls", async () => {
    const queries: string[] = [];
    const sql: ExomemPaddleSql = async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [{ present: true }] };
    };
    assert.equal(await hasUnprovenPaddleReconciliationReferences(sql), true);
    assert.equal(await hasPaddleReconciliationEnvironmentConflict("sandbox", sql), true);
    assert.match(queries[0], /provider_environment IS NULL/);
    assert.match(queries[1], /provider_environment <> \?/);
    assert.match(queries[1], /provider_environment IS NOT NULL/);
  });

  it("claims only due, eligible subscriptions with an expiring skip-locked lease", async () => {
    let query = "";
    let values: unknown[] = [];
    const sql: ExomemPaddleSql = async (strings, ...nextValues) => {
      query = strings.join("?");
      values = nextValues;
      return {
        rows: [
          {
            owner_user_id: "user-a",
            tenant_id: "tenant-a",
            provider_subscription_ref: "sub-a",
            provider_environment: "sandbox",
            provider_reconcile_attempts: 0,
          },
        ],
      };
    };
    assert.deepEqual(
      await claimPaddleReconciliationTargets(
        {
          limit: 7,
          leaseOwner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          leaseMs: 30_000,
          environment: "sandbox",
        },
        sql
      ),
      [TARGETS[0]]
    );
    assert.match(query, /exomem:paddle-reconciliation-claim/);
    assert.match(query, /provider_reconcile_after <= now\(\)/);
    assert.match(query, /provider_reconcile_lease_expires_at <= now\(\)/);
    assert.match(query, /status NOT IN \('deletion_pending', 'deleted'\)/);
    assert.match(query, /FOR UPDATE OF entitlement SKIP LOCKED/);
    assert.match(query, /ORDER BY entitlement\.provider_reconcile_after, entitlement\.tenant_id/);
    assert.match(query, /provider_reconcile_lease_owner/);
    assert.deepEqual(values, ["sandbox", 7, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 30_000]);
  });

  it("completes, retries, and releases only the exact leased subscription", async () => {
    const queries: string[] = [];
    const values: unknown[][] = [];
    const sql: ExomemPaddleSql = async (strings, ...nextValues) => {
      queries.push(strings.join("?"));
      values.push(nextValues);
      return { rows: [{ updated: true }] };
    };
    const input = {
      target: TARGETS[0],
      leaseOwner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    assert.equal(await markPaddleReconciliationSucceeded(input, sql), true);
    assert.equal(
      await markPaddleReconciliationFailed(
        {
          ...input,
          nextAttemptAt: "2026-07-13T10:00:00.000Z",
          errorCode: "PADDLE_RECONCILIATION_FAILED",
        },
        sql
      ),
      true
    );
    assert.equal(await releasePaddleReconciliationLease(input, sql), true);

    assert.match(queries[0], /provider_reconciled_at = now\(\)/);
    assert.match(queries[0], /provider_reconcile_after = now\(\) \+ interval '6 hours'/);
    assert.match(queries[1], /provider_reconcile_attempts = provider_reconcile_attempts \+ 1/);
    assert.match(queries[1], /provider_reconcile_error_code/);
    assert.match(queries[2], /provider_reconcile_lease_owner = NULL/);
    for (const query of queries) {
      assert.match(query, /tenant_id = \?/);
      assert.match(query, /provider_subscription_ref = \?/);
      assert.match(query, /provider_reconcile_lease_owner = \?::uuid/);
    }
    assert.deepEqual(values[0], [
      TARGETS[0].tenantId,
      TARGETS[0].subscriptionId,
      TARGETS[0].environment,
      input.leaseOwner,
    ]);
  });
});
