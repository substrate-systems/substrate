import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

type Claim = { kind: "advanced" | "succeeded" | "retry_scheduled" | "terminal" | "idle" };

let scripted: Claim[] = [];
let claimCalls = 0;
let renewalCalls = 0;

before(() => {
  mock.module("../lifecycle-store", {
    namedExports: {
      SqlLifecycleStore: class {
        async enqueueDueAuthorizationRenewals() {
          renewalCalls += 1;
          return { enqueued: 0, blocked: 0, failed: 0 };
        }
      },
    },
  });
  mock.module("../provisioner", {
    namedExports: {
      HttpCellProvisioner: class {},
      provisionerConfigFromEnv: () => ({}),
    },
  });
  mock.module("../reconciler", {
    namedExports: {
      LifecycleReconciler: class {
        async reconcileOne(): Promise<Claim> {
          claimCalls += 1;
          return scripted.shift() ?? { kind: "idle" };
        }
      },
      expectedCellConfigurationFromEnv: () => ({}),
    },
  });
  mock.module("../agent-contract-canaries", {
    namedExports: { expireCanaryAuthority: async () => undefined },
  });
  mock.module("../billing-deletion", {
    namedExports: { terminateExomemBillingForDeletion: async () => undefined },
  });
});

after(() => mock.reset());

beforeEach(() => {
  scripted = [];
  claimCalls = 0;
  renewalCalls = 0;
});

describe("bounded lifecycle reconcile", () => {
  it("carries one operation through several checkpoints in a single tick", async () => {
    // The shape this exists for: a step finishes and schedules its successor a
    // second or two out, so the queue reads empty in between. Stopping there is
    // what made a delete take 23 minutes of which under a second was work.
    const { runBoundedLifecycleReconcile } = await import("../reconcile-runtime");
    scripted = [
      { kind: "advanced" },
      { kind: "idle" },
      { kind: "advanced" },
      { kind: "idle" },
      { kind: "succeeded" },
    ];

    const summary = await runBoundedLifecycleReconcile({
      maxOperations: 20,
      timeBudgetMs: 5_000,
      idleWaitMs: 10,
    });

    assert.equal(summary.attempted, 3, "every step the tick could reach must be taken");
    assert.equal(summary.advanced, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(renewalCalls, 1, "renewals stay once per tick, not once per wait");
  });

  it("costs an empty queue exactly one claim", async () => {
    // The expensive mistake this change could introduce: the endpoint is billed
    // for being awake, so an idle tick must not poll for its whole budget.
    const { runBoundedLifecycleReconcile } = await import("../reconcile-runtime");
    const startedAt = Date.now();

    const summary = await runBoundedLifecycleReconcile({
      maxOperations: 20,
      timeBudgetMs: 5_000,
      idleWaitMs: 50,
    });

    assert.equal(summary.attempted, 0);
    assert.equal(claimCalls, 1, "an empty queue is one claim and done");
    assert.ok(Date.now() - startedAt < 1_000, "an idle tick must not wait out its budget");
  });

  it("stops waiting once the work it started has finished", async () => {
    const { runBoundedLifecycleReconcile } = await import("../reconcile-runtime");
    scripted = [{ kind: "succeeded" }];
    const startedAt = Date.now();

    const summary = await runBoundedLifecycleReconcile({
      maxOperations: 20,
      timeBudgetMs: 10_000,
      idleWaitMs: 10,
    });

    assert.equal(summary.attempted, 1);
    assert.ok(claimCalls <= 13, `bounded idle polling, saw ${claimCalls} claims`);
    assert.ok(Date.now() - startedAt < 2_000, "it must not hold the tick open to its budget");
  });

  it("keeps the original stop-on-first-idle behaviour for callers that do not opt in", async () => {
    const { runBoundedLifecycleReconcile } = await import("../reconcile-runtime");
    scripted = [{ kind: "advanced" }, { kind: "idle" }, { kind: "advanced" }];

    const summary = await runBoundedLifecycleReconcile({ maxOperations: 20, timeBudgetMs: 5_000 });

    assert.equal(summary.attempted, 1, "without idleWaitMs the tick stops at the first idle");
    assert.equal(claimCalls, 2);
  });

  it("does not wait for an operation that only scheduled a retry", async () => {
    // Retry backoff runs to a minute, so waiting for one is waiting for nothing.
    // Keyed on attempts rather than progress, a single backed-off operation
    // would hold every tick open for its whole wait budget, for as long as it
    // stayed in backoff.
    const { runBoundedLifecycleReconcile } = await import("../reconcile-runtime");
    scripted = [{ kind: "retry_scheduled" }];
    const startedAt = Date.now();

    const summary = await runBoundedLifecycleReconcile({
      maxOperations: 20,
      timeBudgetMs: 5_000,
      idleWaitMs: 50,
    });

    assert.equal(summary.retryScheduled, 1);
    assert.equal(claimCalls, 2, "one claim for the retry, one that finds the queue empty");
    assert.ok(Date.now() - startedAt < 1_000, "a backed-off operation must not hold the tick open");
  });

  it("does not start a wait it cannot finish inside the budget", async () => {
    // The caller is a CronJob with its own timeout, so overshooting the budget
    // turns a draining tick into a recorded failure. A wait longer than what is
    // left must not be started at all: the loop's own deadline check would only
    // notice after the wait had already overrun it.
    const { runBoundedLifecycleReconcile } = await import("../reconcile-runtime");
    scripted = [{ kind: "advanced" }];
    const startedAt = Date.now();

    await runBoundedLifecycleReconcile({
      maxOperations: 20,
      timeBudgetMs: 300,
      idleWaitMs: 1_000,
    });

    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 500, `returned inside its budget rather than after a wait, took ${elapsed}ms`);
  });

  it("never exceeds its work budget", async () => {
    const { runBoundedLifecycleReconcile } = await import("../reconcile-runtime");
    scripted = Array.from({ length: 20 }, () => ({ kind: "advanced" }) as Claim);

    const summary = await runBoundedLifecycleReconcile({
      maxOperations: 3,
      timeBudgetMs: 5_000,
      idleWaitMs: 10,
    });

    assert.equal(summary.attempted, 3);
  });
});
