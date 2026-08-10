import assert from "node:assert/strict";
import { afterEach, before, describe, it, mock } from "node:test";

type Contribution = {
  transactionId: string;
  eventId: string;
  tier: string;
  email: string | null;
};
let contributions: Contribution[] = [];
let contributionInserted = true;

class TestPaddleSignatureError extends Error {}

before(() => {
  mock.module("@/lib/hosted-backup/db", {
    namedExports: {
      recordSupporterContribution: async (contribution: Contribution) => {
        contributions.push(contribution);
        return contributionInserted;
      },
    },
  });

  mock.module("@/lib/license/paddle", {
    namedExports: {
      PaddleSignatureError: TestPaddleSignatureError,
      verifyPaddleSignature: () => undefined,
      extractTransactionFields: (event: { data: { id: string; customer: { email: string } } }) => ({
        transactionId: event.data.id,
        email: event.data.customer.email,
        customerId: null,
      }),
      fetchPaddleCustomerEmail: async () => null,
    },
  });
});

afterEach(() => {
  contributions = [];
  contributionInserted = true;
  delete process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER;
  delete process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10;
  delete process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_29;
});

function requestFor(
  priceId: string,
  distinctId: string | null = "anon-browser-123"
): import("next/server").NextRequest {
  return new Request("https://substratesystems.io/api/license/webhook", {
    method: "POST",
    headers: { "paddle-signature": "ts=1;h1=test" },
    body: JSON.stringify({
      event_id: "evt_test",
      event_type: "transaction.completed",
      data: {
        id: "txn_test",
        customer: { email: "supporter@example.com" },
        ...(distinctId ? { custom_data: { ph_distinct_id: distinctId } } : {}),
        items: [{ price: { id: priceId } }],
      },
    }),
  }) as unknown as import("next/server").NextRequest;
}

describe("POST /api/license/webhook", () => {
  it("fails retryably when no support price is configured", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "secret";
    const { POST } = await import("../route");

    const response = await POST(requestFor("pri_supporter"));

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "server_misconfigured",
      message: "no Endstate support price IDs are configured",
    });
    assert.equal(contributions.length, 0);
  });

  it("queues the recognition-only Supporter flow without issuing an entitlement", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "secret";
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = "pri_supporter";
    const { POST } = await import("../route");

    const response = await POST(requestFor("pri_supporter"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, supporter: true, queued: true });
    assert.deepEqual(contributions, [
      {
        transactionId: "txn_test",
        eventId: "evt_test",
        tier: "patron",
        email: "supporter@example.com",
      },
    ]);
  });

  it("also accepts a newly configured support amount", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "secret";
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = "pri_supporter";
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10 = "pri_support_10";
    const { POST } = await import("../route");

    const response = await POST(requestFor("pri_support_10"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, supporter: true, queued: true });
    assert.equal(contributions[0]?.tier, "supporter");
  });

  it("acknowledges and ignores every other one-time SKU", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "secret";
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = "pri_supporter";
    const { POST } = await import("../route");

    const response = await POST(requestFor("pri_retired_or_unknown"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ignored: true,
      reason: "no handler for transaction",
    });
    assert.equal(contributions.length, 0);
  });

  it("acknowledges a duplicate event without adding another contribution or email obligation", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "secret";
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = "pri_supporter";
    contributionInserted = false;
    const { POST } = await import("../route");

    const response = await POST(requestFor("pri_supporter", null));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, supporter: true, replay: true });
    assert.equal(contributions.length, 1);
  });
});
