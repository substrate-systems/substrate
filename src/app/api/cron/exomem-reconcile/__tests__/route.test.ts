import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const SENTINEL = "cron-provider-credential-query-path-sentinel";
let runCalls = 0;

before(() => {
  mock.module("@/lib/exomem-hosted/reconcile-runtime", {
    namedExports: {
      runBoundedLifecycleReconcile: async () => {
        runCalls += 1;
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
});

after(() => mock.reset());

afterEach(() => {
  runCalls = 0;
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

function request(token?: string) {
  return new Request("https://substratesystems.io/api/cron/exomem-reconcile", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as import("next/server").NextRequest;
}

describe("GET /api/cron/exomem-reconcile", () => {
  it("fails closed before touching lifecycle work", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("wrong"));
    assert.equal(response.status, 401);
    assert.equal(runCalls, 0);
  });

  it("runs a bounded authenticated pass and exposes counts only", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("cron-secret"));
    assert.equal(response.status, 200);
    assert.equal(runCalls, 1);
    const text = await response.text();
    assert.equal(text.includes(SENTINEL), false);
    const body = JSON.parse(text) as { result: Record<string, number> };
    assert.deepEqual(body.result, {
      attempted: 2,
      advanced: 1,
      succeeded: 0,
      retryScheduled: 1,
      terminal: 0,
    });
  });
});
