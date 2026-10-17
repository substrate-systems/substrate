import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

const ORIGINAL_HOSTED = process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
const ORIGINAL_GLOBAL = process.env.CRON_SECRET;
let runCalls = 0;
let outboxCalls = 0;
let sentThisPass = 0;

before(() => {
  mock.module("@/lib/exomem-hosted/access-delivery", {
    namedExports: {
      drainMagicLinkDeliveries: async () => {
        runCalls += 1;
        return {
          expired: 0,
          prunedRateLimits: 0,
          claimed: sentThisPass,
          sent: sentThisPass,
          retryScheduled: 0,
          failed: 0,
          lost: 0,
        };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/email-outbox", {
    namedExports: {
      drainExomemEmailOutbox: async () => {
        outboxCalls += 1;
        return { claimed: 0, sent: 0, retryScheduled: 0, failed: 0, cancelled: 0, lost: 0 };
      },
    },
  });
});

after(() => mock.reset());

afterEach(() => {
  runCalls = 0;
  outboxCalls = 0;
  sentThisPass = 0;
  if (ORIGINAL_HOSTED === undefined) delete process.env.EXOMEM_HOSTED_SCHEDULER_SECRET;
  else process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = ORIGINAL_HOSTED;
  if (ORIGINAL_GLOBAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_GLOBAL;
});

function request(token: string) {
  return new Request("https://substratesystems.io/api/cron/exomem-access-delivery", {
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as import("next/server").NextRequest;
}

describe("GET /api/cron/exomem-access-delivery", () => {
  it("rejects the unrelated global cron bearer", async () => {
    process.env.CRON_SECRET = "global-cron-secret";
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "hosted-scheduler-secret";
    const { GET } = await import("../route");
    const response = await GET(request("global-cron-secret"));
    assert.equal(response.status, 401);
    assert.equal(runCalls, 0);
    assert.equal(outboxCalls, 0);
  });

  it("runs only with the dedicated hosted scheduler bearer", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "hosted-scheduler-secret";
    const { GET } = await import("../route");
    const response = await GET(request("hosted-scheduler-secret"));
    assert.equal(response.status, 200);
    assert.equal(runCalls, 1);
    assert.equal(outboxCalls, 1);
  });

  it("logs a pass's counts when it sent something, and nothing for an idle pass", async () => {
    process.env.EXOMEM_HOSTED_SCHEDULER_SECRET = "hosted-scheduler-secret";
    const info = mock.method(console, "info", () => undefined);
    try {
      const { GET } = await import("../route");
      await GET(request("hosted-scheduler-secret"));
      assert.equal(info.mock.callCount(), 0);
      sentThisPass = 1;
      await GET(request("hosted-scheduler-secret"));
      const line = JSON.parse(String(info.mock.calls[0]!.arguments[0]));
      assert.equal(line.event, "exomem.access_delivery.drained");
      assert.equal(line.magicLinks.sent, 1);
    } finally {
      info.mock.restore();
    }
  });
});
