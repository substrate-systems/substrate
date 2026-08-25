import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const USER_ID = "018f2d91-7c42-7000-8000-0000000000a1";
const TENANT_ID = "018f2d91-7c42-7000-8000-0000000000a2";
const TRANSACTION_ID = `txn_${"a".repeat(26)}`;
let startCalls = 0;
let returnedTransaction: string | null = null;
let returnedResult: { state: "open"; checkoutUrl: string } | { state: "settled" };

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({
        id: "session-1",
        userId: USER_ID,
        tenantId: TENANT_ID,
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-13T00:00:00.000Z",
      }),
      validateMutationRequest: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/billing-account", {
    namedExports: {
      startOwnerCheckout: async () => {
        startCalls += 1;
        return { checkoutUrl: "https://substratesystems.io/exomem/home?_ptxn=txn_start" };
      },
      resumeReturnedOwnerCheckout: async (
        userId: string,
        tenantId: string,
        transactionId: string
      ) => {
        assert.equal(userId, USER_ID);
        assert.equal(tenantId, TENANT_ID);
        returnedTransaction = transactionId;
        return returnedResult;
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  startCalls = 0;
  returnedTransaction = null;
  returnedResult = {
    state: "open",
    checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${TRANSACTION_ID}`,
  };
});

describe("POST /api/exomem/billing/checkout", () => {
  it("starts the existing checkout for an authenticated awaiting-payment owner", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );

    assert.equal(response.status, 200);
    assert.equal(startCalls, 1);
    assert.equal(returnedTransaction, null);
    assert.deepEqual(await response.json(), {
      success: true,
      checkoutUrl: "https://substratesystems.io/exomem/home?_ptxn=txn_start",
    });
  });

  it("owner-validates a returned Paddle transaction instead of starting checkout", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionId: TRANSACTION_ID }),
      })
    );

    assert.equal(response.status, 200);
    assert.equal(returnedTransaction, TRANSACTION_ID);
    assert.equal(startCalls, 0);
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/i);
    assert.deepEqual(await response.json(), {
      success: true,
      state: "open",
      checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${TRANSACTION_ID}`,
    });
  });

  it("returns a clean Home navigation for a settled Paddle return", async () => {
    returnedResult = { state: "settled" };
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionId: TRANSACTION_ID }),
      })
    );

    assert.equal(response.status, 200);
    assert.equal(returnedTransaction, TRANSACTION_ID);
    assert.deepEqual(await response.json(), {
      success: true,
      state: "settled",
      redirectUrl: "/exomem/home",
    });
  });

  it("rejects malformed or padded return bodies before billing", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionId: "txn_short", tenantId: TENANT_ID }),
      })
    );

    assert.equal(response.status, 400);
    assert.equal(startCalls, 0);
    assert.equal(returnedTransaction, null);
  });
});
