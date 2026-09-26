import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

const ORIGINAL_SCHEDULER_SECRET = process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
const ORIGINAL_CLOUD_ENABLED = process.env.EXOMEM_CLOUD_ENABLED;
const SENTINEL = "cron-provider-credential-query-path-sentinel";
let runCalls = 0;
let paddleRunCalls = 0;
let cloudExpireCalls = 0;
let cloudReconcileCalls = 0;
let cloudNoticeRetryCalls = 0;
let cloudDeletionFinishCalls = 0;
let cloudDeletionFinishShouldFail = false;
let cloudOrder: string[] = [];
let lifecycleGate: Promise<void> | null = null;
let paddleGate: Promise<void> | null = null;
let lifecycleShouldFail = false;

before(() => {
  mock.module("@/lib/exomem-hosted/cloud-admission", {
    namedExports: {
      expireCloudAwaitingCheckoutTenants: async () => {
        cloudExpireCalls += 1;
        return [
          { tenantId: "t-expired", outcome: "expired" },
          { tenantId: "t-skipped", outcome: "skipped" },
        ];
      },
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-cancellation-notice", {
    namedExports: {
      retryPendingCloudCancellationNotices: async () => {
        cloudNoticeRetryCalls += 1;
        return { attempted: 2, sent: 1 };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-lifecycle", {
    namedExports: {
      runBoundedCloudReconcile: async () => {
        cloudReconcileCalls += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        cloudOrder.push("reconcile");
        return { reconciled: 4, deleted: 1 };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-deletion-finish", {
    namedExports: {
      runBoundedCloudDeletionFinish: async () => {
        cloudDeletionFinishCalls += 1;
        cloudOrder.push("finish");
        if (cloudDeletionFinishShouldFail) throw new Error("private finish failure");
        return { finished: 2, pending: 3, failed: 1 };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/reconcile-runtime", {
    namedExports: {
      runBoundedLifecycleReconcile: async () => {
        runCalls += 1;
        if (lifecycleGate) await lifecycleGate;
        if (lifecycleShouldFail) throw new Error("private lifecycle failure");
        return {
          attempted: 2,
          advanced: 1,
          succeeded: 0,
          retryScheduled: 1,
          terminal: 0,
          renewalsEnqueued: 2,
          renewalsBlocked: 1,
          renewalsFailed: 3,
          code: SENTINEL,
        };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/paddle-reconciliation-runtime", {
    namedExports: {
      runBoundedPaddleReconcile: async () => {
        paddleRunCalls += 1;
        if (paddleGate) await paddleGate;
        return {
          configured: true,
          attempted: 3,
          applied: 1,
          duplicate: 1,
          stale: 0,
          ignored: 0,
          failed: 1,
          code: SENTINEL,
        };
      },
    },
  });
});

after(() => mock.reset());

afterEach(() => {
  runCalls = 0;
  paddleRunCalls = 0;
  cloudExpireCalls = 0;
  cloudReconcileCalls = 0;
  cloudNoticeRetryCalls = 0;
  cloudDeletionFinishCalls = 0;
  cloudDeletionFinishShouldFail = false;
  cloudOrder = [];
  lifecycleGate = null;
  paddleGate = null;
  lifecycleShouldFail = false;
  if (ORIGINAL_SCHEDULER_SECRET === undefined) delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
  else process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = ORIGINAL_SCHEDULER_SECRET;
  if (ORIGINAL_CLOUD_ENABLED === undefined) delete process.env.EXOMEM_CLOUD_ENABLED;
  else process.env.EXOMEM_CLOUD_ENABLED = ORIGINAL_CLOUD_ENABLED;
});

function request(token?: string) {
  return new Request("https://substratesystems.io/api/cron/exomem-reconcile", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as import("next/server").NextRequest;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("GET /api/cron/exomem-reconcile", () => {
  it("fails closed before touching lifecycle work", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("wrong"));
    assert.equal(response.status, 401);
    assert.equal(runCalls, 0);
    assert.equal(paddleRunCalls, 0);
  });

  it("runs a bounded authenticated pass and exposes counts only", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("cron-secret"));
    assert.equal(response.status, 200);
    assert.equal(runCalls, 1);
    assert.equal(paddleRunCalls, 1);
    const text = await response.text();
    assert.equal(text.includes(SENTINEL), false);
    const body = JSON.parse(text) as { result: Record<string, number> };
    assert.deepEqual(body.result, {
      attempted: 2,
      advanced: 1,
      succeeded: 0,
      retryScheduled: 1,
      terminal: 0,
      // The sweep's counts were produced and then discarded by this, their only
      // production consumer. A cell that misses its attestation window cannot be
      // recovered, and these are the sole signal that one is failing to renew,
      // so they have to leave the process.
      //
      // This pins the route's mapping from summary to JSON and NOTHING ELSE. The
      // file mocks `reconcile-runtime` wholesale, so the assignment that fills
      // these fields is mocked straight past: deleting it passes every test here.
      // The store-to-summary seam is covered in postgres.integration.test.ts,
      // "reports the renewal counts out of runBoundedLifecycleReconcile itself".
      renewalsEnqueued: 2,
      renewalsBlocked: 1,
      renewalsFailed: 3,
      paddle: {
        configured: true,
        attempted: 3,
        applied: 1,
        duplicate: 1,
        stale: 0,
        ignored: 0,
        failed: 1,
      },
    });
  });

  it("starts lifecycle and billing work together so neither lane can starve", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const lifecycle = deferred();
    lifecycleGate = lifecycle.promise;
    const { GET } = await import("../route");
    const pending = GET(request("cron-secret"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runCalls, 1);
    assert.equal(paddleRunCalls, 1);
    lifecycle.resolve();
    assert.equal((await pending).status, 200);
  });

  it("waits for both lanes before returning a stable failure", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    lifecycleShouldFail = true;
    const paddle = deferred();
    paddleGate = paddle.promise;
    const { GET } = await import("../route");
    let settled = false;
    const pending = GET(request("cron-secret")).then((response) => {
      settled = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runCalls, 1);
    assert.equal(paddleRunCalls, 1);
    assert.equal(settled, false);
    paddle.resolve();
    const response = await pending;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      success: false,
      error: { code: "CONTROL_PLANE_UNAVAILABLE", retryable: true },
    });
  });

  it("never touches the Cloud lane when EXOMEM_CLOUD_ENABLED is unset", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    delete process.env.EXOMEM_CLOUD_ENABLED;
    const { GET } = await import("../route");
    const response = await GET(request("cron-secret"));
    assert.equal(response.status, 200);
    assert.equal(cloudExpireCalls, 0);
    assert.equal(cloudReconcileCalls, 0);
    assert.equal(cloudNoticeRetryCalls, 0);
    assert.equal(cloudDeletionFinishCalls, 0);
    const body = (await response.json()) as { result: Record<string, unknown> };
    assert.equal("cloud" in body.result, false);
  });

  it("runs the Cloud expiry and reconcile sweep on the same schedule when the flag is on", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { GET } = await import("../route");
    const response = await GET(request("cron-secret"));
    assert.equal(response.status, 200);
    assert.equal(cloudExpireCalls, 1);
    assert.equal(cloudReconcileCalls, 1);
    assert.equal(cloudNoticeRetryCalls, 1);
    assert.equal(cloudDeletionFinishCalls, 1);
    const body = (await response.json()) as { result: { cloud: Record<string, number> } };
    assert.deepEqual(body.result.cloud, {
      expired: 1,
      activationsSkipped: 1,
      reconciled: 4,
      deleted: 1,
      noticesRetried: 2,
      noticesSent: 1,
      deletionsFinished: 2,
      deletionsPending: 3,
      deletionsFailed: 1,
    });
  });

  // Cloud design D4 "Cloud deletion finish": the finish runs after the
  // reconcile sweep has deleted the cell rows of confirmed deletions.
  it("runs the Cloud deletion finish after the reconcile sweep", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const { GET } = await import("../route");
    assert.equal((await GET(request("cron-secret"))).status, 200);
    assert.deepEqual(cloudOrder, ["reconcile", "finish"]);
  });

  it("reports zero deletion counts, content-free, when the finish lane itself fails", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    cloudDeletionFinishShouldFail = true;
    const logged: string[] = [];
    const errorLog = mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    let response: Response;
    try {
      const { GET } = await import("../route");
      response = await GET(request("cron-secret"));
    } finally {
      errorLog.mock.restore();
    }
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("private finish failure"), false);
    const body = JSON.parse(text) as { result: { cloud: Record<string, number> } };
    assert.equal(body.result.cloud.deletionsFinished, 0);
    assert.equal(body.result.cloud.deletionsPending, 0);
    assert.equal(body.result.cloud.deletionsFailed, 0);
    assert.equal(body.result.cloud.reconciled, 4, "the other Cloud lanes still report");
    assert.deepEqual(logged, ["exomem-cloud: account deletion finish lane failed"]);
  });
});

