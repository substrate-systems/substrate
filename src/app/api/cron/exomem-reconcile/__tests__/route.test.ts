import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

const ORIGINAL_SCHEDULER_SECRET = process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
const SENTINEL = "cron-provider-credential-query-path-sentinel";
let runCalls = 0;
let paddleRunCalls = 0;
let lifecycleGate: Promise<void> | null = null;
let paddleGate: Promise<void> | null = null;
let lifecycleShouldFail = false;

before(() => {
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
  lifecycleGate = null;
  paddleGate = null;
  lifecycleShouldFail = false;
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
});
