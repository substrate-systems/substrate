/**
 * Webhook pre-account path tests — covers the email-fallback resolution
 * introduced in wire-anonymous-buyer-account-linking. When the first usable
 * subscription event arrives without custom_data.user_id AND without a
 * paddle_customer_id match,
 * the webhook falls back to:
 *   1. fetchPaddleCustomerEmail(customer_id) via the Paddle API
 *   2. ensurePreAccount(email) — creates or fetches the users row
 *   3. either prepareInitialClaimToken + claim email (pre-account) or FYI
 *      (real user)
 */

import { afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const SECRET = "test-paddle-secret";

before(() => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.PADDLE_PRICE_ID_HOSTED_BACKUP = "pri_01ks03yq9ggsj4mdfdv3egwz67";
  process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY = "pri_monthly";
  process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY = "pri_yearly";
  Object.assign(process.env, { NODE_ENV: "test" });
});

class PaddleSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaddleSignatureError";
  }
}

function signedHeader(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", SECRET).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function makeReq(body: object): Request {
  const input = body as { event_type?: string; data?: Record<string, unknown> };
  const wireBody = input.event_type?.startsWith("subscription.")
    ? {
        ...input,
        data: {
          ...input.data,
          items: input.data?.items ?? [{ price: { id: "pri_01ks03yq9ggsj4mdfdv3egwz67" } }],
        },
      }
    : input;
  const rawBody = JSON.stringify(wireBody);
  return new Request("https://test.local/api/webhooks/paddle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paddle-signature": signedHeader(rawBody),
    },
    body: rawBody,
  });
}

type State = {
  events: Map<
    string,
    { eventType: string; processedAt: string | null; leased: boolean; lastErrorCode: string | null }
  >;
  customerIdToUserId: Map<string, string>;
  customerIdToEmail: Map<string, string | null>;
  upserts: Array<{
    userId: string;
    paddleSubscriptionId: string;
    paddleCustomerId: string;
    status: string;
    plan: string | null;
  }>;
  users: Map<string, { id: string; hasCreds: boolean }>;
  deliveries: Map<string, { eventId: string; sent: boolean; leased: boolean }>;
  claims: Map<
    string,
    { userId: string; email: string; tokenHash: Uint8Array; initialEmailSent: boolean }
  >;
  claimPreparations: number;
  emailAttempts: number;
  emailFailuresRemaining: number;
  paddleFetchErrors: Set<string>;
};

let state: State;

