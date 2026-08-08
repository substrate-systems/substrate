/**
 * Webhook handler tests using node:test module mocks.
 */

import { afterEach, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const SECRET = "test-paddle-secret";

before(() => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.PADDLE_PRICE_ID_HOSTED_BACKUP = "pri_hosted_backup";
});

function signedHeader(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac("sha256", SECRET).update(`${ts}:${rawBody}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function makeReq(body: object, headerValue: string | null = null): Request {
  const input = body as { event_type?: string; data?: Record<string, unknown> };
  const wireBody = input.event_type?.startsWith("subscription.")
    ? {
        ...input,
        data: {
          ...input.data,
          items: input.data?.items ?? [{ price: { id: "pri_hosted_backup" } }],
        },
      }
    : input;
  const rawBody = JSON.stringify(wireBody);
  const sig = headerValue ?? signedHeader(rawBody);
  const headers = new Headers({
    "content-type": "application/json",
    "paddle-signature": sig,
  });
  if (headerValue === "") headers.delete("paddle-signature");
  return new Request("https://test.local/api/webhooks/paddle", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

type UpsertCall = {
  userId: string;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
  status: string;
  plan: string | null;
};

type DbState = {
  events: Map<string, { eventType: string; processedAt: string | null; leased: boolean }>;
  freshInserts: number;
  customerIdToUserId: Map<string, string>;
  upserts: UpsertCall[];
};

let state: DbState;

function setupDbMocks(options: { customerIdToUserId?: Record<string, string> } = {}) {
  state = {
    events: new Map(),
    freshInserts: 0,
    customerIdToUserId: new Map(Object.entries(options.customerIdToUserId ?? {})),
    upserts: [],
  };
  mock.module("../db", {
    namedExports: {
      recordPaddleEventIfFresh: async (params: { eventId: string; eventType: string }) => {
        if (state.events.has(params.eventId)) return false;
        state.events.set(params.eventId, {
          eventType: params.eventType,
          processedAt: null,
          leased: true,
        });
        state.freshInserts += 1;
        return true;
      },
      claimPaddleEventProcessing: async (params: { eventId: string; eventType: string }) => {
        const existing = state.events.get(params.eventId);
        if (existing?.processedAt) return { kind: "processed" as const };
        if (existing?.leased) return { kind: "in_progress" as const };
        state.events.set(params.eventId, {
          eventType: params.eventType,
          processedAt: null,
          leased: true,
        });
        state.freshInserts += 1;
        return { kind: "acquired" as const, attempt: 1 };
      },
      releasePaddleEventForRetry: async (eventId: string, attempt: number) => {
        assert.equal(attempt, 1);
        const ev = state.events.get(eventId);
        if (ev) ev.leased = false;
      },
      markPaddleEventProcessed: async (eventId: string, attempt: number) => {
        assert.equal(attempt, 1);
        const ev = state.events.get(eventId);
        if (ev) {
          ev.processedAt = new Date().toISOString();
          ev.leased = false;
        }
      },
      findUserIdByPaddleCustomerId: async (cid: string) =>
        state.customerIdToUserId.get(cid) ?? null,
      upsertSubscription: async (params: {
        userId: string;
        paddleSubscriptionId: string;
        paddleCustomerId: string;
        status: string;
        plan?: string | null;
      }) => {
        state.upserts.push({
          userId: params.userId,
          paddleSubscriptionId: params.paddleSubscriptionId,
          paddleCustomerId: params.paddleCustomerId,
          status: params.status,
          plan: params.plan ?? null,
        });
      },
      claimSubscriptionOnboardingDelivery: async () => ({ kind: "acquired" as const }),
      markSubscriptionOnboardingSent: async () => undefined,
      releaseSubscriptionOnboardingForRetry: async () => undefined,
    },
  });
}

afterEach(() => mock.reset());

describe("Paddle webhook signature path", () => {
  it("returns 401 on missing Paddle-Signature header", async () => {
    setupDbMocks({ customerIdToUserId: { cus_1: "u-1" } });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = { event_id: "evt_1", event_type: "subscription.created" };
    const req = makeReq(body, "");
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("X-Endstate-API-Version"), "2.1");
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "PADDLE_SIGNATURE_INVALID");
  });

  it("returns 401 on tampered body (signature was for different content)", async () => {
    setupDbMocks();
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const original = { event_id: "evt_2", event_type: "subscription.created" };
    const sig = signedHeader(JSON.stringify(original));
    const tampered = { event_id: "evt_2_attacker", event_type: "subscription.created" };
    const req = new Request("https://test.local/api/webhooks/paddle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "paddle-signature": sig,
      },
      body: JSON.stringify(tampered),
    });
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 401);
  });
});

describe("Paddle webhook idempotency", () => {
  it("processes once; subsequent identical event_id returns 200 deduped", async () => {
    setupDbMocks({ customerIdToUserId: { cus_1: "u-1" } });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_idem",
      event_type: "subscription.created",
      data: {
        id: "sub_1",
        customer_id: "cus_1",
        custom_data: { user_id: "u-1" },
      },
    };
    const req1 = makeReq(body);
    const res1 = await POST(req1 as unknown as import("next/server").NextRequest);
    assert.equal(res1.status, 200);
    assert.equal(state.freshInserts, 1);

    const req2 = makeReq(body);
    const res2 = await POST(req2 as unknown as import("next/server").NextRequest);
    assert.equal(res2.status, 200);
    const j2 = (await res2.json()) as { ok: true; deduped?: boolean };
    assert.equal(j2.deduped, true);
    // No new insert
    assert.equal(state.freshInserts, 1);
  });
});

describe("Paddle webhook unknown event types", () => {
  it("does not send Supporter transaction.completed into Hosted Backup onboarding", async () => {
    setupDbMocks();
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_unknown",
      event_type: "transaction.completed", // not in our handled set
      data: {
        id: "tx_supporter",
        items: [{ price: { id: "pri_endstate_supporter" } }],
      },
    };
    const req = makeReq(body);
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; ignored?: boolean; event_type?: string };
    assert.equal(j.ignored, true);
    assert.equal(j.event_type, "transaction.completed");
    assert.equal(state.upserts.length, 0);
    assert.ok(state.events.get("evt_unknown")?.processedAt);
  });
});

describe("Paddle webhook product classification", () => {
  it("ignores subscription events for a non-Hosted-Backup price", async () => {
    setupDbMocks();
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const res = await POST(
      makeReq({
        event_id: "evt_foreign_subscription",
        event_type: "subscription.activated",
        data: {
          id: "sub_foreign",
          customer_id: "cus_foreign",
          custom_data: { user_id: "u-foreign" },
          items: [{ price: { id: "pri_not_hosted_backup" } }],
        },
      }) as unknown as import("next/server").NextRequest
    );
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { reason?: string }).reason, "not_hosted_backup_price");
    assert.equal(state.upserts.length, 0);
  });
});

describe("Paddle webhook user_id correlation", () => {
  it("first-time subscription.created with custom_data.user_id upserts without a prior row", async () => {
    // No customer_id mapping exists yet — this is the first event for the user.
    setupDbMocks();
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_first_created",
      event_type: "subscription.created",
      data: {
        id: "sub_first",
        customer_id: "cus_first",
        custom_data: { user_id: "u-first" },
        items: [{ price: { id: "pri_hosted_backup" } }],
      },
    };
    const req = makeReq(body);
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; userId?: string; status?: string };
    assert.equal(j.userId, "u-first");
    assert.equal(j.status, "active");
    assert.equal(state.upserts.length, 1);
    assert.equal(state.upserts[0].userId, "u-first");
    assert.equal(state.upserts[0].paddleCustomerId, "cus_first");
    assert.equal(state.upserts[0].plan, "pri_hosted_backup");
  });

  it("subsequent event without custom_data falls back to paddle_customer_id lookup", async () => {
    setupDbMocks({ customerIdToUserId: { cus_existing: "u-existing" } });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_past_due",
      event_type: "subscription.past_due",
      data: { id: "sub_existing", customer_id: "cus_existing" },
    };
    const req = makeReq(body);
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; userId?: string; status?: string };
    assert.equal(j.userId, "u-existing");
    assert.equal(j.status, "grace");
    assert.equal(state.upserts.length, 1);
    assert.equal(state.upserts[0].userId, "u-existing");
    assert.equal(state.upserts[0].status, "grace");
  });

  it("event with neither custom_data nor a resolvable customer returns retryable failure", async () => {
    setupDbMocks();
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_orphan",
      event_type: "subscription.past_due",
      data: { id: "sub_orphan", customer_id: "cus_orphan" },
    };
    const req = makeReq(body);
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 503);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "PADDLE_USER_UNRESOLVED");
    assert.equal(state.upserts.length, 0);
  });
});

describe("Paddle webhook pause/resume", () => {
  it("subscription.paused upserts status=paused", async () => {
    setupDbMocks({ customerIdToUserId: { cus_p: "u-p" } });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_paused",
      event_type: "subscription.paused",
      data: { id: "sub_p", customer_id: "cus_p" },
    };
    const req = makeReq(body);
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 200);
    assert.equal(state.upserts.length, 1);
    assert.equal(state.upserts[0].status, "paused");
    assert.equal(state.upserts[0].userId, "u-p");
  });

  it("subscription.resumed upserts status=active", async () => {
    setupDbMocks({ customerIdToUserId: { cus_r: "u-r" } });
    const { POST } = await import("../../../app/api/webhooks/paddle/route");
    const body = {
      event_id: "evt_resumed",
      event_type: "subscription.resumed",
      data: { id: "sub_r", customer_id: "cus_r" },
    };
    const req = makeReq(body);
    const res = await POST(req as unknown as import("next/server").NextRequest);
    assert.equal(res.status, 200);
    assert.equal(state.upserts.length, 1);
    assert.equal(state.upserts[0].status, "active");
    assert.equal(state.upserts[0].userId, "u-r");
  });
});
