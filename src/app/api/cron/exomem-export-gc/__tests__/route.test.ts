import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

const ORIGINAL_SCHEDULER_SECRET = process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
const SENTINEL = "provider-object-reference-sensitive-sentinel";
let runCalls = 0;

before(() => {
  mock.module("@/lib/exomem-hosted/export-gc", {
    namedExports: {
      runExportGc: async () => {
        runCalls += 1;
        return { attempted: 2, deleted: 1, retryScheduled: 1, sentinel: SENTINEL };
      },
    },
  });
});

after(() => mock.reset());

afterEach(() => {
  runCalls = 0;
  if (ORIGINAL_SCHEDULER_SECRET === undefined) delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
  else process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = ORIGINAL_SCHEDULER_SECRET;
});

function request(token?: string) {
  return new Request("https://substratesystems.io/api/cron/exomem-export-gc", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as import("next/server").NextRequest;
}

describe("GET /api/cron/exomem-export-gc", () => {
  it("fails closed before claiming provider objects", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("wrong"));
    assert.equal(response.status, 401);
    assert.equal(runCalls, 0);
  });

  it("runs a bounded authenticated pass without exposing provider references", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "cron-secret";
    const { GET } = await import("../route");
    const response = await GET(request("cron-secret"));
    assert.equal(response.status, 200);
    assert.equal(runCalls, 1);
    const text = await response.text();
    assert.equal(text.includes(SENTINEL), false);
    assert.deepEqual(JSON.parse(text).result, {
      attempted: 2,
      deleted: 1,
      retryScheduled: 1,
    });
  });
});