function setupMocks(
  opts: {
    customerIdToEmail?: Record<string, string | null>;
    existingUsers?: Array<{ email: string; id: string; hasCreds: boolean }>;
    paddleFetchErrorsFor?: string[];
    emailFailures?: number;
  } = {}
) {
  state = {
    events: new Map(),
    customerIdToUserId: new Map(),
    customerIdToEmail: new Map(Object.entries(opts.customerIdToEmail ?? {})),
    upserts: [],
    users: new Map(
      (opts.existingUsers ?? []).map((u) => [u.email, { id: u.id, hasCreds: u.hasCreds }])
    ),
    deliveries: new Map(),
    claims: new Map(),
    claimPreparations: 0,
    emailAttempts: 0,
    emailFailuresRemaining: opts.emailFailures ?? 0,
    paddleFetchErrors: new Set(opts.paddleFetchErrorsFor ?? []),
  };

  mock.module("../db", {
    namedExports: {
      recordPaddleEventIfFresh: async (p: { eventId: string; eventType: string }) => {
        if (state.events.has(p.eventId)) return false;
        state.events.set(p.eventId, {
          eventType: p.eventType,
          processedAt: null,
          leased: true,
          lastErrorCode: null,
        });
        return true;
      },
      claimPaddleEventProcessing: async (p: { eventId: string; eventType: string }) => {
        const existing = state.events.get(p.eventId);
        if (existing?.processedAt) return { kind: "processed" as const };
        if (existing?.leased) return { kind: "in_progress" as const };
        state.events.set(p.eventId, {
          eventType: p.eventType,
          processedAt: null,
          leased: true,
          lastErrorCode: existing?.lastErrorCode ?? null,
        });
        return { kind: "acquired" as const, attempt: 1 };
      },
      releasePaddleEventForRetry: async (eventId: string, attempt: number, errorCode: string) => {
        assert.equal(attempt, 1);
        const ev = state.events.get(eventId);
        if (ev) {
          ev.leased = false;
          ev.lastErrorCode = errorCode;
        }
      },
      markPaddleEventProcessed: async (eventId: string, attempt: number) => {
        assert.equal(attempt, 1);
        const ev = state.events.get(eventId);
        if (ev) {
          ev.processedAt = new Date().toISOString();
          ev.leased = false;
          ev.lastErrorCode = null;
        }
      },
      findUserIdByPaddleCustomerId: async (cid: string) =>
        state.customerIdToUserId.get(cid) ?? null,
      upsertSubscription: async (p: {
        userId: string;
        paddleSubscriptionId: string;
        paddleCustomerId: string;
        status: string;
        plan?: string | null;
      }) => {
        state.upserts.push({
          userId: p.userId,
          paddleSubscriptionId: p.paddleSubscriptionId,
          paddleCustomerId: p.paddleCustomerId,
          status: p.status,
          plan: p.plan ?? null,
        });
        state.customerIdToUserId.set(p.paddleCustomerId, p.userId);
      },
      ensurePreAccount: async (email: string) => {
        const existing = state.users.get(email);
        if (existing) return { userId: existing.id, isNew: false };
        const id = `u-${state.users.size + 1}-${email.replace(/[^a-z]/gi, "").slice(0, 6)}`;
        state.users.set(email, { id, hasCreds: false });
        return { userId: id, isNew: true };
      },
      userHasAuthCredentials: async (userId: string) => {
        for (const u of state.users.values()) {
          if (u.id === userId) return u.hasCreds;
        }
        return false;
      },
      findUserById: async (userId: string) => {
        for (const [email, u] of state.users) {
          if (u.id === userId) {
            return {
              id: u.id,
              email,
              email_verified_at: null,
              created_at: new Date().toISOString(),
              deleted_at: null,
            };
          }
        }
        return null;
      },
      getSubscriptionByUserId: async (userId: string) => {
        const last = [...state.upserts].reverse().find((u) => u.userId === userId);
        if (!last) return null;
        return {
          user_id: userId,
          paddle_subscription_id: last.paddleSubscriptionId,
          paddle_customer_id: last.paddleCustomerId,
          status: last.status,
          plan: last.plan,
          grace_started_at: null,
          cancel_started_at: null,
          current_period_end: null,
          updated_at: new Date().toISOString(),
        };
      },
      claimSubscriptionOnboardingDelivery: async (p: {
        paddleSubscriptionId: string;
        eventId: string;
      }) => {
        const existing = state.deliveries.get(p.paddleSubscriptionId);
        if (existing?.sent) return { kind: "already_sent" as const };
        if (existing?.leased && existing.eventId !== p.eventId) {
          return { kind: "in_progress" as const };
        }
        state.deliveries.set(p.paddleSubscriptionId, {
          eventId: p.eventId,
          sent: false,
          leased: true,
        });
        return { kind: "acquired" as const };
      },
      markSubscriptionOnboardingSent: async (p: {
        paddleSubscriptionId: string;
        eventId: string;
      }) => {
        const delivery = state.deliveries.get(p.paddleSubscriptionId);
        assert.equal(delivery?.eventId, p.eventId);
        if (delivery) {
          delivery.sent = true;
          delivery.leased = false;
        }
      },
      releaseSubscriptionOnboardingForRetry: async (p: {
        paddleSubscriptionId: string;
        eventId: string;
      }) => {
        const delivery = state.deliveries.get(p.paddleSubscriptionId);
        if (delivery?.eventId === p.eventId) delivery.leased = false;
      },
    },
  });

  mock.module("../../license/paddle", {
    namedExports: {
      verifyPaddleSignature: ({
        header,
        rawBody,
        secret,
      }: {
        header: string | null;
        rawBody: string;
        secret: string;
      }) => {
        if (!header) throw new PaddleSignatureError("missing signature header");
        const match = /ts=(\d+);h1=([0-9a-f]+)/.exec(header);
        if (!match) throw new PaddleSignatureError("malformed signature header");
        const ts = match[1];
        const h1 = match[2];
        const expected = createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
        if (expected !== h1) throw new PaddleSignatureError("signature mismatch");
      },
      PaddleSignatureError,
      fetchPaddleCustomerEmail: async (customerId: string) => {
        if (state.paddleFetchErrors.has(customerId)) {
          throw new Error("paddle api down");
        }
        return state.customerIdToEmail.get(customerId) ?? null;
      },
    },
  });

  mock.module("../claim-tokens", {
    namedExports: {
      mintClaimToken: async (params: { userId: string; email: string }) => {
        state.claimPreparations += 1;
        const tokenHash = new Uint8Array(32).fill(state.claimPreparations);
        state.claims.set(`legacy-${state.claimPreparations}`, {
          ...params,
          tokenHash,
          initialEmailSent: false,
        });
        return { token: `test-token-${state.claimPreparations}`, tokenHash };
      },
      prepareInitialClaimToken: async (params: {
        userId: string;
        email: string;
        sourceEventId: string;
      }) => {
        const existing = state.claims.get(params.sourceEventId);
        if (existing?.initialEmailSent) return { kind: "already_sent" as const };
        state.claimPreparations += 1;
        const tokenHash = new Uint8Array(32).fill(state.claimPreparations);
        state.claims.set(params.sourceEventId, {
          userId: params.userId,
          email: params.email,
          tokenHash,
          initialEmailSent: false,
        });
        return {
          kind: "ready" as const,
          token: `test-token-${state.claimPreparations}`,
          tokenHash,
        };
      },
      markInitialClaimEmailSent: async (tokenHash: Uint8Array) => {
        for (const claim of state.claims.values()) {
          if (claim.tokenHash === tokenHash) claim.initialEmailSent = true;
        }
      },
      markInitialClaimEmailFailed: async () => undefined,
    },
  });

  mock.module("../../brevo", {
    namedExports: {
      sendTransactionalEmail: async () => {
        state.emailAttempts += 1;
        if (state.emailFailuresRemaining > 0) {
          state.emailFailuresRemaining -= 1;
          return { success: false, error: "simulated Brevo outage" };
        }
        return { success: true, messageId: `msg-${state.emailAttempts}` };
      },
    },
  });
}

