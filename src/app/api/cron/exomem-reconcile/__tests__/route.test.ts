import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

const ORIGINAL_SCHEDULER_SECRET = process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
const SENTINEL = "cron-provider-credential-query-path-sentinel";
let paddleRunCalls = 0;
let cloudExpireCalls = 0;
let cloudReconcileCalls = 0;
let cloudNoticeRetryCalls = 0;
let cloudDeletionFinishCalls = 0;
let cloudDeletionFinishShouldFail = false;
let promotionShouldFail = false;
let cloudOrder: string[] = [];
let cloudGate: Promise<void> | null = null;
let paddleGate: Promise<void> | null = null;
let paddleShouldFail = false;

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
        if (cloudGate) await cloudGate;
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
  mock.module("@/lib/exomem-hosted/self-serve-admission", {
    namedExports: {
      promoteWaitlistedPeople: async () => {
        if (promotionShouldFail) throw new Error("private promotion failure");
        return { status: "ran", promoted: 2, settled: 1 };
      },
      pruneStaleWaitlistEntries: async () => 3,
    },
  });
  mock.module("@/lib/exomem-hosted/paddle-reconciliation-runtime", {
    namedExports: {
      runBoundedPaddleReconcile: async () => {
        paddleRunCalls += 1;
        if (paddleGate) await paddleGate;
        if (paddleShouldFail) throw new Error("private billing failure");
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
  paddleRunCalls = 0;
  cloudExpireCalls = 0;
  cloudReconcileCalls = 0;
  cloudNoticeRetryCalls = 0;
  cloudDeletionFinishCalls = 0;
  cloudDeletionFinishShouldFail = false;
  promotionShouldFail = false;
  cloudOrder = [];
  cloudGate = null;
  paddleGate = null;
  paddleShouldFail = false;
  if (ORIGINAL_SCHEDULER_SECRET === undefined) delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
  else process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = ORIGINAL_SCHEDULER_SECRET;
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
  it("fails closed before touching billing or Cloud work", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("wrong"));
    assert.equal(response.status, 401);
    assert.equal(paddleRunCalls, 0);
    assert.equal(cloudReconcileCalls, 0);
  });

  it("runs a bounded authenticated pass and exposes counts only", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("cron-secret"));
    assert.equal(response.status, 200);
    assert.equal(paddleRunCalls, 1);
    assert.equal(cloudExpireCalls, 1);
    assert.equal(cloudReconcileCalls, 1);
    assert.equal(cloudNoticeRetryCalls, 1);
    assert.equal(cloudDeletionFinishCalls, 1);
    const text = await response.text();
    assert.equal(text.includes(SENTINEL), false);
    const body = JSON.parse(text) as { result: Record<string, unknown> };
    assert.deepEqual(body.result, {
      paddle: {
        configured: true,
        attempted: 3,
        applied: 1,
        duplicate: 1,
        stale: 0,
        ignored: 0,
        failed: 1,
      },
      cloud: {
        expired: 1,
        activationsSkipped: 1,
        reconciled: 4,
        deleted: 1,
        noticesRetried: 2,
        noticesSent: 1,
        deletionsFinished: 2,
        deletionsPending: 3,
        deletionsFailed: 1,
        waitlistPromotion: { status: "ran", promoted: 2, settled: 1 },
        waitlistPruned: 3,
      },
    });
  });

  it("reports a failed waitlist promotion as failed, not as zero promotions", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    promotionShouldFail = true;
    const { GET } = await import("../route");
    const response = await GET(request("cron-secret"));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("private promotion failure"), false);
    const body = JSON.parse(text) as { result: { cloud: Record<string, unknown> } };
    assert.deepEqual(body.result.cloud.waitlistPromotion, {
      status: "failed",
      promoted: null,
      settled: null,
    });
    assert.equal(cloudDeletionFinishCalls, 1);
  });

  it("starts billing and Cloud work together so neither lane can starve", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const paddle = deferred();
    paddleGate = paddle.promise;
    const { GET } = await import("../route");
    const pending = GET(request("cron-secret"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(paddleRunCalls, 1);
    assert.equal(cloudReconcileCalls, 1);
    paddle.resolve();
    assert.equal((await pending).status, 200);
  });

  it("waits for both lanes before returning a stable failure", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    paddleShouldFail = true;
    const cloud = deferred();
    cloudGate = cloud.promise;
    const { GET } = await import("../route");
    let settled = false;
    const pending = GET(request("cron-secret")).then((response) => {
      settled = true;
      return response;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(paddleRunCalls, 1);
    assert.equal(cloudReconcileCalls, 1);
    assert.equal(settled, false);
    cloud.resolve();
    const response = await pending;
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes("private billing failure"), false);
    assert.deepEqual(JSON.parse(text), {
      success: false,
      error: { code: "CONTROL_PLANE_UNAVAILABLE", retryable: true },
    });
  });

  // Cloud design D4 "Cloud deletion finish": the finish runs after the
  // reconcile sweep has deleted the cell rows of confirmed deletions.
  it("runs the Cloud deletion finish after the reconcile sweep", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const { GET } = await import("../route");
    assert.equal((await GET(request("cron-secret"))).status, 200);
    assert.deepEqual(cloudOrder, ["reconcile", "finish"]);
  });

  it("reports zero deletion counts, content-free, when the finish lane itself fails", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
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
