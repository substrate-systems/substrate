import assert from "node:assert/strict";
import { afterEach, before, describe, it, mock } from "node:test";

type Email = { to: string; subject: string };
let sentEmails: Email[] = [];
type AnalyticsCapture = {
  event: string;
  distinctId: string | null;
  properties?: Record<string, unknown>;
};
let analyticsCaptures: AnalyticsCapture[] = [];

class TestPaddleSignatureError extends Error {}

before(() => {
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: async (message: Email) => {
        sentEmails.push(message);
        return { success: true, messageId: "msg_test" };
      },
    },
  });

  mock.module("@/lib/analytics-server", {
    namedExports: {
      ServerEvent: { SupporterPurchased: "supporter_purchased" },
      captureServer: async (capture: AnalyticsCapture) => {
        analyticsCaptures.push(capture);
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
  sentEmails = [];
  analyticsCaptures = [];
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
    assert.equal(sentEmails.length, 0);
  });

  it("keeps the recognition-only Supporter flow", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "secret";
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = "pri_supporter";
    const { POST } = await import("../route");

    const response = await POST(requestFor("pri_supporter"));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, supporter: true });
    assert.deepEqual(
      sentEmails.map(({ to }) => to),
      ["founder@substratesystems.io", "supporter@example.com"]
    );
    assert.deepEqual(analyticsCaptures, [
      {
        event: "supporter_purchased",
        distinctId: "anon-browser-123",
        properties: { product: "supporter" },
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
    assert.deepEqual(await response.json(), { ok: true, supporter: true });
    assert.deepEqual(
      sentEmails.map(({ to }) => to),
      ["founder@substratesystems.io", "supporter@example.com"]
    );
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
    assert.equal(sentEmails.length, 0);
  });

  it("keeps the purchase unresolved when Paddle has no anonymous browser id", async () => {
    process.env.PADDLE_WEBHOOK_SECRET = "secret";
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = "pri_supporter";
    const { POST } = await import("../route");

    const response = await POST(requestFor("pri_supporter", null));

    assert.equal(response.status, 200);
    assert.equal(analyticsCaptures.length, 1);
    assert.equal(analyticsCaptures[0]?.event, "supporter_purchased");
    assert.equal(analyticsCaptures[0]?.distinctId, null);
  });
});
