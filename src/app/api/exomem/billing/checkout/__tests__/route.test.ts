import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const USER_ID = "018f2d91-7c42-7000-8000-0000000000a1";
const TENANT_ID = "018f2d91-7c42-7000-8000-0000000000a2";
const TRANSACTION_ID = `txn_${"a".repeat(26)}`;
let startCalls = 0;
let reviewerCredentialKind: string | null = null;
let returnedTransaction: string | null = null;
let returnedResult: { state: "open"; checkoutUrl: string } | { state: "settled" };
let sessionTenantId = TENANT_ID;
let rateLimitAllowed = true;
let rateLimitKeys: string[] = [];

before(async () => {
  // The per-account limit is a database bucket; here it answers as each test sets it.
  const actualRateLimit = await import("@/lib/exomem-hosted/rate-limit");
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      ...actualRateLimit,
      takeExomemRateLimit: async (_rule: unknown, key: string) => {
        rateLimitKeys.push(key);
        return rateLimitAllowed;
      },
    },
  });
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({
        id: "session-1",
        userId: USER_ID,
        tenantId: sessionTenantId,
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-07-13T00:00:00.000Z",
        reviewerCredentialKind,
      }),
      validateMutationRequest: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/billing-account", {
    namedExports: {
      startOwnerCheckout: async () => {
        startCalls += 1;
        return {
          checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${TRANSACTION_ID}`,
          transactionId: TRANSACTION_ID,
        };
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
  reviewerCredentialKind = null;
  returnedTransaction = null;
  sessionTenantId = TENANT_ID;
  rateLimitAllowed = true;
  rateLimitKeys = [];
  returnedResult = {
    state: "open",
    checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${TRANSACTION_ID}`,
  };
});

describe("POST /api/exomem/billing/checkout", () => {
  it("rejects a cookie switch between successful transaction validation and the readiness read", async () => {
    returnedResult = { state: "settled" };
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const validated = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: TENANT_ID, transactionId: TRANSACTION_ID }),
      })
    );
    assert.equal(validated.status, 200);
    assert.equal((await validated.json()).state, "settled");
    sessionTenantId = "018f2d91-7c42-7000-8000-0000000000b2";
    const { GET } = await import("../../../status/route");
    const status = await GET(
      new NextRequest(`https://substratesystems.io/api/exomem/status?tenantId=${TENANT_ID}`)
    );
    assert.equal(status.status, 403);
    const body = await status.json();
    assert.equal(body.error.code, "EXOMEM_ENTITLEMENT_DENIED");
    assert.equal(body.status, undefined);
  });
  it("refuses initiation and resume when the rendered checkout account differs from the session", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    for (const body of [
      { tenantId: "018f2d91-7c42-7000-8000-0000000000b2" },
      { tenantId: "018f2d91-7c42-7000-8000-0000000000b2", transactionId: TRANSACTION_ID },
    ]) {
      const response = await POST(
        new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, "EXOMEM_ENTITLEMENT_DENIED");
      assert.equal(startCalls, 0);
      assert.equal(returnedTransaction, null);
    }
  });

  it("accepts the matching rendered account on initiation and resume", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    for (const body of [
      { tenantId: TENANT_ID },
      { tenantId: TENANT_ID, transactionId: TRANSACTION_ID },
    ]) {
      const response = await POST(
        new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      assert.equal(response.status, 200);
    }
    assert.equal(startCalls, 1);
    assert.equal(returnedTransaction, TRANSACTION_ID);
  });
  it("denies Cloud reviewer initiation and resume before billing work", async () => {
    reviewerCredentialKind = "cloud_provider_review";
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    for (const body of [{}, { transactionId: TRANSACTION_ID }]) {
      const response = await POST(
        new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      assert.equal(response.status, 403);
      assert.equal(startCalls, 0);
      assert.equal(returnedTransaction, null);
    }
  });
  it("answers an account over its limit with 429 before Paddle is asked", async () => {
    rateLimitAllowed = false;
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );

    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, "RATE_LIMITED");
    assert.deepEqual(rateLimitKeys, [TENANT_ID]);
    assert.equal(startCalls, 0);
  });

  it("never rate-limits the setup page's repeated confirmation of a paid checkout", async () => {
    rateLimitAllowed = false;
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    for (let poll = 0; poll < 40; poll += 1) {
      const response = await POST(
        new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: TENANT_ID, transactionId: TRANSACTION_ID }),
        })
      );
      assert.equal(response.status, 200);
    }
    assert.deepEqual(rateLimitKeys, []);
  });

  it("starts the checkout and returns the transaction id the Paddle overlay opens", async () => {
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
      checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${TRANSACTION_ID}`,
      transactionId: TRANSACTION_ID,
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

  it("refuses a checkout that carries a discount of the client's choosing, before billing", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    for (const body of [{ discountId: `dsc_${"f".repeat(26)}` }, { discountCode: "FRIEND5" }]) {
      const response = await POST(
        new NextRequest("https://substratesystems.io/api/exomem/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      assert.equal(response.status, 400);
    }
    assert.equal(startCalls, 0);
  });
});
