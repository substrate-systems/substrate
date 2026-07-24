import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

/**
 * Cron outcome capture, and the one rule that makes it safe: nothing is recorded
 * before authentication passes. Capturing on the unauthenticated path would let
 * any caller mint analytics events by hitting a public URL — a data-quality
 * problem first and a mild abuse vector second.
 *
 * indexnow is the smallest of the three scheduled routes, so it stands in for
 * the shape all of them share.
 */

type Capture = { job: string; outcome: string; properties?: Record<string, unknown> };

const captures: Capture[] = [];
let authOk = true;
const originalFetch = globalThis.fetch;

before(() => {
  mock.module("@/lib/hosted-backup/cron-auth", {
    namedExports: {
      verifyCronAuth: () => ({ ok: authOk }),
    },
  });
  mock.module("@/lib/analytics-server", {
    namedExports: {
      captureCronOutcome: async (params: Capture) => {
        captures.push(params);
      },
    },
  });
});

after(() => {
  mock.reset();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  captures.length = 0;
  authOk = true;
  globalThis.fetch = originalFetch;
});

function stubFetch(status: number) {
  globalThis.fetch = (async () => new Response("", { status })) as unknown as typeof globalThis.fetch;
}

function request() {
  return new Request("https://substratesystems.io/api/indexnow");
}

describe("indexnow cron outcome capture", () => {
  it("records a completed run with aggregate counts only", async () => {
    stubFetch(200);
    const { GET } = await import("../route");

    const res = await GET(request() as never);

    assert.equal(res.status, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].job, "indexnow");
    assert.equal(captures[0].outcome, "completed");
    assert.equal(typeof captures[0].properties?.submitted, "number");
  });

  it("records a failed run when IndexNow rejects the submission", async () => {
    stubFetch(500);
    const { GET } = await import("../route");

    const res = await GET(request() as never);

    assert.equal(res.status, 502);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].outcome, "failed");
    assert.equal(captures[0].properties?.status, 500);
  });

  it("captures nothing when cron authentication fails", async () => {
    authOk = false;
    stubFetch(200);
    const { GET } = await import("../route");

    const res = await GET(request() as never);

    assert.equal(res.status, 401);
    assert.equal(
      captures.length,
      0,
      "an unauthenticated caller must not be able to mint analytics events",
    );
  });
});