afterEach(() => mock.reset());

describe("Paddle webhook — email-fallback pre-account path", () => {
  it("creates a pre-account and attempts claim email for real-shaped anonymous subscription.activated", async () => {
    setupMocks({
      customerIdToEmail: { cus_anon: "new@example.com" },
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const res = await POST(
      makeReq({
        event_id: "evt_anon_1",
        event_type: "subscription.activated",
        data: {
          id: "sub_anon_1",
          customer_id: "cus_anon",
          custom_data: null,
          next_billed_at: "2026-08-14T11:57:34.753123Z",
          items: [{ price: { id: "pri_01ks03yq9ggsj4mdfdv3egwz67" } }],
        },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; userId?: string; status?: string };
    assert.equal(typeof j.userId, "string");
    assert.equal(j.status, "active");
    assert.equal(state.upserts.length, 1, "subscription should be upserted");
    assert.equal(state.users.size, 1, "pre-account user should be created");
    assert.equal(state.claims.size, 1, "one claim token row should exist");
    assert.equal([...state.claims.values()][0].email, "new@example.com");
    assert.equal(state.emailAttempts, 1, "claim email should be attempted");
  });

  it("keeps subscription.created anonymous onboarding supported", async () => {
    setupMocks({ customerIdToEmail: { cus_created: "created@example.com" } });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const res = await POST(
      makeReq({
        event_id: "evt_created",
        event_type: "subscription.created",
        data: { id: "sub_created", customer_id: "cus_created", custom_data: null },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(res.status, 200);
    assert.equal(state.users.size, 1);
    assert.equal(state.claims.size, 1);
    assert.equal(state.emailAttempts, 1);
  });

  it("sends onboarding once across created, activated, and later reactivation events", async () => {
    setupMocks({ customerIdToEmail: { cus_sequence: "sequence@example.com" } });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const data = {
      id: "sub_sequence",
      customer_id: "cus_sequence",
      custom_data: null,
      items: [{ price: { id: "pri_01ks03yq9ggsj4mdfdv3egwz67" } }],
    };

    for (const [event_id, event_type] of [
      ["evt_sequence_created", "subscription.created"],
      ["evt_sequence_activated", "subscription.activated"],
      ["evt_sequence_reactivated", "subscription.activated"],
    ] as const) {
      const response = await POST(
        makeReq({ event_id, event_type, data }) as unknown as import("next/server").NextRequest
      );
      assert.equal(response.status, 200);
    }

    assert.equal(state.users.size, 1);
    assert.equal(state.claims.size, 1, "one subscription must retain one onboarding claim");
    assert.equal(state.emailAttempts, 1, "later lifecycle events must not resend onboarding");
  });

  it("links to existing credentialed user (no claim token, no pre-account)", async () => {
    setupMocks({
      customerIdToEmail: { cus_alice: "alice@example.com" },
      existingUsers: [{ email: "alice@example.com", id: "u-alice", hasCreds: true }],
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const res = await POST(
      makeReq({
        event_id: "evt_alice_1",
        event_type: "subscription.created",
        data: {
          id: "sub_alice_1",
          customer_id: "cus_alice",
          items: [{ price: { id: "pri_monthly" } }],
        },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(res.status, 200);
    assert.equal(state.upserts[0].userId, "u-alice");
    assert.equal(state.claims.size, 0, "no claim token for existing real user");
    assert.equal(state.emailAttempts, 1, "existing user receives the FYI email");
  });

  it("sends a credentialed buyer FYI once across created and activated", async () => {
    setupMocks({
      customerIdToEmail: { cus_fyi_sequence: "fyi@example.com" },
      existingUsers: [{ email: "fyi@example.com", id: "u-fyi", hasCreds: true }],
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const data = {
      id: "sub_fyi_sequence",
      customer_id: "cus_fyi_sequence",
      custom_data: null,
    };

    for (const [event_id, event_type] of [
      ["evt_fyi_created", "subscription.created"],
      ["evt_fyi_activated", "subscription.activated"],
    ] as const) {
      const response = await POST(
        makeReq({ event_id, event_type, data }) as unknown as import("next/server").NextRequest
      );
      assert.equal(response.status, 200);
    }

    assert.equal(state.claims.size, 0);
    assert.equal(state.emailAttempts, 1);
  });

  it("retries a failed credentialed-buyer FYI without creating a claim", async () => {
    setupMocks({
      customerIdToEmail: { cus_fyi_retry: "fyi-retry@example.com" },
      existingUsers: [{ email: "fyi-retry@example.com", id: "u-fyi-retry", hasCreds: true }],
      emailFailures: 1,
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_fyi_retry",
      event_type: "subscription.activated",
      data: { id: "sub_fyi_retry", customer_id: "cus_fyi_retry", custom_data: null },
    };

    assert.equal(
      (await POST(makeReq(body) as unknown as import("next/server").NextRequest)).status,
      503
    );
    assert.equal(
      (await POST(makeReq(body) as unknown as import("next/server").NextRequest)).status,
      200
    );
    assert.equal(state.claims.size, 0);
    assert.equal(state.emailAttempts, 2);
  });

  it("reuses existing pre-account but mints a fresh claim token", async () => {
    setupMocks({
      customerIdToEmail: { cus_bob: "bob@example.com" },
      existingUsers: [{ email: "bob@example.com", id: "u-bob", hasCreds: false }],
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const res = await POST(
      makeReq({
        event_id: "evt_bob_1",
        event_type: "subscription.created",
        data: {
          id: "sub_bob_1",
          customer_id: "cus_bob",
          items: [{ price: { id: "pri_yearly" } }],
        },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(res.status, 200);
    assert.equal(state.upserts[0].userId, "u-bob");
    assert.equal(state.claims.size, 1, "pre-account still needs a claim token");
    assert.equal([...state.claims.values()][0].userId, "u-bob");
  });

  it("returns an actionable retryable failure when Paddle email-fetch throws", async () => {
    setupMocks({
      customerIdToEmail: { cus_oops: "whatever@example.com" },
      paddleFetchErrorsFor: ["cus_oops"],
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const res = await POST(
      makeReq({
        event_id: "evt_oops",
        event_type: "subscription.created",
        data: { id: "sub_oops", customer_id: "cus_oops" },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(res.status, 503);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "PADDLE_CUSTOMER_LOOKUP_FAILED");
    assert.equal(state.upserts.length, 0);
    assert.equal(state.claims.size, 0);
    assert.equal(state.events.get("evt_oops")?.processedAt, null);
    assert.equal(state.events.get("evt_oops")?.leased, false);
  });

  it("retries a failed first email without duplicate accounts or claim rows", async () => {
    setupMocks({
      customerIdToEmail: { cus_retry: "retry@example.com" },
      emailFailures: 1,
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_retry",
      event_type: "subscription.activated",
      data: { id: "sub_retry", customer_id: "cus_retry", custom_data: null },
    };

    const first = await POST(makeReq(body) as unknown as import("next/server").NextRequest);
    assert.equal(first.status, 503);
    assert.equal(state.users.size, 1);
    assert.equal(state.claims.size, 1);
    assert.equal(state.events.get("evt_retry")?.processedAt, null);

    const second = await POST(makeReq(body) as unknown as import("next/server").NextRequest);
    assert.equal(second.status, 200);
    assert.equal(state.users.size, 1, "retry must reuse pre-account");
    assert.equal(state.claims.size, 1, "retry must replace, not duplicate, unsent claim");
    assert.equal(state.emailAttempts, 2);
    assert.ok(state.events.get("evt_retry")?.processedAt);

    const duplicate = await POST(makeReq(body) as unknown as import("next/server").NextRequest);
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { deduped?: boolean }).deduped, true);
    assert.equal(state.emailAttempts, 2, "processed duplicate must not resend");
  });

  it("does not bootstrap unrelated lifecycle events without a known customer", async () => {
    setupMocks({
      customerIdToEmail: { cus_xx: "who@example.com" },
    });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const res = await POST(
      makeReq({
        event_id: "evt_past_due_orphan",
        event_type: "subscription.past_due",
        data: { id: "sub_xx", customer_id: "cus_xx" },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(res.status, 503);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "PADDLE_USER_UNRESOLVED");
    assert.equal(state.users.size, 0, "no pre-account created for non-created events");
    assert.equal(state.emailAttempts, 0);
  });
});
